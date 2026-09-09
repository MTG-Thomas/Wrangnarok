import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
// Applies the committed generic seed (demo org + loopback echo only), then
// the gitignored per-developer override when present
// (scripts/seed-local.override.sql, see .example template). Real endpoints
// must never land in the base seed.
// NOTE: keep executable .sql free of header comments — workerd D1 exec()
// rejects leading comment-only input (wrangler CLI tolerates it, tests do
// not). Document SQL files here or in markdown, not in the SQL.
const files = ["scripts/seed-local.sql"];
if (existsSync("scripts/seed-local.override.sql")) files.push("scripts/seed-local.override.sql");
else console.log("No scripts/seed-local.override.sql; base seed only (see .example template).");
for (const file of files) {
  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--file", file],
      (error, stdout, stderr) => (error ? reject(new Error(`${file}: ${stderr || error.message}`)) : resolve(stdout)),
    );
  });
  console.log(`Seeded ${file}.`);
}
