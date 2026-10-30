import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRole } from "@opensprint/shared";
import {
  mineReplayGradeExecuteSessionIds,
  buildBehaviorExperimentCandidateBundle,
  SelfImprovementExperimentService,
  type BehaviorExperimentInstructionBaseline,
} from "../services/self-improvement-experiment.service.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    getDb: vi.fn(),
  },
}));

vi.mock("../services/behavior-version-store.service.js", () => ({
  runBehaviorVersionStoreWrite: vi.fn(),
}));

describe("self-improvement-experiment.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mineReplayGradeExecuteSessionIds returns numeric session ids", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.getDb).mockResolvedValue({
      query: vi.fn().mockResolvedValue([{ id: 42 }, { id: 43 }]),
    } as never);

    const ids = await mineReplayGradeExecuteSessionIds("proj-1");
    expect(ids).toEqual([42, 43]);
    expect(vi.mocked(taskStore.getDb)).toHaveBeenCalled();
  });

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

  it("generateAndPersistCandidate persists bundle via BehaviorVersionStore.saveCandidate", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.getDb).mockResolvedValue({
      query: vi.fn().mockResolvedValue([{ id: 1 }]),
    } as never);

    const saveCandidate = vi.fn().mockResolvedValue(undefined);
    const { runBehaviorVersionStoreWrite } =
      await import("../services/behavior-version-store.service.js");
    vi.mocked(runBehaviorVersionStoreWrite).mockImplementation(async (fn) => {
      await fn({ saveCandidate } as never);
    });

    const instructions = {
      getGeneralInstructions: vi.fn().mockResolvedValue("general-body"),
      getRoleInstructions: vi.fn().mockResolvedValue("role-body"),
    };
    const svc = new SelfImprovementExperimentService(
      instructions as import("../services/agent-instructions.service.js").AgentInstructionsService
    );

    const { versionId, bundle } = await svc.generateAndPersistCandidate("proj-1", "run-z", [
      {
        target: "general",
        before: "general-body",
        after: "updated-general",
        supportingDecisionIds: ["d1"],
        contraryDecisionIds: [],
      },
    ]);
    expect(versionId).toBe("exp-run-z");
    expect(bundle.minedSessionIds).toEqual([1]);
    expect(saveCandidate).toHaveBeenCalledWith(
      "proj-1",
      "exp-run-z",
      expect.stringContaining('"versionType":"candidate"')
    );
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
