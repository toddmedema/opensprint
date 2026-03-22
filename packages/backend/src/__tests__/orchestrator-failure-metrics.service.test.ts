import { describe, it, expect } from "vitest";
import {
  rollupOrchestratorEvents,
  resolveFailureMetricsWindow,
} from "../services/orchestrator-failure-metrics.service.js";
import type { OrchestratorEvent } from "../services/event-log.service.js";

describe("orchestrator-failure-metrics.service", () => {
  it("resolveFailureMetricsWindow defaults to 14 days when days omitted", () => {
    const w = resolveFailureMetricsWindow(undefined);
    expect(w.daysUsed).toBe(14);
    expect(Date.parse(w.untilIso)).toBeGreaterThan(Date.parse(w.sinceIso));
  });

  it("rollupOrchestratorEvents groups by event and failure fields", () => {
    const since = "2025-01-01T00:00:00.000Z";
    const until = "2025-01-31T00:00:00.000Z";
    const events: OrchestratorEvent[] = [
      {
        timestamp: "2025-01-05T00:00:00.000Z",
        projectId: "p1",
        taskId: "a",
        event: "task.failed",
        data: { failureType: "timeout", phase: "coding" },
      },
      {
        timestamp: "2025-01-06T00:00:00.000Z",
        projectId: "p1",
        taskId: "b",
        event: "task.failed",
        data: { failureType: "timeout", phase: "coding" },
      },
      {
        timestamp: "2025-01-07T00:00:00.000Z",
        projectId: "p1",
        taskId: "c",
        event: "merge.failed",
        data: { failureType: "merge_quality_gate", stage: "quality_gate", phase: "merge" },
      },
      { timestamp: "2025-01-08T00:00:00.000Z", projectId: "p1", taskId: "d", event: "transition.x" },
    ];
    const summary = rollupOrchestratorEvents("p1", since, until, events);
    expect(summary.totalEventsMatched).toBe(3);
    expect(summary.buckets).toHaveLength(2);
    expect(summary.buckets[0]).toMatchObject({
      event: "task.failed",
      failureType: "timeout",
      phase: "coding",
      count: 2,
    });
    expect(summary.buckets[1]).toMatchObject({
      event: "merge.failed",
      failureType: "merge_quality_gate",
      mergeStage: "quality_gate",
      count: 1,
    });
  });
});
