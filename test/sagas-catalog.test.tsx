// SPDX-License-Identifier: AGPL-3.0
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { NAV_ENTRIES, Nav } from "../client/src/components/Nav";
import { listSagas } from "../client/src/lib/api-client";
import { SagasList } from "../client/src/pages/Sagas";
import type { SagasResponse } from "../client/src/lib/client-types";

const payload: SagasResponse = {
  sagas: [
    {
      id: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
      name: "echo",
      revision: "echo-v1",
      description: "MVP slice: prepare input and call the local HTTP echo Integration",
    },
    {
      id: "2c79a880-f1ac-4183-b324-d05daffc321a",
      name: "ninjaone-orgs",
      revision: "ninjaone-orgs-v1",
      description: "Rung 1: list NinjaOne organizations read-only over client-credentials OAuth",
    },
    {
      id: "5f3bf136-ba9e-4529-8842-6786270ee80d",
      name: "ninjaone-echo-digest",
      revision: "ninjaone-echo-digest-v1",
      description: "Phase 2: NinjaOne organization census digested through the echo Integration",
    },
    {
      id: "7a1f3c5e-9b2d-4f6a-8c1e-5d3b7a9f1c2e",
      name: "system.smoke",
      revision: "system.smoke-v1",
      description:
        "Platform smoke: Worker request handling, D1 write/read verification, multi-Operation Workflow, terminal persistence, usage block — no vendor dependency",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders the Sagas catalog from a mocked /api/sagas payload", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ sagas: payload.sagas }));
  const data = await listSagas();
  expect(data.sagas).toHaveLength(4);

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SagasList initial={data} />
    </MemoryRouter>,
  );
  for (const saga of payload.sagas) {
    expect(html).toContain(saga.name);
    expect(html).toContain(saga.revision);
    expect(html).toContain(saga.description);
    expect(html).toContain(saga.id.slice(0, 12));
    expect(html).toContain(`title="${saga.id}"`);
  }
  expect(html).toContain("Sagas");
});

it("shows Sagas enabled in nav while other unported entries stay disabled", () => {
  const sagas = NAV_ENTRIES.find((entry) => entry.to === "/sagas");
  expect(sagas).toBeDefined();
  expect(sagas?.enabled).toBe(true);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Nav />
    </MemoryRouter>,
  );
  expect(html).toContain("/sagas");
  expect(html).toContain("Sagas and Catalog");
  for (const entry of NAV_ENTRIES.filter((e) => !e.enabled)) {
    expect(entry.issue).toBeDefined();
    expect(html).toContain(entry.label);
    expect(html).toContain(entry.issue as string);
  }
});
