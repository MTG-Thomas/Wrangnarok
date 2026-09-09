// SPDX-License-Identifier: AGPL-3.0
export const echoSaga = Object.freeze({
  id: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
  name: "echo",
  revision: "echo-v1",
  description: "MVP slice: prepare input and call the local HTTP echo Integration",
});
export const ECHO_INTEGRATION_ID = "720b9ebf-9b6a-4eac-bae9-6ed22c970402";
export const ninjaSaga = Object.freeze({
  id: "2c79a880-f1ac-4183-b324-d05daffc321a",
  name: "ninjaone-orgs",
  revision: "ninjaone-orgs-v1",
  description: "Rung 1: list NinjaOne organizations read-only over client-credentials OAuth",
});
export const NINJA_INTEGRATION_ID = "0606e237-137b-4629-8346-85468e1c2df6";
// system.smoke is loopback-free: D1-only Operations + transform steps, zero
// external vendor dependency. Stable identity per ADR 002 (UUID + revision).
export const smokeSaga = Object.freeze({
  id: "7a1f3c5e-9b2d-4f6a-8c1e-5d3b7a9f1c2e",
  name: "system.smoke",
  revision: "system.smoke-v1",
  description: "Platform smoke: Worker request handling, D1 write/read verification, multi-Operation Workflow, terminal persistence, usage block — no vendor dependency",
});
// Disposable smoke Organization (ADR 004): smoke runs here, never against
// production tenant/Connection data. Seeded in tests; provisioned in dev via
// the runbook (docs/architecture/004-ci-cd.md).
export const SMOKE_ORG_NAME = "org_system_smoke";
export const SMOKE_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const SMOKE_USER_ID = "22222222-2222-4222-8222-222222222222";
// Token lives on the regional host, not the central app host: derive it from
// the Connection endpoint origin (verified live 2026-09-09: us2 answers
// /oauth/token, app.ninjarmm.com does not know us2 clients). Read-only scope:
// the M2M app carries monitoring only, and management is rejected for it.
export const NINJA_TOKEN_PATH = "/oauth/token";
export const NINJA_SCOPE = "monitoring";
export const NINJA_ORGS_PATH = "/v2/organizations";
export const BODY_LIMIT = 4096;
export const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
// Canonical per ADR 001 (reconciled #15): deterministic 64-hex Execution ID
// scoped to (org, user, key); required Idempotency-Key 16-128; Pending never
// auto-swept; Scheduled distinct (deferred); operator step-retry ceiling 2.
export const STEP_RETRY_CEILING = 2;
export const EXECUTION_ID = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type ExecutionStatus = "Pending" | "Running" | "Succeeded" | "Failed" | "TimedOut" | "Cancelled";
export interface Principal { readonly userId: string; readonly orgId: string }
export interface EchoInput { message: string }
export interface NinjaOrgsInput { /* empty: read-only census, no parameters */ }
export interface NinjaOrgSummary { id: number; name: string }
export interface NinjaOrgsResult { organizationCount: number; organizations: NinjaOrgSummary[] }
export const NINJA_ORGS_MAX = 25;
export interface SmokeInput { /* empty: loopback-free census, no parameters */ }
export interface SmokeResult {
  d1WriteOk: boolean;
  d1ReadOk: boolean;
  operationCount: number;
  operations: string[];
}
export interface ExecutionParams { executionId: string }
export interface SafeError { code: string; message: string }

export class Fault extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "Fault";
  }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseInput(value: unknown): EchoInput {
  if (!object(value) || Object.keys(value).some((key) => key !== "message") ||
      typeof value.message !== "string" || value.message.length === 0 ||
      new TextEncoder().encode(value.message).length > 1024) {
    throw new Fault(400, "INVALID_INPUT", "Expected one message of 1 to 1024 UTF-8 bytes.");
  }
  return { message: value.message };
}
export function parseNinjaOrgsInput(value: unknown): NinjaOrgsInput {
  if (!object(value) || Object.keys(value).length !== 0) {
    throw new Fault(400, "INVALID_INPUT", "The ninjaone-orgs Saga takes an empty input object.");
  }
  return {};
}
export function parseSmokeInput(value: unknown): SmokeInput {
  if (!object(value) || Object.keys(value).length !== 0) {
    throw new Fault(400, "INVALID_INPUT", "The system.smoke Saga takes an empty input object.");
  }
  return {};
}
export interface SagaDef {
  readonly id: string; readonly name: string; readonly revision: string;
  readonly description: string; readonly parse: (value: unknown) => unknown;
}
const catalog: SagaDef[] = [
  { ...echoSaga, parse: parseInput },
  { ...ninjaSaga, parse: parseNinjaOrgsInput },
  { ...smokeSaga, parse: parseSmokeInput },
];
export function parseSubmission(value: unknown): { saga: SagaDef; input: unknown } {
  if (!object(value) || Object.keys(value).some((key) => !["sagaId", "input"].includes(key)) ||
      typeof value.sagaId !== "string") {
    throw new Fault(400, "INVALID_SUBMISSION", "Provide a built-in Saga ID and its input only.");
  }
  const saga = catalog.find((entry) => entry.id === value.sagaId);
  if (!saga) throw new Fault(400, "UNKNOWN_SAGA", "Provide a built-in Saga ID and its input only.");
  return { saga, input: saga.parse(value.input) };
}
export function parseKey(key: string | null): string {
  if (key === null || !/^[a-zA-Z0-9._:-]{16,128}$/.test(key)) {
    throw new Fault(400, "INVALID_IDEMPOTENCY_KEY", "An Idempotency-Key of 16 to 128 safe characters is required.");
  }
  return key;
}
export async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function executionId(principal: Principal, key: string): Promise<string> {
  return hash(JSON.stringify(["wrangnarok.execution.v1", principal.orgId, principal.userId, parseKey(key)]));
}

/** Shared byte bound, also used before parsing an external Integration response.
 * Callers with a known vendor shape may pass a higher transport cap; what
 * gets persisted is still governed by the D1 result CHECK constraints. */
export async function boundedJson(body: ReadableStream<Uint8Array> | null, limit = BODY_LIMIT): Promise<unknown> {
  if (body === null) throw new Fault(400, "INVALID_JSON", "A JSON body is required.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Fault(413, "BODY_TOO_LARGE", `The body exceeds ${limit} bytes.`);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new Fault(400, "INVALID_JSON", "The body must be valid UTF-8 JSON."); }
}
