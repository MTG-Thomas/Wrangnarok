// SPDX-License-Identifier: AGPL-3.0
// File-based bridge to the opencode inter-session mailbox (.opencode/plugins).
// Lets harnesses without the opencode plugin host (no mailbox_* tools, no
// session identity) send, read, and own an alias in the same JSONL stores.
// Poll-only: nothing here can push into a live session; opencode recipients
// still get their normal push path via their own hooks.
// Identity: --as <session> or $MAILBOX_SESSION. Store: --store <dir> or
// $MAILBOX_STORE, else the stable key derived from the git common dir so all
// worktrees of this repo resolve the same store as main-checkout sessions.

import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  INBOX_MAX,
  MailboxFault,
  buildMessage,
  findReply,
  formatLine,
  isRecentlyActive,
  markStatus,
  parseLine,
  unread,
  validAlias,
} from "../.opencode/plugins/mailbox-store.ts";

function fail(code, message) {
  console.error(`MAILBOX_ERROR ${code}: ${message}`);
  process.exit(code === "USAGE" || code === "VALIDATION" ? 2 : 1);
}

function mailboxRoots() {
  return join(homedir(), ".local", "share", "opencode", "mailbox");
}

function stableKey() {
  try {
    const common = execSync("git rev-parse --git-common-dir", { encoding: "utf-8" }).trim();
    return dirname(common.replace(/\/.git$/, ""));
  } catch {
    return process.cwd();
  }
}

function defaultStore() {
  if (process.env.MAILBOX_STORE) return process.env.MAILBOX_STORE;
  const key = stableKey();
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(mailboxRoots(), hash);
}

function identity(args) {
  const id = args.as ?? process.env.MAILBOX_SESSION;
  if (!id) fail("USAGE", "no identity: pass --as <session> or set $MAILBOX_SESSION.");
  return id;
}

function safeFile(sessionId) {
  const base = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return `${base.length > 0 ? base : "session"}.jsonl`;
}

function readAliases(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, "aliases.json"), "utf-8"));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Missing or corrupt: empty.
  }
  return {};
}

function allStores() {
  try {
    return readdirSync(mailboxRoots(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(mailboxRoots(), e.name));
  } catch {
    return [];
  }
}

/** Everywhere a recipient or inbox may live: the resolved store plus all known ones. */
function searchRoots(defaultRoot) {
  const roots = new Set([defaultRoot, ...allStores()]);
  return [...roots];
}

function loadInbox(root, sessionId) {
  try {
    const raw = readFileSync(join(root, safeFile(sessionId)), "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseLine)
      .filter((m) => m !== null);
  } catch {
    return [];
  }
}

function saveInbox(root, sessionId, messages) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, safeFile(sessionId)),
    messages.map(formatLine).join("\n") + (messages.length > 0 ? "\n" : ""),
  );
}

function aliasFor(root, sessionId) {
  for (const [alias, id] of Object.entries(readAliases(root))) {
    if (id === sessionId) return alias;
  }
  return undefined;
}

/** Resolve a recipient (alias or session id) across every known store. */
function resolveRecipient(to, defaultRoot) {
  const trimmed = to.trim();
  if (trimmed === "*") return { store: null, session: "*" };
  for (const root of searchRoots(defaultRoot)) {
    const aliases = readAliases(root);
    if (aliases[trimmed] !== undefined) return { store: root, session: aliases[trimmed] };
  }
  for (const root of searchRoots(defaultRoot)) {
    if (existsSync(join(root, safeFile(trimmed)))) return { store: root, session: trimmed };
  }
  fail("VALIDATION", `unknown recipient ${JSON.stringify(to)} (no alias or inbox in any store).`);
}

function cmdSend(args, rest) {
  const to = rest["to"];
  const body = rest["body"];
  if (!to || body === undefined) fail("USAGE", "send needs --to <alias|session|*> and --body <text>.");
  const from = identity(args);
  const target = resolveRecipient(to, args.store);
  const message = buildMessage(
    from,
    {
      to: target.session,
      kind: rest["kind"],
      priority: rest["priority"],
      subject: rest["subject"],
      body,
      replyTo: rest["reply-to"],
    },
    randomUUID(),
    new Date().toISOString(),
  );
  const targets =
    target.session === "*"
      ? searchRoots(args.store)
          .filter((root) => existsSync(root))
          .flatMap((root) =>
            readdirSync(root)
              .filter((n) => n.endsWith(".jsonl"))
              .map((n) => ({ root, session: n.slice(0, -6) })),
          )
      : [{ root: target.store ?? args.store, session: target.session }];
  if (targets.length === 0) fail("VALIDATION", "broadcast has no known inboxes yet.");
  for (const t of targets) {
    if (unread(loadInbox(t.root, t.session)).length >= INBOX_MAX) {
      fail("VALIDATION", `recipient inbox is full (${INBOX_MAX} unread).`);
    }
  }
  const fromAlias = target.session === "*" ? aliasFor(defaultStore(), from) : aliasFor(targets[0].root, from);
  for (const t of targets) {
    mkdirSync(t.root, { recursive: true });
    appendFileSync(
      join(t.root, safeFile(t.session)),
      formatLine({ ...message, to: t.session, ...(fromAlias === undefined ? {} : { fromAlias }) }) + "\n",
    );
  }
  console.log(`sent ${message.id} to ${to} (${targets.length} inbox(es))`);
}

function printMessage(m) {
  const head = `[${m.kind}/${m.priority}] from ${m.fromAlias ?? m.from} id=${m.id}${m.replyTo ? ` replyTo=${m.replyTo}` : ""}${m.subject ? ` subj=${JSON.stringify(m.subject)}` : ""}`;
  return `${head}\n${m.body}`;
}

function cmdRead(args, rest) {
  const from = identity(args);
  const roots = rest["all"] ? allStores() : [args.store];
  let shown = 0;
  for (const root of roots) {
    const messages = loadInbox(root, from);
    const pending = unread(messages).slice(0, 20);
    if (pending.length === 0) continue;
    saveInbox(
      root,
      from,
      markStatus(
        messages,
        pending.map((m) => m.id),
        "read",
      ),
    );
    console.log(pending.map(printMessage).join("\n---\n"));
    shown += pending.length;
  }
  if (shown === 0) console.log("Mailbox: empty.");
}

function cmdAlias(args, positional) {
  const alias = (positional[0] ?? "").trim().toLowerCase();
  if (!validAlias(alias)) fail("VALIDATION", "use [a-z0-9_-], max 32 chars, start alnum.");
  const from = identity(args);
  mkdirSync(args.store, { recursive: true });
  const all = readAliases(args.store);
  all[alias] = from;
  writeFileSync(join(args.store, "aliases.json"), JSON.stringify(all, null, 2));
  console.log(`alias ${JSON.stringify(alias)} -> ${from}`);
}

function cmdSessions(args) {
  for (const root of searchRoots(args.store)) {
    const now = Date.now();
    let entries;
    try {
      entries = readdirSync(root).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const aliases = readAliases(root);
    const names = new Map(Object.entries(aliases).map(([a, id]) => [id, a]));
    console.log(`store ${root}:`);
    for (const file of entries) {
      const id = file.slice(0, -".jsonl".length);
      let fresh = false;
      try {
        fresh = isRecentlyActive(statSync(join(root, file)).mtimeMs, now);
      } catch {
        // Unreadable: stale.
      }
      const pending = unread(loadInbox(root, id)).length;
      console.log(
        `  ${id}${names.get(id) ? ` (alias: ${names.get(id)})` : ""} unread=${pending}${fresh ? " active" : ""}`,
      );
    }
  }
}

function cmdSelftest() {
  const root = join(tmpdir(), `mailbox-selftest-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const probe = {
    id: "t1",
    from: "a",
    to: "b",
    ts: new Date().toISOString(),
    kind: "note",
    priority: "standard",
    body: "hi",
    status: "queued",
  };
  if (parseLine(formatLine(probe))?.body !== "hi") fail("INTERNAL", "JSONL round-trip broken.");
  const req = buildMessage("a", { to: "b", kind: "request", body: "q?" }, "r1", new Date().toISOString());
  appendFileSync(join(root, safeFile("b")), formatLine(req) + "\n");
  const rep = buildMessage("b", { to: "a", kind: "reply", body: "a!", replyTo: "r1" }, "r2", new Date().toISOString());
  appendFileSync(join(root, safeFile("a")), formatLine(rep) + "\n");
  const found = findReply(unread(loadInbox(root, "a")), "r1");
  if (found?.body !== "a!") fail("INTERNAL", "request/reply correlation broken.");
  if (!isRecentlyActive(Date.now(), Date.now()) || isRecentlyActive(Date.now() - 3600_000, Date.now())) {
    fail("INTERNAL", "recency window broken.");
  }
  const env = { ...process.env, MAILBOX_STORE: root, MAILBOX_SESSION: "a" };
  const out = execSync(`node "${process.argv[1]}" read`, { encoding: "utf-8", env });
  if (!out.includes("a!")) fail("INTERNAL", "CLI read path broken.");
  console.log("selftest OK");
}

function parseArgv(argv) {
  const args = { store: defaultStore() };
  const positional = [];
  const rest = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--store") args.store = argv[++i];
    else if (token === "--as") args.as = argv[++i];
    else if (token === "--all") rest["all"] = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      rest[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else positional.push(token);
    i++;
  }
  return { args, positional, rest };
}

const [command, ...argv] = process.argv.slice(2);
try {
  const { args, positional, rest } = parseArgv(argv);
  if (command === "send") cmdSend(args, rest);
  else if (command === "read") cmdRead(args, rest);
  else if (command === "alias") cmdAlias(args, positional);
  else if (command === "sessions") cmdSessions(args);
  else if (command === "selftest") cmdSelftest();
  else if (command === "store") console.log(args.store);
  else {
    console.log(`usage: mailbox-cli [--store DIR] [--as SESSION] <send|read|alias|sessions|selftest|store> [options]
  send --to <alias|session|*> --body <text> [--kind note|steer|request|reply] [--priority standard|high] [--subject S] [--reply-to ID]
  read [--all]            unread oldest-first, marks read
  alias <name>            register alias for your session
  sessions                known inboxes across all stores
  selftest                temp-dir roundtrip for CI
  store                   print resolved default store
identity: --as or $MAILBOX_SESSION. store: --store or $MAILBOX_STORE, else stable git-derived key.
needs Node 22.18+ (imports erasable-syntax .ts directly).`);
    process.exit(command === undefined ? 0 : 2);
  }
} catch (error) {
  if (error instanceof MailboxFault) fail("VALIDATION", `${error.code}: ${error.message}`);
  fail("INTERNAL", error instanceof Error ? error.message : String(error));
}
