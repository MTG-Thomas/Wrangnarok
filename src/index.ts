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
import {
  createNotification,
  dismissNotification,
  listAudit,
  listNotifications,
  parseAuditQuery,
  parseNotificationId,
  parseNotificationLimit,
  recordAudit,
  visibleNotification,
} from "./ops";
import { SAGA_CATALOG } from "./sagas";
import { describeContract, SDK_DOC_PATH } from "./sdk";
import { cancelExecution, listHistory, submit, summary, visibleExecution, workflowForSaga } from "./executions";
import { deploymentSecretsFromEnv, scrubValueWithDeploymentSecrets } from "./secrets";
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
    // Query strings are deny-by-default: the history list, audit list, and
    // notifications list routes take them, each with only its own
    // allowlisted keys (anything else is UNSUPPORTED_QUERY).
    const queryList =
      (url.pathname === "/api/executions" && request.method === "GET") ||
      (url.pathname === "/api/audit" && request.method === "GET") ||
      (url.pathname === "/api/notifications" && request.method === "GET");
    if (url.search && !queryList)
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
        // OPS-01 audit: owner cancellation confirmed (best-effort; a failed
        // insert never fails the cancel itself).
        await recordAudit(
          env.DB,
          caller,
          "execution.cancel",
          { type: "execution", id: row.id },
          "success",
          { sagaId: row.saga_id },
          deploymentSecretsFromEnv(env),
        );
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
      // OPS-01 audit: the cancel was requested but never confirmed (failure
      // outcome, retry-safe — the same record as the 503 below).
      await recordAudit(
        env.DB,
        caller,
        "execution.cancel_unconfirmed",
        { type: "execution", id: row.id },
        "failure",
        { outcome: terminateOutcome },
        deploymentSecretsFromEnv(env),
      );
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
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ apps: await listApps(env.DB, caller) });
    }
    if (url.pathname === "/api/apps" && request.method === "POST") {
      requireJson(request);
      const { name, slug } = parseAppBody(await boundedJson(request.body));
      try {
        const app = await createApp(env.DB, caller, name, slug);
        // OPS-01 audit: app lifecycle emission (best-effort; never fails the mutation).
        await recordAudit(
          env.DB,
          caller,
          "app.create",
          { type: "app", id: app.id },
          "success",
          { slug: app.slug },
          deploymentSecretsFromEnv(env),
        );
        return json({ app }, 201);
      } catch (error) {
        if (error instanceof Fault) {
          await recordAudit(
            env.DB,
            caller,
            "app.create",
            { type: "app" },
            "failure",
            { code: error.code },
            deploymentSecretsFromEnv(env),
          );
        }
        throw error;
      }
    }
    const appBuilds = /^\/api\/apps\/([0-9a-f-]{36})\/builds$/.exec(url.pathname);
    if (appBuilds?.[1] && (request.method === "GET" || request.method === "POST")) {
      const id = parseAppId(appBuilds[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      if (request.method === "GET") return json({ jobs: await listJobs(env.DB, caller, id) });
      // OPS-01: the validated build runs inside startBuild; on success the
      // route records app.build.start/app.build.complete audit events and
      // emits a terminal personal notification linked to the job (the one
      // long-running operation this product has). A denied or
      // unvalidatable build records the failure audit and emits nothing.
      try {
        const job = await startBuild(env.DB, caller, id);
        await recordAudit(
          env.DB,
          caller,
          "app.build.start",
          { type: "app", id },
          "success",
          { jobId: job.id, revision: job.revision },
          deploymentSecretsFromEnv(env),
        );
        await recordAudit(
          env.DB,
          caller,
          "app.build.complete",
          { type: "app", id },
          job.status === "succeeded" ? "success" : "failure",
          { jobId: job.id, revision: job.revision },
          deploymentSecretsFromEnv(env),
        );
        const terminal = job.status === "succeeded" ? "completed" : "failed";
        // Best-effort like audit: a notification-table failure must not fail
        // a build that already succeeded. The response carries the row when
        // stored, null when the table is unavailable.
        let notification: unknown = null;
        try {
          notification = await createNotification(
            env.DB,
            caller,
            {
              scope: "personal",
              category: "app_build",
              title: job.status === "succeeded" ? "App build succeeded" : "App build failed",
              status: terminal,
              detail: { appId: id, jobId: job.id, revision: job.revision },
              dedupKey: `app-build:${job.id}`,
            },
            deploymentSecretsFromEnv(env),
          );
        } catch {
          console.warn(`WRANGNAROK_NOTIFICATION_SKIPPED app-build:${job.id}`);
        }
        return json({ job, notification }, 202);
      } catch (error) {
        if (error instanceof Fault) {
          if (error.code === "MANAGED_RESOURCE") {
            await recordAudit(
              env.DB,
              caller,
              "app.managed_deny",
              { type: "app", id },
              "failure",
              { code: error.code },
              deploymentSecretsFromEnv(env),
            );
          } else {
            await recordAudit(
              env.DB,
              caller,
              "app.build.start",
              { type: "app", id },
              "failure",
              { code: error.code },
              deploymentSecretsFromEnv(env),
            );
          }
        }
        throw error;
      }
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
      const id = parseAppId(appSource[1]);
      try {
        const revision = await editAppSource(env.DB, caller, id, await boundedJson(request.body));
        await recordAudit(
          env.DB,
          caller,
          "app.source.edit",
          { type: "app", id },
          "success",
          { revision: revision.revision },
          deploymentSecretsFromEnv(env),
        );
        return json({ revision });
      } catch (error) {
        if (error instanceof Fault) {
          await recordAudit(
            env.DB,
            caller,
            error.code === "MANAGED_RESOURCE" ? "app.managed_deny" : "app.source.edit",
            { type: "app", id },
            "failure",
            { code: error.code },
            deploymentSecretsFromEnv(env),
          );
        }
        throw error;
      }
    }
    const appSwap = /^\/api\/apps\/([0-9a-f-]{36})\/swap$/.exec(url.pathname);
    if (appSwap?.[1] && request.method === "POST") {
      requireJson(request);
      const id = parseAppId(appSwap[1]);
      try {
        const otherAppId = parseSwapBody(await boundedJson(request.body));
        const swapped = await swapSlugs(env.DB, caller, id, otherAppId);
        await recordAudit(
          env.DB,
          caller,
          "app.swap",
          { type: "app", id },
          "success",
          { otherAppId },
          deploymentSecretsFromEnv(env),
        );
        return json({ app: swapped.app, other: swapped.other });
      } catch (error) {
        if (error instanceof Fault) {
          await recordAudit(
            env.DB,
            caller,
            error.code === "MANAGED_RESOURCE" ? "app.managed_deny" : "app.swap",
            { type: "app", id },
            "failure",
            { code: error.code },
            deploymentSecretsFromEnv(env),
          );
        }
        throw error;
      }
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
      const id = parseAppId(appOne[1]);
      try {
        await deleteApp(env.DB, caller, id);
        await recordAudit(
          env.DB,
          caller,
          "app.delete",
          { type: "app", id },
          "success",
          {},
          deploymentSecretsFromEnv(env),
        );
        return json({ deleted: true });
      } catch (error) {
        if (error instanceof Fault) {
          await recordAudit(
            env.DB,
            caller,
            error.code === "MANAGED_RESOURCE" ? "app.managed_deny" : "app.delete",
            { type: "app", id },
            "failure",
            { code: error.code },
            deploymentSecretsFromEnv(env),
          );
        }
        throw error;
      }
    }
    // Administrative audit trail (OPS-01, ADR 018): Organization-scoped event
    // list with action-prefix, outcome, search, date, and cursor filters.
    // No per-row detail route (upstream has none either).
    if (url.pathname === "/api/audit" && request.method === "GET") {
      // Outward path: scrubbed again on read (defense in depth — a secret
      // substring in a stored detail can never ride the list out).
      return json(
        scrubValueWithDeploymentSecrets(await listAudit(env.DB, caller, parseAuditQuery(url.searchParams)), env),
      );
    }
    // Operational notifications (OPS-01, ADR 018): durable personal/org inbox
    // with dismiss behavior. List is the caller's own personal rows plus
    // same-org org-scoped rows; reconnects re-read D1, never a stream.
    if (url.pathname === "/api/notifications" && request.method === "GET") {
      // Outward path: scrubbed again on read, like the audit list above.
      return json(
        scrubValueWithDeploymentSecrets(
          { notifications: await listNotifications(env.DB, caller, parseNotificationLimit(url.searchParams)) },
          env,
        ),
      );
    }
    // Loose segment matcher: parseNotificationId fails closed with
    // INVALID_NOTIFICATION_ID on bad shapes (never UNIMPLEMENTED), and
    // unknown UUIDs answer 404 below, never a leak.
    const notifOne = /^\/api\/notifications\/([^/]+)$/i.exec(url.pathname);
    if (notifOne?.[1] && request.method === "GET") {
      const notification = await visibleNotification(env.DB, caller, parseNotificationId(notifOne[1]));
      if (!notification) return json({ error: { code: "NOTIFICATION_NOT_FOUND", message: "Not found." } }, 404);
      return json(scrubValueWithDeploymentSecrets({ notification }, env));
    }
    if (notifOne?.[1] && request.method === "DELETE") {
      // Dismissal: personal rows by owner only, org rows by any same-org
      // caller. Gone-or-foreign answers 404, never a leak; a second dismiss
      // is gone, not an error to retry.
      const dismissed = await dismissNotification(env.DB, caller, parseNotificationId(notifOne[1]));
      if (!dismissed) return json({ error: { code: "NOTIFICATION_NOT_FOUND", message: "Not found." } }, 404);
      return json({ dismissed: true });
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
