// SPDX-License-Identifier: AGPL-3.0
import { digestSaga, Fault, executionId, ninjaSaga, RECOVERY_WINDOW_MS, smokeSaga } from "./domain";
import type { ExecutionStatus, Principal, SafeError, SagaDef } from "./domain";
import type { Bindings } from "./bindings";
export interface ExecutionRow {
  id: string;
  saga_id: string;
  saga_name: string;
  saga_revision: string;
  org_id: string;
  user_id: string;
  input_json: string;
  dispatched: number;
  status: ExecutionStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result_json: string | null;
  error_json: string | null;
}
export async function visibleExecution(db: D1Database, id: string, caller: Principal): Promise<ExecutionRow> {
  const row = await db
    .prepare("SELECT * FROM executions WHERE id = ? AND org_id = ? AND user_id = ?")
    .bind(id, caller.orgId, caller.userId)
    .first<ExecutionRow>();
  if (!row) throw new Fault(404, "EXECUTION_NOT_FOUND", "Execution not found.");
  return row;
}
/** One native Workflow binding per Saga. Never inferred from the request. */
export function workflowForSaga(env: Bindings, sagaId: string): Workflow<{ executionId: string }> {
  if (sagaId === ninjaSaga.id) return env.NINJA_WORKFLOW;
  if (sagaId === digestSaga.id) return env.DIGEST_WORKFLOW;
  if (sagaId === smokeSaga.id) return env.SMOKE_WORKFLOW;
  return env.ECHO_WORKFLOW;
}
export async function submit(env: Bindings, caller: Principal, key: string, saga: SagaDef, input: unknown) {
  // Canonical per ADR 001 (reconciled #15): deterministic SHA execution ID
  // scoped to (org, user, key); required Idempotency-Key; createBatch
  // retained-ID dedup + dispatched marker; 15-min same-revision retry gate;
  // Pending never auto-swept; caller-driven retry on 503.
  const id = await executionId(caller, key);
  const inputJson = JSON.stringify(input);
  const inserted = await env.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, saga.id, saga.name, saga.revision, caller.orgId, caller.userId, inputJson, new Date().toISOString())
    .run();
  const row = await visibleExecution(env.DB, id, caller);
  if (row.saga_id !== saga.id || row.input_json !== inputJson) {
    throw new Fault(409, "IDEMPOTENCY_CONFLICT", "This key already identifies different input.");
  }
  // A cancelled Execution never dispatches (again): the row stays as the
  // durable receipt, and the caller must submit a fresh Idempotency-Key.
  if (row.status === "Cancelling" || row.status === "Cancelled") {
    throw new Fault(409, "EXECUTION_CANCELLED", "This Execution was cancelled and will not dispatch.");
  }
  if (!row.dispatched) {
    // Same-revision + 15-min refusal window (ADR 001 #15): never auto-fail
    // Pending, never resurrect after the window, never invent success.
    if (row.saga_revision !== saga.revision || Date.now() - Date.parse(row.created_at) >= RECOVERY_WINDOW_MS) {
      throw new Fault(
        409,
        "RECOVERY_EXPIRED",
        "Inspect the existing Execution; it must not be automatically relaunched.",
      );
    }
    // One native Workflow binding per Saga. Never inferred from the request.
    const workflow = workflowForSaga(env, saga.id);
    try {
      // Cloudflare createBatch skips existing retained IDs. Never parse error strings as duplicates.
      await workflow.createBatch([{ id, params: { executionId: id } }]);
      await env.DB.prepare("UPDATE executions SET dispatched = 1 WHERE id = ?").bind(id).run();
    } catch {
      throw new Fault(
        503,
        "DISPATCH_UNCONFIRMED",
        "Work may have started. Retry the same request and Idempotency-Key.",
      );
    }
  }
  return { executionId: id, replayed: inserted.meta.changes === 0, statusUrl: `/api/executions/${id}` };
}
export async function beginOperation(db: D1Database, id: string, name: string, position: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO operations(execution_id,name,position,status,started_at) VALUES (?,?,?,'Running',?) ON CONFLICT(execution_id,name) DO UPDATE SET status='Running',completed_at=NULL,result_json=NULL,error_json=NULL",
    )
    .bind(id, name, position, new Date().toISOString())
    .run();
}
export async function finishOperation(db: D1Database, id: string, name: string, result: unknown): Promise<void> {
  await db
    .prepare("UPDATE operations SET status='Succeeded',completed_at=?,result_json=? WHERE execution_id=? AND name=?")
    .bind(new Date().toISOString(), JSON.stringify(result), id, name)
    .run();
}
export async function failExecution(
  db: D1Database,
  id: string,
  error: SafeError,
  status: "Failed" | "TimedOut" = "Failed",
): Promise<void> {
  // Terminal checkpoints only: conditional on still being Pending/Running so
  // a late checkpoint can never overwrite Cancelled (or another terminal).
  // TimedOut is written exclusively by the explicit timeout-mark-v1 step, and
  // Failed exclusively by persist-failure-v1. Operation rows stay within
  // ('Running','Succeeded','Failed'); the timeout code lives in error_json.
  const now = new Date().toISOString();
  const json = JSON.stringify(error);
  await db.batch([
    db
      .prepare(
        "UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE execution_id=? AND status='Running'",
      )
      .bind(now, json, id),
    db
      .prepare(
        "UPDATE executions SET status=?,completed_at=?,error_json=? WHERE id=? AND status IN ('Pending','Running')",
      )
      .bind(status, now, json, id),
  ]);
}
export async function cancelExecution(db: D1Database, id: string): Promise<void> {
  // Second half of Running/Pending -> Cancelling -> Cancelled. Conditional on
  // still being Cancelling so a concurrent terminal checkpoint wins instead
  // of being overwritten here.
  const now = new Date().toISOString();
  const json = JSON.stringify({ code: "EXECUTION_CANCELLED", message: "The Execution was cancelled by its owner." });
  await db.batch([
    db
      .prepare(
        "UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE execution_id=? AND status='Running'",
      )
      .bind(now, json, id),
    db
      .prepare(
        "UPDATE executions SET status='Cancelled',completed_at=?,error_json=? WHERE id=? AND status='Cancelling'",
      )
      .bind(now, json, id),
  ]);
}
export function summary(row: Omit<ExecutionRow, "input_json" | "result_json" | "error_json">) {
  return {
    executionId: row.id,
    sagaId: row.saga_id,
    sagaName: row.saga_name,
    sagaRevision: row.saga_revision,
    orgId: row.org_id,
    userId: row.user_id,
    status: row.status,
    dispatchConfirmed: row.dispatched === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
