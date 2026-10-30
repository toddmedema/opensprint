import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluatePolicyProposal } from "../services/policy-evaluation.service.js";
const mocks = vi.hoisted(() => ({ run: vi.fn(), record: vi.fn(), activate: vi.fn() }));
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
    getProposal: vi
      .fn()
      .mockResolvedValue({
        id: "p1",
        baseReleaseId: "base",
        version: 1,
        createdAt: "2026-10-30T00:00:00Z",
        supportingDecisionIds: [],
        contraryDecisionIds: [],
      }),
    getRelease: vi
      .fn()
      .mockImplementation(async () => ({
        id: "base",
        rules: [rule],
        instructions: {},
        contentHash: "base-hash",
      })),
    previewProposalRelease: vi
      .fn()
      .mockImplementation(async () => ({
        id: "candidate",
        rules: [rule],
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
    list: vi
      .fn()
      .mockImplementation(async () =>
        Array.from({ length: 10 }, (_, i) => ({
          hash: `fixture-${i}`,
          fixture: {
            sessionId: i + 1,
            policyReleaseId: "base",
            changedPaths: ["src/x.ts"],
            label: ["compliant", "exception", "defect", "conflict", "retrieval_miss"][i % 5],
            holdout: true,
          },
        }))
      ),
    saveEvaluation: vi.fn().mockResolvedValue("retained-artifact-hash"),
  },
}));
vi.mock("../services/isolated-replay-runner.service.js", () => ({
  IsolatedReplayRunner: vi.fn().mockImplementation(() => ({ run: mocks.run })),
}));
describe("policy amendment evaluation admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.run.mockImplementation(async ({ sessionId }) => ({
      success: true,
      reviewPassed: true,
      evaluationComplete: true,
      inputHash: `input-${sessionId}`,
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
      inputHash: `input-${sessionId}`,
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
