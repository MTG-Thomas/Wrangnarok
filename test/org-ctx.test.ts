// SPDX-License-Identifier: AGPL-3.0
// Phase 1b (ADR 010): OrgCtx construction plus the Cancelling lost-terminal
// race. Runs in real workerd with a real D1 binding; drives the terminal
// checkpoints directly so both race orders are deterministic (no timing).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { echoSaga } from "../src/domain";
import { buildOrgCtx } from "../src/saga";
import { cancelExecution, failExecution } from "../src/executions";
import type { ExecutionRow } from "../src/executions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

async function insertExecution(id: string, status: string): Promise<void> {
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      orgId,
      userId,
      JSON.stringify({ message: "hello" }),
      1,
      status,
      new Date().toISOString(),
    )
    .run();
}

async function statusOf(id: string): Promise<string> {
  const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
    .bind(id)
    .first<{ status: string }>();
  if (!row) throw new Error(`missing execution ${id}`);
  return row.status;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
});
afterEach(async () => {
  await reset();
});

it("builds OrgCtx from the D1 row, never from caller input", async () => {
  const id = "c".repeat(64);
  await insertExecution(id, "Pending");
  const row = await bindings.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
  if (!row) throw new Error("missing execution");
  const ctx = buildOrgCtx(row, "prepare-input-v1");
  expect(ctx).toMatchObject({
    orgId,
    userId,
    executionId: id,
    sagaId: echoSaga.id,
    sagaRevision: echoSaga.revision,
    operationId: "prepare-input-v1",
    attemptToken: `${id}:1`,
  });
});

it("lets a racing terminal checkpoint win as Failed once Cancelling", async () => {
  const id = "d".repeat(64);
  await insertExecution(id, "Cancelling");
  await failExecution(bindings.DB, id, { code: "ECHO_INTEGRATION_FAILED", message: "lost race" });
  expect(await statusOf(id)).toBe("Failed");
  // The cancel marker arrives late and must no-op: terminal stays Failed.
  await cancelExecution(bindings.DB, id);
  expect(await statusOf(id)).toBe("Failed");
});

it("keeps Cancelled against a late terminal checkpoint", async () => {
  const id = "e".repeat(64);
  await insertExecution(id, "Cancelling");
  await cancelExecution(bindings.DB, id);
  expect(await statusOf(id)).toBe("Cancelled");
  // Late checkpoint after cancellation matches no row: no overwrite.
  await failExecution(bindings.DB, id, { code: "ECHO_INTEGRATION_FAILED", message: "late" });
  expect(await statusOf(id)).toBe("Cancelled");
});
