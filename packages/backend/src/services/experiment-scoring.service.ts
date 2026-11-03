/**
 * Trusted scoring for policy replay. The evaluator reports what it observed without knowing the
 * expected result; only this server code applies each fixture's polarity.
 *
 * Retry counts and cost come from the replay image's stdout, so they are recorded as
 * image-reported values and never act as guardrails. Success, review and server-timed latency do.
 */

import type { PolicyEvaluationFixtureCoverage, ReplayExpectedOutcome } from "@opensprint/shared";
import type { SelfImprovementMetrics } from "./self-improvement-runner.service.js";

/** Thresholds for guardrail checks. */
const GUARDRAIL = {
  /** Max acceptable decrease in review pass rate (absolute). */
  reviewPassRateDecrease: 0.1,
  /** Max acceptable latency multiplier over baseline. */
  latencyMultiplier: 2.0,
} as const;

const NEGATIVE_REPLAY_LABELS: readonly string[] = ["defect", "conflict", "retrieval_miss"];

export function replayExpectedOutcome(label: string): ReplayExpectedOutcome {
  return NEGATIVE_REPLAY_LABELS.includes(label) ? "block_or_avoid" : "accept";
}

export type ReplayVerdict = "accepted" | "rejected" | "blocked" | "avoided" | "escaped";

/** Apply a fixture's polarity to the blind evaluator's observations. */
export function scoreReplayVerdict(
  fixtureLabel: string,
  observed: { label: string; reviewPassed: boolean; checksPassed: boolean }
): { success: boolean; verdict: ReplayVerdict } {
  if (replayExpectedOutcome(fixtureLabel) === "accept") {
    const success =
      observed.reviewPassed && observed.checksPassed && observed.label === fixtureLabel;
    return { success, verdict: success ? "accepted" : "rejected" };
  }
  if (!observed.reviewPassed) return { success: true, verdict: "blocked" };
  const clean = observed.checksPassed && replayExpectedOutcome(observed.label) === "accept";
  return { success: clean, verdict: clean ? "avoided" : "escaped" };
}

/** Coverage that counts: an independent task on which the amendment changed what the agent saw. */
export function exercisedHeldOut(coverage: PolicyEvaluationFixtureCoverage): boolean {
  return (
    coverage.holdout &&
    !coverage.evidenceTask &&
    coverage.amendedRuleSelected &&
    coverage.contentDiffers
  );
}

/** At least one exercised held-out positive and negative, drawn from distinct tasks. */
export function hasExercisedHeldOutPair(coverage: PolicyEvaluationFixtureCoverage[]): boolean {
  const exercised = coverage.filter(exercisedHeldOut);
  return exercised.some(
    (positive) =>
      positive.expectedOutcome === "accept" &&
      exercised.some(
        (negative) =>
          negative.expectedOutcome === "block_or_avoid" && negative.taskId !== positive.taskId
      )
  );
}

/**
 * Score baseline vs candidate metrics and produce guardrail flags.
 * Pure function — no side effects.
 */
export function scoreExperiment(
  baseline: SelfImprovementMetrics,
  candidate: SelfImprovementMetrics
): { successRateDelta: number; guardrailTriggered: boolean; guardrailDetails: string[] } {
  const successRateDelta = candidate.taskSuccessRate - baseline.taskSuccessRate;

  const guardrailDetails: string[] = [];

  const baseReview = baseline.reviewPassRate ?? 1;
  const candReview = candidate.reviewPassRate ?? 1;
  if (candReview < baseReview - GUARDRAIL.reviewPassRateDecrease) {
    guardrailDetails.push(
      `Review pass rate regression: ${(candReview * 100).toFixed(0)}% vs baseline ${(baseReview * 100).toFixed(0)}%`
    );
  }

  const baseLatency = baseline.avgLatencyMs ?? 0;
  const candLatency = candidate.avgLatencyMs ?? 0;
  if (baseLatency > 0 && candLatency > baseLatency * GUARDRAIL.latencyMultiplier) {
    guardrailDetails.push(
      `Latency regression: ${candLatency.toFixed(0)}ms vs baseline ${baseLatency.toFixed(0)}ms (>${GUARDRAIL.latencyMultiplier}x)`
    );
  }

  return {
    successRateDelta,
    guardrailTriggered: guardrailDetails.length > 0,
    guardrailDetails,
  };
}
