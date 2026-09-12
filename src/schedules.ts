// SPDX-License-Identifier: AGPL-3.0
// TRG-01 (issue #137, ADR 012 accepted design): one-off and recurring
// schedules with durable due-time and cancellation semantics.
//
// A schedule is persisted per-Organization environment state (upstream
// finding 3, never Saga source metadata): one org-scoped row binding a name
// to a stable Saga UUID plus a kind. `one-off` schedules carry a single
// future due instant; `recurring` schedules carry a 5-field cron expression
// plus a timezone label. Both kinds validate input through the Saga parse
// gate at creation, promote due windows through the standard submit
// protocol with a deterministic derived key, and answer the same operator
// lifecycle (create/preview/disable/cancel) through the Organization-admin
// boundary. Due rows survive restart (D1) and promote exactly once under
// racing ticks (PRIMARY KEY on schedule_deliveries plus conditional claim).
//
// Cloudflare mapping: the Cron Trigger tick is the clock, D1 rows are the
// durable intent. A tick promotes due rows; admission policy, Saga identity,
// and dispatch fencing stay where they already live (executions.submit).
// No Queue, no Durable Object, no background job beyond the Cron tick.
import { Fault, hash, UUID } from "./domain";
import type { Principal, SagaDef } from "./domain";

export const SCHEDULE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TIMEZONE_RE = /^[A-Za-z0-9_+/-]{1,64}$/;
const WINDOW_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$/;
/** One-off due instants cap at 30 days, matching the form-deferred bound. */
export const SCHEDULE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** Per-tick admission scan bound (bounded scan cost, Free-tier cheap). */
export const SCHEDULE_TICK_LIMIT = 25;
/** Derived promotion keys reserve the `sch-` namespace like `wep-` does. */
export const SCHEDULE_KEY_PREFIX = "sch-";

export type ScheduleKind = "one-off" | "recurring";

export interface ScheduleRow {
  id: string;
  org_id: string;
  name: string;
  saga_id: string;
  created_by: string;
  enabled: number;
  kind: ScheduleKind;
  cron: string | null;
  timezone: string;
  input_json: string;
  next_due_at: string | null;
  last_window: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  sagaId: string;
  enabled: boolean;
  kind: ScheduleKind;
  cron: string | null;
  timezone: string;
  nextDueAt: string | null;
  lastWindow: string | null;
  createdAt: string;
  updatedAt: string;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Parse a schedule name from the route. Unknown shapes answer 404. */
export function parseScheduleName(name: string): string {
  if (!SCHEDULE_NAME.test(name)) throw new Fault(404, "NOT_FOUND", "Not found.");
  return name;
}

/** Validate a 5-field cron expression (minute hour dom month dow). */
export function parseCron(value: unknown): string {
  if (typeof value !== "string") throw invalid("INVALID_SCHEDULE", "cron must be a 5-field cron expression.");
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) throw invalid("INVALID_SCHEDULE", "cron must be a 5-field cron expression.");
  const bounds: ReadonlyArray<readonly [number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  for (let index = 0; index < 5; index += 1) {
    const field = fields[index] as string;
    const [lo, hi] = bounds[index] as readonly [number, number];
    if (!/^[0-9*,/-]+$/.test(field)) throw invalid("INVALID_SCHEDULE", "cron must be a 5-field cron expression.");
    for (const part of field.split(",")) {
      if (part === "*") continue;
      const stepped = part.split("/");
      if (stepped.length > 2) throw invalid("INVALID_SCHEDULE", "cron must be a 5-field cron expression.");
      const range = stepped[0] as string;
      const step = stepped[1] as string | undefined;
      if (step !== undefined && !/^[0-9]+$/.test(step)) {
        throw invalid("INVALID_SCHEDULE", "cron must be a 5-field cron expression.");
      }
      if (range === "*") continue;
      const dash = range.split("-");
      if (dash.length > 2) throw invalid("INVALID_SCHEDULE", "cron must be a 5-field cron expression.");
      for (const piece of dash) {
        if (!/^[0-9]+$/.test(piece)) throw invalid("INVALID_SCHEDULE", "cron must be a 5-field cron expression.");
        const num = Number(piece);
        if (num < lo || num > hi) throw invalid("INVALID_SCHEDULE", "cron must be a 5-field cron expression.");
      }
    }
  }
  return fields.join(" ");
}

/** Validate a timezone label. Only UTC shifts tick math; other IANA labels
 * are recorded for inspectability and document their UTC-shift behavior in
 * the route descriptor (DST/missed-tick policy lives there, not here). */
export function parseTimezone(value: unknown): string {
  if (value === undefined || value === null) return "UTC";
  if (typeof value !== "string" || !TIMEZONE_RE.test(value.trim())) {
    throw invalid("INVALID_SCHEDULE", "timezone must be an IANA label such as UTC or America/New_York.");
  }
  return value.trim();
}

/** Validate a one-off due instant: future, within 30 days. */
export function parseDueAt(value: unknown, nowMs = Date.now()): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw invalid("INVALID_SCHEDULE", "dueAt must be an ISO 8601 instant.");
  }
  const at = Date.parse(value);
  if (at <= nowMs) throw invalid("INVALID_SCHEDULE", "dueAt must be in the future.");
  if (at - nowMs > SCHEDULE_MAX_MS) throw invalid("INVALID_SCHEDULE", "dueAt must be within 30 days.");
  return new Date(at).toISOString();
}

/** Route-level aliases with the parse* prefix the Worker entry uses. */
export const parseScheduleCron = parseCron;
export const parseScheduleTimezone = parseTimezone;
export const parseScheduleDueAt = parseDueAt;
export const nextScheduleInstant = nextCronInstant;

/** Parse an optional due-instant override for manual tick claims. */
export function parseWindow(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !WINDOW_RE.test(value.trim())) {
    throw invalid("INVALID_SCHEDULE", "window must be a minute instant such as 2026-09-12T10:30.");
  }
  const padded = value.trim().length === 16 ? `${value.trim()}:00` : value.trim();
  const at = Date.parse(`${padded}Z`);
  if (Number.isNaN(at)) throw invalid("INVALID_SCHEDULE", "window must be a minute instant such as 2026-09-12T10:30.");
  return new Date(at).toISOString();
}

export function scheduleSummary(row: ScheduleRow): ScheduleSummary {
  return {
    id: row.id,
    name: row.name,
    sagaId: row.saga_id,
    enabled: row.enabled === 1,
    kind: row.kind,
    cron: row.cron,
    timezone: row.timezone,
    nextDueAt: row.next_due_at,
    lastWindow: row.last_window,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function scheduleId(orgId: string, name: string): Promise<string> {
  return hash(JSON.stringify(["wrangnarok.schedule.v1", orgId, name]));
}

/** Derive the submit key for one window: schedule ID plus window instant.
 * Caller-supplied keys can never collide: the `sch-` namespace is reserved
 * at the submit parser like `wep-` is. */
export function scheduleWindowKey(scheduleIdValue: string, window: string): string {
  const digest = scheduleIdValue.replace(/-/g, "").slice(0, 24);
  const instant = window.replace(/[^0-9]/g, "").slice(0, 14);
  return `${SCHEDULE_KEY_PREFIX}${digest}-${instant}`.slice(0, 64);
}

/** Minute-bucket window label for a due instant (UTC-shifted ticks). */
export function windowForInstant(iso: string): string {
  return iso.slice(0, 16);
}

/** Match one minute against a 5-field cron expression (UTC fields). */
export function cronMatches(cron: string, date: Date): boolean {
  const fields = cron.split(" ");
  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];
  const bounds: ReadonlyArray<readonly [number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  for (let index = 0; index < 5; index += 1) {
    const [lo, hi] = bounds[index] as readonly [number, number];
    if (!fieldMatches(fields[index] as string, values[index] as number, lo, hi)) return false;
  }
  return true;
}

function fieldMatches(field: string, value: number, lo: number, hi: number): boolean {
  for (const part of field.split(",")) {
    const stepped = part.split("/");
    const step = stepped.length === 2 ? Number(stepped[1] as string) : 1;
    const range = stepped[0] as string;
    let start = lo;
    let end = hi;
    if (range !== "*") {
      const dash = range.split("-");
      if (dash.length === 2) {
        start = Number(dash[0]);
        end = Number(dash[1]);
      } else {
        start = Number(dash[0]);
        end = start;
      }
    }
    if (value < start || value > end) continue;
    if ((value - start) % step === 0) return true;
  }
  return false;
}

/** Next minute strictly after `fromMs` whose UTC fields match the cron.
 * Bounded scan (one year of minutes) so a non-matching expression fails
 * closed instead of looping. */
export function nextCronInstant(cron: string, fromMs: number): string {
  const cursor = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let tick = cursor; tick < fromMs + 366 * 24 * 60 * 60 * 1000; tick += 60_000) {
    if (cronMatches(cron, new Date(tick))) return new Date(tick).toISOString();
  }
  throw invalid("INVALID_SCHEDULE", "cron never matches within one year.");
}

export interface ScheduleCreate {
  name: string;
  sagaId: string;
  kind: ScheduleKind;
  cron?: unknown;
  timezone?: unknown;
  dueAt?: unknown;
  input?: unknown;
  enabled?: unknown;
}

async function ensureTables(db: D1Database): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, saga_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL, cron TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', input_json TEXT NOT NULL, next_due_at TEXT, last_window TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id, name))",
    )
    .run();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS schedule_deliveries(schedule_id TEXT NOT NULL, window TEXT NOT NULL, execution_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(schedule_id, window))",
    )
    .run();
  await db.prepare("CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_due_at)").run();
}

/** Create a schedule: operator-managed environment state, never Saga source.
 * Input passes the Saga parse gate now so a miswired schedule fails at
 * creation, not at 3am promotion. Returns the row plus whether it won the
 * (org, name) race. */
export async function createSchedule(
  db: D1Database,
  caller: Principal,
  body: ScheduleCreate,
  sagas: readonly SagaDef[],
): Promise<{ row: ScheduleRow; created: boolean }> {
  const name = parseScheduleName(typeof body.name === "string" ? body.name : "");
  if (typeof body.sagaId !== "string" || !UUID.test(body.sagaId.toLowerCase())) {
    throw invalid("INVALID_SCHEDULE", "sagaId must be a known Saga UUID.");
  }
  const saga = sagas.find((entry) => entry.id === body.sagaId.toLowerCase());
  if (!saga) throw invalid("INVALID_SCHEDULE", "sagaId must be a known Saga UUID.");
  if (body.kind !== "one-off" && body.kind !== "recurring") {
    throw invalid("INVALID_SCHEDULE", "kind must be one-off or recurring.");
  }
  const timezone = parseTimezone(body.timezone);
  let cron: string | null = null;
  let nextDue: string | null;
  if (body.kind === "recurring") {
    cron = parseCron(body.cron);
    nextDue = nextCronInstant(cron, Date.now());
  } else {
    if (body.cron !== undefined) throw invalid("INVALID_SCHEDULE", "one-off schedules carry dueAt, not cron.");
    nextDue = parseDueAt(body.dueAt);
  }
  const parsed = saga.parse(body.input ?? {});
  const inputJson = JSON.stringify(parsed);
  if (inputJson.length > 4096) throw invalid("INVALID_SCHEDULE", "input exceeds the 4096-byte bound.");
  const enabled = body.enabled === undefined ? true : body.enabled === true;
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw invalid("INVALID_SCHEDULE", "enabled must be a boolean.");
  }
  await ensureTables(db);
  const id = await scheduleId(caller.orgId, name);
  const now = new Date().toISOString();
  const window = nextDue === null ? null : windowForInstant(nextDue);
  const inserted = await db
    .prepare(
      "INSERT INTO schedules(id,org_id,name,saga_id,created_by,enabled,kind,cron,timezone,input_json,next_due_at,last_window,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(
      id,
      caller.orgId,
      name,
      saga.id,
      caller.userId,
      enabled ? 1 : 0,
      body.kind,
      cron,
      timezone,
      inputJson,
      nextDue,
      window,
      now,
      now,
    )
    .run();
  const row = await db.prepare("SELECT * FROM schedules WHERE id=?").bind(id).first<ScheduleRow>();
  if (!row) throw new Fault(503, "SCHEDULE_UNCONFIRMED", "Schedule write could not be confirmed.");
  if (inserted.meta.changes === 0 && (row.org_id !== caller.orgId || row.name !== name)) {
    throw new Fault(409, "SCHEDULE_CONFLICT", "This schedule name already exists.");
  }
  return { row, created: inserted.meta.changes !== 0 };
}

/** Load one schedule for exact-org visibility: foreign rows resolve to
 * null so routes answer 404, never a cross-tenant leak. */
export async function loadSchedule(db: D1Database, orgId: string, name: string): Promise<ScheduleRow | null> {
  const row = await db
    .prepare('SELECT * FROM "schedules" WHERE org_id=? AND name=?')
    .bind(orgId, name)
    .first<ScheduleRow>()
    .catch(() => null);
  return row ?? null;
}

/** List schedules for one Organization in name order. */
export async function listSchedules(db: D1Database, orgId: string): Promise<ScheduleRow[]> {
  const rows = await db
    .prepare("SELECT * FROM schedules WHERE org_id=? ORDER BY name")
    .bind(orgId)
    .all<ScheduleRow>()
    .catch(() => ({ results: [] as ScheduleRow[] }));
  return rows.results;
}

export interface SchedulePatch {
  enabled?: unknown;
  cron?: unknown;
  timezone?: unknown;
  dueAt?: unknown;
  input?: unknown;
}

/** Update a schedule: partial body merges over the current row. Unknown
 * keys reject; kind/sagaId never change (delete plus recreate instead). */
export async function updateSchedule(
  db: D1Database,
  caller: Principal,
  name: string,
  body: SchedulePatch,
  sagas: readonly SagaDef[],
): Promise<ScheduleRow> {
  const current = await loadSchedule(db, caller.orgId, name);
  if (!current) throw new Fault(404, "NOT_FOUND", "Not found.");
  const allowed = new Set(["enabled", "cron", "timezone", "dueAt", "input"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw invalid("INVALID_SCHEDULE", `Unknown schedule field: ${key}.`);
  }
  const saga = sagas.find((entry) => entry.id === current.saga_id);
  if (!saga) throw new Fault(409, "SCHEDULE_CONFLICT", "This schedule binds an unknown Saga.");
  let {
    cron,
    timezone,
    input_json: inputJson,
    enabled,
    next_due_at: nextDue,
  } = {
    cron: current.cron,
    timezone: current.timezone,
    input_json: current.input_json,
    enabled: current.enabled,
    next_due_at: current.next_due_at,
  };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw invalid("INVALID_SCHEDULE", "enabled must be a boolean.");
    enabled = body.enabled ? 1 : 0;
  }
  if (body.timezone !== undefined) timezone = parseTimezone(body.timezone);
  if (body.input !== undefined) {
    const parsed = saga.parse(body.input ?? {});
    inputJson = JSON.stringify(parsed);
    if (inputJson.length > 4096) throw invalid("INVALID_SCHEDULE", "input exceeds the 4096-byte bound.");
  }
  if (current.kind === "recurring") {
    if (body.dueAt !== undefined) throw invalid("INVALID_SCHEDULE", "recurring schedules carry cron, not dueAt.");
    if (body.cron !== undefined) {
      cron = parseCron(body.cron);
      nextDue = nextCronInstant(cron, Date.now());
    }
  } else {
    if (body.cron !== undefined) throw invalid("INVALID_SCHEDULE", "one-off schedules carry dueAt, not cron.");
    if (body.dueAt !== undefined) nextDue = parseDueAt(body.dueAt);
  }
  const now = new Date().toISOString();
  const window = nextDue === null ? null : windowForInstant(nextDue);
  await db
    .prepare(
      "UPDATE schedules SET enabled=?,cron=?,timezone=?,input_json=?,next_due_at=?,last_window=?,updated_at=? WHERE id=?",
    )
    .bind(enabled, cron, timezone, inputJson, nextDue, window, now, current.id)
    .run();
  const row = await db.prepare("SELECT * FROM schedules WHERE id=?").bind(current.id).first<ScheduleRow>();
  if (!row) throw new Fault(503, "SCHEDULE_UNCONFIRMED", "Schedule write could not be confirmed.");
  return row;
}

/** Disable a schedule without deleting its delivery history: the tick skips
 * disabled rows, and re-enable resumes the cadence from now. */
export async function disableSchedule(
  db: D1Database,
  caller: Principal,
  name: string,
  sagas: readonly SagaDef[],
): Promise<ScheduleRow> {
  return updateSchedule(db, caller, name, { enabled: false }, sagas);
}

/** Delete a schedule plus its delivery ledger. Executions already promoted
 * keep their rows; the schedule simply stops producing new windows. */
export async function deleteSchedule(db: D1Database, caller: Principal, name: string): Promise<void> {
  const current = await loadSchedule(db, caller.orgId, name);
  if (!current) throw new Fault(404, "NOT_FOUND", "Not found.");
  await db.prepare("DELETE FROM schedule_deliveries WHERE schedule_id=?").bind(current.id).run();
  await db.prepare("DELETE FROM schedules WHERE id=?").bind(current.id).run();
}

export interface DueSchedule {
  row: ScheduleRow;
  window: string;
  dueAt: string;
}

/** Scan due schedules for one tick: enabled rows whose next_due_at is at or
 * before now, bounded so one tick never scans the whole table. */
export async function dueSchedules(
  db: D1Database,
  nowIso: string,
  limit = SCHEDULE_TICK_LIMIT,
): Promise<DueSchedule[]> {
  const rows = await db
    .prepare(
      "SELECT * FROM schedules WHERE enabled=1 AND next_due_at IS NOT NULL AND next_due_at<=? ORDER BY next_due_at LIMIT ?",
    )
    .bind(nowIso, limit)
    .all<ScheduleRow>()
    .catch(() => ({ results: [] as ScheduleRow[] }));
  return rows.results
    .filter((row) => row.next_due_at !== null)
    .map((row) => ({ row, window: windowForInstant(row.next_due_at as string), dueAt: row.next_due_at as string }));
}

/** Claim one window: single winner under racing ticks (PRIMARY KEY), then
 * record the promoted Execution. Returns null when another tick won. */
export async function claimWindow(
  db: D1Database,
  scheduleIdValue: string,
  window: string,
  executionIdValue: string,
): Promise<boolean> {
  const inserted = await db
    .prepare(
      "INSERT INTO schedule_deliveries(schedule_id,window,execution_id,created_at) VALUES (?,?,?,?) ON CONFLICT(schedule_id,window) DO NOTHING",
    )
    .bind(scheduleIdValue, window, executionIdValue, new Date().toISOString())
    .run();
  return inserted.meta.changes !== 0;
}

/** Advance the row past the promoted window: one-off schedules clear
 * next_due_at (terminal); recurring schedules compute the next tick. */
export async function advanceSchedule(db: D1Database, row: ScheduleRow, promotedAtMs: number): Promise<ScheduleRow> {
  let nextDue: string | null = null;
  if (row.kind === "recurring" && row.cron !== null) {
    nextDue = nextCronInstant(row.cron, promotedAtMs);
  }
  const now = new Date().toISOString();
  const window = nextDue === null ? null : windowForInstant(nextDue);
  await db
    .prepare("UPDATE schedules SET next_due_at=?,last_window=?,updated_at=? WHERE id=?")
    .bind(nextDue, window, now, row.id)
    .run();
  const updated = await db.prepare("SELECT * FROM schedules WHERE id=?").bind(row.id).first<ScheduleRow>();
  if (!updated) throw new Fault(503, "SCHEDULE_UNCONFIRMED", "Schedule write could not be confirmed.");
  return updated;
}

/** List delivery windows for one schedule, newest first. */
export async function listScheduleDeliveries(
  db: D1Database,
  scheduleIdValue: string,
  limit = 50,
): Promise<{ window: string; executionId: string; createdAt: string }[]> {
  const rows = await db
    .prepare(
      "SELECT window,execution_id,created_at FROM schedule_deliveries WHERE schedule_id=? ORDER BY window DESC LIMIT ?",
    )
    .bind(scheduleIdValue, limit)
    .all<{ window: string; execution_id: string; created_at: string }>()
    .catch(() => ({ results: [] as { window: string; execution_id: string; created_at: string }[] }));
  return rows.results.map((row) => ({ window: row.window, executionId: row.execution_id, createdAt: row.created_at }));
}

/** Cancel one future Execution: owner-scoped promotion rows only. */
export async function cancelScheduledExecution(
  db: D1Database,
  caller: Principal,
  executionIdValue: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT id,status FROM executions WHERE id=? AND org_id=? AND user_id=?")
    .bind(executionIdValue, caller.orgId, caller.userId)
    .first<{ id: string; status: string }>();
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  if (row.status !== "Pending") {
    throw new Fault(409, "EXECUTION_NOT_CANCELLABLE", "Only future scheduled Executions cancel here.");
  }
  const marked = await db
    .prepare("UPDATE executions SET status='Cancelled',completed_at=? WHERE id=? AND status='Pending'")
    .bind(new Date().toISOString(), row.id)
    .run();
  if (marked.meta.changes === 0)
    throw new Fault(409, "EXECUTION_NOT_CANCELLABLE", "Only future scheduled Executions cancel here.");
}
