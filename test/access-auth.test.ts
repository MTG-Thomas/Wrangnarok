// SPDX-License-Identifier: AGPL-3.0
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { clearAccessCertCache, verifyAccess } from "../src/access";
import { Fault } from "../src/domain";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const ORG = "11111111-1111-4111-8111-111111111111";
const EMAIL = "admin@example.com";
const accessEnv = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ACCESS_ORG_ID: ORG,
  ACCESS_ALLOWED_EMAILS: EMAIL,
};

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keypair() {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
}

async function mint(priv: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

function certsStub(pubJwk: JsonWebKey, kid: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) === `${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...pubJwk, kid, alg: "RS256" }] });
    }
    throw new Error("access-auth tests must not fetch");
  });
}

function validPayload() {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], exp: now + 300, iat: now - 10, email: EMAIL };
}

beforeEach(() => {
  clearAccessCertCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("accepts a valid assertion and maps email plus org", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const token = await mint(privateKey, "k1", validPayload());
  const p = await verifyAccess(token, accessEnv);
  expect(p).toEqual({ userId: EMAIL, orgId: ORG.toLowerCase() });
});

it("rejects wrong aud, expired, bad signature, unknown kid, malformed", async () => {
  const { publicKey, privateKey } = await keypair();
  const other = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, Record<string, unknown>, CryptoKey, string][] = [
    ["wrong-aud", { ...validPayload(), aud: ["nope"] }, privateKey, "k1"],
    ["expired", { ...validPayload(), exp: now - 3600 }, privateKey, "k1"],
    ["bad-sig", validPayload(), other.privateKey, "k1"],
    ["unknown-kid", validPayload(), privateKey, "zz"],
  ];
  for (const [name, payload, key, kid] of cases) {
    const token = await mint(key, kid, payload);
    await expect(verifyAccess(token, accessEnv), name).rejects.toMatchObject({ status: 401 });
  }
  await expect(verifyAccess("not.a.jwt.at.all.parts", accessEnv), "malformed").rejects.toMatchObject({ status: 401 });
  await expect(verifyAccess("abc", accessEnv), "segments").rejects.toMatchObject({ status: 401 });
});

it("denies unlisted email and fails closed when unconfigured", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const token = await mint(privateKey, "k1", { ...validPayload(), email: "intruder@example.com" });
  await expect(verifyAccess(token, accessEnv)).rejects.toMatchObject({ status: 403 });
  const valid = await mint(privateKey, "k1", validPayload());
  await expect(verifyAccess(valid, {})).rejects.toMatchObject({ status: 503 });
});

it("serves the catalog on a valid assertion without LAB configured", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const token = await mint(privateKey, "k1", validPayload());
  const bindings = { ...(env as unknown as Bindings), ...accessEnv };
  delete (bindings as Record<string, unknown>).LAB_ENABLED;
  delete (bindings as Record<string, unknown>).LAB_TOKEN;
  const res = await worker.fetch(
    new Request("http://local.test/api/sagas", { headers: { "Cf-Access-Jwt-Assertion": token } }),
    bindings,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    sagas: expect.arrayContaining([expect.objectContaining({ name: "echo" })]),
  });
});

it("keeps LAB behavior when no assertion header is present", async () => {
  const bindings = { ...(env as unknown as Bindings) };
  delete (bindings as Record<string, unknown>).LAB_ENABLED;
  const res = await worker.fetch(new Request("http://local.test/api/sagas"), bindings);
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(new Fault(401, "UNAUTHORIZED", "Unauthorized.").status).toBe(401);
});

it("maps allowlisted service common_name without email", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const now = Math.floor(Date.now() / 1000);
  const token = await mint(privateKey, "k1", {
    aud: [AUD],
    exp: now + 300,
    iat: now - 10,
    common_name: "wrangnarok-machine-final",
  });
  const p = await verifyAccess(token, { ...accessEnv, ACCESS_ALLOWED_SERVICES: "wrangnarok-machine-final" });
  expect(p).toEqual({ userId: "service:wrangnarok-machine-final", orgId: ORG.toLowerCase() });
});

it("denies unlisted service identity", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const now = Math.floor(Date.now() / 1000);
  const token = await mint(privateKey, "k1", {
    aud: [AUD],
    exp: now + 300,
    iat: now - 10,
    common_name: "unknown-machine",
  });
  await expect(
    verifyAccess(token, { ...accessEnv, ACCESS_ALLOWED_SERVICES: "wrangnarok-machine-final" }),
  ).rejects.toMatchObject({ status: 403 });
});
