// SPDX-License-Identifier: AGPL-3.0
import { authenticate } from "./auth";
import type { Bindings } from "./bindings";
import {
  appDetail,
  createApp,
  deleteApp,
  editAppSource,
  jobDetail,
  listApps,
  listJobs,
  parseAppBody,
  parseAppId,
  parseSwapBody,
  serveAsset,
  startBuild,
  swapSlugs,
  validateApp,
} from "./apps";
import {
  APP_SDK_VERSION,
  createAppGrant,
  declareAppFile,
  declareAppTable,
  deleteAppFile,
  deleteTableRow,
  describeAppHandshake,
  insertTableRow,
  issueFileToken,
  listAppExecutions,
  listAppGrants,
  listDeclaredTables,
  listRuntimeFiles,
  listRuntimeTables,
  loadRuntimeApp,
  parseTableQuery,
  patchTableRow,
  readTableRows,
  recordAppExecution,
  redeemFileDownload,
  redeemFileUpload,
  requireAppGrant,
  revokeAppGrant,
} from "./app-runtime";
import { previewEnvironment, previewLocal } from "./dev";
import {
  boundedJson,
  canTransition,
  classifyTerminateError,
  digestSaga,
  echoSaga,
  Fault,
  helloSaga,
  ninjaSaga,
  object,
  parseDigestInput,
  parseHelloInput,
  parseHistoryQuery,
  parseInput,
  parseKey,
  parseNinjaOrgsInput,
  parseSmokeInput,
  parseSubmission,
  smokeSaga,
} from "./domain";
import type { TerminateOutcome } from "./domain";
import { bindFormInput, FORM_NAME, loadForm } from "./forms";
import { SAGA_CATALOG } from "./sagas";
import { describeContract, SDK_DOC_PATH } from "./sdk";
import { cancelExecution, listHistory, submit, summary, visibleExecution, workflowForSaga } from "./executions";
import { scrubValueWithDeploymentSecrets } from "./secrets";
import { logRequest } from "./usage";
export { EchoWorkflow, HelloWorkflow, NinjaEchoDigestWorkflow, NinjaOrgsWorkflow, SmokeWorkflow } from "./sagas";

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}
/** Log route for the access log: raw /api/* pathname or "static". Query
 * strings never leave the URL object. */
function routeOf(request: Request): string {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/api/")) return "static";
  return `${request.method} ${pathname}`;
}
/** Guard for JSON write routes: unencoded application/json only, matching
 * the /api/executions submit gate. Shared by the app write routes below. */
function requireJson(request: Request): void {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers.has("Content-Encoding")
  )
    throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
}
/** Guard for query-less routes: anything after `?` is UNSUPPORTED_QUERY,
 * matching the /api/executions submit gate. Shared by the app runtime routes
 * below so the deny-by-default rule stays one line per route. */
function rejectQuery(url: URL): void {
  if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
}
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const started = Date.now();
    const response = await handleFetch(request, env);
    logRequest({
      method: request.method,
      route: routeOf(request),
      status: response.status,
      durationMs: Date.now() - started,
    });
    return response;
  },
} satisfies ExportedHandler<Bindings>;

async function handleFetch(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  // Single-Worker full-stack app (ADR 008): the browser UI ships as Static
  // Assets and needs no auth; only /api/* is authenticated JSON.
  if (!url.pathname.startsWith("/api/")) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  }
  try {
    const caller = await authenticate(request, env);
    // Query strings are deny-by-default: only the history list route, the
    // app runtime Table page read, and the version-aware file delete take
    // them, and only their allowlisted keys (anything else is UNSUPPORTED_QUERY).
    const historyList = url.pathname === "/api/executions" && request.method === "GET";
    const appTableRowsRead =
      request.method === "GET" && /^\/api\/apps\/[0-9a-f-]{36}\/runtime\/tables\/[^/]+\/rows$/.test(url.pathname);
    const appRuntimeFileDelete =
      request.method === "DELETE" && /^\/api\/apps\/[0-9a-f-]{36}\/runtime\/files\/.+$/.test(url.pathname);
    if (url.search && !(historyList || appTableRowsRead || appRuntimeFileDelete))
      throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
    if (url.pathname === "/api/sagas" && request.method === "GET")
      // Static Git-owned Catalog (ADR 002): discovery metadata only.
      // D1 Execution rows mirror saga_id/name/revision but never drive behavior.
      return json({ sagas: SAGA_CATALOG });
    if (url.pathname === SDK_DOC_PATH && request.method === "GET")
      // DEV-01 versioned SDK contract (issue #140): machine-readable
      // descriptor of the public author/automation surface. Authenticated
      // like every other /api/* route; drift is pinned by test/sdk.test.ts.
      return json(describeContract());
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
    const formDetail = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (formDetail?.[1] && request.method === "GET") {
      // Form declaration read (FORM-01): persisted fields for this
      // Organization only. Unknown or foreign names answer 404, never a leak.
      const name = formDetail[1];
      if (!FORM_NAME.test(name)) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const def = await loadForm(env.DB, caller.orgId, name);
      if (!def) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json({
        form: {
          id: def.id,
          name: def.name,
          sagaId: def.sagaId,
          fields: def.fields.map((field) => ({
            name: field.name,
            type: field.type,
            required: field.required,
            maxLength: field.maxLength,
          })),
        },
      });
    }
    const formSubmit = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})\/submit$/.exec(url.pathname);
    if (formSubmit?.[1] && request.method === "POST") {
      // Form-to-Saga binding (FORM-01): server validates the submission
      // against the persisted declaration (422 + per-field details on
      // failure), then submits the bound Saga input down the standard
      // Execution path. The submit gate is authoritative; no renderer,
      // provider, or publication behavior lives here.
      const name = formSubmit[1];
      if (!FORM_NAME.test(name)) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const key = parseKey(request.headers.get("Idempotency-Key"));
      if (
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
        request.headers.has("Content-Encoding")
      )
        throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
      const def = await loadForm(env.DB, caller.orgId, name);
      if (!def) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const { saga, input } = bindFormInput(def, await boundedJson(request.body));
      const accepted = await submit(env, caller, key, saga, input);
      // Canonical replay: first submit 202, same-key same-input replay 200 + replayed:true (ADR 001 #15).
      return json({ form: name, ...accepted }, accepted.replayed ? 200 : 202, { Location: accepted.statusUrl });
    }
    if (url.pathname === "/api/dev/preview" && request.method === "POST") {
      // DEV-02 no-registration local preview (ADR 017): read-only by
      // construction. Runs the authoritative server parse against the static
      // Git-owned Catalog with no D1 writes and no Workflow dispatch. The
      // environment section is off by default; opting in only SELECTs
      // Connection presence for the caller's own Organization (never
      // foreign rows, never secret values). Production resources are never
      // touched: this route performs no writes and no vendor calls.
      if (
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
        request.headers.has("Content-Encoding")
      )
        throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
      const body: unknown = await boundedJson(request.body);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_SUBMISSION", "Preview needs a stable Saga UUID and its input only.");
      }
      const record = body as Record<string, unknown>;
      if (Object.keys(record).some((key) => !["sagaId", "input", "checkEnvironment"].includes(key))) {
        throw new Fault(400, "INVALID_SUBMISSION", "Preview needs a stable Saga UUID and its input only.");
      }
      const parsers = new Map<string, (value: unknown) => unknown>([
        [echoSaga.id, parseInput],
        [ninjaSaga.id, parseNinjaOrgsInput],
        [digestSaga.id, parseDigestInput],
        [smokeSaga.id, parseSmokeInput],
        [helloSaga.id, parseHelloInput],
      ]);
      const { meta, parsed, requiredIntegrations } = previewLocal(SAGA_CATALOG, parsers, record.sagaId, record.input);
      const withEnv = record.checkEnvironment === true;
      if (
        record.checkEnvironment !== undefined &&
        record.checkEnvironment !== true &&
        record.checkEnvironment !== false
      ) {
        throw new Fault(400, "INVALID_SUBMISSION", "checkEnvironment must be true or omitted/false.");
      }
      const environment = withEnv ? await previewEnvironment(env.DB, caller.orgId, requiredIntegrations) : [];
      return json({
        preview: {
          saga: meta,
          input: parsed,
          environmentChecked: withEnv,
          environment,
          persisted: false,
          dispatched: false,
        },
      });
    }
    if (url.pathname === "/api/executions" && request.method === "GET") {
      // ExecutionHistory querying (Phase 2): status/sagaId filters plus
      // cursor pagination over org-scoped summaries. The parser rejects
      // unknown keys; the listing never claims completeness (hasMore).
      return json(await listHistory(env.DB, caller, parseHistoryQuery(url.searchParams)));
    }
    const cancel = /^\/api\/executions\/([a-f0-9]{64})\/cancel$/.exec(url.pathname);
    if (cancel?.[1] && request.method === "POST") {
      // Owner-only cancellation (issues #16 then #151): same fixture auth plus
      // the same org/requester scoping as reads — foreign owners get 404, never
      // a leak. The route first writes the logical marker (Pending/Running ->
      // Cancelling, conditional), then attempts the native terminate() control,
      // then CLASSIFIES the native outcome before reporting anything. A
      // confirmed stop is never reported unless one was observed (RUN-04): a
      // resolved terminate, an already-settled engine (finite state), or a
      // vacuous not-found on an undispatched Pending row all confirm; anything
      // else rolls back Cancelling to the prior active status and answers 503
      // CANCELLATION_UNCONFIRMED so the caller retries the same cancel. Only
      // Pending/Running reach the marker write (the transition gate above
      // rejects everything else, including a second cancel that lands while
      // Cancelling); terminal states answer 409 and are never rewritten. A
      // loser that races the winner re-reads below.
      const row = await visibleExecution(env.DB, cancel[1], caller);
      if (!canTransition(row.status, "Cancelling")) {
        throw new Fault(409, "EXECUTION_NOT_CANCELLABLE", "Terminal Executions cannot be cancelled.");
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
      const priorStatus = row.status;
      const priorDispatched = row.dispatched;
      const binding = workflowForSaga(env, row.saga_id);
      let terminateOutcome: TerminateOutcome = "stopped";
      try {
        await (await binding.get(row.id)).terminate();
      } catch (error) {
        terminateOutcome = classifyTerminateError(error);
      }
      // Known terminal outcomes confirm the logical cancel (ADR 001): a
      // delivered stop; an engine that already settled (complete/errored/
      // terminated — the terminal fence already guards racing checkpoints); or
      // a vacuous stop on an undispatched Pending row (dispatch was never
      // confirmed, so the native side has nothing left running).
      if (
        terminateOutcome === "stopped" ||
        terminateOutcome === "already-settled" ||
        (terminateOutcome === "not-found" && priorStatus === "Pending" && priorDispatched === 0)
      ) {
        await cancelExecution(env.DB, row.id);
        return json({ executionId: row.id, status: "Cancelled", cancelled: true });
      }
      // Ambiguous: a dispatched row whose native instance vanished, or any
      // transient/control-plane failure. No terminal or Operation writes — roll
      // back to the prior active status (a compensating write owned by this
      // route, not a product transition) so the caller can retry the same
      // cancel and the true terminal outcome can still land.
      await env.DB.prepare("UPDATE executions SET status=? WHERE id=? AND status='Cancelling'")
        .bind(priorStatus, row.id)
        .run();
      throw new Fault(
        503,
        "CANCELLATION_UNCONFIRMED",
        "Cancellation could not be confirmed. Retry the same cancel request.",
      );
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
      return json(
        scrubValueWithDeploymentSecrets(
          {
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
          },
          env,
        ),
      );
    }
    // Authored Applications (APP-01, ADR 017): independent-app lifecycle
    // (create/edit/validate/build/inspect/swap/delete) plus authorized
    // active-deployment asset serving. Solution-owned rows reject live
    // mutation with MANAGED_RESOURCE; foreign-Organization rows 404. One
    // explicit matcher per route, mirroring the executions/cancel style
    // above: boring and greppable beats a shared capture.
    if (url.pathname === "/api/apps" && request.method === "GET") {
      rejectQuery(url);
      return json({ apps: await listApps(env.DB, caller) });
    }
    if (url.pathname === "/api/apps" && request.method === "POST") {
      requireJson(request);
      const { name, slug } = parseAppBody(await boundedJson(request.body));
      return json({ app: await createApp(env.DB, caller, name, slug) }, 201);
    }
    const appBuilds = /^\/api\/apps\/([0-9a-f-]{36})\/builds$/.exec(url.pathname);
    if (appBuilds?.[1] && (request.method === "GET" || request.method === "POST")) {
      const id = parseAppId(appBuilds[1]);
      rejectQuery(url);
      if (request.method === "GET") return json({ jobs: await listJobs(env.DB, caller, id) });
      return json({ job: await startBuild(env.DB, caller, id) }, 202);
    }
    const appJob = /^\/api\/apps\/([0-9a-f-]{36})\/builds\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (appJob?.[1] && appJob[2] && request.method === "GET") {
      return json({ job: await jobDetail(env.DB, caller, parseAppId(appJob[1]), appJob[2]) });
    }
    const appValidate = /^\/api\/apps\/([0-9a-f-]{36})\/validate$/.exec(url.pathname);
    if (appValidate?.[1] && request.method === "POST") {
      return json({ revision: await validateApp(env.DB, caller, parseAppId(appValidate[1])) });
    }
    const appSource = /^\/api\/apps\/([0-9a-f-]{36})\/source$/.exec(url.pathname);
    if (appSource?.[1] && request.method === "PUT") {
      requireJson(request);
      return json({
        revision: await editAppSource(env.DB, caller, parseAppId(appSource[1]), await boundedJson(request.body)),
      });
    }
    const appSwap = /^\/api\/apps\/([0-9a-f-]{36})\/swap$/.exec(url.pathname);
    if (appSwap?.[1] && request.method === "POST") {
      requireJson(request);
      const otherAppId = parseSwapBody(await boundedJson(request.body));
      const swapped = await swapSlugs(env.DB, caller, parseAppId(appSwap[1]), otherAppId);
      return json({ app: swapped.app, other: swapped.other });
    }
    const appAsset = /^\/api\/apps\/([0-9a-f-]{36})\/assets\/(.+)$/.exec(url.pathname);
    if (appAsset?.[1] && appAsset[2] && request.method === "GET") {
      const served = await serveAsset(env.DB, caller, parseAppId(appAsset[1]), appAsset[2]);
      return new Response(served.content, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          ETag: `"${served.contentHash}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const appOne = /^\/api\/apps\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (appOne?.[1] && request.method === "GET") {
      return json({ app: await appDetail(env.DB, caller, parseAppId(appOne[1])) });
    }
    if (appOne?.[1] && request.method === "DELETE") {
      await deleteApp(env.DB, caller, parseAppId(appOne[1]));
      return json({ deleted: true });
    }
    // Browser App SDK runtime (APP-02, ADR 018): scoped Tables/files/invoke
    // over the installed app context. Author routes trust the Organization
    // caller (same policy as the app lifecycle); runtime routes trust the
    // same caller PLUS a live (non-revoked) grant row per call
    // (requireAppGrant), so revocation is immediate and discovered-but-
    // ungranted refs fail. Hidden Tables stay 404 on the runtime paths.
    // One explicit matcher per route, mirroring the executions style above.
    const appGrants = /^\/api\/apps\/([0-9a-f-]{36})\/grants$/.exec(url.pathname);
    if (appGrants?.[1] && request.method === "GET") {
      rejectQuery(url);
      return json({ grants: await listAppGrants(env.DB, caller, parseAppId(appGrants[1])) });
    }
    if (appGrants?.[1] && request.method === "POST") {
      requireJson(request);
      const created = await createAppGrant(env.DB, caller, parseAppId(appGrants[1]), await boundedJson(request.body));
      return json({ grant: created }, 201);
    }
    const appGrantRevoke = /^\/api\/apps\/([0-9a-f-]{36})\/grants\/([^/]+)\/revoke$/.exec(url.pathname);
    if (appGrantRevoke?.[1] && appGrantRevoke[2] && request.method === "POST") {
      rejectQuery(url);
      return json({
        grant: await revokeAppGrant(env.DB, caller, parseAppId(appGrantRevoke[1]), appGrantRevoke[2]),
      });
    }
    const appTables = /^\/api\/apps\/([0-9a-f-]{36})\/tables$/.exec(url.pathname);
    if (appTables?.[1] && request.method === "GET") {
      rejectQuery(url);
      return json({ tables: await listDeclaredTables(env.DB, caller, parseAppId(appTables[1])) });
    }
    if (appTables?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appTables[1]));
      return json({ table: await declareAppTable(env.DB, caller, app, await boundedJson(request.body)) }, 201);
    }
    const appHandshake = /^\/api\/apps\/([0-9a-f-]{36})\/sdk$/.exec(url.pathname);
    if (appHandshake?.[1] && request.method === "GET") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appHandshake[1]));
      const response = json(describeAppHandshake({ id: app.id, name: app.name, slug: app.slug, status: app.status }));
      response.headers.set("X-App-SDK-Version", APP_SDK_VERSION);
      return response;
    }
    const appRuntimeTables = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/tables$/.exec(url.pathname);
    if (appRuntimeTables?.[1] && request.method === "GET") {
      rejectQuery(url);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRuntimeTables[1]));
      return json({ tables: await listRuntimeTables(env.DB, app.id) });
    }
    const appRowsRead = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/tables\/([^/]+)\/rows$/.exec(url.pathname);
    if (appRowsRead?.[1] && appRowsRead[2] && request.method === "GET") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRowsRead[1]));
      const tableName = decodeURIComponent(appRowsRead[2]);
      await requireAppGrant(env.DB, app.id, "table", tableName, "read");
      return json(await readTableRows(env.DB, app, tableName, parseTableQuery(url.searchParams)));
    }
    const appRowWrite = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/tables\/([^/]+)\/rows$/.exec(url.pathname);
    if (appRowWrite?.[1] && appRowWrite[2] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRowWrite[1]));
      const tableName = decodeURIComponent(appRowWrite[2]);
      await requireAppGrant(env.DB, app.id, "table", tableName, "write");
      // Body cap sits above the max row envelope (row bytes plus the data
      // wrapper); the row byte bound itself is enforced in insertTableRow.
      const body = await boundedJson(request.body, 8192);
      if (!object(body) || !("data" in body)) {
        throw new Fault(400, "INVALID_TABLE_ROW", "Table row writes need a data object.");
      }
      return json({ row: await insertTableRow(env.DB, caller, app, tableName, body.data) }, 201);
    }
    const appRowPatch = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/tables\/([^/]+)\/rows\/([^/]+)$/.exec(url.pathname);
    if (appRowPatch?.[1] && appRowPatch[2] && appRowPatch[3] && request.method === "PATCH") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRowPatch[1]));
      const tableName = decodeURIComponent(appRowPatch[2]);
      await requireAppGrant(env.DB, app.id, "table", tableName, "write");
      const body = await boundedJson(request.body, 8192);
      if (!object(body) || !("data" in body)) {
        throw new Fault(400, "INVALID_TABLE_ROW", "Table row writes need a data object.");
      }
      return json({ row: await patchTableRow(env.DB, app, tableName, appRowPatch[3], body.data) });
    }
    if (appRowPatch?.[1] && appRowPatch[2] && appRowPatch[3] && request.method === "DELETE") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appRowPatch[1]));
      const tableName = decodeURIComponent(appRowPatch[2]);
      await requireAppGrant(env.DB, app.id, "table", tableName, "write");
      return json(await deleteTableRow(env.DB, app, tableName, appRowPatch[3]));
    }
    const appInvoke = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/invoke$/.exec(url.pathname);
    if (appInvoke?.[1] && request.method === "POST") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appInvoke[1]));
      const key = parseKey(request.headers.get("Idempotency-Key"));
      if (
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
        request.headers.has("Content-Encoding")
      )
        throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
      const body = await boundedJson(request.body);
      if (!object(body) || typeof body.sagaId !== "string") {
        throw new Fault(400, "INVALID_SUBMISSION", "Provide a granted Saga ID and its input only.");
      }
      if (Object.keys(body).some((entry) => !["sagaId", "input"].includes(entry))) {
        throw new Fault(400, "INVALID_SUBMISSION", "Provide a granted Saga ID and its input only.");
      }
      // Grant-before-parse: the Saga ref is authorized before the input is
      // validated, so ungranted Sagas fail 403 without leaking which known
      // Saga IDs would parse.
      await requireAppGrant(env.DB, app.id, "saga", body.sagaId, "invoke");
      const { saga, input } = parseSubmission({ sagaId: body.sagaId, input: body.input });
      const accepted = await submit(env, caller, key, saga, input);
      await recordAppExecution(env.DB, caller, app.id, accepted.executionId, saga.id);
      return json(accepted, accepted.replayed ? 200 : 202, { Location: accepted.statusUrl });
    }
    const appExecutions = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/executions$/.exec(url.pathname);
    if (appExecutions?.[1] && request.method === "GET") {
      rejectQuery(url);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appExecutions[1]));
      return json({ executions: await listAppExecutions(env.DB, app.id, 20) });
    }
    const appFilesList = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files$/.exec(url.pathname);
    if (appFilesList?.[1] && request.method === "GET") {
      rejectQuery(url);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFilesList[1]));
      return json({ files: await listRuntimeFiles(env.DB, app.id) });
    }
    const appFileDeclare = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/declare$/.exec(url.pathname);
    if (appFileDeclare?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileDeclare[1]));
      const body = await boundedJson(request.body);
      if (!object(body) || typeof body.name !== "string") {
        throw new Fault(400, "INVALID_APP_FILE", "A file declaration needs a name.");
      }
      await requireAppGrant(env.DB, app.id, "file", body.name, "write");
      return json({ file: await declareAppFile(env.DB, caller, app, body) }, 201);
    }
    const appFileTokens = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/tokens$/.exec(url.pathname);
    if (appFileTokens?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileTokens[1]));
      const body = await boundedJson(request.body);
      if (!object(body) || typeof body.name !== "string" || (body.scope !== "upload" && body.scope !== "download")) {
        throw new Fault(400, "INVALID_APP_FILE", "File tokens need a name and an upload or download scope.");
      }
      const permission = body.scope === "upload" ? "write" : "read";
      await requireAppGrant(env.DB, app.id, "file", body.name, permission);
      return json(await issueFileToken(env.DB, app.id, body.name, body.scope), 201);
    }
    const appFileUpload = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/upload$/.exec(url.pathname);
    if (appFileUpload?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileUpload[1]));
      const token = request.headers.get("X-File-Token");
      // Body cap sits above the max file envelope (base64 bytes plus
      // verification metadata); the file byte bound is enforced at redeem.
      const body = await boundedJson(request.body, 65536);
      if (!object(body) || !("content" in body)) {
        throw new Fault(400, "INVALID_APP_FILE", "File upload needs content, contentType, size, and sha256.");
      }
      return json({ file: await redeemFileUpload(env.DB, app.id, token ?? "", body) }, 201);
    }
    const appFileDownload = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/download$/.exec(url.pathname);
    if (appFileDownload?.[1] && request.method === "POST") {
      requireJson(request);
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileDownload[1]));
      const token = request.headers.get("X-File-Token");
      return json(await redeemFileDownload(env.DB, app.id, token ?? ""));
    }
    const appFileDelete = /^\/api\/apps\/([0-9a-f-]{36})\/runtime\/files\/(.+)$/.exec(url.pathname);
    if (appFileDelete?.[1] && appFileDelete[2] && request.method === "DELETE") {
      const app = await loadRuntimeApp(env.DB, caller, parseAppId(appFileDelete[1]));
      const fileName = decodeURIComponent(appFileDelete[2]);
      await requireAppGrant(env.DB, app.id, "file", fileName, "write");
      const rawExpected = url.searchParams.get("expectedVersion");
      if ([...url.searchParams.keys()].some((key) => key !== "expectedVersion")) {
        throw new Fault(400, "UNSUPPORTED_QUERY", "Only expectedVersion is supported here.");
      }
      const expectedVersion = rawExpected === null ? undefined : Number(rawExpected);
      if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
        throw new Fault(400, "INVALID_APP_FILE", "expectedVersion must be a positive integer file version.");
      }
      return json(await deleteAppFile(env.DB, app, fileName, expectedVersion));
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
    // Outward error path: a secret substring embedded in a Fault message
    // (caller input echoed back, miswired env text) is replaced before send.
    // FORM-01 details channel: the 422 form-validation Fault carries its
    // per-field failure list here. No other Fault sets details; details are
    // field names and fixed reason strings, scrubbed like the rest.
    const faultBody =
      fault.details === undefined
        ? { code: fault.code, message: fault.message }
        : { code: fault.code, message: fault.message, details: fault.details };
    return json(scrubValueWithDeploymentSecrets({ error: faultBody }, env), fault.status, headers);
  }
}
