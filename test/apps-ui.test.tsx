// SPDX-License-Identifier: AGPL-3.0
// Applications UI (APP-01, issue #159): list/detail render from mocked
// /api/* payloads, honest about Solution-owned read-only rows. No input or
// bundle bytes leak into list rows.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchAppDetail, listApps } from "../client/src/lib/api-client";
import type { AppDetail, AppsResponse } from "../client/src/lib/client-types";
import { ApplicationDetailView, ApplicationsList } from "../client/src/pages/Applications";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

const listPayload: AppsResponse = {
  apps: [
    {
      id: APP_ID,
      name: "storefront",
      slug: "storefront",
      ownerKind: "independent",
      status: "live",
      activeDeploymentId: "33333333-3333-4333-8333-333333333333",
      revision: 2,
      updatedAt: "2026-09-11T00:00:00.000Z",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "bundle-owned",
      slug: "bundle-owned",
      ownerKind: "solution",
      status: "ready",
      activeDeploymentId: null,
      revision: 1,
      updatedAt: "2026-09-11T00:00:00.000Z",
    },
  ],
};

const detailPayload: AppDetail = {
  ...listPayload.apps[0]!,
  createdAt: "2026-09-10T00:00:00.000Z",
  revisions: [
    {
      revision: 2,
      files: [{ path: "index.html", content: "<h1>hello</h1>" }],
      dependencies: [{ name: "wrangnarok-ui", version: "1.0.0" }],
      validation: "valid",
      failures: null,
      createdAt: "2026-09-11T00:00:00.000Z",
    },
  ],
  jobs: [
    {
      id: JOB_ID,
      revision: 2,
      status: "succeeded",
      error: null,
      createdAt: "2026-09-11T00:00:00.000Z",
      startedAt: "2026-09-11T00:00:01.000Z",
      finishedAt: "2026-09-11T00:00:02.000Z",
    },
  ],
  activeDeployment: {
    id: "33333333-3333-4333-8333-333333333333",
    revision: 2,
    contentHash: "a".repeat(64),
    createdAt: "2026-09-11T00:00:02.000Z",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders Application rows with status and ownership, linking each detail", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ apps: listPayload.apps }));
  const data = await listApps();
  expect(data.apps).toHaveLength(2);

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ApplicationsList initial={data} />
    </MemoryRouter>,
  );
  expect(html).toContain("storefront");
  expect(html).toContain("bundle-owned");
  expect(html).toContain("live");
  expect(html).toContain("solution");
  expect(html).toContain(`/apps/${APP_ID}`);
  expect(html).toContain("No draft or publish step");
  const row = JSON.stringify(data.apps[0]);
  expect(row).not.toContain("content");
  expect(row).not.toContain("bundle");
});

it("renders the detail with source, jobs, recovery copy, and no rollback UI", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ app: detailPayload }));
  const data = await fetchAppDetail(APP_ID);
  expect(data.jobs).toHaveLength(1);

  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/apps/${APP_ID}`]}>
      <Routes>
        <Route path="/apps/:id" element={<ApplicationDetailView initial={data} />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(html).toContain("storefront");
  expect(html).toContain("Deploy jobs");
  expect(html).toContain("succeeded");
  expect(html).toContain("parked copy of the previous app");
  expect(html).toContain("No retained-history rollback exists");
  expect(html).not.toContain("Rollback to");
  expect(html).not.toContain("Publish");
  expect(html).not.toContain("Draft");
});

it("marks Solution-owned apps read-only in the detail view", async () => {
  const owned: AppDetail = {
    ...detailPayload,
    id: "44444444-4444-4444-8444-444444444444",
    name: "bundle-owned",
    ownerKind: "solution",
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ app: owned }));
  const data = await fetchAppDetail("44444444-4444-4444-8444-444444444444");

  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/apps/44444444-4444-4444-8444-444444444444"]}>
      <Routes>
        <Route path="/apps/:id" element={<ApplicationDetailView initial={data} />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(html).toContain("Solution-owned: read-only here");
  expect(html).toContain("MANAGED_RESOURCE");
});
