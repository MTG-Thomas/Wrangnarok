// SPDX-License-Identifier: AGPL-3.0
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Scoped rollout: recommended base plus type-aware promise-safety rules.
// tsc (strict + noUnusedLocals) and prettier already cover types and style;
// this gate exists for async bug classes tsc cannot see.
export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      ".wrangler/",
      "dist/",
      "client/dist/",
      "coverage/",
      "worker-configuration.d.ts",
      "docs/",
      ".opencode/",
      "CODEX_HANDOFF.md",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "test/**/*.tsx", "client/src/**/*.ts", "client/src/**/*.tsx"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", ".jcode/hooks/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
