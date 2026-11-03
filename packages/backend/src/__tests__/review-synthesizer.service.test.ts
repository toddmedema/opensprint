import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reviewSynthesizerService,
  type AngleReviewInput,
} from "../services/review-synthesizer.service.js";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: vi.fn(),
  },
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getSettings: vi.fn().mockResolvedValue({
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet" },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet" },
    }),
  })),
}));

vi.mock("../services/plan-complexity.js", () => ({
  getComplexityForAgent: vi.fn().mockResolvedValue(undefined),
}));

describe("ReviewSynthesizerService", () => {
  const projectId = "proj-1";
  const repoPath = "/tmp/repo";
  const task = {
    id: "os-abc.1",
    title: "Task 1",
    description: "Do something",
  } as { id: string; title: string; description: string };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns synthesized result when agent produces valid JSON", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify({
        status: "approved",
        summary: "All angles passed: Security, Performance.",
        notes: "",
      }),
    });

    const angleInputs: AngleReviewInput[] = [
      { angle: "security", result: { status: "approved", summary: "OK", notes: "" } },
      { angle: "performance", result: { status: "approved", summary: "OK", notes: "" } },
    ];
    const taskStore = {} as never;
    const result = await reviewSynthesizerService.synthesize(
      projectId,
      repoPath,
      task,
      angleInputs,
      taskStore
    );

    expect(result.status).toBe("approved");
    expect(result.summary).toContain("All angles passed");
    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(1);
  });

  it("returns programmatic merge when agent fails", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("API error"));

    const angleInputs: AngleReviewInput[] = [
      {
        angle: "security",
        result: { status: "rejected", summary: "Bad", issues: ["X"], notes: "" },
      },
      { angle: "performance", result: { status: "approved", summary: "OK", notes: "" } },
    ];
    const taskStore = {} as never;
    const result = await reviewSynthesizerService.synthesize(
      projectId,
      repoPath,
      task,
      angleInputs,
      taskStore
    );

    expect(result.status).toBe("rejected");
    expect(result.issues).toContain("X");
    expect(result.summary).toContain("Bad");
  });

  it("programmatic merge combines rejected issues", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("fail"));

    const angleInputs: AngleReviewInput[] = [
      {
        angle: "security",
        result: { status: "rejected", summary: "S1", issues: ["A"], notes: "" },
      },
      {
        angle: "performance",
        result: { status: "rejected", summary: "S2", issues: ["B"], notes: "" },
      },
    ];
    const taskStore = {} as never;
    const result = await reviewSynthesizerService.synthesize(
      projectId,
      repoPath,
      task,
      angleInputs,
      taskStore
    );

    expect(result.status).toBe("rejected");
    expect(result.issues).toEqual(expect.arrayContaining(["A", "B"]));
  });
  it.each(["success", "failure"])(
    "preserves unique structured blocker identities through %s synthesis",
    async (mode) => {
      const { agentService } = await import("../services/agent.service.js");
      if (mode === "failure")
        vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("offline"));
      else
        vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
          content: JSON.stringify({
            status: "approved",
            summary: "Lead cannot erase blockers",
            notes: "",
          }),
        });
      const finding = {
        id: "f1",
        category: "standard" as const,
        ruleId: "repository",
        ruleRevisionId: "repository@1",
        file: "src/service.ts",
        codeRevision: "a".repeat(40),
        evidence: "Direct read",
        severity: "blocking" as const,
        suggestedRemedy: "Use repository",
        provenance: { reviewer: "reviewer" },
      };
      const result = await reviewSynthesizerService.synthesize(
        projectId,
        repoPath,
        task,
        [
          {
            angle: "security",
            result: { status: "rejected", summary: "Blocked", notes: "", findings: [finding] },
          },
          {
            angle: "performance",
            result: {
              status: "rejected",
              summary: "Also blocked",
              notes: "",
              findings: [
                { ...finding, id: "f9" },
                { ...finding, evidence: "Another distinct blocker" },
              ],
            },
          },
        ],
        {} as never
      );
      expect(result.status).toBe("rejected");
      expect(result.findings).toHaveLength(2);
      expect(new Set(result.findings!.map((f) => f.id)).size).toBe(2);
      expect(
        result.findings!.find((f) => f.evidence === finding.evidence)?.provenance.sources
      ).toHaveLength(2);
    }
  );
});
