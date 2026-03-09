import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const parallelism =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;

export default defineConfig({
  resolve: {
    alias: {
      "@opensprint/shared": path.resolve(__dirname, "../shared/src/index.ts"),
      pg: path.resolve(__dirname, "../../node_modules/pg/lib/index.js"),
      // Alias @google/genai to a mock so Vite can load it. Fixes "Failed to load url @google/genai"
      // in tests that indirectly import agent-client.ts.
      "@google/genai": path.resolve(__dirname, "src/__tests__/mocks/google-genai.mock.ts"),
    },
  },
  // Let Node load these natively so Vite doesn't transform them (avoids "Failed to load url" for
  // drizzle-orm subpaths and native modules like better-sqlite3).
  ssr: {
    external: [
      "@google/genai",
      "drizzle-orm",
      "drizzle-orm/node-postgres",
      "drizzle-orm/pg-core",
      "better-sqlite3",
    ],
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.ts", "src/utils/__tests__/**/*.test.ts"],
    exclude: ["**/git-working-mode-branches.integration.test.ts"],
    pool: "forks",
    minWorkers: 1,
    maxWorkers: Math.max(1, Math.ceil(parallelism * 0.75)),
    globalSetup: ["./src/__tests__/global-setup.ts"],
    globalTeardown: ["./src/__tests__/global-teardown.ts"],
    testTimeout: 30_000,
    teardownTimeout: 25_000,
    hookTimeout: 60_000,
    coverage: {
      all: true,
      provider: "v8",
      include: [
        "src/services/**/*.ts",
        "src/routes/**/*.ts",
        "src/middleware/**/*.ts",
        "src/db/**/*.ts",
        "src/utils/**/*.ts",
      ],
      exclude: [
        "src/__tests__/**",
        "src/utils/__tests__/**",
        "src/__tests__/mocks/**",
        "src/index.ts",
        "src/__tests__/setup.ts",
        "src/__tests__/global-setup.ts",
        "src/__tests__/global-teardown.ts",
      ],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 75,
      },
    },
  },
});
