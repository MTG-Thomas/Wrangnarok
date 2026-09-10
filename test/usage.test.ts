// Unit tests for the usage block helpers in src/usage.ts: console emission
// shape plus persisted-record success and best-effort skip paths.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bindings } from "../src/bindings";
import { buildUsage, logUsage, persistUsage } from "../src/usage";
import type { UsageBlock } from "../src/usage";
import migration from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;

function sampleUsage(): UsageBlock {
  return buildUsage({
    saga: "system.smoke",
    sagaRevision: "system.smoke-v1",
    executionId: "ab".repeat(32),
    orgId: "00000000-0000-4000-8000-000000000001",
    status: "Succeeded",
    operationRows: 4,
    reads: 4,
    writes: 8,
    stepsExecuted: 4,
    durationMs: 12,
  });
}

beforeEach(async () => {
  await bindings.DB.exec(migration);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(seed);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("emits the usage block as one JSON line behind a stable prefix", async () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  logUsage(sampleUsage());
  expect(lines).toHaveLength(1);
  expect(lines[0]?.startsWith("WRANGNAROK_USAGE ")).toBe(true);
  expect(JSON.parse(lines[0]?.slice("WRANGNAROK_USAGE ".length) ?? "")).toMatchObject({
    version: "wrangnarok.usage.v1",
    status: "Succeeded",
  });
});

it("persists the usage record and skips best-effort when the table is missing", async () => {
  const usage = sampleUsage();
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      usage.executionId,
      "id",
      "system.smoke",
      "system.smoke-v1",
      usage.orgId,
      "00000000-0000-4000-8000-000000000002",
      "{}",
      1,
      "Succeeded",
      new Date().toISOString(),
    )
    .run();
  await persistUsage(bindings.DB, usage.executionId, usage);
  const row = await bindings.DB.prepare("SELECT usage_json FROM usage_blocks WHERE execution_id=?")
    .bind(usage.executionId)
    .first<{ usage_json: string }>();
  expect(JSON.parse(row?.usage_json ?? "")).toMatchObject({ executionId: usage.executionId });

  // Pre-migration database: the insert throws, the Execution must not fail.
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((line: string) => {
    warnings.push(line);
  });
  const oldDb = {
    prepare: () => {
      throw new Error("no such table: usage_blocks");
    },
  } as unknown as D1Database;
  await persistUsage(oldDb, usage.executionId, usage);
  expect(warnings).toEqual([`WRANGNAROK_USAGE_PERSIST_SKIPPED ${usage.executionId}`]);
});
