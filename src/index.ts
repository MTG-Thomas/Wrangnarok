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
import type { Principal, TerminateOutcome } from "./domain";
import { bindFormInput, FORM_NAME, loadForm } from "./forms";
import {
  canManageOrg,
  createOrg,
  deleteOrg,
  deletePreview,
  getOrgSummary,
  inviteMember,
  listMembers,
  listOrgs,
  listOrgHistory,
  parseOrgId,
  parseUserId,
  requireInstanceAdmin,
  requireManageOrg,
  resolveCaller,
  resolveUser,
  setOrgStatus,
  setUserStatus,
  updateMember,
  type CallerCtx,
  type MembershipKind,
  type MembershipStatus,
  type MemberUpdate,
  type OrgRole,
} from "./orgs";
import { SAGA_CATALOG } from "./sagas";
import { describeContract, SDK_DOC_PATH } from "./sdk";
import { cancelExecution, listHistory, submit, summary, visibleExecution, workflowForSaga } from "./executions";
import { listExecutionLogs, parseLogSearchQuery, parseLogTailQuery, searchExecutionLogs } from "./logs";
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
    const identity = await authenticate(request, env);
    // AUTH-01 membership gate (ADR 015): every /api/* request resolves the
    // caller against D1. The effective org is the path target for org admin
    // routes (/api/orgs/:id/…), else X-Organization-Id scope selection, else
    // the auth-context org. Selection only narrows to Organizations the
    // caller already belongs to — never an elevation.
    const requestedOrg = request.headers.get("X-Organization-Id");
    const pathOrg = /^\/api\/orgs\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(url.pathname)?.[1];
    // Collection routes address no single org: user-level gate (any known
    // active user lists; only instance admins create). All other routes
    // resolve against the path target or the selected org.
    const isCollection = url.pathname === "/api/orgs";
    const ctx = isCollection
      ? await resolveUser(env.DB, env, identity)
      : await resolveCaller(
          env.DB,
          env,
          identity,
          pathOrg !== undefined
            ? parseOrgId(pathOrg)
            : requestedOrg === null
              ? undefined
              : parseOrgId(requestedOrg.trim()),
        );
    const caller: Principal = ctx.principal;
    // AUTH-01 admin surface (ADR 015): Organization and user lifecycle.
    // Noninteractive management APIs — the same caller policies as the UI.
    // The org history list is the only other route that takes query strings,
    // with the same allowlisted keys as the owner listing.
    const isOrgPath =
      url.pathname === "/api/orgs" || url.pathname.startsWith("/api/orgs/") || url.pathname.startsWith("/api/users/");
    const isOrgHistory = /^\/api\/orgs\/[0-9a-fA-F-]{36}\/executions$/.test(url.pathname) && request.method === "GET";
    // Query strings are deny-by-default: only the history list routes, the
    // OBS-02 log tail, and the OBS-02 log search take them, each with its own
    // allowlisted keys (anything else is UNSUPPORTED_QUERY).
    const queryAllowed =
      (url.pathname === "/api/executions" && request.method === "GET") ||
      isOrgHistory ||
      (url.pathname === "/api/logs" && request.method === "GET") ||
      (/^\/api\/executions\/[a-f0-9]{64}\/logs$/.test(url.pathname) && request.method === "GET");
    if (url.search && !queryAllowed)
      throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
    if (isOrgPath) {
      const orgRoute = await routeOrgs(request, env, ctx, url);
      if (orgRoute) return orgRoute;
    }
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
    if (url.pathname === "/api/logs" && request.method === "GET") {
      // Operator log search (OBS-02): the caller's own rows only, filterable
      // by date/level/Saga, cursor-paginated in seq order. D1 is the source
      // of truth; this is a polling view, never a live stream.
      return json(
        scrubValueWithDeploymentSecrets(
          await searchExecutionLogs(env.DB, caller, parseLogSearchQuery(url.searchParams)),
          env,
        ),
      );
    }
    const logTail = /^\/api\/executions\/([a-f0-9]{64})\/logs$/.exec(url.pathname);
    if (logTail?.[1] && request.method === "GET") {
      // Scoped read/tail for one Execution (OBS-02): owner-only, DEBUG hidden
      // unless explicitly requested, cursor-paginated in seq order. Reconnect
      // backfills by refetching from the last seen cursor (see mergeLogPages).
      return json(
        scrubValueWithDeploymentSecrets(
          await listExecutionLogs(env.DB, caller, logTail[1], parseLogTailQuery(url.searchParams)),
          env,
        ),
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
      return json({ app: await createApp(env.DB, caller, name, slug) }, 201);
    }
    const appBuilds = /^\/api\/apps\/([0-9a-f-]{36})\/builds$/.exec(url.pathname);
    if (appBuilds?.[1] && (request.method === "GET" || request.method === "POST")) {
      const id = parseAppId(appBuilds[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
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

function parseOrgBody(value: unknown): { name: string } {
  if (!object(value) || typeof value.name !== "string") {
    throw new Fault(400, "INVALID_ORG_NAME", "Provide an Organization name of 1 to 128 characters.");
  }
  return { name: value.name };
}

function parseMemberBody(value: unknown): { userId: string; role: OrgRole; kind: MembershipKind } {
  if (!object(value) || typeof value.userId !== "string") {
    throw new Fault(400, "INVALID_USER_ID", "Provide a userId string to invite.");
  }
  const role: OrgRole = value.role === undefined ? "member" : (value.role as OrgRole);
  const kind: MembershipKind = value.kind === undefined ? "ordinary" : (value.kind as MembershipKind);
  if (role !== "member" && role !== "admin") {
    throw new Fault(400, "INVALID_MEMBERSHIP", "Role must be member or admin.");
  }
  if (kind !== "ordinary" && kind !== "external") {
    throw new Fault(400, "INVALID_MEMBERSHIP", "Kind must be ordinary or external.");
  }
  return { userId: value.userId, role, kind };
}

function parseMemberUpdate(value: unknown): MemberUpdate {
  if (!object(value)) throw new Fault(400, "INVALID_MEMBERSHIP", "Provide role, status, or kind to change.");
  const known = ["role", "status", "kind"];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw new Fault(400, "UNSUPPORTED_FIELD", `Field ${key} cannot be changed here.`);
  }
  const update: { role?: OrgRole; status?: MembershipStatus; kind?: MembershipKind } = {};
  if (value.role !== undefined) {
    if (value.role !== "member" && value.role !== "admin") {
      throw new Fault(400, "INVALID_MEMBERSHIP", "Role must be member or admin.");
    }
    update.role = value.role;
  }
  if (value.status !== undefined) {
    if (!["invited", "active", "suspended", "revoked"].includes(value.status as string)) {
      throw new Fault(400, "INVALID_MEMBERSHIP", "Status must be invited, active, suspended, or revoked.");
    }
    update.status = value.status as MembershipStatus;
  }
  if (value.kind !== undefined) {
    if (value.kind !== "ordinary" && value.kind !== "external") {
      throw new Fault(400, "INVALID_MEMBERSHIP", "Kind must be ordinary or external.");
    }
    update.kind = value.kind;
  }
  return update;
}

/** AUTH-01 admin router: Organizations, members, users, and the org admin
 * history surface. Returns null when the path is not an org route. Query
 * strings stay deny-by-default: only the org history list takes them, with
 * the same allowlisted keys as the owner listing. */
async function routeOrgs(request: Request, env: Bindings, ctx: CallerCtx, url: URL): Promise<Response | null> {
  const pathname = url.pathname;
  if (pathname === "/api/orgs" && request.method === "GET") {
    return json({ orgs: await listOrgs(env.DB, ctx) });
  }
  if (pathname === "/api/orgs" && request.method === "POST") {
    requireInstanceAdmin(ctx);
    requireJson(request);
    const org = await createOrg(env.DB, parseOrgBody(await boundedJson(request.body)).name);
    return json(org, 201);
  }
  const orgDetail = /^\/api\/orgs\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (orgDetail?.[1]) {
    const orgId = parseOrgId(orgDetail[1]);
    if (request.method === "GET") {
      if (!(await canManageOrg(env.DB, ctx, orgId))) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
      return json(await getOrgSummary(env.DB, orgId));
    }
  }
  const disable = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/(disable|enable)$/.exec(pathname);
  if (disable?.[1] && disable[2] && request.method === "POST") {
    requireInstanceAdmin(ctx);
    return json(await setOrgStatus(env.DB, parseOrgId(disable[1]), disable[2] === "disable"));
  }
  const del = /^\/api\/orgs\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (del?.[1] && request.method === "DELETE") {
    requireInstanceAdmin(ctx);
    return json(await deleteOrg(env.DB, parseOrgId(del[1])));
  }
  const preview = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/delete-preview$/.exec(pathname);
  if (preview?.[1] && request.method === "GET") {
    requireInstanceAdmin(ctx);
    return json(await deletePreview(env.DB, parseOrgId(preview[1])));
  }
  const members = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/members$/.exec(pathname);
  if (members?.[1]) {
    const orgId = parseOrgId(members[1]);
    if (request.method === "GET") {
      await requireManageOrg(env.DB, ctx, orgId);
      return json({ members: await listMembers(env.DB, orgId) });
    }
    if (request.method === "POST") {
      await requireManageOrg(env.DB, ctx, orgId);
      requireJson(request);
      const body = parseMemberBody(await boundedJson(request.body));
      const member = await inviteMember(env.DB, orgId, parseUserId(body.userId), body.role, body.kind);
      return json(member, 201);
    }
  }
  const member = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/members\/(.+)$/.exec(pathname);
  if (member?.[1] && member[2] && (request.method === "PATCH" || request.method === "PUT")) {
    const orgId = parseOrgId(member[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    requireJson(request);
    return json(
      await updateMember(
        env.DB,
        orgId,
        parseUserId(decodeURIComponent(member[2])),
        parseMemberUpdate(await boundedJson(request.body)),
      ),
    );
  }
  const orgHistory = /^\/api\/orgs\/([0-9a-fA-F-]{36})\/executions$/.exec(pathname);
  if (orgHistory?.[1] && request.method === "GET") {
    const orgId = parseOrgId(orgHistory[1]);
    await requireManageOrg(env.DB, ctx, orgId);
    return json(await listOrgHistory(env.DB, orgId, parseHistoryQuery(url.searchParams)));
  }
  const user = /^\/api\/users\/(.+?)\/(disable|enable)$/.exec(pathname);
  if (user?.[1] && user[2] && request.method === "POST") {
    requireInstanceAdmin(ctx);
    return json(await setUserStatus(env.DB, parseUserId(decodeURIComponent(user[1])), user[2] === "disable"));
  }
  if (pathname.startsWith("/api/orgs") || pathname.startsWith("/api/users/")) {
    throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
  }
  return null;
}
