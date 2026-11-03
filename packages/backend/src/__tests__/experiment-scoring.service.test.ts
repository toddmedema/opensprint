import { describe, it, expect } from "vitest";
import {
  hasExercisedHeldOutPair,
  scoreExperiment,
  scoreReplayVerdict,
} from "../services/experiment-scoring.service.js";
import type { PolicyEvaluationFixtureCoverage } from "@opensprint/shared";
import type { SelfImprovementMetrics } from "../services/self-improvement-runner.service.js";

function makeMetrics(overrides: Partial<SelfImprovementMetrics> = {}): SelfImprovementMetrics {
  return {
    taskSuccessRate: 0.8,
    retryRate: 0.1,
    reviewPassRate: 0.9,
    avgLatencyMs: 5000,
    avgCostUsd: 0.5,
    ...overrides,
  };
}

describe("scoreExperiment", () => {
  it("reports positive delta when candidate has higher success rate", () => {
    const baseline = makeMetrics({ taskSuccessRate: 0.7 });
    const candidate = makeMetrics({ taskSuccessRate: 0.9 });
    const result = scoreExperiment(baseline, candidate);
    expect(result.successRateDelta).toBeCloseTo(0.2, 5);
    expect(result.guardrailTriggered).toBe(false);
    expect(result.guardrailDetails).toEqual([]);
  });

  it("reports negative delta when candidate has lower success rate", () => {
    const baseline = makeMetrics({ taskSuccessRate: 0.9 });
    const candidate = makeMetrics({ taskSuccessRate: 0.6 });
    const result = scoreExperiment(baseline, candidate);
    expect(result.successRateDelta).toBeCloseTo(-0.3, 5);
  });

  it("keeps image-reported retries and cost out of guardrails", () => {
    const baseline = makeMetrics({ retryRate: 0, avgCostUsd: 0.5 });
    const candidate = makeMetrics({ retryRate: 5, avgCostUsd: 500 });
    expect(scoreExperiment(baseline, candidate)).toMatchObject({
      guardrailTriggered: false,
      guardrailDetails: [],
    });
  });

  it("triggers review pass rate guardrail on regression", () => {
    const baseline = makeMetrics({ reviewPassRate: 0.9 });
    const candidate = makeMetrics({ reviewPassRate: 0.7 });
    const result = scoreExperiment(baseline, candidate);
    expect(result.guardrailTriggered).toBe(true);
    expect(result.guardrailDetails.some((d) => d.includes("Review pass rate"))).toBe(true);
  });

  it("triggers latency guardrail when exceeding 2x baseline", () => {
    const baseline = makeMetrics({ avgLatencyMs: 5000 });
    const candidate = makeMetrics({ avgLatencyMs: 15000 });
    const result = scoreExperiment(baseline, candidate);
    expect(result.guardrailTriggered).toBe(true);
    expect(result.guardrailDetails.some((d) => d.includes("Latency regression"))).toBe(true);
  });

  it("does not trigger latency guardrail when baseline is zero", () => {
    const baseline = makeMetrics({ avgLatencyMs: 0 });
    const candidate = makeMetrics({ avgLatencyMs: 10000 });
    const result = scoreExperiment(baseline, candidate);
    expect(result.guardrailDetails.filter((d) => d.includes("Latency"))).toHaveLength(0);
  });

  it("handles undefined optional metrics gracefully", () => {
    const baseline: SelfImprovementMetrics = { taskSuccessRate: 0.8 };
    const candidate: SelfImprovementMetrics = { taskSuccessRate: 0.9 };
    const result = scoreExperiment(baseline, candidate);
    expect(result.successRateDelta).toBeCloseTo(0.1, 5);
    expect(result.guardrailTriggered).toBe(false);
  });

  it("can trigger multiple guardrails simultaneously", () => {
    const baseline = makeMetrics({ reviewPassRate: 0.95, avgLatencyMs: 1000 });
    const candidate = makeMetrics({ reviewPassRate: 0.5, avgLatencyMs: 5000 });
    const result = scoreExperiment(baseline, candidate);
    expect(result.guardrailTriggered).toBe(true);
    expect(result.guardrailDetails).toHaveLength(2);
  });
});

describe("scoreReplayVerdict", () => {
  const observed = (label: string, reviewPassed: boolean, checksPassed = true) => ({
    label,
    reviewPassed,
    checksPassed,
  });
  it("scores a blocked violation as success on a negative fixture", () => {
    expect(scoreReplayVerdict("defect", observed("defect", false))).toEqual({
      success: true,
      verdict: "blocked",
    });
  });
  it("scores an avoided violation as success on a negative fixture", () => {
    expect(scoreReplayVerdict("conflict", observed("compliant", true))).toEqual({
      success: true,
      verdict: "avoided",
    });
  });
  it.each([
    ["accepted violation", observed("defect", true)],
    ["accepted failing check", observed("compliant", true, false)],
  ])("scores an %s as failure on a negative fixture", (_name, verdict) => {
    expect(scoreReplayVerdict("defect", verdict)).toEqual({ success: false, verdict: "escaped" });
  });
  it("requires acceptance, passing checks, and the human label on a positive fixture", () => {
    expect(scoreReplayVerdict("compliant", observed("compliant", true)).success).toBe(true);
    expect(scoreReplayVerdict("compliant", observed("compliant", false)).success).toBe(false);
    expect(scoreReplayVerdict("compliant", observed("compliant", true, false)).success).toBe(false);
    expect(scoreReplayVerdict("compliant", observed("defect", true)).success).toBe(false);
  });
});

describe("hasExercisedHeldOutPair", () => {
  const coverage = (
    expectedOutcome: PolicyEvaluationFixtureCoverage["expectedOutcome"],
    overrides: Partial<PolicyEvaluationFixtureCoverage> = {}
  ): PolicyEvaluationFixtureCoverage => ({
    fixtureId: "1",
    fixtureHash: "hash",
    taskId: expectedOutcome,
    label: expectedOutcome === "accept" ? "compliant" : "defect",
    expectedOutcome,
    holdout: true,
    evidenceTask: false,
    amendedRuleSelected: true,
    contentDiffers: true,
    ...overrides,
  });
  it("accepts one exercised held-out positive and negative from different tasks", () => {
    expect(hasExercisedHeldOutPair([coverage("accept"), coverage("block_or_avoid")])).toBe(true);
  });
  it.each([
    ["not held out", { holdout: false }],
    ["amendment evidence", { evidenceTask: true }],
    ["rule not selected", { amendedRuleSelected: false }],
    ["unchanged content", { contentDiffers: false }],
    ["the same task", { taskId: "accept" }],
  ])("rejects a negative fixture with %s", (_name, overrides) => {
    expect(
      hasExercisedHeldOutPair([coverage("accept"), coverage("block_or_avoid", overrides)])
    ).toBe(false);
  });
});
