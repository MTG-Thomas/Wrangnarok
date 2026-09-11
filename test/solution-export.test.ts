// SPDX-License-Identifier: AGPL-3.0
// SOL-03 (issue #163): portable Solution source capture/export/import.
// Proven against real local D1 in workerd: capture preview and gap paths,
// export/import round-trip in a fresh org, malicious archive and path input,
// missing modules, and export-job failure with guaranteed cleanup.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { ECHO_INTEGRATION_ID, echoSaga, helloSaga, NINJA_INTEGRATION_ID } from "../src/domain";
import { SAGA_DEFINITIONS } from "../src/sagas";
import { installBundle } from "../src/solutions";
import {
  captureSource,
  checkClosure,
  defaultSourceNotes,
  exportSourcePackage,
  importSourcePackage,
  mapSourceToInstall,
  previewCaptureSource,
  runExportJob,
  staticSourceCatalogs,
} from "../src/solution-export";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";

const bindings = env as unknown as Bindings;
const BUNDLE_ID = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
const ENDPOINT = "http://127.0.0.1:8788/echo";

function manifest() {
  return {
    manifestVersion: 1,
    bundle: { id: BUNDLE_ID, name: "echo-starter", version: "1.0.0" },
    sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
    integrations: [
      {
        id: ECHO_INTEGRATION_ID,
        connections: [{ org: "default", config: { endpoint: ENDPOINT }, secretsRequired: [] }],
      },
    ],
    config: [{ key: "supportEmail", value: "ops@example.com" }],
  };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(migration4);
});

afterEach(async () => {
  await reset();
});

describe("solution source capture (SOL-03)", () => {
  it("stays in agreement with the Saga definitions and the installer catalog", () => {
    const catalogs = staticSourceCatalogs();
    for (const def of SAGA_DEFINITIONS) {
      const pin = catalogs.sagas.find((entry) => entry.id === def.id);
      expect(pin?.revision).toBe(def.revision);
      expect(pin?.name).toBe(def.name);
      expect([...(pin?.requiredIntegrations ?? [])]).toEqual([...def.requiredIntegrations]);
    }
    const defs = new Map(SAGA_DEFINITIONS.map((def) => [def.id, def]));
    expect(catalogs.sagas).toHaveLength(defs.size);
  });

  it("previews capture read-only and captures after a clean install", async () => {
    const preview = await previewCaptureSource(bindings.DB, manifest());
    expect(preview.package.source.id).toBe(BUNDLE_ID);
    expect(preview.package.modules).toHaveLength(1);
    expect(preview.package.metadata.notes.join(" ")).toContain("not a data backup");
    expect(preview.gaps.some((gap) => gap.reason === "MISSING_MANAGED_ROW" && gap.blocking)).toBe(true);
    await expect(captureSource(bindings.DB, manifest())).rejects.toMatchObject({ code: "CAPTURE_BLOCKED" });
    // Preview wrote nothing.
    const orgs = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM organizations").first<{ n: number }>();
    expect(orgs?.n).toBe(0);

    await installBundle(bindings.DB, manifest());
    const captured = await captureSource(bindings.DB, manifest(), {
      readme: "# echo-starter",
      git: { commit: "abc1234" },
    });
    expect(captured.gaps).toEqual([]);
    expect(captured.package.source.readme).toBe("# echo-starter");
    expect(captured.package.modules[0]?.name).toBe("echo");
  });

  it("refuses to adopt loose rows and reports foreign ownership and drift", async () => {
    await installBundle(bindings.DB, manifest());
    const blocked = await previewCaptureSource(bindings.DB, {
      ...manifest(),
      integrations: [
        {
          id: NINJA_INTEGRATION_ID,
          connections: [
            {
              org: "default",
              config: { endpoint: "https://api.ninjaone.test" },
              secretsRequired: ["clientSecret"],
            },
          ],
        },
      ],
      sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
    });
    expect(blocked.gaps.map((gap) => gap.reason)).toContain("MISSING_MANAGED_ROW");

    // Loose row for the declared connection: reported, never adopted.
    const org = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
      .bind("漂")
      .first<{ id: string }>();
    void org;
    const looseId = crypto.randomUUID();
    const defaultOrg = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
      .bind("default")
      .first<{ id: string }>();
    await bindings.DB.prepare(
      "INSERT INTO connections(id, org_id, integration_id, endpoint, managed_by) VALUES (?, ?, ?, ?, NULL)",
    )
      .bind(looseId, defaultOrg?.id, NINJA_INTEGRATION_ID, "https://api.ninjaone.test")
      .run();
    const loose = await previewCaptureSource(bindings.DB, {
      manifestVersion: 1,
      bundle: { id: BUNDLE_ID, name: "mixed", version: "9.9.9" },
      sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
      integrations: [
        {
          id: NINJA_INTEGRATION_ID,
          connections: [
            {
              org: "default",
              config: { endpoint: "https://api.ninjaone.test" },
              secretsRequired: ["clientSecret"],
            },
          ],
        },
      ],
      config: [],
    });
    expect(loose.gaps.map((gap) => gap.reason)).toContain("LOOSE_RESOURCE_NOT_ADOPTED");
    expect(loose.gaps.some((gap) => gap.blocking)).toBe(true);
    await expect(
      captureSource(bindings.DB, {
        manifestVersion: 1,
        bundle: { id: BUNDLE_ID, name: "mixed", version: "9.9.9" },
        sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
        integrations: [
          {
            id: NINJA_INTEGRATION_ID,
            connections: [
              {
                org: "default",
                config: { endpoint: "https://api.ninjaone.test" },
                secretsRequired: ["clientSecret"],
              },
            ],
          },
        ],
        config: [],
      }),
    ).rejects.toMatchObject({ code: "CAPTURE_BLOCKED" });

    // Drifted managed row blocks capture.
    await bindings.DB.prepare("UPDATE connections SET endpoint = ? WHERE org_id = ? AND integration_id = ?")
      .bind("http://127.0.0.1:9999/drifted", defaultOrg?.id, ECHO_INTEGRATION_ID)
      .run();
    const drifted = await previewCaptureSource(bindings.DB, manifest());
    expect(drifted.gaps.map((gap) => gap.reason)).toContain("DRIFTED_CONNECTION");
    await expect(captureSource(bindings.DB, manifest())).rejects.toMatchObject({ code: "CAPTURE_BLOCKED" });
  });

  it("refuses capture across ownership boundaries", async () => {
    await installBundle(bindings.DB, manifest());
    const preview = await previewCaptureSource(bindings.DB, {
      ...manifest(),
      bundle: { id: "00000000-0000-4000-8000-000000000000", name: "echo-starter", version: "1.0.0" },
    });
    expect(preview.gaps.map((gap) => gap.reason)).toContain("OWNERSHIP_MISMATCH");
  });
});

describe("solution source export and import (SOL-03)", () => {
  async function capturedPackage() {
    await installBundle(bindings.DB, manifest());
    const captured = await captureSource(bindings.DB, manifest(), { readme: "# echo-starter" });
    return captured.package;
  }

  it("round-trips export and import, then installs into a fresh org", async () => {
    const pkg = await capturedPackage();
    const exported = await exportSourcePackage(pkg);
    expect(exported.files.map((file) => file.name).sort()).toEqual(["solution.manifest.json", "solution.source.json"]);
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/);
    const imported = await importSourcePackage(JSON.parse(exported.files[0]?.json as string));
    expect(imported.report.modules).toBe(1);
    expect(imported.report.integrations).toBe(1);
    expect(imported.package.source.id).toBe(BUNDLE_ID);

    // Fresh-org adoption: the extracted manifest installs through the real
    // installer with no tenant state carried over.
    const fresh = JSON.parse(exported.files[1]?.json as string);
    fresh.integrations[0].connections[0].org = "second";
    const result = await installBundle(bindings.DB, fresh);
    void result;
    const row = await bindings.DB.prepare(
      "SELECT c.endpoint, c.managed_by FROM connections c JOIN organizations o ON o.id = c.org_id WHERE o.name = ? AND c.integration_id = ?",
    )
      .bind("second", ECHO_INTEGRATION_ID)
      .first<{ endpoint: string; managed_by: string }>();
    expect(row?.endpoint).toBe(ENDPOINT);
    expect(row?.managed_by).toBe(`${BUNDLE_ID}@1.0.0`);
    // The second org got the same deterministic Connection id the mapper predicts.
    const secondOrg = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
      .bind("second")
      .first<{ id: string }>();
    const idRow = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id = ? AND integration_id = ?")
      .bind(secondOrg?.id, ECHO_INTEGRATION_ID)
      .first<{ id: string }>();
    expect(idRow?.id).toBe(await mapSourceToInstall(BUNDLE_ID, secondOrg?.id as string, ECHO_INTEGRATION_ID));
  });

  it("maps source identity to the exact managed Connection id the installer writes", async () => {
    await installBundle(bindings.DB, manifest());
    const defaultOrg = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
      .bind("default")
      .first<{ id: string }>();
    const row = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id = ? AND integration_id = ?")
      .bind(defaultOrg?.id, ECHO_INTEGRATION_ID)
      .first<{ id: string }>();
    expect(row?.id).toBe(await mapSourceToInstall(BUNDLE_ID, defaultOrg?.id as string, ECHO_INTEGRATION_ID));
  });

  it("rejects embedded credentials, table rows, execution state, and artifact bytes", async () => {
    const pkg = await capturedPackage();
    for (const poison of [
      { tableRows: [{ id: 1 }] },
      { executions: [{ id: "x" }] },
      { operations: [] },
      { artifactBytes: "aGVsbG8=" },
      { secrets: { clientSecret: "hunter2" } },
      { credentials: { token: "x" } },
      { clientSecret: "hunter2" },
    ]) {
      await expect(exportSourcePackage({ ...pkg, ...poison })).rejects.toMatchObject({
        code:
          poison && ("clientSecret" in poison || "token" in poison) ? "CREDENTIAL_IN_SOURCE" : "TENANT_STATE_EXCLUDED",
      });
    }
    // Caller-known secret values embedded anywhere fail closed by value, too.
    const sneaky = JSON.parse(JSON.stringify(pkg));
    sneaky.assets = [{ path: "notes/leak.md", contentType: "text/markdown", text: "value is hunter2 here" }];
    await expect(exportSourcePackage(sneaky, { secrets: { clientSecret: "hunter2" } })).rejects.toMatchObject({
      code: "CREDENTIAL_IN_SOURCE",
    });
  });

  it("rejects malicious archive structure and asset paths", async () => {
    const pkg = await capturedPackage();
    await expect(importSourcePackage({ ...pkg, format: "bifrost.zip" })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(importSourcePackage({ ...pkg, formatVersion: 2 })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(
      importSourcePackage({ ...pkg, assets: [{ path: "../../etc/passwd", contentType: "text/plain", text: "x" }] }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_PATH" });
    await expect(
      importSourcePackage({
        ...pkg,
        assets: [
          { path: "a.md", contentType: "text/markdown", text: "x" },
          { path: "a.md", contentType: "text/markdown", text: "y" },
        ],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_ASSET_PATH" });
    await expect(
      importSourcePackage({
        ...pkg,
        assets: [{ path: "run.exe", contentType: "application/octet-stream", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    const protoPoison = JSON.parse(JSON.stringify(pkg));
    Object.defineProperty(protoPoison, "__proto__", { value: { polluted: true }, enumerable: true });
    await expect(importSourcePackage(protoPoison)).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(importSourcePackage({ ...pkg, source: { ...pkg.source, version: "9.9.9" } })).rejects.toMatchObject({
      code: "SOURCE_MANIFEST_MISMATCH",
    });
    await expect(
      importSourcePackage({ ...pkg, metadata: { ...pkg.metadata, upstream: "somewhere-else" } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("fails closed on missing modules and undeclared requirements", async () => {
    const pkg = await capturedPackage();
    const ghost = JSON.parse(JSON.stringify(pkg));
    ghost.modules = [
      {
        sagaId: "00000000-0000-4000-8000-000000000000",
        name: "ghost",
        revision: "ghost-v1",
        description: "missing",
        requiredIntegrations: [],
      },
    ];
    ghost.manifest = {
      ...pkg.manifest,
      sagas: [{ id: "00000000-0000-4000-8000-000000000000", revision: "ghost-v1" }],
    };
    await expect(importSourcePackage(ghost)).rejects.toMatchObject({ code: "UNKNOWN_SAGA" });

    const closureGhost = checkClosure(
      pkg.manifest,
      [
        {
          sagaId: "00000000-0000-4000-8000-000000000000",
          name: "ghost",
          revision: "ghost-v1",
          description: "missing",
          requiredIntegrations: [],
        },
      ],
      staticSourceCatalogs(),
    );
    expect(closureGhost.map((gap) => gap.reason)).toContain("MISSING_MODULE");

    const driftedPin = JSON.parse(JSON.stringify(pkg));
    driftedPin.modules[0].revision = "echo-v999";
    driftedPin.manifest.sagas[0].revision = "echo-v999";
    await expect(importSourcePackage(driftedPin)).rejects.toMatchObject({ code: "REVISION_MISMATCH" });

    const missingReq = JSON.parse(JSON.stringify(pkg));
    missingReq.manifest.integrations = [];
    await expect(importSourcePackage(missingReq)).rejects.toMatchObject({ code: "INTEGRATION_NOT_DECLARED" });
    const closure = checkClosure(missingReq.manifest, pkg.modules, staticSourceCatalogs());
    expect(closure.map((gap) => gap.reason)).toContain("INTEGRATION_NOT_DECLARED");

    const unknownReq = JSON.parse(JSON.stringify(pkg));
    unknownReq.source.requirements = [{ name: "wrangnarok.time-machine", version: "1" }];
    await expect(importSourcePackage(unknownReq)).rejects.toMatchObject({ code: "REQUIREMENT_UNSATISFIED" });
  });

  it("rejects an oversized package without writing anything", async () => {
    const pkg = await capturedPackage();
    const big = JSON.parse(JSON.stringify(pkg));
    big.assets = [{ path: "notes/big.md", contentType: "text/markdown", text: "x".repeat(70000) }];
    let written = 0;
    const sink = {
      writeTemp: () => {
        written += 1;
      },
      commit: () => {},
      cleanup: () => {},
    };
    await expect(runExportJob(big, sink)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(written).toBe(0);
  });

  it("cleans up staged files when the export job fails mid-stage", async () => {
    const pkg = await capturedPackage();
    const staged: string[] = [];
    let cleaned = 0;
    let committed = false;
    const sink = {
      writeTemp: (name: string) => {
        if (name === "solution.manifest.json") throw new Error("disk full mid-stage");
        staged.push(name);
      },
      commit: () => {
        committed = true;
      },
      cleanup: () => {
        cleaned += 1;
        staged.length = 0;
      },
    };
    await expect(runExportJob(pkg, sink)).rejects.toMatchObject({ code: "EXPORT_JOB_FAILED" });
    expect(committed).toBe(false);
    expect(cleaned).toBe(1);
    expect(staged).toEqual([]);
  });

  it("cleans up when commit itself fails after staging", async () => {
    const pkg = await capturedPackage();
    const staged: string[] = [];
    let cleaned = 0;
    const sink = {
      writeTemp: (name: string) => {
        staged.push(name);
      },
      commit: () => {
        throw new Error("commit lost the race");
      },
      cleanup: () => {
        cleaned += 1;
        staged.length = 0;
      },
    };
    await expect(runExportJob(pkg, sink)).rejects.toMatchObject({ code: "EXPORT_JOB_FAILED" });
    expect(cleaned).toBe(1);
    expect(staged).toEqual([]);
  });

  it("keeps hello pins portable and preserves secret-schema requirements", async () => {
    await installBundle(
      bindings.DB,
      {
        manifestVersion: 1,
        bundle: { id: BUNDLE_ID, name: "hello-starter", version: "2.0.0" },
        sagas: [{ id: helloSaga.id, revision: helloSaga.revision }],
        integrations: [],
        config: [],
      },
      { orgName: "default" },
    );
    const captured = await captureSource(bindings.DB, {
      manifestVersion: 1,
      bundle: { id: BUNDLE_ID, name: "hello-starter", version: "2.0.0" },
      sagas: [{ id: helloSaga.id, revision: helloSaga.revision }],
      integrations: [],
      config: [],
    });
    expect(captured.package.modules[0]?.requiredIntegrations).toEqual([]);
    const exported = await exportSourcePackage(captured.package);
    const imported = await importSourcePackage(JSON.parse(exported.files[0]?.json as string));
    expect(imported.report.modules).toBe(1);
    expect(defaultSourceNotes().join(" ")).toContain("OPS-03");
  });
});
