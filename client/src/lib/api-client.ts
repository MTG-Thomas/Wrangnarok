// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/api-client.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök Bearer fixture only.
//
// Auth: the fixture token is supplied by the operator (localStorage, set via
// the Token field in the UI) and sent as `Authorization: Bearer <token>`.
// Secrets are never bundled in client code.
import { parseApiError } from "./api-error";
import type {
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
