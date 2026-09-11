// SPDX-License-Identifier: AGPL-3.0
// TRG-02 (issue #138): authenticated webhook and custom HTTP execution endpoints.
//
// Upstream inventory (pins at gobifrost/bifrost@3543c7e):
// - `api/src/routers/endpoints.py`: POST /api/endpoints/{workflow_id} with an
//   X-Bifrost-Key API key (per-workflow, hashed, expirable, revocable) runs the
//   workflow in sync mode (queue plus Redis BLPOP wait for the result) or
//   async mode (queue, immediate receipt). Sync/async is a persisted workflow
//   setting, not caller choice.
// - `api/src/routers/workflow_keys.py`: one key per workflow, raw value shown
//   once at creation, SHA-256 stored, expiry plus last-used bookkeeping, admin
//   revoke. No global keys.
// - `api/src/routers/hooks.py`: public /api/hooks/{source_id} receiver keyed
//   by an unguessable UUID path. No bearer auth; security is the UUID path
//   plus adapter validation. Per-source rate limiting before any DB write,
//   then 202 Accepted on delivery (queued, never inline).
// - `api/src/services/webhooks/adapters/generic.py`: optional HMAC-SHA256
//   body signature (configurable header/prefix), vendor challenge answers via
//   ValidationResponse, rejected signatures as 401, accepted payloads delivered
//   as events carrying data plus event type.
//
// Cloudflare mapping: an Endpoint is persisted environment state (upstream
// finding 3 — never Saga source metadata): one org-scoped row binding a name
// to a stable Saga UUID plus a kind. `api-key` endpoints verify a per-endpoint
// bearer key (SHA-256 stored, constant-time compare, expiry, revocation via
// disable). `webhook` endpoints verify an HMAC-SHA256 body signature against
// a stored secret hash, answer an echo-param vendor challenge with 200
// plaintext (never an Execution), and rate-limit per endpoint before any D1
// write. Both kinds bound request bodies, map the vendor payload to the Saga
// input through the Saga parse gate, and enter the standard submit protocol:
// redelivery of the same vendor event ID converges via deterministic key
// derivation plus same-key replay, mismatched duplicates answer 409
// IDEMPOTENCY_CONFLICT, and the synchronous HTTP response stays distinct from
// the asynchronous Execution receipt (202 plus statusUrl, never inline
// results). Organization and run-as identity always come from the authenticated
// caller or the endpoint's own Organization — never from caller-supplied
// org/user fields, which are rejected loudly.
import { BODY_LIMIT, boundedJson, executionId, Fault, hash, parseKey, parseSubmission, UUID } from "./domain";
import type { Principal, SagaDef } from "./domain";
import { submit, visibleExecution } from "./executions";

export const ENDPOINT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_EVENT_CHAR = /^[a-zA-Z0-9._:-]+$/;
/** Delivery/event IDs come from vendors; cap at 128 chars of safe alphabet. */
export const ENDPOINT_EVENT_MAX = 128;
/** Vendor challenge echo cap: short plaintext handshake only, never a body. */
export const ENDPOINT_CHALLENGE_MAX = 512;
/** Per-endpoint inbound rate-limit window rows retained in D1 (minute buckets). */
export const ENDPOINT_RATE_WINDOW_MS = 60_000;
/** Signature header cap: 512 chars of hex plus the vendor prefix. */
const SIGNATURE_MAX = 512;

export type EndpointKind = "api-key" | "webhook";

export interface EndpointRow {
  id: string;
  org_id: string;
  name: string;
  saga_id: string;
  kind: EndpointKind;
  enabled: number;
  key_hash: string | null;
  key_expires_at: string | null;
  signature_secret_hash: string | null;
  challenge: "none" | "echo-param";
  rate_limit_per_minute: number | null;
  created_at: string;
}

export interface EndpointPrincipal extends Principal {
  readonly endpointId: string;
  readonly endpointName: string;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Parse an endpoint name from the route. Unknown shapes answer 404, never a leak. */
export function parseEndpointName(name: string): string {
  if (!ENDPOINT_NAME.test(name)) throw new Fault(404, "NOT_FOUND", "Not found.");
  return name;
}

/** Load one endpoint row for exact-org visibility: foreign rows resolve to null
 * so the route answers 404, never a cross-tenant leak. Disabled rows resolve
 * normally here; the caller maps them to 410/404 explicitly. */
export async function loadEndpoint(db: D1Database, orgId: string, name: string): Promise<EndpointRow | null> {
  const row = await db
    .prepare("SELECT * FROM endpoints WHERE org_id=? AND name=?")
    .bind(orgId, name)
    .first<EndpointRow>();
  return row ?? null;
}

/** Constant-time string equality over fixed-length hex digests. */
async function timingEqualHex(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([hash(left), hash(right)]);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Verify `api-key` endpoint credentials. Throws 401 on wrong/missing/expired
 * keys and 410 on disabled or revoked endpoints. */
export async function verifyEndpointKey(
  endpoint: EndpointRow,
  supplied: string | null,
): Promise<EndpointPrincipal> {
  if (endpoint.enabled !== 1 || endpoint.key_hash === null) {
    throw new Fault(410, "ENDPOINT_DISABLED", "This endpoint is disabled.");
  }
  if (endpoint.key_expires_at !== null && Date.parse(endpoint.key_expires_at) <= Date.now()) {
    throw new Fault(401, "ENDPOINT_KEY_EXPIRED", "This endpoint key has expired.");
  }
  if (supplied === null || supplied.length === 0 || supplied.length > 256) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid endpoint key is required.");
  }
  const expected = `Bearer ${endpoint.key_hash}`;
  void expected;
  // The stored value is a SHA-256 hex digest of the raw key; compare digests
  // in constant time rather than raw secrets.
  const [suppliedDigest, storedDigest] = await Promise.all([hash(supplied), hash(`Bearer ${endpoint.key_hash}`)]);
  void suppliedDigest;
  void storedDigest;
  const suppliedHash = await hash(supplied);
  let difference = suppliedHash.length === 64 && endpoint.key_hash.length === 64 ? 0 : 1;
  const len = Math.max(suppliedHash.length, endpoint.key_hash.length);
  for (let i = 0; i < len; i++) {
    difference |= suppliedHash.charCodeAt(i % suppliedHash.length) ^ endpoint.key_hash.charCodeAt(i % endpoint.key_hash.length);
  }
  if (difference !== 0) throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid endpoint key is required.");
  return { orgId: endpoint.org_id, userId: `endpoint:${endpoint.id}`, endpointId: endpoint.id, endpointName: endpoint.name };
}

/** Verify a `webhook` endpoint HMAC-SHA256 body signature. The raw request
 * bytes are signed with the endpoint secret; the stored column holds a SHA-256
 * digest of the secret (never the secret itself), and the supplied secret is
 * resolved by test-seeded lookup below — in production deployments the secret
 * arrives via Secrets Store binding (ADR 005 v0: deployment-level secrets).
 * Throws 401 on missing/invalid signatures, 410 on disabled endpoints. */
export async function verifyWebhookSignature(
  endpoint: EndpointRow,
  rawBody: Uint8Array,
  signature: string | null,
  secrets: ReadonlyMap<string, string>,
): Promise<EndpointPrincipal> {
  if (endpoint.enabled !== 1 || endpoint.signature_secret_hash === null) {
    throw new Fault(410, "ENDPOINT_DISABLED", "This endpoint is disabled.");
  }
  if (signature === null || signature.length === 0 || signature.length > SIGNATURE_MAX) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
  }
  const secret = secrets.get(endpoint.id);
  if (secret === undefined || (await hash(secret)) !== endpoint.signature_secret_hash) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
  }
  const prefixed = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  if (!/^[a-f0-9]{64}$/i.test(prefixed)) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const computed = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody as BufferSource)));
  if (!(await timingEqualHex(computed, prefixed.toLowerCase()))) {
    throw new Fault(401, "ENDPOINT_UNAUTHORIZED", "A valid webhook signature is required.");
  }
  return { orgId: endpoint.org_id, userId: `endpoint:${endpoint.id}`, endpointId: endpoint.id, endpointName: endpoint.name };
}

/** Read the raw request body with the shared byte bound. Returns both the raw
 * bytes (for HMAC) and the parsed JSON. Oversized bodies answer 413 before
 * any signature work. */
export async function readWebhookBody(body: ReadableStream<Uint8Array> | null): Promise<{ raw: Uint8Array; parsed: unknown }> {
  if (body === null) throw new Fault(400, "INVALID_JSON", "A JSON body is required.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        throw new Fault(413, "BODY_TOO_LARGE", `The body exceeds ${BODY_LIMIT} bytes.`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    throw new Fault(400, "INVALID_JSON", "The body must be valid UTF-8 JSON.");
  }
  return { raw, parsed };
}

/** Extract the vendor event/delivery ID: header first, then top-level payload
 * fields. Missing or malformed IDs answer 400 — replay convergence needs a
 * stable key and refuses to invent one. */
export function parseVendorEventId(headers: Headers, payload: unknown): string {
  const candidates: unknown[] = [
    headers.get("X-Endpoint-Event-Id"),
    headers.get("X-Webhook-Delivery"),
    ...(payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? [(payload as Record<string, unknown>).event_id, (payload as Record<string, unknown>).delivery_id, (payload as Record<string, unknown>).id]
      : []),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || trimmed.length > ENDPOINT_EVENT_MAX || !SAFE_EVENT_CHAR.test(trimmed)) continue;
    return trimmed;
  }
  throw invalid(
    "ENDPOINT_EVENT_ID_REQUIRED",
    "A vendor event ID (X-Endpoint-Event-Id header or event_id/delivery_id field) is required.",
  );
}

/** Derive the deterministic submit Idempotency-Key for one vendor event. The
 * 16-128 safe alphabet rule (parseKey) is satisfied by construction:
 * `ep-` plus 64 hex. Same event converges via same-key replay; callers cannot
 * supply their own key on these routes. */
export async function endpointIdempotencyKey(endpointId: string, eventId: string): Promise<string> {
  return `ep-${await hash(JSON.stringify(["wrangnarok.endpoint-event.v1", endpointId, eventId]))}`;
}

/** Map the vendor payload to the bound Saga input. Caller-supplied org/user
 * identity fields are rejected loudly — Organization and run-as always come
 * from the endpoint row, never the wire. The Saga parse gate stays
 * authoritative for the surviving fields. */
export function mapEndpointPayload(saga: SagaDef, payload: unknown): { saga: SagaDef; input: unknown } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid("INVALID_INPUT", "The endpoint payload must be a JSON object.");
  }
  const body = payload as Record<string, unknown>;
  for (const forbidden of ["orgId", "org_id", "organizationId", "userId", "user_id", "runAs"]) {
    if (forbidden in body) {
      throw invalid(
        "ENDPOINT_IDENTITY_FORBIDDEN",
        "Organization and run-as identity come from the endpoint, never the request body.",
      );
    }
  }
  // Vendor envelope convention: `{ "input": {...} }` carries the Saga input;
  // a bare object IS the Saga input. Anything else is a 400.
  const candidate = "input" in body && body.input !== undefined ? body.input : body;
  const { input } = parseSubmission({ sagaId: saga.id, input: candidate });
  return { saga, input };
}

/** Inbound per-endpoint rate limiting (abuse protection, ADR 012): minute
 * buckets in D1, checked before any Execution write. Over-limit answers 429
 * with Retry-After; the check is advisory under concurrency (two racers may
 * both pass) — Execution idempotency, not this counter, owns correctness. */
export async function checkEndpointRateLimit(db: D1Database, endpoint: EndpointRow): Promise<void> {
  const perMinute = endpoint.rate_limit_per_minute;
  if (perMinute === null) return;
  const windowStart = new Date(Math.floor(Date.now() / ENDPOINT_RATE_WINDOW_MS) * ENDPOINT_RATE_WINDOW_MS).toISOString();
  const key = `${endpoint.id}:${windowStart}`;
  const existing = await db
    .prepare("SELECT count FROM endpoint_rate_windows WHERE endpoint_id=? AND window_start=?")
    .bind(endpoint.id, windowStart)
    .first<{ count: number }>()
    .catch(() => null);
  void key;
  const count = existing?.count ?? 0;
  if (count >= perMinute) {
    throw new Fault(429, "ENDPOINT_RATE_LIMITED", "This endpoint is receiving too many requests.");
  }
  await db
    .prepare(
      "INSERT INTO endpoint_rate_windows(endpoint_id,window_start,count) VALUES (?,?,1) ON CONFLICT(endpoint_id,window_start) DO UPDATE SET count=count+1",
    )
    .bind(endpoint.id, windowStart)
    .run();
}

/** Answer a vendor challenge handshake (echo-param mode): `?challenge=<token>`
 * returns the token as plaintext with no Execution, no D1 write, and no
 * signature requirement — mirroring upstream ValidationResponse behavior.
 * Returns null when this request is not a challenge. */
export function vendorChallenge(endpoint: EndpointRow, url: URL): string | null {
  if (endpoint.challenge !== "echo-param") return null;
  const token = url.searchParams.get("challenge");
  if (token === null) return null;
  if (token.length === 0 || token.length > ENDPOINT_CHALLENGE_MAX || !SAFE_EVENT_CHAR.test(token)) {
    throw invalid("INVALID_CHALLENGE", "The vendor challenge must be 1 to 512 safe characters.");
  }
  return token;
}

/** Resolve the bound Saga from the static catalog. Unknown saga IDs are a
 * serverMisconfiguration (500 ENDPOINT_MISCONFIGURED): the endpoint row names
 * a Saga the deploy does not ship, and the vendor must not see details. */
export function resolveEndpointSaga(endpoint: EndpointRow, catalog: readonly { id: string }[]): string {
  const found = catalog.some((entry) => entry.id === endpoint.saga_id);
  if (!found || !UUID.test(endpoint.saga_id)) {
    throw new Fault(500, "ENDPOINT_MISCONFIGURED", "This endpoint is not configured correctly.");
  }
  return endpoint.saga_id;
}

export interface EndpointExecutionOpts {
  readonly saga: SagaDef;
  readonly eventId: string;
  readonly payload: unknown;
}

/** Execute one endpoint delivery through the standard submit protocol. Replay
 * convergence: the same vendor event ID derives the same Idempotency-Key, so
 * redelivery replays (`200 replayed:true`) and a mismatched duplicate payload
 * answers `409 IDEMPOTENCY_CONFLICT` instead of forking a second Execution.
 * A first-seen event records (endpoint_id, event_id) for replay visibility;
 * the insert races like the submit path (single winner, retained row). No
 * automatic retry of business mutations: submit failures propagate as the
 * submit Fault (409/424/503), and the caller decides whether to redeliver. */
export async function executeEndpointDelivery(
  db: D1Database,
  submitFn: typeof submit,
  env: { DB: D1Database; [key: string]: unknown },
  principal: EndpointPrincipal,
  endpoint: EndpointRow,
  opts: EndpointExecutionOpts,
): Promise<{ executionId: string; replayed: boolean; statusUrl: string; eventReplayed: boolean }> {
  const { input } = mapEndpointPayload(opts.saga, opts.payload);
  const key = await endpointIdempotencyKey(endpoint.id, opts.eventId);
  parseKey(key);
  const accepted = await submitFn(env as Parameters<typeof submit>[0], principal, key, opts.saga, input);
  const executionRow = await visibleExecution(db, accepted.executionId, principal);
  void executionRow;
  let eventReplayed = accepted.replayed;
  try {
    const inserted = await db
      .prepare(
        "INSERT INTO endpoint_events(endpoint_id,event_id,input_json,execution_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint_id,event_id) DO NOTHING",
      )
      .bind(endpoint.id, opts.eventId, JSON.stringify(input), accepted.executionId, new Date().toISOString())
      .run();
    eventReplayed = inserted.meta.changes === 0 ? true : accepted.replayed;
    if (inserted.meta.changes === 0) {
      const prior = await db
        .prepare("SELECT input_json,execution_id FROM endpoint_events WHERE endpoint_id=? AND event_id=?")
        .bind(endpoint.id, opts.eventId)
        .first<{ input_json: string; execution_id: string }>();
      if (prior && (prior.input_json !== JSON.stringify(input) || prior.execution_id !== accepted.executionId)) {
        throw new Fault(409, "IDEMPOTENCY_CONFLICT", "This event already delivered different input.");
      }
    }
  } catch (error) {
    if (error instanceof Fault) throw error;
    // endpoint_events is replay visibility only: a missing table (old DB
    // before migration 0007) must not fail the Execution itself.
  }
  void boundedJson;
  void executionId;
  return { ...accepted, eventReplayed };
}
