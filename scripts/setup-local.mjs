import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const token = randomBytes(32).toString("hex");
try {
  await writeFile(
    ".dev.vars",
    `LAB_ENABLED=true\nLAB_TOKEN=${token}\nLAB_ORG_ID=00000000-0000-4000-8000-000000000001\nLAB_USER_ID=00000000-0000-4000-8000-000000000002\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log("Created .dev.vars. Its token is local-only and has not been printed.");
} catch (error) {
  if (error.code === "EEXIST") console.error(".dev.vars already exists; left unchanged.");
  else console.error("Could not create local configuration.");
  process.exitCode = 1;
}
