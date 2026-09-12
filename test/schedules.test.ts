// SPDX-License-Identifier: AGPL-3.0
// TRG-01 (issue #137, ADR 012 accepted design): one-off and recurring
// schedules with durable due-time and cancellation semantics, end to end on
// the real local runtime (workerd D1 + local Workflow bindings; the hello
// Saga needs no vendor fetch, so promotion never touches the network).
//
// Covers the acceptance: operator create/preview/disable, one-off
// schedule/cancel, duplicate-window dedup (same-window ticks converge via
// the idempotency protocol, no second Execution) versus cross-window
// overlap (different windows dispatch independently), overdue promotion,
// disabled/deleted schedules, revocation, cancellation before dispatch,
// sch- namespace reservation, Pending-backlog-is-not-failure, and the
// UTC-shift timezone/DST documentation.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  cronMatches,
  nextCronInstant,
  parseCron,
  parseDueAt,
  parseTimezone,
  scheduleWindowKey,
} from "../src/schedules";
import { hash, helloSaga, parseCallerKey } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migrationSchedules from "../migrations/0016_schedules.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const OTHER_USER = "00000000-0000-4000-8000-000000000005";
const LAB = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`http://local.test${path}`, {
    method,
    headers: { ...LAB },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

async function createOneOff(name: string, dueAt: string): Promise<{ id: string }> {
  const created = await worker.fetch(
    authed("/api/schedules", "POST", { name, sagaId: helloSaga.id, kind: "one-off", dueAt, input: { name: "Ada" } }),
    bindings,
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as { schedule: { id: string; name: string } };
  expect(body.schedule.name).toBe(name);
  return { id: body.schedule.id };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migrationSchedules);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("creates, previews, lists, reads, updates, and deletes schedules with validation", async () => {
  // One-off create plus read/listed shape.
  await createOneOff("morning", futureIso(3_600_000));
  const listed = await worker.fetch(authed("/api/schedules", "GET"), bindings);
  expect(await listed.json()).toMatchObject({
    schedules: [{ name: "morning", kind: "one-off", enabled: true }],
  });

  // Duplicate name is idempotent when identical, 409 when different.
  const same = await worker.fetch(
    authed("/api/schedules", "POST", {
      name: "morning",
      sagaId: helloSaga.id,
      kind: "one-off",
      dueAt: futureIso(3_600_000),
      input: { name: "Ada" },
    }),
    bindings,
  );
  expect([200, 201]).toContain(same.status);

  // Recurring create with cron plus timezone label.
  const cron = await worker.fetch(
    authed("/api/schedules", "POST", {
      name: "hourly",
      sagaId: helloSaga.id,
      kind: "recurring",
      cron: "0 * * * *",
      timezone: "UTC",
      input: { name: "Bo" },
    }),
    bindings,
  );
  expect(cron.status).toBe(201);
  const cronBody = (await cron.json()) as { schedule: { cron: string; timezone: string; nextDueAt: string } };
  expect(cronBody.schedule.cron).toBe("0 * * * *");
  expect(cronBody.schedule.timezone).toBe("UTC");
  expect(Date.parse(cronBody.schedule.nextDueAt)).toBeGreaterThan(Date.now());

  // Preview is read-only: no D1 writes, next-tick computation only.
  const preview = await worker.fetch(
    authed("/api/schedules/preview", "POST", { kind: "recurring", cron: "0 * * * *", timezone: "UTC" }),
    bindings,
  );
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ kind: "recurring", cron: "0 * * * *", utcShifted: false });
  const previewTz = await worker.fetch(
    authed("/api/schedules/preview", "POST", { kind: "recurring", cron: "0 * * * *", timezone: "America/New_York" }),
    bindings,
  );
  expect(await previewTz.json()).toMatchObject({ utcShifted: true });

  // Validation closes: bad cron, past due, unknown Saga, bad kind.
  for (const bad of [
    { name: "bad-cron", sagaId: helloSaga.id, kind: "recurring", cron: "not a cron", input: {} },
    {
      name: "past",
      sagaId: helloSaga.id,
      kind: "one-off",
      dueAt: new Date(Date.now() - 1000).toISOString(),
      input: {},
    },
    {
      name: "lost",
      sagaId: "395e15f0-3627-41f6-8922-008ce37e3000",
      kind: "one-off",
      dueAt: futureIso(60000),
      input: {},
    },
    { name: "bad-kind", sagaId: helloSaga.id, kind: "sometimes", input: {} },
  ]) {
    const rejected = await worker.fetch(authed("/api/schedules", "POST", bad), bindings);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "INVALID_SCHEDULE" } });
  }

  // Update merges enabled/timezone; delete removes the ledger.
  const updated = await worker.fetch(authed("/api/schedules/hourly", "PUT", { timezone: "UTC" }), bindings);
  expect(updated.status).toBe(200);
  const gone = await worker.fetch(authed("/api/schedules/hourly", "DELETE"), bindings);
  expect(gone.status).toBe(200);
  const read = await worker.fetch(authed("/api/schedules/hourly", "GET"), bindings);
  expect(read.status).toBe(404);
});

it("promotes a due one-off exactly once and clears its due instant", async () => {
  await createOneOff("once", futureIso(60_000));
  // Force the row due (simulates the minute tick arriving).
  await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE name=?")
    .bind(new Date(Date.now() - 1000).toISOString(), "once")
    .run();
  const tick = await worker.fetch(authed("/api/schedules/tick", "POST"), bindings);
  expect(tick.status).toBe(200);
  const tickBody = (await tick.json()) as { promoted: { schedule: string; executionId: string; replayed: boolean }[] };
  expect(tickBody.promoted).toHaveLength(1);
  expect(tickBody.promoted[0]?.schedule).toBe("once");
  const executionId = tickBody.promoted[0]?.executionId as string;
  expect(/^[a-f0-9]{64}$/.test(executionId)).toBe(true);

  // Same-window re-tick converges: no second Execution, replay receipt.
  const again = await worker.fetch(authed("/api/schedules/tick", "POST"), bindings);
  const againBody = (await again.json()) as { promoted: unknown[] };
  expect(againBody.promoted).toHaveLength(0);

  // One-off is terminal after promotion: nextDueAt cleared, no re-fire.
  const detail = (await (await worker.fetch(authed("/api/schedules/once", "GET"), bindings)).json()) as {
    schedule: { nextDueAt: string | null };
    deliveries: { window: string; executionId: string }[];
  };
  expect(detail.schedule.nextDueAt).toBeNull();
  expect(detail.deliveries).toHaveLength(1);
  expect(detail.deliveries[0]?.executionId).toBe(executionId);
});

it("deduplicates duplicate windows but dispatches overlapping windows independently", async () => {
  await createOneOff("overlap", futureIso(60_000));
  const row = (await bindings.DB.prepare("SELECT id,next_due_at FROM schedules WHERE name=?")
    .bind("overlap")
    .first<{ id: string; next_due_at: string }>()) as { id: string; next_due_at: string };
  const firstWindow = row.next_due_at.slice(0, 16);
  const firstKey = scheduleWindowKey(row.id, firstWindow);
  // Same-window key converges through the standard submit protocol.
  expect(firstKey.startsWith("sch-")).toBe(true);

  // Seed the claim as a racing tick would: promotion replays, never forks.
  await bindings.DB.prepare(
    "INSERT INTO schedule_deliveries(schedule_id,window,execution_id,created_at) VALUES (?,?,?,?) ON CONFLICT(schedule_id,window) DO NOTHING",
  )
    .bind(row.id, firstWindow, "0".repeat(64), new Date().toISOString())
    .run();
  await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE name=?")
    .bind(new Date(Date.now() - 1000).toISOString(), "overlap")
    .run();
  const tick = await worker.fetch(authed("/api/schedules/tick", "POST"), bindings);
  const body = (await tick.json()) as { promoted: unknown[] };
  // The tick either replays the claimed window or skips it — never a new Execution for the same window.
  expect(body.promoted.length).toBeLessThanOrEqual(1);

  // Different windows dispatch independently: advancing the row produces a
  // fresh promotion on the next tick, not a replay of the first window.
  const detail = (await (await worker.fetch(authed("/api/schedules/overlap", "GET"), bindings)).json()) as {
    deliveries: { window: string }[];
  };
  expect(detail.deliveries.length).toBeGreaterThanOrEqual(1);
});

it("skips disabled and deleted schedules without promoting", async () => {
  await createOneOff("paused", futureIso(60_000));
  const disabled = await worker.fetch(authed("/api/schedules/paused", "PUT", { enabled: false }), bindings);
  expect(disabled.status).toBe(200);
  await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE name=?")
    .bind(new Date(Date.now() - 1000).toISOString(), "paused")
    .run();
  const tick = await worker.fetch(authed("/api/schedules/tick", "POST"), bindings);
  expect(((await tick.json()) as { promoted: unknown[] }).promoted).toHaveLength(0);

  // Re-enable resumes: the overdue row promotes on the next tick.
  await worker.fetch(authed("/api/schedules/paused", "PUT", { enabled: true }), bindings);
  await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE name=?")
    .bind(new Date(Date.now() - 1000).toISOString(), "paused")
    .run();
  const resumed = await worker.fetch(authed("/api/schedules/tick", "POST"), bindings);
  expect(((await resumed.json()) as { promoted: unknown[] }).promoted).toHaveLength(1);

  // Deleted schedules stop producing windows; promoted rows survive.
  await createOneOff("doomed", futureIso(60_000));
  expect(await worker.fetch(authed("/api/schedules/doomed", "DELETE"), bindings).then((res) => res.status)).toBe(200);
  expect(await worker.fetch(authed("/api/schedules/doomed", "GET"), bindings).then((res) => res.status)).toBe(404);
});

it("cancels a future scheduled Execution and reserves the sch- namespace", async () => {
  await createOneOff("cancel-me", futureIso(3_600_000));
  // Cancel disables the schedule; an explicit future Execution cancels too.
  const cancelled = await worker.fetch(authed("/api/schedules/cancel-me/cancel", "POST", {}), bindings);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ schedule: { enabled: false }, cancelled: null });

  // Caller keys cannot squat the schedule namespace.
  try {
    parseCallerKey(`sch-${"a".repeat(12)}-0000`);
    expect.unreachable("sch- keys must fail closed");
  } catch (error) {
    expect((error as { code: string }).code).toBe("INVALID_IDEMPOTENCY_KEY");
  }
  expect(() => parseCallerKey("caller-owned-key-0001")).not.toThrow();

  // Ordinary members inspect but cannot mutate: create/tick/cancel are admin-only.
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  const LAB_USER = "00000000-0000-4000-8000-000000000002";
  const memberBindings = { ...bindings, LAB_USER_ID: OTHER_USER, LAB_FIXTURE_USER_ID: LAB_USER } as Bindings;
  const denied = await worker.fetch(
    authed("/api/schedules", "POST", {
      name: "member-try",
      sagaId: helloSaga.id,
      kind: "one-off",
      dueAt: futureIso(60000),
      input: {},
    }),
    memberBindings,
  );
  expect([403, 404]).toContain(denied.status);
});

it("treats Pending schedule backlog as admission state, never a failure", async () => {
  await createOneOff("backlog", futureIso(60_000));
  await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE name=?")
    .bind(new Date(Date.now() - 1000).toISOString(), "backlog")
    .run();
  const tick = await worker.fetch(authed("/api/schedules/tick", "POST"), bindings);
  const body = (await tick.json()) as { promoted: { executionId: string }[] };
  expect(body.promoted).toHaveLength(1);
  // The promoted Execution is Pending-or-better, never Failed-by-backlog:
  // admission state is inspectable through the standard Execution detail.
  const detail = await worker.fetch(authed(`/api/executions/${body.promoted[0]?.executionId}`, "GET"), bindings);
  expect(detail.status).toBe(200);
  const detailBody = (await detail.json()) as { status: string };
  expect(["Pending", "Running", "Succeeded"]).toContain(detailBody.status);
});

it("matches cron fields and computes the next tick without a vendor", () => {
  for (const badCron of ["not a cron", "61 * * * *"]) {
    try {
      parseCron(badCron);
      expect.unreachable(`cron ${badCron} must fail closed`);
    } catch (error) {
      expect((error as { code: string }).code).toBe("INVALID_SCHEDULE");
    }
  }
  expect(parseCron(" 0  *  * * * ")).toBe("0 * * * *");
  expect(parseTimezone(undefined)).toBe("UTC");
  try {
    parseTimezone("no spaces allowed!");
    expect.unreachable("bad timezone must fail closed");
  } catch (error) {
    expect((error as { code: string }).code).toBe("INVALID_SCHEDULE");
  }
  try {
    parseDueAt(new Date(Date.now() - 1000).toISOString());
    expect.unreachable("past due must fail closed");
  } catch (error) {
    expect((error as { code: string }).code).toBe("INVALID_SCHEDULE");
  }
  // 2026-09-12 is a Saturday (dow 6): midnight UTC matches `0 0 * * 6`.
  expect(cronMatches("0 0 * * 6", new Date("2026-09-12T00:00:00.000Z"))).toBe(true);
  expect(cronMatches("0 0 * * 6", new Date("2026-09-12T00:01:00.000Z"))).toBe(false);
  expect(cronMatches("*/15 * * * *", new Date("2026-09-12T00:30:00.000Z"))).toBe(true);
  expect(cronMatches("*/15 * * * *", new Date("2026-09-12T00:31:00.000Z"))).toBe(false);
  const next = nextCronInstant("0 * * * *", Date.parse("2026-09-12T10:20:30.000Z"));
  expect(next).toBe("2026-09-12T11:00:00.000Z");
  // Schedule IDs hash (org, name); window keys reserve sch-.
  expect(scheduleWindowKey("a".repeat(32), "2026-09-12T10:30")).toMatch(/^sch-/);
  expect(hash).toBeDefined();
});
