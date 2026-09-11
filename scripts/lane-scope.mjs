// SPDX-License-Identifier: AGPL-3.0
// Lane scope check: verify a lane branch touches only its slice's files.
// Usage: node scripts/lane-scope.mjs <scope-file>
// A scope file lists allowed path prefixes, one per line ("#" comments allowed).
// Exit 0 = clean, exit 1 = out-of-scope files staged, unstaged, or committed.
// Compares working tree + index + branch diff vs origin/main.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const scopeFile = process.argv
  .slice(1)
  .find((a) => !a.endsWith("lane-scope.mjs") && !a.endsWith("node.exe") && !a.startsWith("-"));
if (!scopeFile || !existsSync(scopeFile)) {
  console.error("usage: node scripts/lane-scope.mjs <scope-file>");
  process.exit(2);
}

const allowed = readFileSync(scopeFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

// Directories lanes must never stage, regardless of scope file.
const NEVER = [".jcode/skills/", ".opencode/skills/", "node_modules/", ".wrangler/", "vendor/"];

let out;
try {
  // Uncommitted changes (working tree + index).
  const uncommitted = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  // Committed branch changes vs origin/main.
  let committed = "";
  try {
    committed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" });
  } catch {
    committed = "";
  }
  out =
    uncommitted +
    "\n" +
    committed
      .split("\n")
      .filter(Boolean)
      .map((f) => `M  ${f}`)
      .join("\n");
} catch {
  console.error("lane-scope: git status failed");
  process.exit(2);
}

const files = out
  .split("\n")
  .map((l) =>
    l
      .slice(3)
      .trim()
      .replace(/^"(.*)"$/, "$1"),
  )
  .filter(Boolean);

const bad = files.filter((f) => {
  if (NEVER.some((n) => f.startsWith(n))) return true;
  return !allowed.some((a) => f === a || f.startsWith(a.endsWith("/") ? a : a + "/") || f.startsWith(a));
});

if (bad.length) {
  console.error("lane-scope: out-of-scope files detected:");
  for (const f of bad) console.error(`  ${f}`);
  console.error(`allowed prefixes (${scopeFile}):`);
  for (const a of allowed) console.error(`  ${a}`);
  process.exit(1);
}
console.log(`lane-scope: clean (${files.length} files within scope)`);
