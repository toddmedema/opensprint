import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@opensprint/shared": path.resolve(__dirname, "../shared/src/index.ts"),
      pg: path.resolve(__dirname, "../../node_modules/pg/lib/index.js"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts", "src/utils/__tests__/**/*.test.ts"],
    exclude: ["**/git-working-mode-branches.integration.test.ts"],
    pool: "forks",
    globalSetup: ["./src/__tests__/global-setup.ts"],
    globalTeardown: ["./src/__tests__/global-teardown.ts"],
    testTimeout: 30_000,
    teardownTimeout: 25_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/services/**"],
      exclude: ["src/__tests__/**"],
    },
  },
});
