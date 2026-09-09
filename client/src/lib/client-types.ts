// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/client-types.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök shapes only.

/** Execution status values served by the Wrangnarök Worker. */
export type ExecutionStatus =
  | "Pending"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Cancelled";

/** One durable unit of Saga execution (maps to a Workflow step). */
export interface OperationSummary {
  name: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  result: unknown;
  error: unknown;
}

/** Row shape for GET /api/executions (20 + hasMore, no input/results in rows). */
export interface ExecutionSummary {
  executionId: string;
  sagaId: string;
  sagaName: string;
  sagaRevision: string;
  orgId: string;
  userId: string;
  status: ExecutionStatus;
  dispatchConfirmed: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExecutionHistoryResponse {
  executions: ExecutionSummary[];
  hasMore: boolean;
}

/** Detail shape for GET /api/executions/:id. */
export interface ExecutionDetail extends ExecutionSummary {
  runtimeStatus: string | null;
  input: unknown;
  result: unknown;
  error: unknown;
  operations: OperationSummary[];
}
