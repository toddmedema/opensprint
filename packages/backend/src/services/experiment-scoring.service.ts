/**
 * Experiment scoring and autonomy-aware promotion decision.
 *
 * Scoring priority: task success quality first; retry/review regressions
 * and latency/cost as guardrails.
 *
 * Autonomy mapping:
 *   confirm_all  → never auto-promote; always queue approval
 *   major_only   → auto-promote only for clear, non-regressing improvements
 *   full         → auto-promote when candidate is not worse (v1 auto-promotion)
 */

import type { AiAutonomyLevel } from "@opensprint/shared";
import type { SelfImprovementMetrics } from "./self-improvement-runner.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("experiment-scoring");

export type ExperimentDecision = "promote" | "approval_needed" | "reject";

export interface ExperimentScoringResult {
  decision: ExperimentDecision;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Candidate minus baseline success rate (positive = improvement). */
  successRateDelta: number;
  /** True when any guardrail (retry, review, latency, cost) regressed beyond threshold. */
  guardrailTriggered: boolean;
  guardrailDetails: string[];
}

/** Thresholds for guardrail checks. */
const GUARDRAIL = {
  /** Max acceptable increase in retry rate (absolute). */
  retryRateIncrease: 0.15,
  /** Max acceptable decrease in review pass rate (absolute). */
  reviewPassRateDecrease: 0.1,
  /** Max acceptable latency multiplier over baseline. */
  latencyMultiplier: 2.0,
  /** Max acceptable cost multiplier over baseline. */
  costMultiplier: 2.0,
  /** Minimum success rate improvement for auto-promotion under major_only. */
  majorOnlyMinDelta: 0.0,
} as const;

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

  const baseRetry = baseline.retryRate ?? 0;
  const candRetry = candidate.retryRate ?? 0;
  if (candRetry > baseRetry + GUARDRAIL.retryRateIncrease) {
    guardrailDetails.push(
      `Retry rate regression: ${(candRetry * 100).toFixed(0)}% vs baseline ${(baseRetry * 100).toFixed(0)}%`
    );
  }

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

  const baseCost = baseline.avgCostUsd ?? 0;
  const candCost = candidate.avgCostUsd ?? 0;
  if (baseCost > 0 && candCost > baseCost * GUARDRAIL.costMultiplier) {
    guardrailDetails.push(
      `Cost regression: $${candCost.toFixed(4)} vs baseline $${baseCost.toFixed(4)} (>${GUARDRAIL.costMultiplier}x)`
    );
  }

  return {
    successRateDelta,
    guardrailTriggered: guardrailDetails.length > 0,
    guardrailDetails,
  };
}

/**
 * Decide promote / approval_needed / reject based on scoring result and autonomy level.
 */
export function decideExperimentOutcome(
  baseline: SelfImprovementMetrics,
  candidate: SelfImprovementMetrics,
  autonomyLevel: AiAutonomyLevel,
  governance?: { policyAffecting: boolean; evaluationComplete: boolean }
): ExperimentScoringResult {
  const { successRateDelta, guardrailTriggered, guardrailDetails } = scoreExperiment(
    baseline,
    candidate
  );

  if (governance && !governance.evaluationComplete) {
    return {
      decision: "reject",
      reason:
        "Evaluation is incomplete; missing or placeholder replay inputs cannot authorize promotion.",
      successRateDelta,
      guardrailTriggered: true,
      guardrailDetails: [...guardrailDetails, "Incomplete independent evaluation"],
    };
  }

  const candidateWorse = successRateDelta < -0.001;
  const candidateBetter = successRateDelta > 0.001;

  if (candidateWorse) {
    const reason = `Candidate task success rate is worse than baseline (${(successRateDelta * 100).toFixed(1)}% delta).`;
    log.info("Experiment decision: reject (success regression)", {
      autonomyLevel,
      successRateDelta,
    });
    return { decision: "reject", reason, successRateDelta, guardrailTriggered, guardrailDetails };
  }

  if (guardrailTriggered) {
    if (autonomyLevel === "full" && candidateBetter) {
      const reason = `Candidate improves success rate (+${(successRateDelta * 100).toFixed(1)}%) but has guardrail regressions: ${guardrailDetails.join("; ")}. Queuing for approval.`;
      log.info("Experiment decision: approval_needed (guardrail triggered under full autonomy)", {
        autonomyLevel,
        successRateDelta,
        guardrailDetails,
      });
      return {
        decision: "approval_needed",
        reason,
        successRateDelta,
        guardrailTriggered,
        guardrailDetails,
      };
    }
    const reason = `Guardrail regressions detected: ${guardrailDetails.join("; ")}. Queuing for approval.`;
    log.info("Experiment decision: approval_needed (guardrail)", {
      autonomyLevel,
      successRateDelta,
      guardrailDetails,
    });
    return {
      decision: "approval_needed",
      reason,
      successRateDelta,
      guardrailTriggered,
      guardrailDetails,
    };
  }

  if (governance?.policyAffecting) {
    return {
      decision: "approval_needed",
      reason:
        "Instruction and policy amendments require explicit human approval at every autonomy level.",
      successRateDelta,
      guardrailTriggered,
      guardrailDetails,
    };
  }

  switch (autonomyLevel) {
    case "confirm_all": {
      const reason = candidateBetter
        ? `Candidate improves success rate (+${(successRateDelta * 100).toFixed(1)}%) with no guardrail regressions. Autonomy is confirm_all; queuing for approval.`
        : `Candidate matches baseline with no guardrail regressions. Autonomy is confirm_all; queuing for approval.`;
      log.info("Experiment decision: approval_needed (confirm_all)", {
        autonomyLevel,
        successRateDelta,
      });
      return {
        decision: "approval_needed",
        reason,
        successRateDelta,
        guardrailTriggered,
        guardrailDetails,
      };
    }

    case "major_only": {
      if (candidateBetter && successRateDelta > GUARDRAIL.majorOnlyMinDelta) {
        const reason = `Candidate improves success rate (+${(successRateDelta * 100).toFixed(1)}%) with no guardrail regressions. Auto-promoting under major_only autonomy.`;
        log.info("Experiment decision: promote (major_only, clear improvement)", {
          autonomyLevel,
          successRateDelta,
        });
        return {
          decision: "promote",
          reason,
          successRateDelta,
          guardrailTriggered,
          guardrailDetails,
        };
      }
      const reason = `Candidate does not clearly improve success rate (${(successRateDelta * 100).toFixed(1)}% delta). Queuing for approval under major_only autonomy.`;
      log.info("Experiment decision: approval_needed (major_only, no clear improvement)", {
        autonomyLevel,
        successRateDelta,
      });
      return {
        decision: "approval_needed",
        reason,
        successRateDelta,
        guardrailTriggered,
        guardrailDetails,
      };
    }

    case "full": {
      const reason = candidateBetter
        ? `Candidate improves success rate (+${(successRateDelta * 100).toFixed(1)}%) with no guardrail regressions. Auto-promoting under full autonomy.`
        : `Candidate matches baseline with no guardrail regressions. Auto-promoting under full autonomy.`;
      log.info("Experiment decision: promote (full autonomy)", {
        autonomyLevel,
        successRateDelta,
      });
      return {
        decision: "promote",
        reason,
        successRateDelta,
        guardrailTriggered,
        guardrailDetails,
      };
    }

    default: {
      const reason = `Unknown autonomy level '${autonomyLevel as string}'. Queuing for approval.`;
      return {
        decision: "approval_needed",
        reason,
        successRateDelta,
        guardrailTriggered,
        guardrailDetails,
      };
    }
  }
}
