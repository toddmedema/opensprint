import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      "@opensprint/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    css: false,
    include: ["src/**/*.test.{ts,tsx}", "src/**/*.e2e.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: { minForks: 1, maxForks: 4 },
    },
    testTimeout: 30_000,
    teardownTimeout: 10_000,
    coverage: {
      all: true,
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__tests__/**",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/**/*.d.ts",
        "src/components/icons/**",
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 73, // 73.6% current; raise to 80% as coverage improves
        lines: 80,
      },
    },
  },
});
