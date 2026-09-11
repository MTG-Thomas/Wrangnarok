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
  parseCallerKey,
  parseDigestInput,
  parseHelloInput,
  parseHistoryQuery,
  parseInput,
  parseNinjaOrgsInput,
  parseSmokeInput,
  parseSubmission,
  smokeSaga,
} from "./domain";
import type { Principal, TerminateOutcome } from "./domain";
import {
  authenticateEndpointKey,
  authenticateWebhook,
  checkEndpointRateLimit,
  createEndpoint,
  endpointSummary,
  executeEndpointDelivery,
  findChallengeEndpoint,
  listEndpointEvents,
  listEndpoints,
  loadEndpoint,
  loadEndpointsByName,
  parseEndpointName,
  parseVendorEventId,
  parseWebhookSecrets,
  readWebhookBody,
  resolveEndpointSagaId,
  rotateEndpointCredential,
  updateEndpoint,
  vendorChallenge,
} from "./endpoints";
import type { EndpointRow } from "./endpoints";
import { bindFormInput, FORM_NAME, loadForm } from "./forms";
import { deleteConfig, listConfigs, parseUpdateConfigInput, setConfig, updateConfig } from "./config";
import {
  consumeUploadToken,
  createLocation,
  deleteFile,
  deleteLocation,
  finalizeUpload,
  grantPolicy,
  issueDownloadBatch,
  issueUploadBatch,
  listFiles,
  listLocations,
  listPolicies,
  loadLocation,
  objectKey,
  parseBatchEntries,
  parseFileListQuery,
  parseFilePath,
  parseFinalizeBody,
  parseLocationName,
  readBoundedBytes,
  resolveBearerRead,
  resolveDownloadToken,
  revokePolicy,
  testAccess,
} from "./files";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  scrubConnectionPayload,
  testConnection,
  updateConnection,
} from "./connections";
import { describeIntegrations } from "./integrations";

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
import {
  batchDelete,
  batchInsert,
  batchUpdate,
  countRows,
  createTable,
  deleteRow,
  deleteTable,
  grantTable,
  insertRow,
  listTables,
  loadTable,
  parseBatchBody,
  parseBatchDeleteBody,
  parseTableName,
  parseTableQuery,
  queryRows,
  readRow,
  revokeTable,
  TABLE_NAME,
  updateRow,
} from "./tables";
import { SAGA_CATALOG, SAGA_DEFINITIONS } from "./sagas";
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
/** Bearer token from the Authorization header, or null. Endpoint deliveries
 * accept it as the api-key transport alongside X-Endpoint-Key. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}
/** Public TRG-02 deliveries (issue #138, ADR 019): vendor-facing webhook and
 * endpoint receivers. Authenticated by credential (per-endpoint key or HMAC
 * secret), never by the operator session — so they run BEFORE the
 * authenticated /api/* gate below. Name resolution is global by name (names
 * are not secret); the credential disambiguates across Organizations. */
async function handlePublicDelivery(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url);
  const delivery = /^\/(api\/endpoints|hooks)\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
  if (!delivery?.[1] || !delivery[2] || request.method !== "POST") return null;
  const expected = delivery[1] === "api/endpoints" ? "api-key" : "webhook";
  const name = parseEndpointName(delivery[2]);
  // Query strings stay deny-by-default here except the vendor challenge
  // handshake (?challenge=<token> on echo-param webhook endpoints). Any
  // other query answers UNSUPPORTED_QUERY like the rest of the API.
  const queryKeys = [...url.searchParams.keys()];
  if (queryKeys.some((entry) => entry !== "challenge")) {
    throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
  }
  const rows = await loadEndpointsByName(env.DB, name).catch(() => [] as EndpointRow[]);
  if (rows.length === 0) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  const challengeRow = findChallengeEndpoint(rows.filter((row) => row.kind === "webhook"));
  const challenge = challengeRow ? vendorChallenge(challengeRow, url) : null;
  if (challenge !== null) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (url.search) {
    throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
  }
  // Read the wire body exactly once: api-key deliveries parse it as JSON;
  // webhook deliveries keep the raw bytes for HMAC and parse from them.
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers.has("Content-Encoding")
  )
    throw new Fault(415, "JSON_REQUIRED", "Unencoded JSON is required.");
  const { raw, parsed } = await readWebhookBody(request.body);
  const headers = request.headers;
  const secrets = parseWebhookSecrets(env.ENDPOINT_WEBHOOK_SECRETS);
  const authed =
    expected === "api-key"
      ? await authenticateEndpointKey(
          rows.filter((row) => row.kind === "api-key"),
          request.headers.get("X-Endpoint-Key") ?? bearerToken(request),
        )
      : await authenticateWebhook(
          rows.filter((row) => row.kind === "webhook"),
          raw,
          headers.get("X-Webhook-Signature"),
          secrets,
        );
  await checkEndpointRateLimit(env.DB, authed.endpoint);
  const eventId = parseVendorEventId(headers, parsed);
  resolveEndpointSagaId(authed.endpoint, SAGA_CATALOG);
  const saga = SAGA_DEFINITIONS.find((entry) => entry.id === authed.endpoint.saga_id);
  if (!saga) throw new Fault(500, "ENDPOINT_MISCONFIGURED", "This endpoint is not configured correctly.");
  const accepted = await executeEndpointDelivery(env.DB, submit, env, authed.principal, authed.endpoint, {
    saga: { id: saga.id, name: saga.name, revision: saga.revision, description: saga.description, parse: saga.parse },
    eventId,
    payload: parsed,
  });
  const responseHeaders: Record<string, string> = { Location: accepted.statusUrl };
  if (accepted.eventReplayed) responseHeaders["X-Endpoint-Replayed"] = "true";
  return json(
    {
      executionId: accepted.executionId,
      replayed: accepted.replayed,
      eventReplayed: accepted.eventReplayed,
      statusUrl: accepted.statusUrl,
    },
    accepted.replayed ? 200 : 202,
    responseHeaders,
  );
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
    // Public vendor receivers live outside /api/* precisely so they do not
    // require the operator session (ADR 019): /hooks/:name for webhooks.
    if (url.pathname.startsWith("/hooks/")) {
      try {
        const delivered = await handlePublicDelivery(request, env);
        if (delivered) return delivered;
      } catch (error) {
        const fault =
          error instanceof Fault ? error : new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
        return json({ error: { code: fault.code, message: fault.message } }, fault.status);
      }
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  }
  try {
    // Public credential-authenticated endpoint deliveries share the /api/*
    // prefix (POST /api/endpoints/:name) but carry no operator session, so
    // they run after the public /hooks/* path but before the membership
    // gate below: vendor credentials, never the operator session.
    const apiDelivery = /^\/api\/endpoints\/[a-z0-9][a-z0-9-]{0,63}$/.exec(url.pathname);
    if (apiDelivery && request.method === "POST") {
      const delivered = await handlePublicDelivery(request, env);
      if (delivered) return delivered;
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
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
    // Query strings are deny-by-default: only the history list routes,
    // the table query/count routes, and the file structural list and byte
    // routes take them, each through its own allowlisted parser (anything
    // else is UNSUPPORTED_QUERY).
    const historyList = url.pathname === "/api/executions" || isOrgHistory;
    const tableQueryList =
      request.method === "GET" && /^\/api\/tables\/[a-z0-9][a-z0-9-]{0,63}\/(rows|count)$/.test(url.pathname);
    const fileList = url.pathname === "/api/files" && request.method === "GET";
    const fileBytes = url.pathname === "/api/files/content" && (request.method === "GET" || request.method === "PUT");
    if (url.search && !(historyList && request.method === "GET") && !tableQueryList && !fileList && !fileBytes)
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
      const key = parseCallerKey(request.headers.get("Idempotency-Key"));
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
      const key = parseCallerKey(request.headers.get("Idempotency-Key"));
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
    // Managed file locations (FILE-01, ADR 018): declared locations,
    // policy-checked proxy access, finalize-after-upload verification, and
    // versioned mutation. One explicit matcher per route, mirroring the
    // executions/apps style: boring and greppable beats a shared capture.
    // Query strings stay deny-by-default: only GET /api/files takes them,
    // and only its allowlisted keys (location/prefix/limit/cursor).
    // Capability tokens arrive as ?token= on the byte routes only; every
    // other file route reads the standard Authorization header.
    if (url.pathname === "/api/file-locations" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ locations: await listLocations(env.DB, caller) });
    }
    if (url.pathname === "/api/file-locations" && request.method === "POST") {
      requireJson(request);
      return json({ location: await createLocation(env.DB, caller, await boundedJson(request.body)) }, 201);
    }
    const locationOne = /^\/api\/file-locations\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (locationOne?.[1] && request.method === "GET") {
      const found = await loadLocation(env.DB, caller.orgId, locationOne[1]);
      if (!found) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const policies = await listPolicies(env.DB, caller, locationOne[1]);
      return json({ location: found, policies });
    }
    if (locationOne?.[1] && request.method === "DELETE") {
      await deleteLocation(env.DB, caller, locationOne[1]);
      return json({ deleted: true });
    }
    if (url.pathname === "/api/files/uploads" && request.method === "POST") {
      requireJson(request);
      const issued = await issueUploadBatch(env.DB, caller, parseBatchEntries(await boundedJson(request.body)));
      const denied = issued.some((entry) => !entry.allowed);
      return json(
        {
          entries: issued.map((entry) =>
            entry.allowed
              ? { path: entry.path, allowed: true, token: entry.token, expiresAt: entry.expiresAt }
              : { path: entry.path, allowed: false, code: entry.code, message: entry.message },
          ),
        },
        denied ? 207 : 200,
      );
    }
    if (url.pathname === "/api/files/downloads" && request.method === "POST") {
      requireJson(request);
      const issued = await issueDownloadBatch(env.DB, caller, parseBatchEntries(await boundedJson(request.body)));
      const denied = issued.some((entry) => !entry.allowed);
      return json(
        {
          entries: issued.map((entry) =>
            entry.allowed
              ? { path: entry.path, allowed: true, token: entry.token, expiresAt: entry.expiresAt }
              : { path: entry.path, allowed: false, code: entry.code, message: entry.message },
          ),
        },
        denied ? 207 : 200,
      );
    }
    if (url.pathname === "/api/files/content" && request.method === "PUT") {
      // Upload bytes to a staging key: the token is single-use-consumed and
      // the body is bounded at the location limit + 1 (413 past the cap).
      // Bearer uploads are not accepted: writes always go through an issued
      // slot so the finalize step can verify what was stored.
      const token = url.searchParams.get("token");
      const extra = [...url.searchParams.keys()].filter((key) => key !== "token");
      if (token === null || extra.length > 0)
        throw new Fault(400, "UNSUPPORTED_QUERY", "Uploads need exactly ?token= from an issued slot.");
      const consumed = await consumeUploadToken(env.DB, token);
      const declared = await loadLocation(env.DB, consumed.orgId, consumed.location);
      if (!declared) throw new Fault(404, "NOT_FOUND", "Not found.");
      if (!request.body) throw new Fault(400, "EMPTY_UPLOAD", "The upload body must not be empty.");
      const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() || "";
      if (declared.contentTypes.length > 0 && !declared.contentTypes.includes(contentType)) {
        throw new Fault(415, "CONTENT_TYPE_REJECTED", `Content type "${contentType}" is not allowed in this location.`);
      }
      const bytes = await readBoundedBytes(request.body, declared.maxBytes + 1);
      await env.FILES.put(consumed.staging, bytes, { httpMetadata: { contentType: contentType || undefined } });
      return json({ staged: true, size: bytes.byteLength });
    }
    if (url.pathname === "/api/files/content" && request.method === "GET") {
      // Download bytes: capability token (?token=) or Bearer-shape read,
      // resolved through the existence-first read tier. Only ready rows are
      // readable; every denied read answers 404 (non-disclosure).
      const getToken = url.searchParams.get("token");
      if (getToken !== null) {
        const extra = [...url.searchParams.keys()].filter((key) => key !== "token");
        if (extra.length > 0)
          throw new Fault(400, "UNSUPPORTED_QUERY", "Only token is supported with capability downloads.");
      } else {
        for (const key of url.searchParams.keys()) {
          if (key !== "location" && key !== "path")
            throw new Fault(400, "UNSUPPORTED_QUERY", "Only location and path are supported here.");
        }
      }
      const token = getToken;
      const resolved =
        token !== null
          ? await resolveDownloadToken(env.DB, token)
          : await resolveBearerRead(
              env.DB,
              caller,
              parseLocationName(url.searchParams.get("location") ?? ""),
              parseFilePath(url.searchParams.get("path") ?? ""),
            );
      const row = await env.DB.prepare(
        "SELECT size,content_type,sha256,version FROM files WHERE org_id=? AND location=? AND path=? AND status='ready'",
      )
        .bind(resolved.sourceOrgId, resolved.location, resolved.path)
        .first<{ size: number; content_type: string; sha256: string; version: number }>();
      if (!row) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const stored = await env.FILES.get(objectKey(resolved.sourceOrgId, resolved.location, resolved.path));
      if (!stored) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return new Response(stored.body, {
        status: 200,
        headers: {
          "Content-Type": row.content_type,
          "Content-Length": String(row.size),
          ETag: `"${row.sha256}"`,
          "X-File-Version": String(row.version),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (url.pathname === "/api/files/finalize" && request.method === "POST") {
      requireJson(request);
      return json({
        file: await finalizeUpload(env.DB, env.FILES, caller, parseFinalizeBody(await boundedJson(request.body))),
      });
    }
    if (url.pathname === "/api/files" && request.method === "GET") {
      // Organization-scoped structural listing (never shared rows).
      if (!url.search) throw new Fault(400, "INVALID_LOCATION", "Listing needs a location.");
      const listed = await listFiles(env.DB, caller, parseFileListQuery(url.searchParams));
      return json({ files: listed.files, nextCursor: listed.nextCursor });
    }
    if (url.pathname === "/api/files" && request.method === "DELETE") {
      requireJson(request);
      await deleteFile(env.DB, env.FILES, caller, await boundedJson(request.body));
      return json({ deleted: true });
    }
    if (url.pathname === "/api/file-policies" && request.method === "POST") {
      requireJson(request);
      return json({ policy: await grantPolicy(env.DB, caller, await boundedJson(request.body)) }, 201);
    }
    if (url.pathname === "/api/file-policies" && request.method === "DELETE") {
      requireJson(request);
      await revokePolicy(env.DB, caller, await boundedJson(request.body));
      return json({ revoked: true });
    }
    if (url.pathname === "/api/file-policies/test" && request.method === "POST") {
      requireJson(request);
      return json({ access: await testAccess(env.DB, caller, await boundedJson(request.body)) });
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
    // Connection management (CON-01, issue #146): portable Integration
    // definitions plus per-Organization non-secret mappings through one
    // authorized boundary. Every response is scrubbed with the deployment
    // secrets before send; views carry required-secret names only, never
    // values. Secret values are never accepted on any path here (SEC-02
    // tripwire stays shut). One explicit matcher per route.
    if (url.pathname === "/api/integrations" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(scrubConnectionPayload({ integrations: describeIntegrations() }, env));
    }
    if (url.pathname === "/api/connections" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json(scrubConnectionPayload({ connections: await listConnections(env.DB, caller) }, env));
    }
    if (url.pathname === "/api/connections" && request.method === "POST") {
      requireJson(request);
      const body = (await boundedJson(request.body)) as { integrationId?: unknown } & Record<string, unknown>;
      if (typeof body.integrationId !== "string") {
        throw new Fault(400, "UNKNOWN_INTEGRATION", "A Connection write needs an integrationId.");
      }
      const created = await createConnection(env.DB, caller, body.integrationId, {
        config: body.config,
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      });
      return json(scrubConnectionPayload({ connection: created }, env), 201);
    }
    const connTest = /^\/api\/connections\/([0-9a-f-]{36})\/test$/.exec(url.pathname);
    if (connTest?.[1] && request.method === "POST") {
      const tested = await testConnection(env.DB, caller, connTest[1], env);
      if (!tested.ok) {
        const code = tested.code;
        const status =
          code === "UNKNOWN_INTEGRATION" || code === "CONNECTION_NOT_FOUND" || code === "CONNECTION_DISABLED"
            ? 404
            : code === "INTEGRATION_REQUIREMENT_UNSATISFIED"
              ? 424
              : code === "SECRET_NOT_CONFIGURED"
                ? 502
                : 502;
        return json(scrubConnectionPayload({ test: tested }, env), status);
      }
      return json(scrubConnectionPayload({ test: tested }, env));
    }
    const connOne = /^\/api\/connections\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (connOne?.[1] && request.method === "GET") {
      return json(scrubConnectionPayload({ connection: await getConnection(env.DB, caller, connOne[1]) }, env));
    }
    if (connOne?.[1] && request.method === "PUT") {
      requireJson(request);
      const body = (await boundedJson(request.body)) as Record<string, unknown>;
      const updated = await updateConnection(env.DB, caller, connOne[1], {
        ...(body.config === undefined ? {} : { config: body.config }),
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      });
      return json(scrubConnectionPayload({ connection: updated }, env));
    }
    if (connOne?.[1] && request.method === "DELETE") {
      await deleteConnection(env.DB, caller, connOne[1]);
      return json({ deleted: true });
    }
    // TRG-02 endpoint management (issue #138, ADR 018): operator-owned
    // inventory over this Organization's scoped endpoints. Create returns
    // the raw credential once (apiKey, or webhookSecret to plant in the
    // deployment secret store); summaries never carry digests or secrets.
    // Bad names answer 404 (never a leak); foreign-Organization rows 404.
    if (url.pathname === "/api/endpoints" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ endpoints: await listEndpoints(env.DB, caller.orgId).catch(() => []) });
    }
    if (url.pathname === "/api/endpoints" && request.method === "POST") {
      requireJson(request);
      const body = await boundedJson(request.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_ENDPOINT", "Provide name, sagaId, and kind.");
      }
      const record = body as Record<string, unknown>;
      if (typeof record.name === "string") parseEndpointName(record.name);
      const created = await createEndpoint(
        env.DB,
        caller.orgId,
        {
          name: typeof record.name === "string" ? record.name : "",
          sagaId: typeof record.sagaId === "string" ? record.sagaId : "",
          kind: record.kind as "api-key" | "webhook",
          ...(record.rateLimitPerMinute === undefined
            ? {}
            : { rateLimitPerMinute: record.rateLimitPerMinute as number | null }),
          ...(record.challenge === undefined ? {} : { challenge: record.challenge as "none" | "echo-param" }),
          ...(record.keyExpiresAt === undefined ? {} : { keyExpiresAt: record.keyExpiresAt as string | null }),
        },
        SAGA_CATALOG.map((entry) => entry.id),
      );
      return json(
        {
          endpoint: endpointSummary(created.row),
          ...(created.row.kind === "api-key"
            ? { apiKey: created.rawCredential }
            : { webhookSecret: created.rawCredential }),
        },
        201,
      );
    }
    const endpointEvents = /^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})\/events$/.exec(url.pathname);
    // Unknown name shapes (uppercase, dots, slashes beyond one segment)
    // answer 404 like parseEndpointName does — never UNIMPLEMENTED theater.
    if (
      /^\/api\/endpoints\/[^/]+(\/[^/]+)?$/.exec(url.pathname) &&
      !endpointEvents &&
      !/^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})\/rotate$/.exec(url.pathname) &&
      !/^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname)
    ) {
      return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
    if (endpointEvents?.[1] && request.method === "GET") {
      const name = parseEndpointName(endpointEvents[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ events: await listEndpointEvents(env.DB, caller.orgId, name, 50).catch(() => []) });
    }
    const endpointRotate = /^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})\/rotate$/.exec(url.pathname);
    if (endpointRotate?.[1] && request.method === "POST") {
      const name = parseEndpointName(endpointRotate[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const rotated = await rotateEndpointCredential(env.DB, caller.orgId, name).catch(() => null);
      if (!rotated) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json({
        endpoint: endpointSummary(rotated.row),
        ...(rotated.row.kind === "api-key"
          ? { apiKey: rotated.rawCredential }
          : { webhookSecret: rotated.rawCredential }),
      });
    }
    const endpointOne = /^\/api\/endpoints\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (endpointOne?.[1] && (request.method === "GET" || request.method === "PATCH")) {
      const name = parseEndpointName(endpointOne[1]);
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      const row = await loadEndpoint(env.DB, caller.orgId, name).catch(() => null);
      if (!row) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      if (request.method === "GET") return json({ endpoint: endpointSummary(row) });
      requireJson(request);
      const body = await boundedJson(request.body);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_ENDPOINT", "Provide enabled, rateLimitPerMinute, or keyExpiresAt.");
      }
      const record = body as Record<string, unknown>;
      const updated = await updateEndpoint(env.DB, caller.orgId, name, {
        ...(record.enabled === undefined ? {} : { enabled: record.enabled as boolean }),
        ...(record.rateLimitPerMinute === undefined
          ? {}
          : { rateLimitPerMinute: record.rateLimitPerMinute as number | null }),
        ...(record.keyExpiresAt === undefined ? {} : { keyExpiresAt: record.keyExpiresAt as string | null }),
      });
      return json({ endpoint: endpointSummary(updated) });
    }
    // Author Tables over D1 (TABLE-01 minimal slice, TABLE-02 query/count/
    // batch; issues #117, #154): Organization-scoped declarations with
    // deny-by-absence per-action grants, policy-safe keyset queries, scoped
    // counts with skip_count, and all-or-denied batch mutations. One explicit
    // matcher per route, mirroring the apps style above: boring and greppable
    // beats a shared capture. Realtime subscriptions are deferred per the
    // multi-slice note in issue #154; polling repeats the GET rows route.
    if (url.pathname === "/api/tables" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ tables: await listTables(env.DB, caller) });
    }
    if (url.pathname === "/api/tables" && request.method === "POST") {
      requireJson(request);
      const body: unknown = await boundedJson(request.body);
      if (body === null || typeof body !== "object" || Array.isArray(body) || !("name" in body)) {
        throw new Fault(400, "INVALID_TABLE", "Table creation needs { name }.");
      }
      return json({ table: await createTable(env.DB, caller, (body as Record<string, unknown>).name) }, 201);
    }
    const tableCount = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/count$/.exec(url.pathname);
    if (tableCount?.[1] && request.method === "GET") {
      // Scoped filtered count: same filters as the rows route. skip_count
      // answers total=-1 without scanning; a filled scan window answers -2.
      const table = await loadTable(env.DB, caller.orgId, tableCount[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await countRows(env.DB, caller, table, parseTableQuery(url.searchParams)));
    }
    const tableRows = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows$/.exec(url.pathname);
    if (tableRows?.[1] && request.method === "GET") {
      const table = await loadTable(env.DB, caller.orgId, tableRows[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await queryRows(env.DB, caller, table, parseTableQuery(url.searchParams)));
    }
    const tableBatchInsert = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows\/batch$/.exec(url.pathname);
    if (tableBatchInsert?.[1] && request.method === "POST") {
      // All-or-denied batch insert: policy/attribution denials fail the whole
      // batch first (403 TABLE_BATCH_DENIED); operational per-item failures
      // ride per-item results after the surviving writes land atomically.
      requireJson(request);
      const table = await loadTable(env.DB, caller.orgId, tableBatchInsert[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await batchInsert(env.DB, caller, table, parseBatchBody(await boundedJson(request.body))), 201);
    }
    const tableBatchUpdate = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows\/batch-update$/.exec(url.pathname);
    if (tableBatchUpdate?.[1] && request.method === "PUT") {
      requireJson(request);
      const table = await loadTable(env.DB, caller.orgId, tableBatchUpdate[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await batchUpdate(env.DB, caller, table, parseBatchBody(await boundedJson(request.body))));
    }
    const tableBatchDelete = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows\/batch-delete$/.exec(url.pathname);
    if (tableBatchDelete?.[1] && request.method === "POST") {
      requireJson(request);
      const table = await loadTable(env.DB, caller.orgId, tableBatchDelete[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json(await batchDelete(env.DB, caller, table, parseBatchDeleteBody(await boundedJson(request.body))));
    }
    const tableRow = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/rows\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(
      url.pathname,
    );
    if (tableRow?.[1] && tableRow[2]) {
      const table = await loadTable(env.DB, caller.orgId, tableRow[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      if (request.method === "PUT") {
        requireJson(request);
        const body: unknown = await boundedJson(request.body);
        if (body === null || typeof body !== "object" || Array.isArray(body) || !("data" in body)) {
          throw new Fault(400, "INVALID_DOCUMENT", "Row writes need { data } with a JSON object document.");
        }
        const row = await insertRow(env.DB, caller, table, tableRow[2], (body as Record<string, unknown>).data);
        return json({ row }, 201);
      }
      if (request.method === "GET") {
        return json({ row: await readRow(env.DB, caller, table, tableRow[2]) });
      }
      if (request.method === "PATCH") {
        requireJson(request);
        const body: unknown = await boundedJson(request.body);
        if (body === null || typeof body !== "object" || Array.isArray(body) || !("data" in body)) {
          throw new Fault(400, "INVALID_DOCUMENT", "Row updates need { data } with a JSON object document.");
        }
        return json({
          row: await updateRow(env.DB, caller, table, tableRow[2], (body as Record<string, unknown>).data),
        });
      }
      if (request.method === "DELETE") {
        await deleteRow(env.DB, caller, table, tableRow[2]);
        return json({ deleted: true });
      }
    }
    const tableGrant = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})\/grants$/.exec(url.pathname);
    if (tableGrant?.[1] && (request.method === "POST" || request.method === "DELETE")) {
      // Owner-only grant administration. Grants name user IDs in this slice;
      // role claims belong to AUTH-02. Revocation converges immediately for
      // subsequent calls (no live push until realtime subscriptions land).
      requireJson(request);
      const name = parseTableName(tableGrant[1]);
      const table = await loadTable(env.DB, caller.orgId, name);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const body: unknown = await boundedJson(request.body);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Fault(400, "INVALID_GRANT", "Grant bodies need { action, granteeUserId }.");
      }
      const record = body as Record<string, unknown>;
      if (request.method === "POST") {
        await grantTable(env.DB, caller, table, record.action, record.granteeUserId);
        return json({ granted: true });
      }
      await revokeTable(env.DB, caller, table, record.action, record.granteeUserId);
      return json({ revoked: true });
    }
    const tableOne = /^\/api\/tables\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (tableOne?.[1] && request.method === "GET") {
      if (!TABLE_NAME.test(tableOne[1])) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const table = await loadTable(env.DB, caller.orgId, tableOne[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      return json({ table });
    }
    if (tableOne?.[1] && request.method === "DELETE") {
      const table = await loadTable(env.DB, caller.orgId, tableOne[1]);
      if (!table) return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      await deleteTable(env.DB, caller, table);
      return json({ deleted: true });
    }
    // Scoped configuration (CON-02, ADR 019): typed key/value rows for the
    // caller's own Organization. Secret rows answer "[SECRET]" on every read
    // surface and provision only references — values resolve transiently at
    // the Integration Action boundary and never persist, log, or return.
    // One explicit matcher per route, mirroring the tables style: boring and
    // greppable beats a shared capture.
    if (url.pathname === "/api/config" && request.method === "GET") {
      if (url.search) throw new Fault(400, "UNSUPPORTED_QUERY", "Query parameters are not supported on this route.");
      return json({ configs: await listConfigs(env.DB, caller) });
    }
    if (url.pathname === "/api/config" && request.method === "POST") {
      requireJson(request);
      const body: unknown = await boundedJson(request.body);
      if (!object(body))
        throw new Fault(400, "INVALID_CONFIG", "Config writes need { key, type, value?, description? }.");
      const record = body as Record<string, unknown>;
      return json(
        {
          config: await setConfig(
            env.DB,
            caller,
            { key: record.key, type: record.type, value: record.value, description: record.description },
            env as unknown as Record<string, string | undefined>,
          ),
        },
        201,
      );
    }
    const configOne = /^\/api\/config\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
    if (configOne?.[1]) {
      if (request.method === "PUT") {
        requireJson(request);
        return json({
          config: await updateConfig(
            env.DB,
            caller,
            configOne[1],
            parseUpdateConfigInput(await boundedJson(request.body)),
            env as unknown as Record<string, string | undefined>,
          ),
        });
      }
      if (request.method === "DELETE") {
        await deleteConfig(env.DB, caller, configOne[1]);
        return json({ deleted: true });
      }
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
