import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@opensprint/shared": path.resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    pool: "threads",
    poolOptions: {
      threads: { minThreads: 1, maxThreads: 2 },
    },
    testTimeout: 30_000,
    teardownTimeout: 10_000,
  },
});
