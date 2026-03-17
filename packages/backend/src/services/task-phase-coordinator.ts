/**
 * TaskPhaseCoordinator — safe join point for parallel test + review results.
 *
 * When coding succeeds, tests and review run concurrently. This coordinator
 * collects both outcomes and calls a single resolution handler when both
 * are complete, eliminating the race where two async paths mutate slot state.
 */

import type { TestResults, ReviewAgentResult } from "@opensprint/shared";
import type { FailureType, RetryQualityGateDetail } from "./orchestrator-phase-context.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("phase-coordinator");

export interface TestOutcome {
  status: "passed" | "failed" | "error";
  results?: TestResults;
  rawOutput?: string;
  errorMessage?: string;
  failureType?: FailureType;
  qualityGateDetail?: RetryQualityGateDetail | null;
}

export interface ReviewOutcome {
  status: "approved" | "rejected" | "no_result" | "error";
  result?: ReviewAgentResult | null;
  exitCode: number | null;
  /** Angle-aware context used to explain no_result / error outcomes. */
  failureContext?: Array<{
    angle?: string;
    exitCode: number | null;
    reason?: string;
  }>;
}

export type PhaseResolution = (test: TestOutcome, review: ReviewOutcome) => Promise<void>;

const DEFAULT_REVIEW_KEY = "__general_review__";

export interface TaskPhaseCoordinatorOptions {
  reviewAngles?: string[];
  /** When true with reviewAngles non-empty, expect both general and angle outcomes (key __general_review__ + each angle). */
  includeGeneralReview?: boolean;
  /**
   * When provided and multiple angles are used (and not includeGeneralReview), the synthesizer runs before resolving.
   * It receives all angle outcomes and returns a single synthesized ReviewOutcome.
   */
  synthesizeReviewResults?: (outcomes: Map<string, ReviewOutcome>) => Promise<ReviewOutcome>;
}

export class TaskPhaseCoordinator {
  private testOutcome: TestOutcome | null = null;
  private readonly expectedReviewKeys: Set<string>;
  private readonly reviewOutcomes = new Map<string, ReviewOutcome>();
  private resolved = false;
  private readonly synthesizeReviewResults?: (
    outcomes: Map<string, ReviewOutcome>
  ) => Promise<ReviewOutcome>;
  private readonly useSynthesis: boolean;

  constructor(
    private readonly taskId: string,
    private readonly resolve: PhaseResolution,
    options?: TaskPhaseCoordinatorOptions
  ) {
    const angles = options?.reviewAngles?.filter(Boolean) ?? [];
    const includeGeneral = options?.includeGeneralReview === true && angles.length > 0;
    this.expectedReviewKeys = new Set(
      includeGeneral
        ? [DEFAULT_REVIEW_KEY, ...angles]
        : angles.length > 0
          ? angles
          : [DEFAULT_REVIEW_KEY]
    );
    this.synthesizeReviewResults = options?.synthesizeReviewResults;
    this.useSynthesis =
      angles.length > 1 &&
      !includeGeneral &&
      typeof options?.synthesizeReviewResults === "function";
  }

  setTestOutcome(outcome: TestOutcome): void {
    if (this.resolved) return;
    this.testOutcome = outcome;
    log.info("Test outcome received", { taskId: this.taskId, status: outcome.status });
    this.tryResolve();
  }

  setReviewOutcome(outcome: ReviewOutcome, angle?: string): void {
    if (this.resolved) return;
    const key = this.resolveReviewKey(angle);
    this.reviewOutcomes.set(key, outcome);
    log.info("Review outcome received", {
      taskId: this.taskId,
      status: outcome.status,
      reviewKey: key,
      received: this.reviewOutcomes.size,
      expected: this.expectedReviewKeys.size,
    });
    this.tryResolve();
  }

  private synthesizing = false;

  private tryResolve(): void {
    if (this.resolved || !this.testOutcome || this.synthesizing) return;
    const reviewOutcome = this.getAggregatedReviewOutcome();
    if (!reviewOutcome) return;

    // When any angle has no_result or error, resolve directly without synthesis.
    // Otherwise the synthesizer (which filters to approved/rejected only) could
    // return 'approved' and incorrectly override the no_result.
    if (reviewOutcome.status === "no_result" || reviewOutcome.status === "error") {
      this.resolved = true;
      log.info("Review has no_result or error, resolving without synthesis", {
        taskId: this.taskId,
        test: this.testOutcome.status,
        review: reviewOutcome.status,
      });
      this.resolve(this.testOutcome, reviewOutcome).catch((err) => {
        log.error("Phase resolution failed", { taskId: this.taskId, err });
      });
      return;
    }

    if (this.useSynthesis && this.synthesizeReviewResults) {
      this.synthesizing = true;
      log.info("All angle outcomes ready, running lead synthesizer", {
        taskId: this.taskId,
        reviewCount: this.reviewOutcomes.size,
      });
      this.synthesizeReviewResults(new Map(this.reviewOutcomes))
        .then((synthesized) => {
          this.resolved = true;
          log.info("Synthesis complete, resolving", {
            taskId: this.taskId,
            test: this.testOutcome!.status,
            review: synthesized.status,
          });
          return this.resolve(this.testOutcome!, synthesized);
        })
        .catch((err) => {
          log.error("Synthesis failed, using programmatic merge", {
            taskId: this.taskId,
            err,
          });
          this.resolved = true;
          return this.resolve(this.testOutcome!, reviewOutcome);
        });
      return;
    }

    this.resolved = true;
    log.info("Both outcomes ready, resolving", {
      taskId: this.taskId,
      test: this.testOutcome.status,
      review: reviewOutcome.status,
      reviewCount: this.reviewOutcomes.size,
    });
    this.resolve(this.testOutcome, reviewOutcome).catch((err) => {
      log.error("Phase resolution failed", { taskId: this.taskId, err });
    });
  }

  private resolveReviewKey(angle?: string): string {
    if (angle && this.expectedReviewKeys.has(angle)) return angle;
    if (!angle && this.expectedReviewKeys.size === 1) {
      return [...this.expectedReviewKeys][0]!;
    }
    if (angle) return angle;
    return DEFAULT_REVIEW_KEY;
  }

  private getAggregatedReviewOutcome(): ReviewOutcome | null {
    for (const key of this.expectedReviewKeys) {
      if (!this.reviewOutcomes.has(key)) return null;
    }

    const keyedOutcomes = [...this.expectedReviewKeys].map((key) => ({
      key,
      outcome: this.reviewOutcomes.get(key)!,
    }));
    const outcomes = keyedOutcomes.map(({ outcome }) => outcome);
    const noResultOutcomes = keyedOutcomes.filter(
      ({ outcome }) => outcome.status === "no_result" || outcome.status === "error"
    );
    if (noResultOutcomes.length > 0) {
      const combinedContext = noResultOutcomes.flatMap(({ key, outcome }) => {
        if (outcome.failureContext && outcome.failureContext.length > 0) {
          return outcome.failureContext;
        }
        return [
          {
            angle: key === DEFAULT_REVIEW_KEY ? undefined : key,
            exitCode: outcome.exitCode,
          },
        ];
      });
      const dedupedContext = [
        ...new Map(combinedContext.map((ctx) => [JSON.stringify(ctx), ctx])).values(),
      ];
      return {
        status: "no_result",
        result: null,
        exitCode: noResultOutcomes[0]?.outcome.exitCode ?? null,
        ...(dedupedContext.length > 0 && { failureContext: dedupedContext }),
      };
    }

    const rejected = outcomes.filter((o) => o.status === "rejected");
    if (rejected.length > 0) {
      const mergedIssues = [
        ...new Set(
          rejected
            .flatMap((o) => o.result?.issues ?? [])
            .map((issue) => issue.trim())
            .filter(Boolean)
        ),
      ];
      const mergedSummary = rejected
        .map((o) => o.result?.summary?.trim() ?? "")
        .filter(Boolean)
        .join(" | ");
      const mergedNotes = rejected
        .map((o) => o.result?.notes?.trim() ?? "")
        .filter(Boolean)
        .join("\n\n");

      return {
        status: "rejected",
        exitCode: rejected[0]?.exitCode ?? null,
        result: {
          status: "rejected",
          summary: mergedSummary || "Review rejected",
          ...(mergedIssues.length > 0 && { issues: mergedIssues }),
          notes: mergedNotes,
        },
      };
    }

    return {
      status: "approved",
      result: outcomes[0]?.result ?? null,
      exitCode: outcomes[0]?.exitCode ?? 0,
    };
  }
}
