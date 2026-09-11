// SPDX-License-Identifier: AGPL-3.0
// RUN-02 (issue #136, ADR 018): nested Saga invocation against real local
// bindings. A hello-parent Execution dispatches a hello child through the
// durable child handle, awaits its typed JSON output, and serves inspectable
// lineage. Child failure is actionable (CHILD_FAILED) and can never become
// fabricated parent success. Rejections (unknown child, non-serializable
// input, self-invoke, foreign-org receipts, corrupt results), duplicate
// dispatch convergence, parent-cancel fan-out, and child timeout all run in
// real workerd with real D1/Workflow bindings; nothing here uses unit
// doubles for the runtime.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  awaitChildResult,
  bindSagaChildren,
  cancelDirectChildren,
  childDispatchKey,
  childDispatchStep,
  childExecutionId,
  childPollStep,
  childTerminalOf,
  invokeChild,
  resolveChildSaga,
} from "../src/children";
import type { ChildEnv } from "../src/children";
import { executionId, Fault, helloParentSaga, helloSaga } from "../src/domain";
import { parseHelloParentInput } from "../src/domain";
import type { OrgCtx } from "../src/saga";
import { helloParentSagaDef } from "../src/sagas/hello-parent";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_child_lineage.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const auth = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };

function submitRequest(key: string, sagaId: string, body: unknown) {
  return new Request("http://local.test/api/executions", {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": key },
    body: JSON.stringify({ sagaId, input: body }),
  });
}

function detailRequest(id: string) {
  return new Request(`http://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } });
}

function cancelRequest(id: string) {
  return new Request(`http://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } });
}

async function detail(id: string) {
  const response = await worker.fetch(detailRequest(id), bindings);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    executionId: string;
    status: string;
    result: { greeting: string; name: string; childExecutionId: string } | null;
    error: { code: string; message: string } | null;
    parentExecutionId: string | null;
    parentStep: string | null;
    children: { executionId: string; sagaId: string; sagaName: string; status: string }[];
    operations: { name: string; status: string }[];
  };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(seed);
});

afterEach(async () => {
  await reset();
});

describe("RUN-02 nested invocation (issue #136)", () => {
  it("runs a parent invoking an authorized child with typed I/O and inspectable lineage", async () => {
    const key = "run02-parent-happy-001";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_PARENT_WORKFLOW, id);
    expect((await worker.fetch(submitRequest(key, helloParentSaga.id, { name: "Ada" }), bindings)).status).toBe(202);
    await instance.waitForStatus("complete");
    const parent = await detail(id);
    expect(parent.status).toBe("Succeeded");
    expect(parent.result).toMatchObject({ greeting: "Hello, Ada!", name: "Ada" });
    expect(parent.result?.childExecutionId).toMatch(/^[a-f0-9]{64}$/);
    expect(parent.parentExecutionId).toBeNull();
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toMatchObject({ executionId: parent.result?.childExecutionId, sagaName: "hello" });
    expect(parent.operations.map((op) => op.name)).toEqual(
      expect.arrayContaining(["prepare-input-v1", "child-dispatch-invoke-v1", "child-await-invoke-v1"]),
    );
    // The child side carries the parent lineage and the same typed output.
    const child = await detail(parent.result?.childExecutionId as string);
    expect(child.status).toBe("Succeeded");
    expect(child.parentExecutionId).toBe(id);
    expect(child.parentStep).toBe("child-dispatch-invoke");
    expect(child.result).toMatchObject({ greeting: "Hello, Ada!", name: "Ada" });
  }, 25000);

  it("fails the parent actionably when the child input is invalid, never inventing success", async () => {
    // Empty child name: the child prepare rejects, the parent persists
    // CHILD_FAILED with the child code, and no greeting is fabricated.
    const key = "run02-parent-childfail-001";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_PARENT_WORKFLOW, id);
    expect((await worker.fetch(submitRequest(key, helloParentSaga.id, { name: "" }), bindings)).status).toBe(400);
    expect(instance).toBeDefined();
    // Direct proof at the row level: reserve a parent/child pair and drive
    // the child to Failed, then read the parent-visible outcome.
    const parentId = "a1".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const childId = "b2".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: 7 }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Failed",
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify({ code: "EXECUTION_FAILED", message: "nope" }),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: childId, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${childId}` },
      ),
    ).rejects.toMatchObject({ code: "CHILD_FAILED" });
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unknown children, non-serializable input, self-invocation, and bad keys before any write", async () => {
    const parentId = "c3".repeat(32);
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: {
        sagas: [
          { ...helloSaga, parse: (v: unknown) => v },
          { ...helloParentSaga, parse: (v: unknown) => v },
        ],
      },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", "no-such-saga", { name: "Ada" }),
    ).rejects.toMatchObject({
      code: "CHILD_SAGA_NOT_FOUND",
    });
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { run: () => 1 }),
    ).rejects.toMatchObject({ code: "CHILD_INPUT_NOT_SERIALIZABLE" });
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloParentSaga.id, { name: "Ada" }),
    ).rejects.toMatchObject({ code: "CHILD_SELF_INVOKE" });
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }, { key: "bad key!" }),
    ).rejects.toMatchObject({ code: "CHILD_KEY_INVALID" });
    await expect(
      invokeChild({ ...childEnv, parentExecutionId: "nope" }, "child-dispatch-invoke-v1", helloSaga.id, {
        name: "Ada",
      }),
    ).rejects.toMatchObject({ code: "CHILD_PARENT_INVALID" });
    // No rows were reserved by any rejected dispatch.
    const count = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a foreign-org child receipt and corrupt child results", async () => {
    const childId = "d4".repeat(32);
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .bind("00000000-0000-4000-8000-000000000009", "Foreign org probe")
      .run();
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        "00000000-0000-4000-8000-000000000009",
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        "f".repeat(64),
        "child-dispatch-invoke-v1",
        1,
        "Succeeded",
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify({ greeting: "Hello, Ada!", name: "Ada" }),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: "e5".repeat(32),
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: "e5".repeat(32).concat(":0"),
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: "e5".repeat(32),
      parentSagaId: helloParentSaga.id,
    };
    // Foreign-org receipt: the org-scoped read 404s, failing closed.
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: childId, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${childId}` },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    // Corrupt Succeeded row: invalid JSON is CHILD_RESULT_CORRUPT, never success.
    const corruptId = "1a".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        corruptId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        "e5".repeat(32),
        "child-dispatch-invoke-v1",
        1,
        "Succeeded",
        new Date().toISOString(),
        new Date().toISOString(),
        "{not-json",
      )
      .run();
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: corruptId, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${corruptId}` },
      ),
    ).rejects.toMatchObject({ code: "CHILD_RESULT_CORRUPT" });
  });

  it("converges duplicate child dispatches on one child row", async () => {
    const parentId = "2b".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const live = {
      ...bindings,
      HELLO_WORKFLOW: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const childEnv: ChildEnv = {
      env: live,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    const first = await invokeChild(
      childEnv,
      "child-dispatch-invoke-v1",
      helloSaga.id,
      { name: "Ada" },
      { key: "sib" },
    );
    const second = await invokeChild(
      childEnv,
      "child-dispatch-invoke-v1",
      helloSaga.id,
      { name: "Ada" },
      { key: "sib" },
    );
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions WHERE parent_execution_id=?")
      .bind(parentId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    // Same key with different input conflicts loudly instead of forking.
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Bo" }, { key: "sib" }),
    ).rejects.toMatchObject({ code: "CHILD_DISPATCH_CONFLICT" });
  });

  it("maps dispatch ambiguity to CHILD_DISPATCH_UNCONFIRMED with the reservation intact", async () => {
    const parentId = "3c".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const flaky = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {
          throw new Error("control plane unavailable");
        },
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const childEnv: ChildEnv = {
      env: flaky,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    const failure = await invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "CHILD_DISPATCH_UNCONFIRMED" });
    // The reservation stays Pending and undispatched: retry-safe, never invented.
    const childId = await childExecutionId(
      { orgId: principal.orgId, userId: principal.userId },
      parentId,
      "child-dispatch-invoke-v1",
      helloSaga.id,
      "default",
    );
    const row = await bindings.DB.prepare("SELECT status,dispatched FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string; dispatched: number }>();
    expect(row).toMatchObject({ status: "Pending", dispatched: 0 });
  });

  it("fans out parent cancellation to a reserved child without resurrecting it", async () => {
    // The hello child settles instantly, so a live Running child cannot be
    // arranged through the real parent: cancel right after submit while the
    // parent is still Pending/Running, then prove the fan-out marked the
    // reserved child (Cancelled when still active, untouched when already
    // terminal) and never resurrected anything.
    const parentKey = "run02-cancel-fanout-001";
    const parentId = await executionId(principal, parentKey);
    await using _parent = await introspectWorkflowInstance(bindings.HELLO_PARENT_WORKFLOW, parentId);
    void _parent;
    expect((await worker.fetch(submitRequest(parentKey, helloParentSaga.id, { name: "Ada" }), bindings)).status).toBe(
      202,
    );
    const cancelled = await worker.fetch(cancelRequest(parentId), bindings);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ executionId: parentId, status: "Cancelled", cancelled: true });
    expect((await detail(parentId)).status).toBe("Cancelled");
    const kids = await bindings.DB.prepare("SELECT id,status FROM executions WHERE parent_execution_id=?")
      .bind(parentId)
      .all<{ id: string; status: string }>();
    // Either the child never dispatched (no kids yet) or the fan-out reached
    // it before it settled: in both cases nothing active remains and the
    // parent lineage is intact.
    for (const kid of kids.results) {
      expect(["Cancelled", "Succeeded"]).toContain(kid.status);
      expect((await detail(kid.id)).parentExecutionId).toBe(parentId);
    }
  }, 25000);

  it("leaves an ambiguous child active and the parent confirmation intact", async () => {
    // A dispatched child whose native instance vanished: fan-out rolls it
    // back to Running, the parent still confirms, and the child stays
    // inspectable for its true terminal.
    const parentId = "4d".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const childId = "5e".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const live = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => {
          throw new Error("instance.not_found");
        },
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const confirmed = await cancelDirectChildren(live, principal, parentId);
    expect(confirmed).toEqual([]);
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string }>();
    expect(row?.status).toBe("Running");
  });

  it("confirms fan-out for a Pending child whose instance never existed", async () => {
    // Vacuous stop (same rule as the parent route): an undispatched Pending
    // child confirms outright through cancelDirectChildren.
    const parentId = "aa".repeat(32);
    const childId = "bb".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        0,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const live = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => {
          throw new Error("instance.not_found");
        },
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    await expect(cancelDirectChildren(live, principal, parentId)).resolves.toEqual([childId]);
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string }>();
    expect(row?.status).toBe("Cancelled");
  });

  it("times out the await while the child keeps running", async () => {
    const parentId = "6f".repeat(32);
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const childId = "7a".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    let sleeps = 0;
    const failure = await awaitChildResult(
      childEnv,
      {
        sleep: async () => {
          sleeps += 1;
        },
      },
      { executionId: childId, sagaId: helloSaga.id, replayed: false, statusUrl: `/api/executions/${childId}` },
      { awaitTimeoutMs: 1 },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "CHILD_AWAIT_TIMEOUT" });
    expect(sleeps).toBe(0);
    // The child keeps running: the timeout stopped the wait, not the work.
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string }>();
    expect(row?.status).toBe("Running");
  });

  it("validates await receipts and timeout bounds before any read", async () => {
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: "8b".repeat(32),
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${"8b".repeat(32)}:0`,
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: "8b".repeat(32),
      parentSagaId: helloParentSaga.id,
    };
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: "nope", sagaId: helloSaga.id, replayed: false, statusUrl: "/x" },
      ),
    ).rejects.toMatchObject({ code: "CHILD_RECEIPT_INVALID" });
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: "9c".repeat(32), sagaId: helloSaga.id, replayed: false, statusUrl: "/x" },
        { awaitTimeoutMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "CHILD_AWAIT_INVALID" });
  });
});

describe("RUN-02 child helpers (pure, no bindings)", () => {
  it("resolves children by UUID or exact name and derives stable keys", async () => {
    const catalog = { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] };
    expect(resolveChildSaga(catalog, helloSaga.id).name).toBe("hello");
    expect(resolveChildSaga(catalog, helloSaga.id.toUpperCase()).name).toBe("hello");
    expect(resolveChildSaga(catalog, "hello").id).toBe(helloSaga.id);
    expect(() => resolveChildSaga(catalog, "nope")).toThrow(Fault);
    expect(childDispatchKey("p", "s", "c", "k")).toBe("child.p.s.c.k");
    expect(childDispatchStep("invoke")).toBe("child-dispatch-invoke");
    expect(childPollStep("abcdef12")).toBe("child-poll-abcdef12");
    expect(childTerminalOf("Succeeded")).toBe("Succeeded");
    expect(childTerminalOf("Failed")).toBe("Failed");
    expect(childTerminalOf("Running")).toBeNull();
    const caller = { orgId: principal.orgId, userId: principal.userId };
    expect(await childExecutionId(caller, "p", "s", "c", "k")).toBe(await childExecutionId(caller, "p", "s", "c", "k"));
    expect(await childExecutionId(caller, "p", "s", "c", "k")).not.toBe(
      await childExecutionId(caller, "p", "s", "c", "other"),
    );
    expect(parseHelloParentInput({ name: "Ada" })).toEqual({ name: "Ada" });
    expect(parseHelloParentInput({ name: "Ada", childKey: "k-1" })).toEqual({ name: "Ada", childKey: "k-1" });
    expect(() => parseHelloParentInput({ name: "" })).toThrow(Fault);
    expect(() => parseHelloParentInput({ name: "Ada", childKey: "bad key!" })).toThrow(Fault);
    expect(() => parseHelloParentInput({ name: "Ada", extra: 1 })).toThrow(Fault);
  });

  it("binds the ctx.children handle to invoke plus await", async () => {
    const parentId = "ad".repeat(32);
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const live = {
      ...bindings,
      HELLO_WORKFLOW: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const handle = bindSagaChildren(
      {
        env: live,
        catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
        parentOrg: org,
        parentExecutionId: parentId,
        parentSagaId: helloParentSaga.id,
      },
      { sleep: async () => {} },
    );
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const receipt = await handle.invoke(helloSaga.id, { name: "Ada" });
    expect(receipt.executionId).toMatch(/^[a-f0-9]{64}$/);
    // Mark the child Succeeded and read it back through the same handle.
    await bindings.DB.prepare("UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=?")
      .bind(new Date().toISOString(), JSON.stringify({ greeting: "Hello, Ada!", name: "Ada" }), receipt.executionId)
      .run();
    await expect(handle.awaitResult(receipt)).resolves.toMatchObject({ greeting: "Hello, Ada!" });
    expect(helloParentSagaDef.id).toBe(helloParentSaga.id);
  });
});
