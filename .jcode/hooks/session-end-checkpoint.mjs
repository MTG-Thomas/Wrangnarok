// SPDX-License-Identifier: AGPL-3.0
// jcode session_end observer: append a terse checkpoint line to the active
// goal file so the next session can resume without re-reading everything.
// Fire-and-forget: failures are logged by jcode, never block the agent.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const cwd = process.env.JCODE_HOOK_CWD ?? process.cwd();
const sessionId = process.env.JCODE_HOOK_SESSION_ID ?? "unknown";
const goalFile = join(cwd, ".opencode", "goals", "overnight-bifrost.md");

if (existsSync(goalFile)) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `- ${stamp}Z (Jcode session ${sessionId.slice(0, 12)} ended; see git log for changes).\n`;
  try {
    appendFileSync(goalFile, line);
  } catch {
    // Observer: never throw.
  }
}
process.exit(0);
