// SPDX-License-Identifier: AGPL-3.0
// Project CLI: thin conveniences over the Worker HTTP API only. No Saga
// logic lives here — every command is fetch calls plus polling plus output
// formatting. Destructive actions take exact IDs only, never prefixes or
// search matches.
//
// Auth: --token, else $WRANGNAROK_TOKEN, else LAB_TOKEN from .dev.vars
// (local fixture only; the token value is never printed). Behind Cloudflare
// Access (e.g. dev), also pass --access-client-id/--access-client-secret
// (or $CF_ACCESS_CLIENT_ID/$CF_ACCESS_CLIENT_SECRET); without an SSO
// session or service token the edge challenges machine callers.
// --org is reserved for future multi-tenancy: organization always comes
// from the auth context, so passing it fails loudly.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const TERMINAL = ["Succeeded", "Failed", "TimedOut", "Cancelled"];
const EXECUTION_ID = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
/** Human-rendering bound for input/result payloads (mirrors the D1 4096-byte bound). */
const CLI_JSON_BOUND = 4096;
const HISTORY_STATUSES = ["Pending", "Running", "Succeeded", "Failed", "TimedOut", "Cancelling", "Cancelled"];

function fail(code, message) {
  console.error(`WRANGNAROK_CLI ${code}: ${message}`);
  process.exit(code === "USAGE" ? 2 : 1);
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function readDevVars() {
  try {
    if (!existsSync(".dev.vars")) return {};
    const vars = {};
    for (const line of readFileSync(".dev.vars", "utf-8").split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) vars[match[1]] = match[2];
    }
    return vars;
  } catch {
    return {};
  }
}

function authToken() {
  const token = arg("token") ?? process.env.WRANGNAROK_TOKEN ?? readDevVars().LAB_TOKEN ?? "";
  if (!token) {
    fail("USAGE", "no bearer token: pass --token, set $WRANGNAROK_TOKEN, or run `npm run setup:local`.");
  }
  return token;
}

function baseUrl() {
  const base = arg("base", process.env.WRANGNAROK_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) fail("USAGE", `--base must be an http(s) URL, got ${JSON.stringify(base)}.`);
  return base;
}

function accessHeaders() {
  const id = arg("access-client-id") ?? process.env.CF_ACCESS_CLIENT_ID ?? "";
  const secret = arg("access-client-secret") ?? process.env.CF_ACCESS_CLIENT_SECRET ?? "";
  if (id || secret) {
    if (!id || !secret) fail("USAGE", "Access service token needs both id and secret.");
    return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
  }
  return {};
}

async function readJson(response, what) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail("SERVER_MISMATCH", `${what} returned HTTP ${response.status} with a non-JSON body: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    const code = data?.error?.code ?? "UNKNOWN";
    const message = data?.error?.message ?? text.slice(0, 160);
    fail("SERVER_REJECTED", `${what} failed: HTTP ${response.status} ${code}: ${message}`);
  }
  return data;
}

function asJson() {
  return flag("json");
}

function emit(value) {
  if (asJson()) console.log(JSON.stringify(value));
  return asJson();
}

async function fetchSagas(ctx) {
  const data = await readJson(await ctx.fetchImpl(`${ctx.base}/api/sagas`, { headers: ctx.headers }), "saga catalog");
  if (!Array.isArray(data.sagas)) fail("SERVER_MISMATCH", "saga catalog has no sagas array.");
  return data.sagas;
}

async function resolveSagaId(ctx, ref) {
  if (/^[0-9a-fA-F-]{36}$/.test(ref)) return ref;
  const sagas = await fetchSagas(ctx);
  const matches = sagas.filter((entry) => entry.name === ref);
  if (matches.length === 0) fail("SERVER_MISMATCH", `no Saga named ${JSON.stringify(ref)} in the catalog.`);
  if (matches.length > 1) fail("SERVER_MISMATCH", `multiple Sagas named ${JSON.stringify(ref)}; pass a stable UUID.`);
  return matches[0].id;
}

function checkExecutionId(id) {
  if (!EXECUTION_ID.test(id ?? "")) {
    fail("USAGE", "cancel and detail need the exact 64-hex Execution ID (no prefixes, no search).");
  }
  return id;
}

function readInput() {
  const raw = arg("input", "{}");
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf-8") : raw;
  try {
    return JSON.parse(text);
  } catch {
    return fail("USAGE", "--input must be JSON (or @path to a JSON file).");
  }
}

async function pollDetail(ctx, executionId, { wait, timeoutMs, pollMs, sleep }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await readJson(
      await ctx.fetchImpl(`${ctx.base}/api/executions/${executionId}`, { headers: ctx.headers }),
      "execution detail",
    );
    if (typeof detail.status !== "string") fail("SERVER_MISMATCH", "execution detail has no status.");
    if (TERMINAL.includes(detail.status) || !wait) return detail;
    if (Date.now() >= deadline) fail("TIMEOUT", `execution ${executionId} did not settle in time.`);
    await sleep(pollMs);
  }
}

function printSagas(sagas) {
  if (emit({ sagas })) return;
  for (const saga of sagas) console.log(`${saga.name}\t${saga.id}\t${saga.revision}`);
}

function boundedCliJson(value) {
  if (value === null || value === undefined) return "—";
  const text = JSON.stringify(value, null, 2) ?? "—";
  if (text.length <= CLI_JSON_BOUND) return text;
  return `${text.slice(0, CLI_JSON_BOUND)}\n… (truncated at ${CLI_JSON_BOUND} chars; rerun with --json for the full payload)`;
}

function printHistory(executions, hasMore, { pages }) {
  if (emit({ executions, hasMore })) return;
  for (const row of executions) {
    console.log(
      `${String(row.executionId).slice(0, 12)}\t${row.sagaName}\t${row.status}\t${row.startedAt ?? row.createdAt ?? "-"}`,
    );
  }
  // Loaded-slice counts are never presented as totals: hasMore means the
  // server holds rows this output does not show.
  if (hasMore) console.log(`# ${executions.length} loaded across ${pages} page(s); more available server-side.`);
  else console.log(`# ${executions.length} loaded (complete under these filters).`);
}

function printDetail(detail) {
  if (emit(detail)) return;
  console.log(`${detail.executionId} ${detail.status}`);
  console.log(`saga: ${detail.sagaName} (${detail.sagaRevision})`);
  console.log(`runtime: ${detail.runtimeStatus ?? "unavailable (native history expired or not yet dispatched)"}`);
  console.log(`dispatch: ${detail.dispatchConfirmed ? "confirmed" : "unconfirmed (Pending receipt only)"}`);
  console.log(
    `created: ${detail.createdAt ?? "-"} started: ${detail.startedAt ?? "-"} completed: ${detail.completedAt ?? "-"}`,
  );
  console.log(`input: ${boundedCliJson(detail.input)}`);
  if (detail.status === "Succeeded") console.log(`result: ${boundedCliJson(detail.result)}`);
  else if (detail.status === "Failed" || detail.status === "TimedOut" || detail.status === "Cancelled") {
    const error = detail.error;
    console.log(`error: ${error?.code ?? "UNKNOWN"}: ${error?.message ?? "no message"}`);
  } else console.log("output: still active (no terminal result yet)");
  for (const op of detail.operations ?? []) {
    console.log(`op ${op.name} ${op.status} started=${op.startedAt} completed=${op.completedAt ?? "-"}`);
    if (op.result !== null && op.result !== undefined) console.log(`  result: ${boundedCliJson(op.result)}`);
    if (op.error !== null && op.error !== undefined) {
      console.log(`  error: ${op.error?.code ?? "UNKNOWN"}: ${op.error?.message ?? boundedCliJson(op.error)}`);
    }
  }
}

function printCancel(outcome) {
  if (emit(outcome)) return;
  if (outcome.cancelled)
    console.log(`${outcome.executionId} Cancelled (confirmed; it will not run again under this key)`);
  else console.log(`${outcome.executionId} ${outcome.status} (already in progress; another request won the race)`);
}

const HELP = `wrangnarok: thin CLI over the Worker HTTP API (no Saga logic here).

Usage: node scripts/wrangnarok.mjs [global flags] <command> [args]

Global flags:
  --base URL            Worker origin (default http://127.0.0.1:8787, or $WRANGNAROK_BASE)
  --token TOKEN         Bearer token (default $WRANGNAROK_TOKEN, else .dev.vars LAB_TOKEN)
  --access-client-id / --access-client-secret (or $CF_ACCESS_CLIENT_ID/_SECRET)
                        Cloudflare Access service token headers for dev URLs
  --org ID              RESERVED: fails loudly; organization comes from auth context
  --json                Machine-readable JSON output (default is human-readable)
  --help                This text

Commands:
  sagas                                   List the Saga catalog
  submit --saga NAME|UUID [--input JSON|@FILE] [--key KEY] [--no-wait]
                                          Submit an Execution (202 + poll to terminal)
  detail --id HEX                         Fetch one Execution (add --wait to poll)
  history [--status S[,S2]] [--saga NAME|UUID] [--from YYYY-MM-DD]
          [--to YYYY-MM-DD] [--limit N] [--all]
                                          Query Execution summaries (server filters,
                                          cursor traversal; loaded counts are not totals)
  cancel --id HEX                         Cancel one Execution (exact ID only)
  selftest                                Offline selftest (stub fetch, no network)

Auth notes: local .dev.vars tokens never leave this machine in logs. Dev
URLs behind Access challenge machine callers without a service token.
Cancel takes the exact 64-hex Execution ID; nothing here guesses targets.`;

export function parseContext(argv = process.argv) {
  return {
    command: argv[2],
    base: (arg("base", process.env.WRANGNAROK_BASE ?? "http://127.0.0.1:8787") ?? "").replace(/\/+$/, ""),
    json: argv.includes("--json"),
    org: arg("org"),
  };
}

export async function runCommand(ctx, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const full = {
    ...ctx,
    fetchImpl,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json",
      ...accessHeaders(),
    },
  };
  switch (ctx.command) {
    case "sagas": {
      return { sagas: await fetchSagas(full) };
    }
    case "submit": {
      if (!ctx.saga) fail("USAGE", "submit needs --saga NAME|UUID.");
      const key = ctx.key ?? `cli-${randomUUID()}`;
      if (!IDEMPOTENCY_KEY.test(key)) fail("USAGE", "--key must be 16-128 chars [A-Za-z0-9._:-].");
      const sagaId = await resolveSagaId(full, ctx.saga);
      const accepted = await readJson(
        await fetchImpl(`${ctx.base}/api/executions`, {
          method: "POST",
          headers: { ...full.headers, "Idempotency-Key": key },
          body: JSON.stringify({ sagaId, input: ctx.input }),
        }),
        "execution submit",
      );
      if (typeof accepted.executionId !== "string") fail("SERVER_MISMATCH", "submit returned no executionId.");
      if (!ctx.wait) return accepted;
      return pollDetail(full, accepted.executionId, {
        wait: true,
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
        sleep,
      });
    }
    case "detail": {
      return pollDetail(full, checkExecutionId(ctx.id), {
        wait: ctx.wait,
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
        sleep,
      });
    }
    case "history": {
      // Cursor traversal: --all follows nextCursor while preserving the
      // active filters; otherwise one page. Statuses stay comma-separated
      // (mirrors the server + upstream multi-status filter).
      const statuses = ctx.statusFilter
        ? String(ctx.statusFilter)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      for (const status of statuses) {
        if (!HISTORY_STATUSES.includes(status))
          fail("USAGE", `--status must be ${HISTORY_STATUSES.join("|")} (comma-separated ok).`);
      }
      const sagaId = ctx.sagaFilter ? await resolveSagaId(full, ctx.sagaFilter) : undefined;
      const collected = [];
      let cursor;
      let pages = 0;
      let hasMore;
      for (;;) {
        const params = new URLSearchParams();
        if (statuses.length > 0) params.set("status", statuses.join(","));
        if (sagaId) params.set("sagaId", sagaId);
        if (ctx.from) params.set("startDate", ctx.from);
        if (ctx.to) params.set("endDate", ctx.to);
        if (ctx.limit) params.set("limit", String(ctx.limit));
        if (cursor) params.set("cursor", cursor);
        const suffix = params.size > 0 ? `?${params.toString()}` : "";
        const data = await readJson(
          await fetchImpl(`${ctx.base}/api/executions${suffix}`, { headers: full.headers }),
          "history",
        );
        if (!Array.isArray(data.executions)) fail("SERVER_MISMATCH", "history has no executions array.");
        collected.push(...data.executions);
        pages += 1;
        hasMore = data.hasMore === true;
        cursor = typeof data.nextCursor === "string" ? data.nextCursor : undefined;
        if (!ctx.all || !hasMore || !cursor) break;
      }
      return { executions: collected, hasMore, pages };
    }
    case "cancel": {
      const id = checkExecutionId(ctx.id);
      return readJson(
        await fetchImpl(`${ctx.base}/api/executions/${id}/cancel`, { method: "POST", headers: full.headers }),
        "execution cancel",
      );
    }
    default:
      fail("USAGE", `unknown command ${JSON.stringify(ctx.command ?? "")}. See --help.`);
      return undefined;
  }
}

async function main() {
  if (flag("help") || process.argv[2] === "help" || !process.argv[2]) {
    console.log(HELP);
    return;
  }
  if (process.argv[2] === "selftest") {
    await selftest();
    return;
  }
  if (arg("org") !== undefined) {
    fail("ORG_RESERVED", "--org is reserved for future multi-tenancy; organization comes from the auth context.");
  }
  const parsed = parseContext();
  if (!/^https?:\/\//.test(parsed.base)) fail("USAGE", "--base must be an http(s) URL.");
  const limit = arg("limit");
  if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50)) {
    fail("USAGE", "--limit must be an integer from 1 to 50.");
  }
  const command = parsed.command;
  const ctx = {
    command,
    token: authToken(),
    base: baseUrl(),
    json: parsed.json,
    timeoutMs: Number(arg("timeout-ms", "120000")),
    pollMs: Number(arg("poll-ms", "2000")),
    // Per-command arguments; each command reads only its own.
    saga: command === "submit" ? arg("saga") : undefined,
    sagaFilter: command === "history" ? arg("saga") : undefined,
    id: command === "detail" || command === "cancel" ? arg("id") : undefined,
    key: command === "submit" ? arg("key") : undefined,
    input: command === "submit" ? readInput() : undefined,
    statusFilter: command === "history" ? arg("status") : undefined,
    limit: limit === undefined ? undefined : Number(limit),
    from: command === "history" ? arg("from") : undefined,
    to: command === "history" ? arg("to") : undefined,
    all: command === "history" ? flag("all") : false,
    wait: command === "submit" ? !flag("no-wait") : flag("wait"),
  };
  const result = await runCommand(ctx).catch((error) => {
    if (error instanceof Error && error.message.startsWith("WRANGNAROK_CLI")) throw error;
    fail("NETWORK", `request failed: ${error instanceof Error ? error.message : error}`);
  });
  if (command === "sagas") printSagas(result.sagas);
  else if (command === "history") printHistory(result.executions, result.hasMore, { pages: result.pages ?? 1 });
  else if (command === "detail") printDetail(result);
  else if (command === "cancel") printCancel(result);
  else if (parsed.json) console.log(JSON.stringify(result));
  else if (typeof result.status === "string") console.log(`${result.executionId} ${result.status}`);
  else console.log(`${result.executionId} accepted (replayed: ${result.replayed === true})`);
}

function stubFetch(scenarios) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = scenarios.shift();
      if (!next) throw new Error(`Unexpected fetch: ${url}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function selftest() {
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`selftest failed: ${name}`);
    passed += 1;
  };
  const base = { command: "", base: "http://local.test", token: "tok", timeoutMs: 1000, pollMs: 0, json: false };
  const noSleep = { sleep: async () => {} };

  // sagas list passes through.
  {
    const stub = stubFetch([jsonResponse({ sagas: [{ id: "u", name: "echo", revision: "echo-v1" }] })]);
    const result = await runCommand({ ...base, command: "sagas" }, { fetchImpl: stub.fetch, ...noSleep });
    check("sagas", result.sagas.length === 1 && stub.calls[0].url === "http://local.test/api/sagas");
  }

  // submit resolves a Saga name, sends a key, and polls to terminal.
  {
    const id = "a".repeat(64);
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-uuid", name: "echo", revision: "echo-v1" }] }),
      jsonResponse({ executionId: id, replayed: false }, 202),
      jsonResponse({ executionId: id, status: "Running" }),
      jsonResponse({ executionId: id, status: "Succeeded" }),
    ]);
    const result = await runCommand(
      { ...base, command: "submit", saga: "echo", input: {}, key: "laneC-selftest-001", wait: true },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("submit terminal", result.status === "Succeeded");
    check("submit key", stub.calls[1].init.headers["Idempotency-Key"] === "laneC-selftest-001");
  }

  // history forwards allowlisted filters only.
  {
    const stub = stubFetch([jsonResponse({ executions: [], hasMore: false, nextCursor: null })]);
    await runCommand(
      { ...base, command: "history", statusFilter: "Failed", limit: 5 },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("history query", stub.calls[0].url === "http://local.test/api/executions?status=Failed&limit=5");
  }

  // history --all follows cursors with filters preserved.
  {
    const stub = stubFetch([
      jsonResponse({ executions: [{ executionId: "a" }], hasMore: true, nextCursor: "cursor-2" }),
      jsonResponse({ executions: [{ executionId: "b" }], hasMore: false, nextCursor: null }),
    ]);
    const result = await runCommand(
      {
        ...base,
        command: "history",
        statusFilter: "Failed,TimedOut",
        from: "2026-09-01",
        to: "2026-09-10",
        limit: 1,
        all: true,
      },
      { fetchImpl: stub.fetch, ...noSleep },
    );
    check("history traversal", result.executions.length === 2 && result.pages === 2 && result.hasMore === false);
    check(
      "history cursor keeps filters",
      stub.calls[1].url.includes("status=Failed%2CTimedOut") &&
        stub.calls[1].url.includes("startDate=2026-09-01") &&
        stub.calls[1].url.includes("cursor=cursor-2"),
    );
  }

  // history rejects unknown statuses before any fetch.
  {
    const stub = stubFetch([]);
    let error = null;
    const exit = process.exit;
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "history", statusFilter: "Bogus" }, { fetchImpl: stub.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
    }
    check("history status gate", /exit:2/.test(String(error)) && stub.calls.length === 0);
  }

  // cancel refuses ambiguous IDs.
  {
    const stub = stubFetch([]);
    let error = null;
    const exit = process.exit;
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "cancel", id: "abc" }, { fetchImpl: stub.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
    }
    check("cancel exact id", /exit:2/.test(String(error)) && stub.calls.length === 0);
  }

  // cancel success passes the terminal marker through.
  {
    const id = "d".repeat(64);
    const stub = stubFetch([jsonResponse({ executionId: id, status: "Cancelled", cancelled: true })]);
    const result = await runCommand({ ...base, command: "cancel", id }, { fetchImpl: stub.fetch, ...noSleep });
    check("cancel success", result.status === "Cancelled");
    check("cancel exact url", stub.calls[0].url === `http://local.test/api/executions/${id}/cancel`);
  }

  // server mismatch is loud.
  {
    const stub = stubFetch([new Response("not json", { status: 200 })]);
    let error = null;
    const exit = process.exit;
    const errlines = [];
    const err = console.error;
    console.error = (line) => errlines.push(String(line));
    process.exit = (code) => {
      throw new Error(`exit:${code}`);
    };
    try {
      await runCommand({ ...base, command: "sagas" }, { fetchImpl: stub.fetch, ...noSleep });
    } catch (e) {
      error = e;
    } finally {
      process.exit = exit;
      console.error = err;
    }
    check("mismatch loud", /exit:1/.test(String(error)) && errlines.some((line) => line.includes("SERVER_MISMATCH")));
  }

  console.log(`wrangnarok cli selftest: ${passed} passed.`);
}

const invokedAsCli = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (invokedAsCli) {
  try {
    await main();
  } catch (error) {
    console.error(`WRANGNAROK_CLI FAILED: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
