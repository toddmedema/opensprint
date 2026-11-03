import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluatePolicyProposal,
  policyReplayInstructions,
} from "../services/policy-evaluation.service.js";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  record: vi.fn(),
  activate: vi.fn(),
  candidateRule: {} as Record<string, unknown>,
  baseRule: {} as Record<string, unknown>,
  decisions: [] as Array<{ id: string; taskId: string }>,
  fixtures: [] as Array<{ hash: string; fixture: Record<string, unknown> }>,
  bindings: undefined as Array<{ sessionId: number; releaseId: string; hash: string }> | undefined,
}));
const rule = {
  id: "rule1",
  ruleId: "repository",
  revision: 1,
  text: "Use repository",
  rationale: "consistency",
  owner: "owner",
  paths: [],
  components: [],
  roles: [],
  severity: "standard",
  mandatory: true,
  exceptionEligible: true,
  examples: { compliant: [], noncompliant: [] },
  parentIds: [],
  overrideIds: [],
  conflictIds: [],
  layer: 1,
  sourceHash: "hash",
};
vi.mock("../services/governance.service.js", () => ({
  governanceService: {
    getProposal: vi.fn().mockResolvedValue({
      id: "p1",
      baseReleaseId: "base",
      version: 1,
      createdAt: "2026-10-30T00:00:00Z",
      patches: [{ ruleId: "repository" }],
      supportingDecisionIds: ["decision"],
      contraryDecisionIds: [],
    }),
    listProposals: vi.fn().mockResolvedValue([]),
    listDecisions: vi.fn().mockImplementation(async () => mocks.decisions),
    listReplayFixtureBindings: vi.fn().mockImplementation(
      async () =>
        mocks.bindings ??
        mocks.fixtures.map((f) => ({
          sessionId: f.fixture.sessionId,
          releaseId: "base",
          hash: f.hash,
        }))
    ),
    getRelease: vi.fn().mockImplementation(async () => ({
      id: "base",
      rules: [mocks.baseRule],
      instructions: {},
      contentHash: "base-hash",
    })),
    previewProposalRelease: vi.fn().mockImplementation(async () => ({
      id: "candidate",
      rules: [mocks.candidateRule],
      instructions: {},
      contentHash: "candidate-hash",
    })),
    recordEvaluation: mocks.record,
    activateProposal: mocks.activate,
  },
}));
vi.mock("../services/replay-fixture.service.js", () => ({
  REPLAY_LABELS: ["compliant", "exception", "defect", "conflict", "retrieval_miss"],
  replayFixtureService: {
    list: vi.fn().mockImplementation(async () => mocks.fixtures),
    saveEvaluation: vi.fn().mockResolvedValue("retained-artifact-hash"),
  },
}));
vi.mock("../services/isolated-replay-runner.service.js", () => ({
  IsolatedReplayRunner: vi.fn().mockImplementation(() => ({ run: mocks.run })),
}));
describe("policy amendment evaluation admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.baseRule, rule);
    Object.assign(mocks.candidateRule, rule, {
      id: "rule2",
      revision: 2,
      text: "Use repository for every write",
    });
    mocks.decisions = [];
    mocks.bindings = undefined;
    mocks.fixtures = Array.from({ length: 10 }, (_, i) => ({
      hash: `fixture-${i + 1}`,
      fixture: {
        sessionId: i + 1,
        taskId: `task-${i + 1}`,
        policyReleaseId: "base",
        changedPaths: ["src/x.ts"],
        label: ["compliant", "exception", "defect", "conflict", "retrieval_miss"][i % 5],
        holdout: true,
      },
    }));
    mocks.run.mockImplementation(async ({ sessionId }) => ({
      success: true,
      reviewPassed: true,
      evaluationComplete: true,
      inputHash: `fixture-${sessionId}`,
      rubricId: "independent-rubric",
      holdout: true,
      retryCount: 0,
      latencyMs: 1,
      costUsd: 0,
    }));
    mocks.record.mockImplementation(async (_project, _proposal, evaluation) => ({
      state: evaluation.complete && evaluation.passed ? "evaluated" : "draft",
      evaluation,
    }));
  });
  it("rejects an aggregate tie with a known missed violation in a held-out example", async () => {
    mocks.run.mockImplementation(async ({ sessionId }) => ({
      success: sessionId !== 3,
      reviewPassed: sessionId !== 3,
      evaluationComplete: true,
      inputHash: `fixture-${sessionId}`,
      rubricId: "independent-rubric",
      retryCount: 0,
      latencyMs: 1,
      costUsd: 0,
    }));
    const result = await evaluatePolicyProposal("project", "p1", 1, "/repo");
    expect(result).toMatchObject({
      state: "draft",
      evaluation: { complete: true, passed: false, candidate: { taskSuccessRate: 0.9 } },
    });
    expect(mocks.activate).not.toHaveBeenCalled();
  });
  it("records a complete passing benchmark without activating it", async () => {
    const result = await evaluatePolicyProposal("project", "p1", 1, "/repo");
    expect(result).toMatchObject({
      state: "evaluated",
      evaluation: {
        complete: true,
        passed: true,
        artifactHash: "retained-artifact-hash",
        releaseContentHash: "candidate-hash",
      },
    });
    expect(mocks.run).toHaveBeenCalledTimes(20);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
  const incomplete = { state: "draft", evaluation: { complete: false, passed: false } };
  it("passes a negative fixture whose violation was blocked by review", async () => {
    mocks.run.mockImplementation(async ({ sessionId }) => ({
      success: true,
      reviewPassed: false,
      verdict: "blocked",
      evaluationComplete: true,
      inputHash: `fixture-${sessionId}`,
      rubricId: "independent-rubric",
      retryCount: 0,
      latencyMs: 1,
      costUsd: 0,
    }));
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject({
      state: "evaluated",
    });
  });
  it("records per-fixture coverage", async () => {
    const result = await evaluatePolicyProposal("project", "p1", 1, "/repo");
    expect(result.evaluation!.heldOutCount).toBe(10);
    expect(result.evaluation!.fixtureCoverage[2]).toEqual({
      fixtureId: "3",
      fixtureHash: "fixture-3",
      taskId: "task-3",
      label: "defect",
      expectedOutcome: "block_or_avoid",
      holdout: true,
      evidenceTask: false,
      amendedRuleSelected: true,
      contentDiffers: true,
    });
  });
  it("does not pass a no-op amendment that only renames the revision", async () => {
    mocks.candidateRule.text = rule.text;
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject(incomplete);
  });
  it("does not pass an amended rule that no fixture selects", async () => {
    for (const r of [mocks.baseRule, mocks.candidateRule])
      Object.assign(r, { mandatory: false, paths: ["other/**"] });
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject(incomplete);
  });
  it("does not count tasks in the amendment's evidence as held out", async () => {
    mocks.decisions = [3, 4, 5, 8, 9, 10].map((n) => ({ id: "decision", taskId: `task-${n}` }));
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject(incomplete);
  });
  it("requires held-out positive and negative fixtures from distinct tasks", async () => {
    for (const f of mocks.fixtures) f.fixture.taskId = "same-task";
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject(incomplete);
  });
  it("refuses fixtures without a database binding or whose bound file disappeared", async () => {
    mocks.bindings = [];
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject(incomplete);
    mocks.bindings = [
      ...mocks.fixtures.map((f) => ({
        sessionId: f.fixture.sessionId as number,
        releaseId: "base",
        hash: f.hash,
      })),
      { sessionId: 99, releaseId: "base", hash: "removed" },
    ];
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject(incomplete);
  });
  it("refuses an outcome measured from a different fixture hash", async () => {
    mocks.run.mockImplementation(async () => ({
      success: true,
      reviewPassed: true,
      evaluationComplete: true,
      inputHash: "substituted",
      rubricId: "independent-rubric",
      retryCount: 0,
      latencyMs: 1,
      costUsd: 0,
    }));
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject(incomplete);
  });
  it("labels image-reported usage and keeps it from blocking activation", async () => {
    mocks.run.mockImplementation(async ({ sessionId, variant }) => ({
      success: true,
      reviewPassed: true,
      evaluationComplete: true,
      inputHash: `fixture-${sessionId}`,
      rubricId: "independent-rubric",
      retryCount: variant === "candidate" ? 50 : 0,
      latencyMs: 1,
      costUsd: variant === "candidate" ? 500 : 1,
    }));
    const result = await evaluatePolicyProposal("project", "p1", 1, "/repo");
    expect(result.state).toBe("evaluated");
    expect(result.evaluation!.candidate).toMatchObject({
      imageReportedRetryRate: 50,
      imageReportedAvgCostUsd: 500,
    });
    expect(result.evaluation!.candidate).not.toHaveProperty("avgCostUsd");
  });
  it("gives the coder only prompt-time paths while reviewers see the actual change", () => {
    const scoped = { ...rule, mandatory: false, paths: ["src/late.ts"] };
    const release = { id: "r", rules: [scoped], instructions: {} } as never;
    const rendered = policyReplayInstructions(release, ["src/late.ts"], []);
    expect(rendered.roles.coder).not.toContain(rule.text);
    expect(rendered.roles.reviewer).toContain(rule.text);
    expect(policyReplayInstructions(release, ["src/late.ts"]).roles.coder).toContain(rule.text);
  });
  it("does not accept structurally missing executor evidence", async () => {
    mocks.run.mockResolvedValue({
      success: true,
      reviewPassed: true,
      retryCount: 0,
      latencyMs: 1,
      costUsd: 0,
    });
    expect(await evaluatePolicyProposal("project", "p1", 1, "/repo")).toMatchObject({
      state: "draft",
      evaluation: { complete: false, passed: false },
    });
  });
});
