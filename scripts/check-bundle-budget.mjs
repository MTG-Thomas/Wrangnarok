// SPDX-License-Identifier: AGPL-3.0
// Worker bundle budget (ADR 004): fail closed when the emitted Worker
// bundle exceeds its size budget. Measures raw bytes of the exact bundle
// `wrangler deploy --dry-run --outfile` produces — no CLI output parsing —
// so dependency bloat and cold-start creep break CI instead of drifting.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 2026-09-11 (TABLE-02 query/count/batch slice, issue #154): 180 KiB. The
// author-Tables surface (16 routes plus the tables domain: declarations,
// per-action grants, bounded keyset queries, scoped counts, all-or-denied
// batches) plus the SDK contract entries stacks on the AUTH-01 surface with
// the same deliberate feature headroom, not dependency bloat: package.json
// is unchanged versus main. Combined measures ~174 KiB.
// 2026-09-11 (OPS-01, issue #172): 195 KiB. The audit/notifications slice
// (src/ops.ts: audit + notification domain, keyset pagination, reconcile;
// 4 read routes plus audit emission on 5 app routes and the cancel route;
// SDK audit/notification surface) stacks on the TABLE-02 surface with the
// same deliberate feature headroom, not dependency bloat: package.json is
// unchanged. Remeasure after merge; shrink the raise if the combined bundle
// lands lower. Combined measures ~194 KiB (198216 bytes with 6.5 KiB of
// headroom under this budget).
const BUDGET_BYTES = 195 * 1024;

const dir = mkdtempSync(join(tmpdir(), "wrangnarok-bundle-"));
const outfile = join(dir, "worker.js");
try {
  // Run the pinned local Wrangler directly under node: no shell, no npx
  // resolution, identical on every platform.
  execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--outfile", outfile],
    {
      stdio: "inherit",
    },
  );
  const { size } = statSync(outfile);
  console.log(`Worker bundle: ${size} bytes (budget ${BUDGET_BYTES} bytes).`);
  if (size > BUDGET_BYTES) {
    console.error(
      `Worker bundle budget exceeded: ${size} bytes > ${BUDGET_BYTES} bytes. Shrink the bundle or raise the budget deliberately.`,
    );
    process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
