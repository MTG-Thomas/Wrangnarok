// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170): opt-in Saga tool registry tests. Runs in real
// workerd with a real D1 binding (migrations 0001-0002 plus 0024); no vendor
// HTTP on this path. Pins the acceptance slice: explicit opt-in with stable
// identity, derived schemas, distinctive descriptions, collision-safe names,
// and identical scoping of discovery and execution (disabled/stale gone
// from both).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, helloSaga } from "../src/domain";
import { toolRegistry } from "../src/tools";
import { SAGA_CATALOG } from "../src/sagas";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration24 from "../migrations/0024_tool_enrollments.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function call(path: string, method = "GET", body?: unknown, key?: string) {
  return new Request(`http://local.test${path}`, {
    method,
    headers: headers(key ? { "Idempotency-Key": key } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration24);
  await bindings.DB.prepare("DELETE FROM tool_enrollments").run();
});

afterEach(async () => {
  await reset();
});

describe("tool enrollment (TOOL-01 opt-in)", () => {
  it("starts with an empty discovery list", async () => {
    const response = await worker.fetch(call("/api/tools"), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tools: [] });
  });

  it("enrolls with stable identity, derived name, and distinctive description", async () => {
    const response = await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      tool: { name: string; sagaId: string; sagaRevision: string; description: string };
    };
    expect(body.tool.sagaId).toBe(helloSaga.id);
    expect(body.tool.sagaRevision).toBe(helloSaga.revision);
    expect(body.tool.name).toBe(toolRegistry.toolNameFor(helloSaga.name));
    expect(body.tool.description.startsWith(`[${body.tool.name}]`)).toBe(true);
    expect(body.tool.description).toContain(helloSaga.description);
  });

  it("rejects unknown sagas, bad names, and duplicate enrollments", async () => {
    const unknown = await worker.fetch(
      call("/api/tools", "POST", { sagaId: "00000000-0000-4000-8000-000000000000" }),
      bindings,
    );
    expect(unknown.status).toBe(404);
    const badName = await worker.fetch(
      call("/api/tools", "POST", { sagaId: helloSaga.id, name: "Bad Name!" }),
      bindings,
    );
    expect(badName.status).toBe(400);
    expect(await badName.json()).toMatchObject({ error: { code: "INVALID_TOOL" } });
    const first = await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings);
    expect(first.status).toBe(201);
    const second = await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "TOOL_EXISTS" } });
    // A second Saga cannot squat the first tool's name.
    const squat = await worker.fetch(
      call("/api/tools", "POST", {
        sagaId: echoSaga.id,
        name: ((await (await worker.fetch(call("/api/tools"), bindings)).json()) as { tools: { name: string }[] })
          .tools[0]?.name,
      }),
      bindings,
    );
    expect(squat.status).toBe(409);
  });

  it("derives collision-safe names per Saga", () => {
    expect(toolRegistry.toolNameFor("hello")).toBe("hello_tool");
    expect(toolRegistry.toolNameFor("ninjaone-orgs")).toBe("ninjaone_orgs_tool");
    expect(toolRegistry.toolNameFor("Hello World!")).toBe("hello_world_tool");
    expect(toolRegistry.toolNameFor("hello")).not.toBe(toolRegistry.toolNameFor("hello-world"));
  });

  it("hides disabled enrollments from discovery and execution", async () => {
    const enrolled = (await (
      await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings)
    ).json()) as { tool: { name: string } };
    const disabled = await worker.fetch(call(`/api/tools/${enrolled.tool.name}/disable`, "POST", {}), bindings);
    expect(disabled.status).toBe(200);
    const listed = (await (await worker.fetch(call("/api/tools"), bindings)).json()) as { tools: unknown[] };
    expect(listed.tools).toEqual([]);
    const execute = await worker.fetch(
      call(`/api/tools/${enrolled.tool.name}/execute`, "POST", { input: { name: "Al" } }, "tool-disabled-exec-0001"),
      bindings,
    );
    expect(execute.status).toBe(404);
    expect(await execute.json()).toMatchObject({ error: { code: "TOOL_DISABLED" } });
  });

  it("fails stale enrollments closed at execution with TOOL_STALE", async () => {
    await bindings.DB.prepare(
      "INSERT INTO tool_enrollments(id,org_id,tool_name,saga_id,saga_revision,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)",
    )
      .bind(
        "00000000-0000-4000-8000-000000000701",
        principal.orgId,
        "stale_tool",
        helloSaga.id,
        "hello-v0",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const listed = (await (await worker.fetch(call("/api/tools"), bindings)).json()) as { tools: unknown[] };
    expect(listed.tools).toEqual([]);
    const execute = await worker.fetch(
      call("/api/tools/stale_tool/execute", "POST", { input: { name: "Al" } }, "tool-stale-exec-0001"),
      bindings,
    );
    expect(execute.status).toBe(409);
    expect(await execute.json()).toMatchObject({ error: { code: "TOOL_STALE" } });
  });

  it("scopes discovery and execution identically per organization", async () => {
    await worker.fetch(call("/api/tools", "POST", { sagaId: helloSaga.id }), bindings);
    const listed = (await (await worker.fetch(call("/api/tools"), bindings)).json()) as {
      tools: { name: string }[];
    };
    expect(listed.tools).toHaveLength(1);
    // A stranger with no membership cannot reach the route at all (401/403
    // via the membership gate), and a same-org sibling sees the same list.
    // Cross-org leakage is covered by the registry resolve tests below.
    const resolved = await toolRegistry.resolve(bindings.DB, principal, listed.tools[0]?.name ?? "", SAGA_CATALOG);
    expect(resolved.sagaId).toBe(helloSaga.id);
    const foreign = await toolRegistry
      .resolve(
        bindings.DB,
        { orgId: "00000000-0000-4000-8000-000000000004", userId: principal.userId },
        listed.tools[0]?.name ?? "",
        SAGA_CATALOG,
      )
      .then(() => null)
      .catch((error: unknown) => error);
    expect(foreign).toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("denies unauthenticated discovery and rejects query strings", async () => {
    expect((await worker.fetch(new Request("http://local.test/api/tools"), bindings)).status).toBe(401);
    expect((await worker.fetch(call("/api/tools?scope=all"), bindings)).status).toBe(400);
  });
});
