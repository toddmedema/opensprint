import { describe, it, expect } from "vitest";
import { matchesPlanSearchQuery } from "./planSearchFilter";
import type { Plan } from "@opensprint/shared";

function createPlan(planId: string, content: string, overrides?: Partial<Plan>): Plan {
  return {
    metadata: {
      planId,
      epicId: `epic-${planId}`,
      shippedAt: null,
      complexity: "medium",
    },
    content,
    status: "planning",
    taskCount: 0,
    doneTaskCount: 0,
    dependencyCount: 0,
    ...overrides,
  };
}

describe("matchesPlanSearchQuery", () => {
  it("returns true when query is empty", () => {
    const plan = createPlan("plan-1", "# Auth Feature\n\nLogin flow");
    expect(matchesPlanSearchQuery(plan, "")).toBe(true);
    expect(matchesPlanSearchQuery(plan, "   ")).toBe(true);
  });

  it("matches plan title (from H1 in content)", () => {
    const plan = createPlan("plan-1", "# Auth Feature\n\nLogin flow with OAuth");
    expect(matchesPlanSearchQuery(plan, "auth")).toBe(true);
    expect(matchesPlanSearchQuery(plan, "Auth")).toBe(true);
    expect(matchesPlanSearchQuery(plan, "feature")).toBe(true);
  });

  it("matches plan content/description", () => {
    const plan = createPlan("plan-1", "# Auth Feature\n\nLogin flow with OAuth and 2FA");
    expect(matchesPlanSearchQuery(plan, "oauth")).toBe(true);
    expect(matchesPlanSearchQuery(plan, "2fa")).toBe(true);
    expect(matchesPlanSearchQuery(plan, "login")).toBe(true);
  });

  it("returns false when no match", () => {
    const plan = createPlan("plan-1", "# Auth Feature\n\nLogin flow");
    expect(matchesPlanSearchQuery(plan, "dashboard")).toBe(false);
    expect(matchesPlanSearchQuery(plan, "xyz")).toBe(false);
  });

  it("falls back to planId when content is empty or has no extractable title", () => {
    const plan = createPlan("plan-user-authentication", "");
    expect(matchesPlanSearchQuery(plan, "user")).toBe(true);
    expect(matchesPlanSearchQuery(plan, "authentication")).toBe(true);
  });
});
