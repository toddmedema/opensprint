import type {
  AgentRole,
  PolicyEvaluation,
  PolicyEvaluationFixtureCoverage,
  PolicyProposal,
  PolicyRelease,
} from "@opensprint/shared";
import { AGENT_ROLE_CANONICAL_ORDER } from "@opensprint/shared";
import { governanceService } from "./governance.service.js";
import {
  GOVERNANCE_STALE_VERSION,
  resolvePolicyContext,
  governanceError,
} from "./policy-context.js";
import { replayFixtureService, REPLAY_LABELS } from "./replay-fixture.service.js";
import { IsolatedReplayRunner, type ReplayOutcome } from "./isolated-replay-runner.service.js";
import type {
  BehaviorExperimentCandidateBundle,
  BehaviorExperimentInstructionBaseline,
} from "./self-improvement-experiment.service.js";
import {
  exercisedHeldOut,
  hasExercisedHeldOutPair,
  replayExpectedOutcome,
  scoreExperiment,
} from "./experiment-scoring.service.js";

/** The coder saw only prompt-time paths; roles acting after the code see what actually changed. */
function replayRolePaths(role: AgentRole, changedPaths: string[], promptPaths?: string[]) {
  return role === "coder" ? (promptPaths ?? changedPaths) : changedPaths;
}
/** Render the complete release, using the same resolver as live Execute. */
export function policyReplayInstructions(
  release: PolicyRelease,
  changedPaths: string[],
  promptChangedPaths?: string[]
): BehaviorExperimentInstructionBaseline {
  const roles: Partial<Record<AgentRole, string>> = {};
  for (const role of AGENT_ROLE_CANONICAL_ORDER)
    roles[role] = resolvePolicyContext(
      release,
      role,
      replayRolePaths(role, changedPaths, promptChangedPaths)
    ).content;
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
/** Render without release and revision identifiers, so only substantive policy text compares. */
function withoutRevisionIdentity(release: PolicyRelease): PolicyRelease {
  const stable = new Map(release.rules.map((rule) => [rule.id, rule.ruleId]));
  const rename = (ids: string[]) => ids.map((id) => stable.get(id) ?? id);
  return {
    ...release,
    id: "evaluated-release",
    rules: release.rules.map((rule) => ({
      ...rule,
      id: rule.ruleId,
      parentIds: rename(rule.parentIds),
      overrideIds: rename(rule.overrideIds),
      conflictIds: rename(rule.conflictIds),
    })),
  };
}
/** Whether this fixture's own rendered policy shows the amendment, on the same role. */
function amendmentCoverage(
  proposal: PolicyProposal,
  base: PolicyRelease,
  candidate: PolicyRelease,
  changedPaths: string[],
  promptPaths?: string[]
): Pick<PolicyEvaluationFixtureCoverage, "amendedRuleSelected" | "contentDiffers"> {
  const amended = new Set(proposal.patches.map((patch) => patch.ruleId));
  const before = withoutRevisionIdentity(base);
  const after = withoutRevisionIdentity(candidate);
  let amendedRuleSelected = false;
  let contentDiffers = false;
  for (const role of AGENT_ROLE_CANONICAL_ORDER) {
    const paths = replayRolePaths(role, changedPaths, promptPaths);
    const baseline = resolvePolicyContext(before, role, paths);
    const changed = resolvePolicyContext(after, role, paths);
    const selected =
      (base.instructions[role] ?? "") !== (candidate.instructions[role] ?? "") ||
      [baseline, changed].some((context) =>
        context.receipt.selected.some((rule) => amended.has(rule.ruleId))
      );
    if (selected && baseline.content !== changed.content) {
      amendedRuleSelected = true;
      contentDiffers = true;
    } else if (selected) amendedRuleSelected = true;
    else if (baseline.content !== changed.content) contentDiffers = true;
  }
  return { amendedRuleSelected, contentDiffers };
}
/** Tasks behind the amendment's nomination and draft cannot also validate it as held out. */
async function amendmentEvidenceTasks(
  projectId: string,
  proposal: PolicyProposal
): Promise<Set<string>> {
  const proposals = await governanceService.listProposals(projectId);
  const sources = [proposal, ...proposals.filter((p) => p.id === proposal.sourceNominationId)];
  const decisions = new Set(
    sources.flatMap((p) => [...p.supportingDecisionIds, ...p.contraryDecisionIds])
  );
  const events = new Set(
    sources.flatMap((p) => [...(p.supportingEventIds ?? []), ...(p.contraryEventIds ?? [])])
  );
  const tasks = new Set(
    (await governanceService.listDecisions(projectId))
      .filter((decision) => decisions.has(decision.id))
      .map((decision) => decision.taskId)
  );
  if (events.size) {
    const cases = new Set(
      (await governanceService.listEvents(projectId))
        .filter((event) => events.has(event.id) && event.caseId)
        .map((event) => event.caseId)
    );
    for (const c of await governanceService.listCases(projectId))
      if (cases.has(c.id)) tasks.add(c.taskId);
  }
  return tasks;
}
function metrics(outcomes: ReplayOutcome[]): Record<string, number> {
  const n = outcomes.length || 1;
  return {
    taskSuccessRate: outcomes.filter((o) => o.success).length / n,
    reviewPassRate: outcomes.filter((o) => o.reviewPassed).length / n,
    avgLatencyMs: outcomes.reduce((s, o) => s + o.latencyMs, 0) / n,
    imageReportedRetryRate: outcomes.reduce((s, o) => s + o.retryCount, 0) / n,
    imageReportedAvgCostUsd: outcomes.reduce((s, o) => s + o.costUsd, 0) / n,
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
      governanceError("Proposal changed; reload before evaluating.", GOVERNANCE_STALE_VERSION);
    const base = await governanceService.getRelease(projectId, proposal.baseReleaseId);
    const candidate = await governanceService.previewProposalRelease(projectId, proposalId);
    const fixtures = (await replayFixtureService.list(projectId)).filter(
      (f) => f.fixture.policyReleaseId === base.id
    );
    const bound = (await governanceService.listReplayFixtureBindings(projectId)).filter(
      (binding) => binding.releaseId === base.id
    );
    const evidenceBound =
      bound.every((binding) =>
        fixtures.some((f) => f.fixture.sessionId === binding.sessionId && f.hash === binding.hash)
      ) &&
      fixtures.every((f) => bound.some((binding) => binding.sessionId === f.fixture.sessionId));
    const evidenceTasks = await amendmentEvidenceTasks(projectId, proposal);
    const runner = new IsolatedReplayRunner({ projectId });
    const outcomes: Array<{
      sessionId: number;
      baseline: ReplayOutcome;
      candidate: ReplayOutcome;
    }> = [];
    const fixtureCoverage: PolicyEvaluationFixtureCoverage[] = [];
    for (const stored of fixtures) {
      const fixture = stored.fixture;
      const changedPaths = fixture.changedPaths ?? [];
      const promptPaths = fixture.promptChangedPaths;
      const baselineContent = policyReplayInstructions(base, changedPaths, promptPaths);
      const candidateContent = policyReplayInstructions(candidate, changedPaths, promptPaths);
      fixtureCoverage.push({
        fixtureId: String(fixture.sessionId),
        fixtureHash: stored.hash,
        taskId: fixture.taskId ?? "",
        label: fixture.label,
        expectedOutcome: replayExpectedOutcome(fixture.label),
        holdout: fixture.holdout,
        evidenceTask: evidenceTasks.has(fixture.taskId ?? ""),
        ...amendmentCoverage(proposal, base, candidate, changedPaths, promptPaths),
      });
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
    const hashes = new Map(fixtures.map((f) => [f.fixture.sessionId, f.hash]));
    // Five examples is a smoke test. This floor is only an activation prerequisite, not a broad quality claim.
    const complete =
      fixtures.length >= 10 &&
      REPLAY_LABELS.every((label) => labels.has(label)) &&
      evidenceBound &&
      hasExercisedHeldOutPair(fixtureCoverage) &&
      outcomes.every(
        (o) =>
          o.baseline.evaluationComplete === true &&
          o.candidate.evaluationComplete === true &&
          o.baseline.inputHash === hashes.get(o.sessionId) &&
          o.candidate.inputHash === hashes.get(o.sessionId) &&
          o.baseline.rubricId === o.candidate.rubricId
      );
    const scored = scoreExperiment(
      {
        taskSuccessRate: baseline.taskSuccessRate!,
        reviewPassRate: baseline.reviewPassRate,
        avgLatencyMs: baseline.avgLatencyMs,
      },
      {
        taskSuccessRate: changed.taskSuccessRate!,
        reviewPassRate: changed.reviewPassRate,
        avgLatencyMs: changed.avgLatencyMs,
      }
    );
    // An aggregate tie cannot hide a known missed violation, especially in held-out cases.
    const passed =
      complete &&
      scored.successRateDelta >= 0 &&
      !scored.guardrailTriggered &&
      outcomes.every((outcome) => outcome.candidate.success);
    const artifactHash = await replayFixtureService.saveEvaluation(projectId, {
      proposalId,
      baseRelease: base,
      candidateRelease: candidate,
      fixtureHashes: fixtures.map((f) => f.hash),
      fixtureCoverage,
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
      heldOutCount: new Set(fixtureCoverage.filter(exercisedHeldOut).map((c) => c.taskId)).size,
      positiveCount: fixtures.filter(
        (f) => f.fixture.label === "compliant" || f.fixture.label === "exception"
      ).length,
      negativeCount: fixtures.filter((f) =>
        ["defect", "conflict", "retrieval_miss"].includes(f.fixture.label)
      ).length,
      fixtureCoverage,
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
