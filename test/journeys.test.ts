import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, journeyId } from "../src/domain";
import migration from "../migrations/0001_initial.sql?raw";
import seed from "../scripts/seed-local.sql?raw";
const bindings = env as unknown as Bindings;
const principal = { groveId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const key = "first-acorn-test-001";
function request(path: string, method = "GET", message = "hello") {
  return new Request(`http://local.test${path}`, { method,
    headers: { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json", "Idempotency-Key": key },
    ...(method === "POST" ? { body: JSON.stringify({ sagaId: echoSaga.id, input: { message } }) } : {}),
  });
}
beforeEach(async () => {
  // These are real local D1 SQL statements, not an in-memory repository double.
  await bindings.DB.exec(migration);
  await bindings.DB.exec(seed);
  // Intercept only outbound vendor HTTP. Native D1/Workflow bindings are never replaced.
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
it("traverses HTTP -> D1 -> Workflow -> HTTP Realm -> D1, and reuses a submission", async () => {
  const id = await journeyId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  const accepted = await worker.fetch(request("/api/journeys", "POST"), bindings);
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("Location")).toBe(`/api/journeys/${id}`);
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(request(`/api/journeys/${id}`), bindings);
  expect(await detail.json()).toMatchObject({ journeyId: id, status: "Succeeded", result: { message: "hello" },
    operations: [{ name: "prepare-input-v1", status: "Succeeded" }, { name: "echo-http-v1", status: "Succeeded" }] });
  expect((await worker.fetch(request("/api/journeys", "POST"), bindings)).status).toBe(202);
  expect((await worker.fetch(request("/api/journeys", "POST", "changed"), bindings)).status).toBe(409);
  expect((await worker.fetch(request(`/api/journeys/${id}`), { ...bindings, LAB_USER_ID: "00000000-0000-4000-8000-000000000003" })).status).toBe(404);
  expect((await worker.fetch(request(`/api/journeys/${id}`), { ...bindings, LAB_GROVE_ID: "00000000-0000-4000-8000-000000000004" })).status).toBe(404);
  const history = await worker.fetch(request("/api/journeys"), bindings);
  const text = await history.text();
  expect(text).not.toContain('"input"');
  expect(text).not.toContain('"result"');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("persists structured failure without copying the vendor error body", async () => {
  const id = await journeyId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  vi.mocked(fetch).mockResolvedValue(new Response("private-vendor-diagnostic", { status: 503 }));
  expect((await worker.fetch(request("/api/journeys", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/journeys/${id}`), bindings);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ status: "Failed", error: { code: "ECHO_REALM_FAILED" } });
  expect(text).not.toContain("private-vendor-diagnostic");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("denies unauthenticated requests and stays disabled by default", async () => {
  expect((await worker.fetch(new Request("http://local.test/api/journeys"), bindings)).status).toBe(401);
  expect((await worker.fetch(request("/api/journeys"), { ...bindings, LAB_ENABLED: "false" })).status).toBe(404);
});

it("does not resolve another Grove's Connection when this Grove has none", async () => {
  await bindings.DB.prepare("DELETE FROM connections WHERE grove_id=?").bind(principal.groveId).run();
  await bindings.DB.prepare("INSERT INTO groves(id,name) VALUES ('other-grove','Other')").run();
  await bindings.DB.prepare("INSERT INTO connections(id,grove_id,realm_id,endpoint) VALUES ('other','other-grove','720b9ebf-9b6a-4eac-bae9-6ed22c970402','http://127.0.0.1:8788/echo')").run();
  const id = await journeyId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  expect((await worker.fetch(request("/api/journeys", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/journeys/${id}`), bindings);
  expect(await response.json()).toMatchObject({ status: "Failed", error: { code: "CONNECTION_NOT_CONFIGURED" } });
  expect(fetch).not.toHaveBeenCalled();
});
