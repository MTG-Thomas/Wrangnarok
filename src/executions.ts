// SPDX-License-Identifier: AGPL-3.0
import { echoSaga, Fault, executionId, RECOVERY_WINDOW_MS } from "./domain";
import type { EchoInput, ExecutionStatus, Principal, SafeError } from "./domain";
import type { Bindings } from "./bindings";
export interface ExecutionRow {
  id: string; saga_id: string; saga_name: string; saga_revision: string;
  org_id: string; user_id: string; input_json: string; dispatched: number;
  status: ExecutionStatus; created_at: string; started_at: string | null;
  completed_at: string | null; result_json: string | null; error_json: string | null;
}
export async function visibleExecution(db: D1Database, id: string, caller: Principal): Promise<ExecutionRow> {
  const row = await db.prepare("SELECT * FROM executions WHERE id = ? AND org_id = ? AND user_id = ?")
    .bind(id, caller.orgId, caller.userId).first<ExecutionRow>();
  if (!row) throw new Fault(404, "EXECUTION_NOT_FOUND", "Execution not found.");
  return row;
}
export async function submit(env: Bindings, caller: Principal, key: string, input: EchoInput) {
  const id = await executionId(caller, key);
  const inputJson = JSON.stringify(input);
  const inserted = await env.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  ).bind(id, echoSaga.id, echoSaga.name, echoSaga.revision, caller.orgId, caller.userId, inputJson, new Date().toISOString()).run();
  const row = await visibleExecution(env.DB, id, caller);
  if (row.saga_id !== echoSaga.id || row.input_json !== inputJson) {
    throw new Fault(409, "IDEMPOTENCY_CONFLICT", "This key already identifies different input.");
  }
  if (!row.dispatched) {
    if (row.saga_revision !== echoSaga.revision || Date.now() - Date.parse(row.created_at) >= RECOVERY_WINDOW_MS) {
      throw new Fault(409, "RECOVERY_EXPIRED", "Inspect the existing Execution; it must not be automatically relaunched.");
    }
    try {
      // Cloudflare createBatch skips existing retained IDs. Never parse error strings as duplicates.
      await env.ECHO_WORKFLOW.createBatch([{ id, params: { executionId: id } }]);
      await env.DB.prepare("UPDATE executions SET dispatched = 1 WHERE id = ?").bind(id).run();
    } catch {
      throw new Fault(503, "DISPATCH_UNCONFIRMED", "Work may have started. Retry the same request and Idempotency-Key.");
    }
  }
  return { executionId: id, reused: inserted.meta.changes === 0, statusUrl: `/api/executions/${id}` };
}
export async function beginOperation(db: D1Database, id: string, name: string, position: number): Promise<void> {
  await db.prepare("INSERT INTO operations(execution_id,name,position,status,started_at) VALUES (?,?,?,'Running',?) ON CONFLICT(execution_id,name) DO UPDATE SET status='Running',completed_at=NULL,result_json=NULL,error_json=NULL")
    .bind(id, name, position, new Date().toISOString()).run();
}
export async function finishOperation(db: D1Database, id: string, name: string, result: EchoInput): Promise<void> {
  await db.prepare("UPDATE operations SET status='Succeeded',completed_at=?,result_json=? WHERE execution_id=? AND name=?")
    .bind(new Date().toISOString(), JSON.stringify(result), id, name).run();
}
export async function failExecution(db: D1Database, id: string, error: SafeError): Promise<void> {
  const now = new Date().toISOString();
  const json = JSON.stringify(error);
  await db.batch([
    db.prepare("UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE execution_id=? AND status='Running'").bind(now,json,id),
    db.prepare("UPDATE executions SET status='Failed',completed_at=?,error_json=? WHERE id=? AND status IN ('Pending','Running')").bind(now,json,id),
  ]);
}
export function summary(row: Omit<ExecutionRow, "input_json" | "result_json" | "error_json">) {
  return { executionId: row.id, sagaId: row.saga_id, sagaName: row.saga_name, sagaRevision: row.saga_revision,
    orgId: row.org_id, userId: row.user_id, status: row.status, dispatchConfirmed: row.dispatched === 1,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at };
}
