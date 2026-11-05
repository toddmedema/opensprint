import { defineProject } from "vitest/config";
import {
  backendCommonTestConfig,
  createDrizzleSchemaPgResolvePlugin,
  backendIntegrationInclude,
  backendResolveConfig,
  backendSsrConfig,
} from "./vitest.shared.js";

export default defineProject({
  plugins: [createDrizzleSchemaPgResolvePlugin()],
  resolve: backendResolveConfig,
  ssr: backendSsrConfig,
  test: {
    ...backendCommonTestConfig,
    name: "backend-integration",
    include: backendIntegrationInclude,
    env: { OPENSPRINT_VITEST_SCHEMA_SCOPE: "int" },
    pool: "forks",
    // Integration suites pin shared process-level test paths/state. Running files in parallel
    // can cross-contaminate those globals and cause intermittent "socket hang up" failures.
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    isolate: true,
    retry: 2,
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
