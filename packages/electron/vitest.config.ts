import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const coverageReporters =
  process.env.CI === "true" || process.env.CI === "1"
    ? ["text-summary", "json-summary", "lcovonly"]
    : ["text", "html", "json-summary"];

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.{js,mjs,ts}", "*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      all: true,
      provider: "v8",
      reporter: coverageReporters,
      // Main process entrypoints (main/preload) are integration-heavy; enforce thresholds on unit-tested modules.
      include: [
        "boot-screen.ts",
        "desktop-crash-log.ts",
        "open-in-editor.ts",
        "runtime-branding.ts",
        "sqlite-runtime-path.ts",
        "window-options.ts",
      ],
      exclude: ["**/*.test.*"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: {
      // Resolve scripts from package root
      ".": path.resolve(__dirname, "."),
    },
  },
});
