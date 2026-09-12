// SPDX-License-Identifier: AGPL-3.0
import { Fault, type Principal } from "./domain";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ORG_ID?: string;
  ACCESS_ALLOWED_EMAILS?: string;
  ACCESS_ALLOWED_SERVICES?: string;
}

interface AccessConfig {
  teamDomain: string;
  aud: string;
  orgId: string;
  allowed: ReadonlySet<string>;
  services: ReadonlySet<string>;
}

// Module-level cert cache: kid -> CryptoKey. Workers isolates reuse it;
// rotation is picked up when an unknown kid arrives (single refetch).
const certCache = new Map<string, CryptoKey>();

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function readAccessConfig(env: AccessEnv): AccessConfig | null {
  const rawDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  // Regex-free trailing-slash strip (CodeQL polynomial-regexp on env input).
  let teamDomain = rawDomain;
  while (teamDomain.endsWith("/")) teamDomain = teamDomain.slice(0, -1);
  const aud = (env.ACCESS_AUD ?? "").trim();
  const orgId = (env.ACCESS_ORG_ID ?? "").trim().toLowerCase();
  if (!teamDomain || !aud || !orgId) return null;
  const allowed = new Set(
    (env.ACCESS_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  const services = new Set(
    (env.ACCESS_ALLOWED_SERVICES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return { teamDomain, aud, orgId, allowed, services };
}

async function keyFor(teamDomain: string, kid: string, fetchFn: typeof fetch): Promise<CryptoKey | null> {
  const cached = certCache.get(kid);
  if (cached) return cached;
  const res = await fetchFn(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) return null;
  const body = (await res.json()) as { keys?: { kid?: string; kty?: string; n?: string; e?: string }[] };
  for (const k of body.keys ?? []) {
    if (k.kid == null || k.kty !== "RSA" || k.n == null || k.e == null) continue;
    const jwk: JsonWebKey = { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    certCache.set(k.kid, key);
  }
  return certCache.get(kid) ?? null;
}

/** Verify a Cloudflare Access JWT assertion. Throws Fault(401/403/503). */
export async function verifyAccess(
  assertion: string,
  env: AccessEnv,
  fetchFn: typeof fetch = fetch,
): Promise<Principal> {
  const cfg = readAccessConfig(env);
  if (cfg == null) throw new Fault(503, "ACCESS_NOT_CONFIGURED", "Access auth is not configured.");
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const [headB64, payloadB64, sigB64] = parts;
  if (headB64 == null || payloadB64 == null || sigB64 == null) {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; email?: string; common_name?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  const key = await keyFor(cfg.teamDomain, header.kid, fetchFn);
  if (key == null) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const data = new TextEncoder().encode(`${headB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(sigB64), data);
  if (!ok) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + 60 < now) {
    throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(cfg.aud)) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email && cfg.allowed.has(email)) return { userId: email, orgId: cfg.orgId };
  // Service-token assertions carry common_name instead of email (Phase 3 will
  // fold services into the membership table; until then an explicit allowlist).
  const svc = typeof payload.common_name === "string" ? payload.common_name.trim().toLowerCase() : "";
  if (svc && cfg.services.has(svc)) return { userId: `service:${svc}`, orgId: cfg.orgId };
  throw new Fault(403, "FORBIDDEN", "Forbidden.");
}

/** Credential classes a verified Principal can hold.
 *
 * AUTH-03 (issue #144): upstream Bifrost distinguishes delegated human
 * identity (login/SSO/MFA/passkeys, `api/src/routers/auth.py`,
 * `oauth_sso.py`, `mfa.py`, `passkeys.py`) from scoped machine credentials
 * (user API keys and per-workflow keys, `api/src/routers/workflow_keys.py`).
 * Locally both arrive through the same two gates: a Cloudflare Access
 * assertion (human email or service common_name, ADR 014) or the LAB fixture
 * bearer (local only, never production). The class is derived from the
 * Principal shape alone, so routes, audit rows, and the SDK identity surface
 * share one definition instead of re-parsing prefixes. */
export type CredentialClass = "human" | "service" | "fixture" | "endpoint";

const SERVICE_PREFIX = "service:";
const ENDPOINT_PREFIX = "endpoint:";

/** True for Access service-token principals (`service:<client-id>`), minted
 * by verifyAccess from an allowlisted assertion common_name. Service tokens
 * carry no email and authenticate through Access client-credentials, the
 * local analogue of upstream OAuth2 M2M API Services. */
export function isServicePrincipal(userId: string): boolean {
  return userId.startsWith(SERVICE_PREFIX) && userId.length > SERVICE_PREFIX.length;
}

/** True for TRG-02 scoped endpoint-delivery principals (`endpoint:<id>`),
 * minted by verifyEndpointKey/verifyWebhookSignature from a per-endpoint
 * credential. Endpoint principals are the local analogue of upstream
 * per-workflow keys: least-privilege, expiry/rotation-aware, and bound to a
 * single Saga binding instead of an operator session. */
export function isEndpointPrincipal(userId: string): boolean {
  return userId.startsWith(ENDPOINT_PREFIX) && userId.length > ENDPOINT_PREFIX.length;
}

/** Classify a verified caller Principal into its credential class. Endpoint
 * delivery principals are checked before service principals so a future
 * `service:`-prefixed endpoint id can never be mistaken for an Access
 * service token. Anything else verified through the fixture or Access human
 * path is a delegated human identity (Access email) or the local fixture. */
export function credentialClassFor(userId: string, viaAccess: boolean): CredentialClass {
  if (isEndpointPrincipal(userId)) return "endpoint";
  if (isServicePrincipal(userId)) return "service";
  return viaAccess ? "human" : "fixture";
}

/** Test hook: drop cached certs (rotation tests, suite isolation). */
export function clearAccessCertCache(): void {
  certCache.clear();
}
