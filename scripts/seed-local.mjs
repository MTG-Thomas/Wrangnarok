import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
// Applies the committed generic seed, then the gitignored per-developer
// override when present. Real endpoints must never land in the base seed.
const files = ["scripts/seed-local.sql"];
if (existsSync("scripts/seed-local.override.sql")) files.push("scripts/seed-local.override.sql");
else console.log("No scripts/seed-local.override.sql; base seed only (see .example template).");
for (const file of files) {
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ["./node_modules/wrangler/bin/wrangler.js",
      "d1", "execute", "DB", "--local", "--file", file],
    (error, stdout, stderr) => error ? reject(new Error(`${file}: ${stderr || error.message}`)) : resolve(stdout));
  });
  console.log(`Seeded ${file}.`);
}
