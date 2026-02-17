import { describe, it, expect } from "vitest";
import { getSlotForRole, AGENT_ROLE_LABELS } from "../types/agent.js";
import type { AgentRole } from "../types/agent.js";

describe("AgentRole and slot mapping", () => {
  describe("getSlotForRole", () => {
    it("returns coding for coder and reviewer", () => {
      expect(getSlotForRole("coder")).toBe("coding");
      expect(getSlotForRole("reviewer")).toBe("coding");
    });

    it("returns planning for all other roles", () => {
      const planningRoles: AgentRole[] = [
        "dreamer",
        "planner",
        "harmonizer",
        "analyst",
        "summarizer",
        "auditor",
        "delta_planner",
      ];
      for (const role of planningRoles) {
        expect(getSlotForRole(role)).toBe("planning");
      }
    });
  });

  describe("AGENT_ROLE_LABELS", () => {
    it("has human-readable label for each role", () => {
      expect(AGENT_ROLE_LABELS.dreamer).toBe("Dreamer");
      expect(AGENT_ROLE_LABELS.planner).toBe("Planner");
      expect(AGENT_ROLE_LABELS.harmonizer).toBe("Harmonizer");
      expect(AGENT_ROLE_LABELS.analyst).toBe("Analyst");
      expect(AGENT_ROLE_LABELS.summarizer).toBe("Summarizer");
      expect(AGENT_ROLE_LABELS.auditor).toBe("Auditor");
      expect(AGENT_ROLE_LABELS.delta_planner).toBe("Delta Planner");
      expect(AGENT_ROLE_LABELS.coder).toBe("Coder");
      expect(AGENT_ROLE_LABELS.reviewer).toBe("Reviewer");
    });
  });
});
