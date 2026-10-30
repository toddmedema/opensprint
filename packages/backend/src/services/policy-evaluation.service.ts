import type { AgentRole, PolicyEvaluation, PolicyRelease } from "@opensprint/shared";
import { AGENT_ROLE_CANONICAL_ORDER } from "@opensprint/shared";
import { governanceService } from "./governance.service.js";
import { resolvePolicyContext, governanceError } from "./policy-context.js";
import { replayFixtureService, REPLAY_LABELS } from "./replay-fixture.service.js";
import { IsolatedReplayRunner } from "./isolated-replay-runner.service.js";
import type { ReplayOutcome } from "./experiment-replay.service.js";
import type {
  BehaviorExperimentCandidateBundle,
  BehaviorExperimentInstructionBaseline,
} from "./self-improvement-experiment.service.js";
import { scoreExperiment } from "./experiment-scoring.service.js";

/** Render the complete release, using the same resolver as live Execute. */
export function policyReplayInstructions(
  release: PolicyRelease,
  changedPaths: string[]
): BehaviorExperimentInstructionBaseline {
  const roles: Partial<Record<AgentRole, string>> = {};
  for (const role of AGENT_ROLE_CANONICAL_ORDER)
    roles[role] = resolvePolicyContext(release, role, changedPaths).content;
  return {
    general: "Use only the supplied immutable policy and original task inputs.",
    roles,
    templates: {
      coder: roles.coder ?? "",
      reviewer: roles.reviewer ?? "",
      finalReview: roles.reviewer ?? "",
      selfImprovement: roles.auditor ?? "",
    },
  };
}
function metrics(outcomes: ReplayOutcome[]): Record<string, number> {
  const n = outcomes.length || 1;
  return {
    taskSuccessRate: outcomes.filter((o) => o.success).length / n,
    reviewPassRate: outcomes.filter((o) => o.reviewPassed).length / n,
    retryRate: outcomes.reduce((s, o) => s + o.retryCount, 0) / n,
    avgLatencyMs: outcomes.reduce((s, o) => s + o.latencyMs, 0) / n,
    avgCostUsd: outcomes.reduce((s, o) => s + o.costUsd, 0) / n,
  };
}
const running = new Set<string>();
export async function evaluatePolicyProposal(
  projectId: string,
  proposalId: string,
  expectedVersion: number,
  repoPath: string
) {
  const key = `${projectId}:${proposalId}`;
  if (running.has(key)) governanceError("This proposal is already being evaluated.");
  running.add(key);
  try {
    const proposal = await governanceService.getProposal(projectId, proposalId);
    if (proposal.version !== expectedVersion)
      governanceError("Proposal changed; reload before evaluating.");
    const base = await governanceService.getRelease(projectId, proposal.baseReleaseId);
    const candidate = await governanceService.previewProposalRelease(projectId, proposalId);
    const fixtures = (await replayFixtureService.list(projectId)).filter(
      (f) => f.fixture.policyReleaseId === base.id
    );
    const runner = new IsolatedReplayRunner({ projectId });
    const outcomes: Array<{
      sessionId: number;
      baseline: ReplayOutcome;
      candidate: ReplayOutcome;
    }> = [];
    for (const stored of fixtures) {
      const fixture = stored.fixture;
      const baselineContent = policyReplayInstructions(base, fixture.changedPaths ?? []);
      const candidateContent = policyReplayInstructions(candidate, fixture.changedPaths ?? []);
      const bundle: BehaviorExperimentCandidateBundle = {
        versionType: "candidate",
        minedSessionIds: [fixture.sessionId],
        runId: proposal.id,
        generalInstructionDiff: "",
        roleInstructionDiffs: {},
        promptTemplateDiffs: { coder: "", reviewer: "", finalReview: "", selfImprovement: "" },
        createdAt: proposal.createdAt,
        baselineContent,
        candidateContent,
        supportingDecisionIds: proposal.supportingDecisionIds,
        contraryDecisionIds: proposal.contraryDecisionIds,
        policyAffecting: true,
        policyRelease: candidate,
      };
      const baseline = await runner.run({
        sessionId: fixture.sessionId,
        worktreePath: repoPath,
        variant: "baseline",
      });
      const changed = await runner.run({
        sessionId: fixture.sessionId,
        worktreePath: repoPath,
        variant: "candidate",
        candidateBundle: bundle,
      });
      outcomes.push({ sessionId: fixture.sessionId, baseline, candidate: changed });
    }
    const baseline = metrics(outcomes.map((o) => o.baseline));
    const changed = metrics(outcomes.map((o) => o.candidate));
    const labels = new Set(fixtures.map((f) => f.fixture.label));
    // Five examples is a smoke test. This floor is only an activation prerequisite, not a broad quality claim.
    const complete =
      fixtures.length >= 10 &&
      REPLAY_LABELS.every((label) => labels.has(label)) &&
      fixtures.some((f) => f.fixture.holdout && f.fixture.label === "compliant") &&
      fixtures.some(
        (f) =>
          f.fixture.holdout && ["defect", "conflict", "retrieval_miss"].includes(f.fixture.label)
      ) &&
      outcomes.every(
        (o) =>
          o.baseline.evaluationComplete === true &&
          o.candidate.evaluationComplete === true &&
          o.baseline.inputHash === o.candidate.inputHash &&
          o.baseline.rubricId === o.candidate.rubricId
      );
    const scored = scoreExperiment(
      { ...baseline, taskSuccessRate: baseline.taskSuccessRate },
      { ...changed, taskSuccessRate: changed.taskSuccessRate }
    );
    // An aggregate tie cannot hide a known missed violation, especially in held-out cases.
    const passed =
      complete &&
      scored.successRateDelta >= 0 &&
      !scored.guardrailTriggered &&
      outcomes.every((outcome) => outcome.candidate.success && outcome.candidate.reviewPassed);
    const artifactHash = await replayFixtureService.saveEvaluation(projectId, {
      proposalId,
      baseRelease: base,
      candidateRelease: candidate,
      fixtureHashes: fixtures.map((f) => f.hash),
      outcomes,
      baseline,
      candidate: changed,
      complete,
      passed,
    });
    const evaluation: PolicyEvaluation = {
      complete,
      passed,
      executor: `offline-docker:${process.env.OPENSPRINT_REPLAY_IMAGE ?? "unavailable"}`,
      fixtureIds: fixtures.map((f) => String(f.fixture.sessionId)),
      heldOutCount: fixtures.filter((f) => f.fixture.holdout).length,
      positiveCount: fixtures.filter(
        (f) => f.fixture.label === "compliant" || f.fixture.label === "exception"
      ).length,
      negativeCount: fixtures.filter((f) =>
        ["defect", "conflict", "retrieval_miss"].includes(f.fixture.label)
      ).length,
      baseline,
      candidate: changed,
      artifactHash,
      releaseContentHash: candidate.contentHash,
      measuredAt: new Date().toISOString(),
    };
    return governanceService.recordEvaluation(projectId, proposalId, evaluation, expectedVersion);
  } finally {
    running.delete(key);
  }
}
