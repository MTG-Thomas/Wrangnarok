// SPDX-License-Identifier: AGPL-3.0
// DEV-01 (issue #140): versioned SDK contract drift tests plus local
// happy/denied/error examples. Runs in real workerd via
// @cloudflare/vitest-plugin; D1/Workflow bindings are never replaced, only
// outbound vendor HTTP is intercepted. No production deployment.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, helloSaga } from "../src/domain";
import {
  createSdkClient,
  describeContract,
  inspectSaga,
  localCatalog,
  parseExecutionDetail,
  parseHistoryPage,
  parseSagaCatalog,
  parseSdkError,
  scaffoldSaga,
  SdkError,
  SDK_DOC_PATH,
  SDK_ERROR_CODES,
  SDK_VERSION,
  validateAgainstSchema,
} from "../src/sdk";
import { SAGA_CATALOG } from "../src/sagas";
import migration from "../migrations/0001_initial.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

describe("SDK contract version and descriptor (issue #140)", () => {
  it("pins the contract version and serves it over GET /api/sdk", async () => {
    expect(SDK_VERSION).toBe("1");
    expect(SDK_DOC_PATH).toBe("/api/sdk");
    const descriptor = describeContract();
    expect(descriptor.contract).toBe("wrangnarok.sdk");
    expect(descriptor.version).toBe(SDK_VERSION);
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["GET /api/sdk", "GET /api/sagas", "POST /api/executions"]),
    );
    for (const capability of descriptor.capabilities) {
      expect(["supported", "git-owned", "tracked"]).toContain(capability.status);
    }
    // Resource-management SDK commands stay tracked to their owning parity
    // issues; the descriptor must never declare them complete.
    const resources = descriptor.capabilities.find((entry) => entry.name === "resource-management");
    expect(resources?.status).toBe("tracked");
  });

  it("serves the same descriptor through the authenticated Worker route", async () => {
    await bindings.DB.exec(migration);
    await bindings.DB.exec(seed);
    const denied = await worker.fetch(new Request("http://local.test/api/sdk"), bindings);
    expect(denied.status).toBe(401);
    const ok = await worker.fetch(new Request("http://local.test/api/sdk", { headers: authHeaders() }), bindings);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(describeContract());
  });

  it("keeps SDK_ERROR_CODES covering every served error code", async () => {
    await bindings.DB.exec(migration);
    await bindings.DB.exec(seed);
    // Force representative failures through the real routes and assert each
    // served code is in the contract list.
    const unauth = await worker.fetch(new Request("http://local.test/api/sagas"), bindings);
    expect(SDK_ERROR_CODES).toContain(((await unauth.json()) as { error: { code: string } }).error.code);
    const badJson = await worker.fetch(
      new Request("http://local.test/api/executions", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": "sdk-drift-test-0001" }),
        body: "{not json",
      }),
      bindings,
    );
    expect(SDK_ERROR_CODES).toContain(((await badJson.json()) as { error: { code: string } }).error.code);
    const badInput = await worker.fetch(
      new Request("http://local.test/api/executions", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": "sdk-drift-test-0002" }),
        body: JSON.stringify({ sagaId: helloSaga.id, input: { name: "" } }),
      }),
      bindings,
    );
    expect(SDK_ERROR_CODES).toContain(((await badInput.json()) as { error: { code: string } }).error.code);
    const notFound = await worker.fetch(
      new Request(`http://local.test/api/executions/${"f".repeat(64)}`, { headers: authHeaders() }),
      bindings,
    );
    expect(SDK_ERROR_CODES).toContain(((await notFound.json()) as { error: { code: string } }).error.code);
  });
});

describe("SDK offline authoring helpers", () => {
  it("scaffolds a defineSaga module with stable identity markers", () => {
    const scaffolded = scaffoldSaga({
      name: "hello-again",
      id: "395e15f0-3627-41f6-8922-008ce37e3b99",
      description: "A fresh author scaffold.",
    });
    expect(scaffolded.files).toHaveLength(1);
    const file = scaffolded.files[0];
    expect(file?.path).toBe("src/sagas/hello-again.ts");
    for (const marker of [
      "defineSaga",
      "requiredIntegrations",
      'step.do("prepare-input-v1"',
      "prepareExecution",
      "executeSaga",
      "395e15f0-3627-41f6-8922-008ce37e3b99",
    ]) {
      expect(file?.content).toContain(marker);
    }
    expect(scaffolded.next.join("\n")).toContain("sagas.manifest.json");
    expect(() => scaffoldSaga({ name: "Bad Name", id: "not-a-uuid", description: "x" })).toThrow(SdkError);
    expect(() => scaffoldSaga({ name: "ok", id: "not-a-uuid", description: "x" })).toThrow(/stable UUID/);
  });

  it("inspects the offline catalog by id and exact name only", () => {
    const catalog = localCatalog();
    expect(catalog).toHaveLength(SAGA_CATALOG.length);
    const hello = inspectSaga(catalog, "hello");
    expect(hello.id).toBe(helloSaga.id);
    expect(inspectSaga(catalog, helloSaga.id)).toEqual(hello);
    expect(() => inspectSaga(catalog, "no-such-saga")).toThrow(/No Saga named/);
    expect(() => inspectSaga(catalog, "395e15f0-3627-41f6-8922-008ce37e3b00")).toThrow(/stable id/);
  });

  it("validates inputs against served schemas before submit", () => {
    const hello = inspectSaga(localCatalog(), "hello");
    expect(validateAgainstSchema({ name: "Ada" }, hello.inputSchema)).toEqual({ ok: true });
    expect(validateAgainstSchema({}, hello.inputSchema).ok).toBe(false);
    expect(validateAgainstSchema({ name: 7 }, hello.inputSchema).ok).toBe(false);
    expect(validateAgainstSchema({ nickname: "Ada" }, hello.inputSchema).ok).toBe(false);
    expect(validateAgainstSchema("anything", undefined)).toEqual({ ok: true });
  });

  it("resolves the SDK scaffold offline with no network", () => {
    const scaffolded = scaffoldSaga({
      name: "cli-check",
      id: "395e15f0-3627-41f6-8922-008ce37e3b98",
      description: "CLI parity check.",
      revision: "cli-check-v1",
    });
    for (const marker of ["defineSaga", "requiredIntegrations", 'step.do("prepare-input-v1"']) {
      expect(scaffolded.files[0]?.content).toContain(marker);
    }
  });

  it("surfaces SDK error codes for unknown refs without network", async () => {
    const client = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    // Offline catalog helpers fail before any fetch.
    expect(() => inspectSaga([], "hello")).toThrow(/No Saga named/);
    await expect(client.inspectSaga("no-such-saga")).rejects.toMatchObject({ code: "SDK_CLIENT_NETWORK" });
  });
});

describe("SDK automation client: local happy/denied/error examples", () => {
  beforeEach(async () => {
    await bindings.DB.exec(migration);
    await bindings.DB.exec(seed);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "http://127.0.0.1:8788/echo") throw new Error("Unexpected outbound request");
      return Response.json({ message: "hello" });
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
  });

  it("lists, inspects, submits, polls, and diagnoses a happy Execution", async () => {
    const key = "sdk-client-happy-001";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(new Request(url, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }), {
        ...bindings,
      })) as typeof fetch;
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl, pollMs: 0 });
    const sagas = await client.listSagas();
    expect(parseSagaCatalog({ sagas })).toHaveLength(SAGA_CATALOG.length);
    const hello = await client.inspectSaga("hello");
    expect(hello.inputSchema).toBeDefined();
    const submitted = await client.submitExecution({ saga: "hello", input: { name: "Ada" }, key });
    expect(submitted).toMatchObject({ executionId: id, status: "Succeeded" });
    await instance.waitForStatus("complete");
    const settled = await client.getExecution(id);
    expect(parseExecutionDetail(JSON.parse(JSON.stringify(settled)))).toMatchObject({
      status: "Succeeded",
      result: { greeting: "Hello, Ada!", name: "Ada" },
    });
    const diagnosis = await client.diagnoseExecution(id);
    expect(diagnosis.hint).toBeNull();
    const page = await client.listHistory({});
    expect(parseHistoryPage(JSON.parse(JSON.stringify(page))).executions.length).toBeGreaterThan(0);
  });

  it("keeps the same caller policy as the UI: denied callers get 401/404, never data", async () => {
    const key = "sdk-client-denied-001";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
    const authed = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(new Request(url, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }), {
        ...bindings,
      })) as typeof fetch;
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl: authed, pollMs: 0 });
    await client.submitExecution({ saga: "hello", input: { name: "Bo" }, key, wait: false });
    await instance.waitForStatus("complete");
    // No token: 401 UNAUTHORIZED.
    const anonFetch = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(new Request(url, init ?? {}), { ...bindings })) as typeof fetch;
    const anon = createSdkClient({ base: "http://local.test", token: "wrong-token", fetchImpl: anonFetch });
    await expect(anon.getExecution(id)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Foreign owner with a valid token shape: 404 EXECUTION_NOT_FOUND, never a leak.
    const foreignFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = authHeaders(init?.headers as Record<string, string>);
      return worker.fetch(new Request(url, { ...(init ?? {}), headers }), {
        ...bindings,
        LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
      });
    }) as typeof fetch;
    const foreign = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl: foreignFetch });
    await expect(foreign.getExecution(id)).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    const error = await foreign.getExecution(id).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SdkError);
    expect((await parseSdkError(new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "No." } }), { status: 403 }))).code).toBe(
      "FORBIDDEN",
    );
  });

  it("surfaces validation and contract errors with stable codes", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(new Request(url, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }), {
        ...bindings,
      })) as typeof fetch;
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl, pollMs: 0 });
    await expect(client.inspectSaga("no-such-saga")).rejects.toMatchObject({ code: "SDK_SAGA_NOT_FOUND" });
    await expect(client.getExecution("abc")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    await expect(
      client.submitExecution({ saga: "hello", input: { name: "" }, key: "sdk-client-error-001" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.getContract()).resolves.toMatchObject({ version: SDK_VERSION });
  });
});
