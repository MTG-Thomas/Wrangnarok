// SPDX-License-Identifier: AGPL-3.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExecutionSummary } from "../client/src/lib/client-types";
import {
  EMPTY_HISTORY_FILTERS,
  filterExecutions,
  formatExecutionDuration,
  formatExecutionTime,
  groupExecutionsByDay,
  hasActiveHistoryFilters,
  summarizeExecutions,
} from "../client/src/lib/history-view";
import { fetchExecutionHistory } from "../client/src/lib/api-client";
import { ExecutionHistoryList } from "../client/src/pages/ExecutionHistory";
import type { ExecutionHistoryResponse } from "../client/src/lib/client-types";

function row(overrides: Partial<ExecutionSummary> & { executionId: string }): ExecutionSummary {
  return {
    sagaId: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
    sagaName: "echo",
    sagaRevision: "echo-v1",
    orgId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    status: "Succeeded",
    dispatchConfirmed: true,
    createdAt: "2026-09-10T08:00:00.000Z",
    startedAt: "2026-09-10T08:00:01.000Z",
    completedAt: "2026-09-10T08:00:02.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-09-10T12:00:00.000Z");

describe("filterExecutions", () => {
  const rows = [
    row({ executionId: "a".repeat(64), sagaName: "echo", status: "Succeeded" }),
    row({ executionId: "b".repeat(64), sagaName: "ninjaone-orgs", status: "Failed" }),
    row({ executionId: "c".repeat(64), sagaName: "echo", status: "Running", startedAt: null, completedAt: null }),
  ];

  it("matches search across Saga name, user, Execution ID, and status", () => {
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, search: "ninja" })).toHaveLength(1);
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, search: "NINJA" }).map((r) => r.sagaName)).toEqual([
      "ninjaone-orgs",
    ]);
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, search: "bbbb" }).map((r) => r.executionId)).toEqual([
      "b".repeat(64),
    ]);
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, search: "running" }).map((r) => r.status)).toEqual([
      "Running",
    ]);
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, search: "00000000-0000-4000" })).toHaveLength(3);
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, search: "nope" })).toHaveLength(0);
  });

  it("filters by exact Saga name and status pill", () => {
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, sagaName: "echo" })).toHaveLength(2);
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, status: "Failed" }).map((r) => r.sagaName)).toEqual([
      "ninjaone-orgs",
    ]);
    expect(filterExecutions(rows, { ...EMPTY_HISTORY_FILTERS, sagaName: "echo", status: "Succeeded" })).toHaveLength(1);
  });

  it("bounds by inclusive calendar day on the anchor date", () => {
    const dayRows = [
      row({
        executionId: "d".repeat(64),
        startedAt: "2026-09-08T23:59:00.000Z",
        createdAt: "2026-09-08T23:58:00.000Z",
      }),
      row({
        executionId: "e".repeat(64),
        startedAt: "2026-09-09T00:01:00.000Z",
        createdAt: "2026-09-09T00:00:00.000Z",
      }),
    ];
    const one = { ...EMPTY_HISTORY_FILTERS, localTime: false, from: "2026-09-09", to: "2026-09-09" };
    expect(filterExecutions(dayRows, one).map((r) => r.executionId)).toEqual(["e".repeat(64)]);
    expect(filterExecutions(dayRows, { ...EMPTY_HISTORY_FILTERS, localTime: false, from: "2026-09-09" })).toHaveLength(
      1,
    );
    expect(filterExecutions(dayRows, { ...EMPTY_HISTORY_FILTERS, localTime: false, to: "2026-09-08" })).toHaveLength(1);
  });
});

describe("summarizeExecutions", () => {
  it("counts the loaded page by status", () => {
    const summary = summarizeExecutions([
      row({ executionId: "a".repeat(64), status: "Succeeded" }),
      row({ executionId: "b".repeat(64), status: "Succeeded" }),
      row({ executionId: "c".repeat(64), status: "Failed" }),
      row({ executionId: "d".repeat(64), status: "Cancelling" }),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.byStatus).toEqual({ Succeeded: 2, Failed: 1, Cancelling: 1 });
  });
});

describe("groupExecutionsByDay", () => {
  it("labels Today/Yesterday, orders newest first, undated last", () => {
    const groups = groupExecutionsByDay(
      [
        row({
          executionId: "a".repeat(64),
          startedAt: "2026-09-10T08:00:00.000Z",
          createdAt: "2026-09-10T07:59:00.000Z",
        }),
        row({
          executionId: "b".repeat(64),
          startedAt: "2026-09-09T08:00:00.000Z",
          createdAt: "2026-09-09T07:59:00.000Z",
        }),
      ],
      false,
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]?.executions.map((e) => e.executionId)[0]).toBe("a".repeat(64));
  });
});

describe("formatExecutionDuration", () => {
  it("compacts durations and returns null when open", () => {
    expect(formatExecutionDuration("2026-09-10T08:00:00.000Z", "2026-09-10T08:00:00.412Z")).toBe("412ms");
    expect(formatExecutionDuration("2026-09-10T08:00:00.000Z", "2026-09-10T08:00:03.000Z")).toBe("3s");
    expect(formatExecutionDuration("2026-09-10T08:00:00.000Z", "2026-09-10T08:01:12.000Z")).toBe("1m 12s");
    expect(formatExecutionDuration("2026-09-10T08:00:00.000Z", null)).toBeNull();
    expect(formatExecutionDuration(null, null)).toBeNull();
    expect(formatExecutionDuration("2026-09-10T08:00:02.000Z", "2026-09-10T08:00:01.000Z")).toBeNull();
  });
});

describe("formatExecutionTime", () => {
  it("shows time-only for today and day plus time otherwise (UTC)", () => {
    expect(formatExecutionTime("2026-09-10T08:12:00.000Z", false, NOW)).toBe("08:12 UTC");
    expect(formatExecutionTime("2026-09-09T08:12:00.000Z", false, NOW)).toBe("2026-09-09, 08:12 UTC");
    expect(formatExecutionTime(null, false, NOW)).toBe("—");
    expect(formatExecutionTime("not-a-date", false, NOW)).toBe("not-a-date");
  });
});

describe("hasActiveHistoryFilters", () => {
  it("is false for the empty state and true for any narrowing filter", () => {
    expect(hasActiveHistoryFilters(EMPTY_HISTORY_FILTERS)).toBe(false);
    expect(hasActiveHistoryFilters({ ...EMPTY_HISTORY_FILTERS, search: "x" })).toBe(true);
    expect(hasActiveHistoryFilters({ ...EMPTY_HISTORY_FILTERS, status: "Failed" })).toBe(true);
    expect(hasActiveHistoryFilters({ ...EMPTY_HISTORY_FILTERS, to: "2026-09-09" })).toBe(true);
    expect(hasActiveHistoryFilters({ ...EMPTY_HISTORY_FILTERS, localTime: false })).toBe(false);
  });
});

describe("fetchExecutionHistory server query", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the allowlisted status/sagaId/sagaName/date/limit/cursor keys", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      seen.push(String(input));
      return Response.json({ executions: [], hasMore: false, nextCursor: null });
    }) as typeof fetch);
    await fetchExecutionHistory();
    await fetchExecutionHistory({ status: "Failed" });
    await fetchExecutionHistory({ status: ["Failed", "TimedOut"] });
    await fetchExecutionHistory({
      status: "Failed",
      sagaId: "2c79a880-f1ac-4183-b324-d05daffc321a",
      sagaName: "ninjaone-orgs",
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      limit: 5,
      cursor: "cursor-2",
    });
    expect(seen).toEqual([
      "/api/executions",
      "/api/executions?status=Failed",
      "/api/executions?status=Failed%2CTimedOut",
      "/api/executions?status=Failed&sagaId=2c79a880-f1ac-4183-b324-d05daffc321a&sagaName=ninjaone-orgs&startDate=2026-09-01&endDate=2026-09-10&limit=5&cursor=cursor-2",
    ]);
  });
});

describe("ExecutionHistory page structure", () => {
  const payload: ExecutionHistoryResponse = {
    executions: [
      row({ executionId: "a".repeat(64), sagaName: "echo", status: "Succeeded" }),
      row({
        executionId: "b".repeat(64),
        sagaId: "2c79a880-f1ac-4183-b324-d05daffc321a",
        sagaName: "ninjaone-orgs",
        sagaRevision: "ninjaone-orgs-v1",
        status: "Failed",
      }),
    ],
    hasMore: true,
    nextCursor: null,
  };

  function html(): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ExecutionHistoryList initial={payload} />
      </MemoryRouter>,
    );
  }

  it("renders the header summary with loaded-slice counts", () => {
    const page = html();
    expect(page).toContain("history-summary");
    expect(page).toContain("2 Executions loaded");
    expect(page).toContain("1 Succeeded");
    expect(page).toContain("1 Failed");
    expect(page).toContain("more available server-side");
  });

  it("renders the Bifrost-style filter bar and status pills", () => {
    const page = html();
    expect(page).toContain("Name search");
    expect(page).toContain("All Sagas");
    expect(page).toContain("ninjaone-orgs");
    expect(page).toContain("Local time");
    expect(page).toContain("From");
    expect(page).toContain("(server)");
    expect(page).toContain("(loaded pages only)");
    expect(page).toContain(">All<span");
    for (const status of ["Pending", "Running", "Succeeded", "Failed", "TimedOut", "Cancelling", "Cancelled"]) {
      expect(page).toContain(status);
    }
  });

  it("renders Organization / Run by / Started / Duration columns with day groups and detail chevrons", () => {
    const page = html();
    for (const column of ["Organization", "Saga", "Status", "Run by", "Started", "Duration"]) {
      expect(page).toContain(column);
    }
    expect(page).toContain("history-day-row");
    expect(page).toContain(`/history/${"a".repeat(64)}`);
    expect(page).toContain("Open Execution");
    expect(page).toContain("›");
  });

  it("keeps our vocabulary: no Workflow, run, or Agents language", () => {
    const page = html();
    expect(page).not.toContain("Workflow");
    expect(page).not.toContain("Agents");
    expect(page).not.toContain("agents");
  });
});
