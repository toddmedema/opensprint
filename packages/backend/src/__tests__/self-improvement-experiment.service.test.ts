import { describe, it, expect } from "vitest";
import type { AgentRole } from "@opensprint/shared";
import {
  buildBehaviorExperimentCandidateBundle,
  type BehaviorExperimentInstructionBaseline,
} from "../services/self-improvement-experiment.service.js";

describe("self-improvement-experiment.service", () => {
  it("buildBehaviorExperimentCandidateBundle applies exact decision-backed content and complete diffs", () => {
    const baseline: BehaviorExperimentInstructionBaseline = {
      general: "base",
      roles: { coder: "role-c", reviewer: "role-r" } as Partial<Record<AgentRole, string>>,
      templates: { coder: "t-c", reviewer: "t-r", finalReview: "t-f", selfImprovement: "t-s" },
    };
    const bundle = buildBehaviorExperimentCandidateBundle({
      sessionIds: [7, 8],
      baseline,
      runId: "si-run",
      amendments: [
        {
          target: "general",
          before: "base",
          after: "base\nApproved diagnostic exceptions require evidence.",
          supportingDecisionIds: ["decision-1"],
          contraryDecisionIds: ["decision-2"],
        },
      ],
    });
    expect(bundle.versionType).toBe("candidate");
    expect(bundle.minedSessionIds).toEqual([7, 8]);
    expect(bundle.runId).toBe("si-run");
    expect(bundle.generalInstructionDiff).toContain("--- AGENTS.md");
    expect(bundle.generalInstructionDiff).toContain(
      "Approved diagnostic exceptions require evidence."
    );
    expect(bundle.candidateContent?.general).toContain("diagnostic exceptions");
    expect(bundle.supportingDecisionIds).toEqual(["decision-1"]);
    expect(bundle.contraryDecisionIds).toEqual(["decision-2"]);
    expect(bundle.promptTemplateDiffs.coder).toBe("");
  });

  it("does not invent overlays without substantive amendments and rejects stale content", () => {
    const baseline: BehaviorExperimentInstructionBaseline = {
      general: "approved",
      roles: {},
      templates: { coder: "", reviewer: "", finalReview: "", selfImprovement: "" },
    };
    const bundle = buildBehaviorExperimentCandidateBundle({
      sessionIds: [],
      baseline,
      runId: "no-rulings",
    });
    expect(bundle.candidateContent).toEqual(baseline);
    expect(bundle.generalInstructionDiff).toBe("");
    expect(() =>
      buildBehaviorExperimentCandidateBundle({
        sessionIds: [],
        baseline,
        runId: "stale",
        amendments: [
          {
            target: "general",
            before: "old",
            after: "new",
            supportingDecisionIds: ["d1"],
            contraryDecisionIds: [],
          },
        ],
      })
    ).toThrow("Stale");
  });
});
