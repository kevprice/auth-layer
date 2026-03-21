import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "apps/**/*.test.tsx", "packages/**/*.test.ts", "integrations/**/*.test.ts"],
    environment: "node",
    environmentMatchGlobs: [["apps/web/**/*.test.tsx", "jsdom"], ["integrations/browser-extension/**/*.test.ts", "jsdom"]],
    setupFiles: ["apps/web/test/setup.ts"]
  }
});
