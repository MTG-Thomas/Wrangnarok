// SPDX-License-Identifier: AGPL-3.0
// jcode pre_tool gate: block production-touching Wrangler commands.
// Local-first per AGENTS.md: deploys stay dry-run, D1 stays --local.
// Exit 0 = allow, exit 2 = block (stderr becomes the tool error).
import { readFileSync } from "node:fs";

const tool = process.env.JCODE_HOOK_TOOL_NAME ?? "";

function readInput() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return process.env.JCODE_HOOK_TOOL_INPUT ?? "";
  }
}

const input = readInput();

function block(reason) {
  process.stderr.write(`blocked by wrangnarok pre_tool guard: ${reason}\n`);
  process.exit(2);
}

function bashCommand(raw) {
  try {
    return String(JSON.parse(raw).command ?? "");
  } catch {
    return String(raw);
  }
}

function toolFilePath(raw) {
  try {
    const body = JSON.parse(raw);
    return String(body.file_path ?? body.filePath ?? "");
  } catch {
    return "";
  }
}

if (tool === "bash") {
  const cmd = bashCommand(input);
  // Production deploy guard: only dry runs are allowed from agent sessions.
  if (/\bwrangler\s+deploy\b/.test(cmd) && !/--dry-run/.test(cmd)) {
    block("wrangler deploy without --dry-run (production deploys need explicit human approval).");
  }
  // Remote D1 guard: migrations/queries must target --local.
  if (/\bwrangler\s+d1\b/.test(cmd) && !/--local/.test(cmd)) {
    block("wrangler d1 without --local (remote D1 writes need explicit human approval).");
  }
  // Secret hygiene: never echo secret values into tracked files or logs.
  if (/\bwrangler\s+secret\s+put\b/.test(cmd)) {
    block("wrangler secret put from agent sessions (human runs secret writes).");
  }
}

if (tool === "write" || tool === "edit" || tool === "apply_patch") {
  const filePath = toolFilePath(input);
  // Local secret files are gitignored but must never gain committed credentials.
  if (/\.dev\.vars/.test(filePath)) {
    block(`writes to ${filePath} (local secret file; human manages it via npm run setup:local).`);
  }
}

process.exit(0);
