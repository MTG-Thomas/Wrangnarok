// SPDX-License-Identifier: AGPL-3.0
import { echoSaga, Fault, journeyId, RECOVERY_WINDOW_MS } from "./domain";
import type { EchoInput, JourneyStatus, Principal, SafeError } from "./domain";
import type { Bindings } from "./bindings";
export interface JourneyRow {
  id: string; saga_id: string; saga_name: string; saga_revision: string;
  grove_id: string; user_id: string; input_json: string; dispatched: number;
  status: JourneyStatus; created_at: string; started_at: string | null;
  completed_at: string | null; result_json: string | null; error_json: string | null;
}
export async function visibleJourney(db: D1Database, id: string, caller: Principal): Promise<JourneyRow> {
  const row = await db.prepare("SELECT * FROM journeys WHERE id = ? AND grove_id = ? AND user_id = ?")
    .bind(id, caller.groveId, caller.userId).first<JourneyRow>();
  if (!row) throw new Fault(404, "JOURNEY_NOT_FOUND", "Journey not found.");
  return row;
}
export async function submit(env: Bindings, caller: Principal, key: string, input: EchoInput) {
  const id = await journeyId(caller, key);
  const inputJson = JSON.stringify(input);
  const inserted = await env.DB.prepare(
    "INSERT INTO journeys(id,saga_id,saga_name,saga_revision,grove_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  ).bind(id, echoSaga.id, echoSaga.name, echoSaga.revision, caller.groveId, caller.userId, inputJson, new Date().toISOString()).run();
  const row = await visibleJourney(env.DB, id, caller);
  if (row.saga_id !== echoSaga.id || row.input_json !== inputJson) {
    throw new Fault(409, "IDEMPOTENCY_CONFLICT", "This key already identifies different input.");
  }
  if (!row.dispatched) {
    if (row.saga_revision !== echoSaga.revision || Date.now() - Date.parse(row.created_at) >= RECOVERY_WINDOW_MS) {
      throw new Fault(409, "RECOVERY_EXPIRED", "Inspect the existing Journey; it must not be automatically relaunched.");
    }
    try {
      // Cloudflare createBatch skips existing retained IDs. Never parse error strings as duplicates.
      await env.ECHO_WORKFLOW.createBatch([{ id, params: { journeyId: id } }]);
      await env.DB.prepare("UPDATE journeys SET dispatched = 1 WHERE id = ?").bind(id).run();
    } catch {
      throw new Fault(503, "DISPATCH_UNCONFIRMED", "Work may have started. Retry the same request and Idempotency-Key.");
    }
  }
  return { journeyId: id, reused: inserted.meta.changes === 0, statusUrl: `/api/journeys/${id}` };
}
export async function beginOperation(db: D1Database, id: string, name: string, position: number): Promise<void> {
  await db.prepare("INSERT INTO operations(journey_id,name,position,status,started_at) VALUES (?,?,?,'Running',?) ON CONFLICT(journey_id,name) DO UPDATE SET status='Running',completed_at=NULL,result_json=NULL,error_json=NULL")
    .bind(id, name, position, new Date().toISOString()).run();
}
export async function finishOperation(db: D1Database, id: string, name: string, result: EchoInput): Promise<void> {
  await db.prepare("UPDATE operations SET status='Succeeded',completed_at=?,result_json=? WHERE journey_id=? AND name=?")
    .bind(new Date().toISOString(), JSON.stringify(result), id, name).run();
}
export async function failJourney(db: D1Database, id: string, error: SafeError): Promise<void> {
  const now = new Date().toISOString();
  const json = JSON.stringify(error);
  await db.batch([
    db.prepare("UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE journey_id=? AND status='Running'").bind(now,json,id),
    db.prepare("UPDATE journeys SET status='Failed',completed_at=?,error_json=? WHERE id=? AND status IN ('Pending','Running')").bind(now,json,id),
  ]);
}
export function summary(row: Omit<JourneyRow, "input_json" | "result_json" | "error_json">) {
  return { journeyId: row.id, sagaId: row.saga_id, sagaName: row.saga_name, sagaRevision: row.saga_revision,
    groveId: row.grove_id, userId: row.user_id, status: row.status, dispatchConfirmed: row.dispatched === 1,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at };
}
