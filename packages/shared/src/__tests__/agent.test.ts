import { describe, it, expect } from "vitest";
import {
  getSlotForRole,
  getRoleDisplayLabel,
  AGENT_ROLE_LABELS,
  AGENT_ROLE_CANONICAL_ORDER,
  AGENT_ROLE_PHASES,
  AGENT_ROLE_DESCRIPTIONS,
  sortAgentsByCanonicalOrder,
} from "../types/agent.js";
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
      expect(AGENT_ROLE_LABELS.coder).toBe("Coder");
      expect(AGENT_ROLE_LABELS.reviewer).toBe("Reviewer");
    });
  });

  describe("AGENT_ROLE_CANONICAL_ORDER", () => {
    it("matches README/PRD agent table order", () => {
      expect(AGENT_ROLE_CANONICAL_ORDER).toEqual([
        "dreamer",
        "planner",
        "harmonizer",
        "analyst",
        "summarizer",
        "auditor",
        "coder",
        "reviewer",
        "merger",
      ]);
    });
  });

  describe("AGENT_ROLE_PHASES", () => {
    it("has phase(s) for each role matching README table", () => {
      expect(AGENT_ROLE_PHASES.dreamer).toEqual(["Sketch"]);
      expect(AGENT_ROLE_PHASES.planner).toEqual(["Plan"]);
      expect(AGENT_ROLE_PHASES.harmonizer).toEqual(["All"]);
      expect(AGENT_ROLE_PHASES.analyst).toEqual(["Evaluate"]);
      expect(AGENT_ROLE_PHASES.summarizer).toEqual(["Execute"]);
      expect(AGENT_ROLE_PHASES.auditor).toEqual(["Execute"]);
      expect(AGENT_ROLE_PHASES.coder).toEqual(["Execute"]);
      expect(AGENT_ROLE_PHASES.reviewer).toEqual(["Execute"]);
      expect(AGENT_ROLE_PHASES.merger).toEqual(["Execute"]);
    });
  });

  describe("AGENT_ROLE_DESCRIPTIONS", () => {
    /** Role descriptions from README.md Agent team table (source of truth) */
    const README_ROLE_DESCRIPTIONS: Record<string, string> = {
      dreamer: "Refines your idea into a PRD; asks the hard questions before the journey begins.",
      planner: "Decomposes the PRD into epics, tasks, and dependency graph.",
      harmonizer: "Keeps the PRD true as implementation forces compromises.",
      analyst: "Categorizes feedback and maps it to the right epic.",
      summarizer: "Distills context to exactly what the Coder needs.",
      auditor: "Surveys what's actually built and what still needs doing.",
      coder: "Implements tasks and ships working code with tests.",
      reviewer: "Validates implementation against acceptance criteria.",
      merger: "Resolves rebase conflicts and keeps the journey moving.",
    };

    it("has entry for all 9 roles in AGENT_ROLE_CANONICAL_ORDER", () => {
      for (const role of AGENT_ROLE_CANONICAL_ORDER) {
        expect(AGENT_ROLE_DESCRIPTIONS[role]).toBeDefined();
        expect(typeof AGENT_ROLE_DESCRIPTIONS[role]).toBe("string");
        expect(AGENT_ROLE_DESCRIPTIONS[role].length).toBeGreaterThan(10);
      }
    });

    it("matches README table descriptions exactly for all 9 agents", () => {
      for (const role of AGENT_ROLE_CANONICAL_ORDER) {
        expect(AGENT_ROLE_DESCRIPTIONS[role]).toBe(README_ROLE_DESCRIPTIONS[role]);
      }
    });
  });

  describe("sortAgentsByCanonicalOrder", () => {
    it("sorts agents by canonical role order", () => {
      const agents = [
        { id: "1", phase: "coding", role: "coder" as AgentRole, label: "C", startedAt: "" },
        { id: "2", phase: "plan", role: "dreamer" as AgentRole, label: "D", startedAt: "" },
        { id: "3", phase: "execute", role: "auditor" as AgentRole, label: "A", startedAt: "" },
      ];
      const sorted = sortAgentsByCanonicalOrder(agents);
      expect(sorted.map((a) => a.role)).toEqual(["dreamer", "auditor", "coder"]);
    });

    it("sorts entries with getAgent when provided", () => {
      const entries = [
        {
          agent: {
            id: "1",
            phase: "coding",
            role: "reviewer" as AgentRole,
            label: "R",
            startedAt: "",
          },
        },
        {
          agent: {
            id: "2",
            phase: "plan",
            role: "planner" as AgentRole,
            label: "P",
            startedAt: "",
          },
        },
      ];
      const sorted = sortAgentsByCanonicalOrder(entries, (e) => e.agent);
      expect(sorted.map((e) => e.agent.role)).toEqual(["planner", "reviewer"]);
    });

    it("uses phase-derived role when role is missing (coding→coder, review→reviewer)", () => {
      const agents = [
        { id: "1", phase: "review", role: undefined, label: "R", startedAt: "" },
        { id: "2", phase: "coding", role: undefined, label: "C", startedAt: "" },
      ];
      const sorted = sortAgentsByCanonicalOrder(agents);
      expect(sorted[0].phase).toBe("coding");
      expect(sorted[1].phase).toBe("review");
    });
  });

  describe("AGENT_ROLE_PHASES (consistency check)", () => {
    it("has phase(s) for each role matching agent.ts source of truth", () => {
      expect(AGENT_ROLE_PHASES.dreamer).toEqual(["Sketch"]);
      expect(AGENT_ROLE_PHASES.planner).toEqual(["Plan"]);
      expect(AGENT_ROLE_PHASES.harmonizer).toEqual(["All"]);
      expect(AGENT_ROLE_PHASES.analyst).toEqual(["Evaluate"]);
      expect(AGENT_ROLE_PHASES.summarizer).toEqual(["Execute"]);
      expect(AGENT_ROLE_PHASES.auditor).toEqual(["Execute"]);
      expect(AGENT_ROLE_PHASES.coder).toEqual(["Execute"]);
      expect(AGENT_ROLE_PHASES.reviewer).toEqual(["Execute"]);
      expect(AGENT_ROLE_PHASES.merger).toEqual(["Execute"]);
    });

    it("covers all roles in AGENT_ROLE_CANONICAL_ORDER", () => {
      for (const role of AGENT_ROLE_CANONICAL_ORDER) {
        expect(AGENT_ROLE_PHASES[role]).toBeDefined();
        expect(Array.isArray(AGENT_ROLE_PHASES[role])).toBe(true);
        expect(AGENT_ROLE_PHASES[role].length).toBeGreaterThan(0);
      }
    });

    it("matches README table phases for all 9 agents", () => {
      const README_PHASES: Record<string, readonly string[]> = {
        dreamer: ["Sketch"],
        planner: ["Plan"],
        harmonizer: ["All"],
        analyst: ["Evaluate"],
        summarizer: ["Execute"],
        auditor: ["Execute"],
        coder: ["Execute"],
        reviewer: ["Execute"],
        merger: ["Execute"],
      };
      for (const role of AGENT_ROLE_CANONICAL_ORDER) {
        expect(AGENT_ROLE_PHASES[role]).toEqual(README_PHASES[role]);
      }
    });
  });

  describe("getRoleDisplayLabel", () => {
    it("returns role label only when name is absent", () => {
      expect(getRoleDisplayLabel({ role: "coder", phase: "coding" })).toBe("Coder");
      expect(getRoleDisplayLabel({ role: "planner", phase: "plan" })).toBe("Planner");
    });

    it("returns role (name) when name is present", () => {
      expect(getRoleDisplayLabel({ role: "coder", phase: "coding", name: "Frodo" })).toBe(
        "Coder (Frodo)"
      );
      expect(getRoleDisplayLabel({ role: "reviewer", phase: "review", name: "Sam" })).toBe(
        "Reviewer (Sam)"
      );
    });

    it("falls back to phase label when role is unknown", () => {
      expect(getRoleDisplayLabel({ phase: "coding" })).toBe("Coding");
      expect(getRoleDisplayLabel({ phase: "plan", name: "Gandalf" })).toBe("Plan (Gandalf)");
    });

    it("ignores empty or whitespace-only name", () => {
      expect(getRoleDisplayLabel({ role: "coder", name: "" })).toBe("Coder");
      expect(getRoleDisplayLabel({ role: "coder", name: "   " })).toBe("Coder");
    });
  });
});
