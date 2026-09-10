// SPDX-License-Identifier: AGPL-3.0
import { authenticate } from "./auth";
import type { Bindings } from "./bindings";
import { boundedJson, canTransition, echoSaga, Fault, ninjaSaga, parseKey, parseSubmission, smokeSaga } from "./domain";
import { cancelExecution, submit, summary, visibleExecution, workflowForSaga } from "./executions";
import type { ExecutionRow } from "./executions";
export { EchoWorkflow, NinjaOrgsWorkflow, SmokeWorkflow } from "./sagas";

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    // Single-Worker full-stack app (ADR 008): the browser UI ships as Static
    // Assets and needs no auth; only /api/* is authenticated JSON.
    if (!url.pathname.startsWith("/api/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
    try {
      const caller = await authenticate(request, env);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported by this slice.");
      if (url.pathname === "/api/sagas" && request.method === "GET")
        return json({ sagas: [echoSaga, ninjaSaga, smokeSaga] });
      if (url.pathname === "/api/executions" && request.method === "POST") {
        const key = parseKey(request.headers.get("Idempotency-Key"));
        if (
          request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
          request.headers.has("Content-Encoding")
        )
          throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
        const { saga, input } = parseSubmission(await boundedJson(request.body));
        const accepted = await submit(env, caller, key, saga, input);
        // Canonical replay: first submit 202, same-key same-input replay 200 + replayed:true (ADR 001 #15).
        return json(accepted, accepted.replayed ? 200 : 202, { Location: accepted.statusUrl });
      }
      if (url.pathname === "/api/executions" && request.method === "GET") {
        // Deliberately small first page. Never claim this is complete history when more rows exist.
        const rows = await env.DB.prepare(
          "SELECT id,saga_id,saga_name,saga_revision,org_id,user_id,dispatched,status,created_at,started_at,completed_at FROM executions WHERE org_id=? AND user_id=? ORDER BY created_at DESC,id DESC LIMIT 21",
        )
          .bind(caller.orgId, caller.userId)
          .all<Omit<ExecutionRow, "input_json" | "result_json" | "error_json">>();
        return json({ executions: rows.results.slice(0, 20).map(summary), hasMore: rows.results.length > 20 });
      }
      const cancel = /^\/api\/executions\/([a-f0-9]{64})\/cancel$/.exec(url.pathname);
      if (cancel?.[1] && request.method === "POST") {
        // Owner-only cancellation (issue #16): same fixture auth plus the
        // same org/requester scoping as reads — foreign owners get 404, never
        // a leak. Pending cancels immediately; Running moves
        // Running -> Cancelling -> Cancelled onto the native terminate
        // control. Re-cancel while Cancelling is idempotent; terminal states
        // answer 409 and are never rewritten.
        const row = await visibleExecution(env.DB, cancel[1], caller);
        if (!canTransition(row.status, "Cancelling")) {
          throw new Fault(409, "EXECUTION_NOT_CANCELLABLE", "Terminal Executions cannot be cancelled.");
        }
        if (row.status === "Cancelling") {
          return json({ executionId: row.id, status: "Cancelling", cancelled: false });
        }
        const marked = await env.DB.prepare(
          "UPDATE executions SET status='Cancelling' WHERE id=? AND status IN ('Pending','Running')",
        )
          .bind(row.id)
          .run();
        if (marked.meta.changes === 0) {
          const current = await visibleExecution(env.DB, row.id, caller);
          if (current.status === "Cancelling") {
            return json({ executionId: row.id, status: "Cancelling", cancelled: false });
          }
          throw new Fault(409, "EXECUTION_NOT_CANCELLABLE", "Terminal Executions cannot be cancelled.");
        }
        const binding = workflowForSaga(env, row.saga_id);
        try {
          await (await binding.get(row.id)).terminate();
        } catch {
          // Already settled natively (complete/errored/terminated): the D1
          // marker below still applies, fenced by its Cancelling condition.
        }
        await cancelExecution(env.DB, row.id);
        return json({ executionId: row.id, status: "Cancelled", cancelled: true });
      }
      const match = /^\/api\/executions\/([a-f0-9]{64})$/.exec(url.pathname);
      if (match?.[1] && request.method === "GET") {
        const row = await visibleExecution(env.DB, match[1], caller);
        const operations = await env.DB.prepare(
          "SELECT name,status,started_at,completed_at,result_json,error_json FROM operations WHERE execution_id=? ORDER BY position,name",
        )
          .bind(row.id)
          .all<{
            name: string;
            status: string;
            started_at: string;
            completed_at: string | null;
            result_json: string | null;
            error_json: string | null;
          }>();
        let runtimeStatus: string | null = null;
        try {
          const binding = workflowForSaga(env, row.saga_id);
          runtimeStatus = (await (await binding.get(row.id)).status()).status;
        } catch {
          /* Unavailable or expired, not proof of failure. */
        }
        return json({
          ...summary(row),
          runtimeStatus,
          input: JSON.parse(row.input_json),
          result: row.result_json ? JSON.parse(row.result_json) : null,
          error: row.error_json ? JSON.parse(row.error_json) : null,
          operations: operations.results.map((op) => ({
            name: op.name,
            status: op.status,
            startedAt: op.started_at,
            completedAt: op.completed_at,
            result: op.result_json ? JSON.parse(op.result_json) : null,
            error: op.error_json ? JSON.parse(op.error_json) : null,
          })),
        });
      }
      // Gray-out is server-enforced: mapped /api/* routes serve, every other
      // /api/* path reports UNIMPLEMENTED (never a generic NOT_FOUND).
      return json(
        { error: { code: "UNIMPLEMENTED", message: "This API surface is not implemented in this slice." } },
        501,
      );
    } catch (error) {
      const fault =
        error instanceof Fault ? error : new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
      const headers: Record<string, string> = {};
      if (fault.status === 401) headers["WWW-Authenticate"] = "Bearer";
      if (fault.status === 503) headers["Retry-After"] = "5";
      return json({ error: { code: fault.code, message: fault.message } }, fault.status, headers);
    }
  },
} satisfies ExportedHandler<Bindings>;
