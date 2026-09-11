// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/api-client.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök Bearer fixture only.
//
// Auth: the fixture token is supplied by the operator (localStorage, set via
// the Token field in the UI) and sent as `Authorization: Bearer <token>`.
// Secrets are never bundled in client code.
import { parseApiError } from "./api-error";
import type {
  AppDependency,
  AppDetail,
  AppFile,
  AppJob,
  AppRevision,
  AppsResponse,
  AppSummary,
  ExecutionDetail,
  ExecutionHistoryResponse,
  ExecutionStatus,
  SagasResponse,
  SagaSummary,
} from "./client-types";

const TOKEN_KEY = "wrangnarok.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (e.g. SSR render in tests); callers still work.
  }
}

async function get(path: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(path, { headers });
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

function isHistoryResponse(value: unknown): value is ExecutionHistoryResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["executions"]) || typeof v["hasMore"] !== "boolean") return false;
  // nextCursor is new (Phase 2 querying); older payloads without it still read.
  return !("nextCursor" in v) || typeof v["nextCursor"] === "string" || v["nextCursor"] === null;
}

function isSagasResponse(value: unknown): value is SagasResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["sagas"])) return false;
  return (v["sagas"] as unknown[]).every((entry): entry is SagaSummary => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e["id"] === "string" &&
      typeof e["name"] === "string" &&
      typeof e["revision"] === "string" &&
      typeof e["description"] === "string"
    );
  });
}

function isDetailResponse(value: unknown): value is ExecutionDetail {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["executionId"] === "string" && Array.isArray(v["operations"]) && "runtimeStatus" in v;
}

/** Server-side history filters (allowlisted query keys; anything else is UNSUPPORTED_QUERY). */
export interface HistoryListQuery {
  /** One status or a comma-separated multi-status set (mirrors upstream). */
  status?: ExecutionStatus | ExecutionStatus[];
  sagaId?: string;
  /** Exact Saga name (upstream workflowName parity). */
  sagaName?: string;
  /** Inclusive ISO lower bound on created_at (YYYY-MM-DD accepted). */
  startDate?: string;
  /** Inclusive-day / exact-datetime upper bound on created_at. */
  endDate?: string;
  limit?: number;
  /** Opaque page marker from a previous response. */
  cursor?: string;
}

function statusParam(status: ExecutionStatus | ExecutionStatus[]): string {
  return (Array.isArray(status) ? status : [status]).join(",");
}

/**
 * GET /api/executions — ExecutionHistory list (summaries + hasMore + nextCursor).
 * Status/Saga/date-range filters run server-side; free-text search stays
 * client-side over each loaded slice (see lib/history-view.ts), and is never
 * presented as a server total.
 */
export async function fetchExecutionHistory(query: HistoryListQuery = {}): Promise<ExecutionHistoryResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", statusParam(query.status));
  if (query.sagaId) params.set("sagaId", query.sagaId);
  if (query.sagaName) params.set("sagaName", query.sagaName);
  if (query.startDate) params.set("startDate", query.startDate);
  if (query.endDate) params.set("endDate", query.endDate);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const data = await get(`/api/executions${suffix}`);
  if (!isHistoryResponse(data)) throw new Error("Unexpected history response shape.");
  return data;
}

/** GET /api/sagas — Sagas catalog (read-only discovery metadata). */
export async function listSagas(): Promise<SagasResponse> {
  const data = await get("/api/sagas");
  if (!isSagasResponse(data)) throw new Error("Unexpected sagas response shape.");
  return data;
}

/** GET /api/executions/:id — Execution detail with Operations + runtimeStatus. */
export async function fetchExecutionDetail(id: string): Promise<ExecutionDetail> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Unexpected Execution ID shape.");
  const data = await get(`/api/executions/${id}`);
  if (!isDetailResponse(data)) throw new Error("Unexpected detail response shape.");
  return data;
}

/** Terminal Execution statuses: polling stops here (mirrors upstream's terminal set). */
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ["Succeeded", "Failed", "TimedOut", "Cancelled"];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** POST /api/executions/:id/cancel — owner-only cancellation. */
export async function cancelExecution(
  id: string,
): Promise<{ executionId: string; status: string; cancelled: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Unexpected Execution ID shape.");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/executions/${id}/cancel`, { method: "POST", headers });
  if (!response.ok) throw await parseApiError(response);
  const data = (await response.json()) as { executionId?: unknown; status?: unknown; cancelled?: unknown };
  if (typeof data.executionId !== "string" || typeof data.status !== "string" || typeof data.cancelled !== "boolean") {
    throw new Error("Unexpected cancel response shape.");
  }
  return { executionId: data.executionId, status: data.status, cancelled: data.cancelled };
}

const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAppSummary(value: unknown): value is AppSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["slug"] === "string" &&
    (v["ownerKind"] === "independent" || v["ownerKind"] === "solution") &&
    ["created", "ready", "building", "live", "failed"].includes(v["status"] as string)
  );
}

function isAppDetail(value: unknown): value is AppDetail {
  if (!isAppSummary(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return Array.isArray(v["revisions"]) && Array.isArray(v["jobs"]);
}

function isAppJob(value: unknown): value is AppJob {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["revision"] === "number" &&
    ["queued", "running", "succeeded", "failed"].includes(v["status"] as string)
  );
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

async function putJson(path: string, body: unknown): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(path, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

/** GET /api/apps — Applications for this Organization (ADR 017). */
export async function listApps(): Promise<AppsResponse> {
  const data = await get("/api/apps");
  if (typeof data !== "object" || data === null || !Array.isArray((data as { apps?: unknown }).apps)) {
    throw new Error("Unexpected apps response shape.");
  }
  const apps = (data as { apps: unknown[] }).apps;
  if (!apps.every(isAppSummary)) throw new Error("Unexpected apps response shape.");
  return { apps };
}

/** POST /api/apps — create an independent app (no draft/publish step). */
export async function createApp(name: string, slug: string): Promise<AppSummary> {
  const data = await postJson("/api/apps", { name, slug });
  const app = (data as { app?: unknown }).app;
  if (!isAppSummary(app)) throw new Error("Unexpected app response shape.");
  return app;
}

/** GET /api/apps/:id — app detail with revisions, jobs, active deployment. */
export async function fetchAppDetail(id: string): Promise<AppDetail> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await get(`/api/apps/${id}`);
  const app = (data as { app?: unknown }).app;
  if (!isAppDetail(app)) throw new Error("Unexpected app response shape.");
  return app;
}

/** PUT /api/apps/:id/source — edit source declarations (independent only). */
export async function editAppSource(id: string, files: AppFile[], dependencies: AppDependency[]): Promise<AppRevision> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await putJson(`/api/apps/${id}/source`, { files, dependencies });
  const revision = (data as { revision?: unknown }).revision;
  if (typeof revision !== "object" || revision === null) throw new Error("Unexpected revision response shape.");
  return revision as AppRevision;
}

/** POST /api/apps/:id/validate — validate the current revision. */
export async function validateApp(id: string): Promise<AppRevision> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await postJson(`/api/apps/${id}/validate`, {});
  const revision = (data as { revision?: unknown }).revision;
  if (typeof revision !== "object" || revision === null) throw new Error("Unexpected revision response shape.");
  return revision as AppRevision;
}

/** POST /api/apps/:id/builds — start an async deploy job (validate-gated). */
export async function startAppBuild(id: string): Promise<AppJob> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await postJson(`/api/apps/${id}/builds`, {});
  const job = (data as { job?: unknown }).job;
  if (!isAppJob(job)) throw new Error("Unexpected job response shape.");
  return job;
}

/** GET /api/apps/:id/builds — inspect the async deploy-job queue. */
export async function listAppJobs(id: string): Promise<AppJob[]> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const data = await get(`/api/apps/${id}/builds`);
  const jobs = (data as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs) || !jobs.every(isAppJob)) throw new Error("Unexpected jobs response shape.");
  return jobs;
}

/** GET /api/apps/:id/builds/:jobId — inspect one deploy job. */
export async function fetchAppJob(id: string, jobId: string): Promise<AppJob> {
  if (!APP_ID.test(id) || !APP_ID.test(jobId)) throw new Error("Unexpected App ID shape.");
  const data = await get(`/api/apps/${id}/builds/${jobId}`);
  const job = (data as { job?: unknown }).job;
  if (!isAppJob(job)) throw new Error("Unexpected job response shape.");
  return job;
}

/** POST /api/apps/:id/swap — parked-old-app slug-swap recovery. */
export async function swapAppSlugs(id: string, otherAppId: string): Promise<{ app: AppSummary; other: AppSummary }> {
  if (!APP_ID.test(id) || !APP_ID.test(otherAppId)) throw new Error("Unexpected App ID shape.");
  const data = await postJson(`/api/apps/${id}/swap`, { otherAppId });
  const body = data as { app?: unknown; other?: unknown };
  if (!isAppSummary(body.app) || !isAppSummary(body.other)) throw new Error("Unexpected swap response shape.");
  return { app: body.app, other: body.other };
}

/** DELETE /api/apps/:id — delete an independent app (owned rows refuse). */
export async function deleteApp(id: string): Promise<void> {
  if (!APP_ID.test(id)) throw new Error("Unexpected App ID shape.");
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`/api/apps/${id}`, { method: "DELETE", headers });
  if (!response.ok) throw await parseApiError(response);
}
