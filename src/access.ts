// SPDX-License-Identifier: AGPL-3.0
import { Fault, type Principal } from "./domain";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ORG_ID?: string;
  ACCESS_ALLOWED_EMAILS?: string;
}

interface AccessConfig {
  teamDomain: string;
  aud: string;
  orgId: string;
  allowed: ReadonlySet<string>;
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
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/, "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  const orgId = (env.ACCESS_ORG_ID ?? "").trim().toLowerCase();
  if (!teamDomain || !aud || !orgId) return null;
  const allowed = new Set(
    (env.ACCESS_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return { teamDomain, aud, orgId, allowed };
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
  let payload: { aud?: string | string[]; exp?: number; email?: string };
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
  if (!email || !cfg.allowed.has(email)) throw new Fault(403, "FORBIDDEN", "Forbidden.");
  return { userId: email, orgId: cfg.orgId };
}

/** Test hook: drop cached certs (rotation tests, suite isolation). */
export function clearAccessCertCache(): void {
  certCache.clear();
}
