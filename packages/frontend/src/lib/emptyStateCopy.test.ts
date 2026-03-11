import { describe, it, expect } from "vitest";
import { EMPTY_STATE_COPY } from "./emptyStateCopy";

describe("EMPTY_STATE_COPY", () => {
  it("defines copy for all five phases", () => {
    expect(EMPTY_STATE_COPY.sketch).toBeDefined();
    expect(EMPTY_STATE_COPY.plan).toBeDefined();
    expect(EMPTY_STATE_COPY.execute).toBeDefined();
    expect(EMPTY_STATE_COPY.eval).toBeDefined();
    expect(EMPTY_STATE_COPY.deliver).toBeDefined();
  });

  it("each phase has title, description, and primaryActionLabel", () => {
    const phases = ["sketch", "plan", "execute", "eval", "deliver"] as const;
    for (const phase of phases) {
      const spec = EMPTY_STATE_COPY[phase];
      expect(spec.title).toBeTruthy();
      expect(typeof spec.title).toBe("string");
      expect(spec.description).toBeTruthy();
      expect(typeof spec.description).toBe("string");
      expect(spec.primaryActionLabel).toBeTruthy();
      expect(typeof spec.primaryActionLabel).toBe("string");
    }
  });

  it("matches documented pattern (title, description, action)", () => {
    expect(EMPTY_STATE_COPY.sketch.title).toBe("What do you want to build?");
    expect(EMPTY_STATE_COPY.sketch.description).toBe("Describe your app idea and Open Sprint will generate a PRD.");
    expect(EMPTY_STATE_COPY.plan.title).toBe("No plans yet");
    expect(EMPTY_STATE_COPY.plan.description).toBe("Create a plan to break down your spec into tasks.");
    expect(EMPTY_STATE_COPY.execute.title).toBe("No tasks yet");
    expect(EMPTY_STATE_COPY.execute.description).toBe("Ship a plan from the Plan phase to start generating tasks.");
    expect(EMPTY_STATE_COPY.eval.title).toBe("No feedback yet");
    expect(EMPTY_STATE_COPY.eval.description).toBe("Test your app and report findings using the form above.");
    expect(EMPTY_STATE_COPY.deliver.title).toBe("No deliveries yet");
    expect(EMPTY_STATE_COPY.deliver.description).toBe("Configure targets in settings, then deploy from the toolbar.");
  });
});
