/**
 * Integration test: verifies that @opensprint/shared package exports resolve
 * correctly when main/types/exports point at ./src/index.ts (source resolution).
 * Both Vite (frontend) and tsx (backend) should resolve to TypeScript source
 * during development.
 */
import { describe, it, expect } from "vitest";
import * as shared from "@opensprint/shared";

describe("package exports (src/index.ts resolution)", () => {
  it("exports constants", () => {
    expect(shared.KANBAN_COLUMNS).toBeDefined();
    expect(shared.API_PREFIX).toBeDefined();
    expect(shared.OPENSPRINT_PATHS).toBeDefined();
  });

  it("exports plan template utilities", () => {
    expect(shared.getPlanTemplate).toBeDefined();
    expect(typeof shared.getPlanTemplate).toBe("function");
  });

  it("exports bead ID utilities", () => {
    expect(shared.getEpicId).toBeDefined();
    expect(typeof shared.getEpicId).toBe("function");
  });

  it("exports deployment utilities", () => {
    expect(shared.getDefaultDeploymentTarget).toBeDefined();
    expect(typeof shared.getDefaultDeploymentTarget).toBe("function");
  });
});
