import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      LAB_ENABLED: "true",
      LAB_TOKEN: "a".repeat(64),
      LAB_ORG_ID: "00000000-0000-4000-8000-000000000001",
      LAB_USER_ID: "00000000-0000-4000-8000-000000000002",
    } },
  })],
  test: { include: ["test/**/*.test.ts"] },
});
