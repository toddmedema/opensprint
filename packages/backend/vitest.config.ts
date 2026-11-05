import { defineConfig } from "vitest/config";
import { backendGlobalSetupFile } from "./vitest.shared.js";

const coverageReporters =
  process.env.CI === "true" || process.env.CI === "1"
    ? ["text-summary", "json-summary", "lcovonly"]
    : ["text", "html", "json-summary"];

export default defineConfig({
  test: {
    // Unit routes also use PostgreSQL. Provision/verify the isolated test database
    // before any selected project's workers, including unit-only and coverage runs.
    globalSetup: [backendGlobalSetupFile],
    // Vitest 3 creates its worker pool from the root config, not project configs. Keep
    // HTTP/database suites sequential here so their existing isolation policy takes effect
    // in both `test` and `test:coverage` (which runs all three projects together).
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    projects: [
      "./vitest.unit.config.ts",
      "./vitest.env-route.config.ts",
      "./vitest.integration.config.ts",
    ],
    testTimeout: 30_000,
    coverage: {
      all: true,
      provider: "v8",
      reporter: coverageReporters,
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
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
