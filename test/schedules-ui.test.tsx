// SPDX-License-Identifier: AGPL-3.0
// Schedules UI (TRG-01, issue #137): list/detail render from mocked /api/*
// payloads. Promotion/dispatch flow is covered by the workerd tests (real
// local D1/Workflow bindings); this suite pins the read slice rendering.
import { expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchScheduleDetail, listSchedules } from "../client/src/lib/api-client";
import type { ScheduleDetailResponse, SchedulesResponse } from "../client/src/lib/client-types";
import { ScheduleDetailView, SchedulesList } from "../client/src/pages/Schedules";

const listPayload: SchedulesResponse = {
  schedules: [
    {
      id: "395e15f0-3627-41f6-8922-008ce37e3b99",
      name: "morning",
      sagaId: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
      enabled: true,
      kind: "recurring",
      cron: "0 * * * *",
      timezone: "UTC",
      nextDueAt: "2026-09-13T00:00:00.000Z",
      lastWindow: "2026-09-12T00:00",
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
    {
      id: "395e15f0-3627-41f6-8922-008ce37e3c00",
      name: "once",
      sagaId: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
      enabled: false,
      kind: "one-off",
      cron: null,
      timezone: "UTC",
      nextDueAt: null,
      lastWindow: null,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
  ],
};

const detailPayload: ScheduleDetailResponse = {
  schedule: listPayload.schedules[0] as ScheduleDetailResponse["schedule"],
  deliveries: [
    {
      window: "2026-09-12T00:00",
      executionId: "a".repeat(64),
      createdAt: "2026-09-12T00:00:01.000Z",
    },
  ],
};

it("lists schedules with kind/state/next-due and renders one delivery ledger", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/schedules") return Response.json(listPayload);
    if (url === "/api/schedules/morning") return Response.json(detailPayload);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    expect(await listSchedules()).toEqual(listPayload);
    expect(await fetchScheduleDetail("morning")).toEqual(detailPayload);
    const listHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SchedulesList initial={listPayload} />
      </MemoryRouter>,
    );
    expect(listHtml).toContain("Schedules");
    expect(listHtml).toContain("morning");
    expect(listHtml).toContain("recurring");
    expect(listHtml).toContain("/schedules/morning");
    const detailHtml = renderToStaticMarkup(
      <MemoryRouter>
        <ScheduleDetailView name="morning" initial={detailPayload} />
      </MemoryRouter>,
    );
    expect(detailHtml).toContain("Schedule morning");
    expect(detailHtml).toContain("Deliveries");
    expect(detailHtml).toContain("2026-09-12T00:00");
  } finally {
    fetchMock.mockRestore();
  }
});
