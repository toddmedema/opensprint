/**
 * Aggregates orchestrator_events into ranked buckets for failure diagnostics.
 */

import type { FailureMetricBucket, FailureMetricsSummary } from "@opensprint/shared";
import type { OrchestratorEvent } from "./event-log.service.js";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const MAX_BUCKETS = 80;

/** Events that carry structured failure context in `data`. */
const ROLLUP_EVENT_NAMES = new Set([
  "task.failed",
  "task.requeued",
  "merge.failed",
  "task.dispatch_deferred",
]);

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function bucketKey(parts: {
  event: string;
  failureType: string | null;
  mergeStage: string | null;
  phase: string | null;
}): string {
  return `${parts.event}\0${parts.failureType ?? ""}\0${parts.mergeStage ?? ""}\0${parts.phase ?? ""}`;
}

function parseData(data: Record<string, unknown> | undefined): {
  failureType: string | null;
  mergeStage: string | null;
  phase: string | null;
} {
  if (!data) {
    return { failureType: null, mergeStage: null, phase: null };
  }
  return {
    failureType: asString(data.failureType),
    mergeStage: asString(data.mergeStage) ?? asString(data.stage),
    phase: asString(data.phase),
  };
}

export function rollupOrchestratorEvents(
  projectId: string,
  sinceIso: string,
  untilIso: string,
  events: OrchestratorEvent[]
): FailureMetricsSummary {
  const tallies = new Map<string, FailureMetricBucket>();

  let totalMatched = 0;
  for (const ev of events) {
    if (!ROLLUP_EVENT_NAMES.has(ev.event)) continue;
    totalMatched += 1;
    const { failureType, mergeStage, phase } = parseData(ev.data);
    const key = bucketKey({ event: ev.event, failureType, mergeStage, phase });
    const existing = tallies.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      tallies.set(key, {
        event: ev.event,
        failureType,
        mergeStage,
        phase,
        count: 1,
      });
    }
  }

  const buckets = [...tallies.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_BUCKETS);

  return {
    projectId,
    since: sinceIso,
    until: untilIso,
    totalEventsMatched: totalMatched,
    buckets,
  };
}

export function resolveFailureMetricsWindow(days?: number): {
  sinceIso: string;
  untilIso: string;
  daysUsed: number;
} {
  const d =
    days != null && Number.isFinite(days) && days > 0
      ? Math.min(Math.floor(days), MAX_DAYS)
      : DEFAULT_DAYS;
  const until = new Date();
  const since = new Date(until.getTime() - d * 24 * 60 * 60 * 1000);
  return {
    sinceIso: since.toISOString(),
    untilIso: until.toISOString(),
    daysUsed: d,
  };
}

export const FAILURE_METRICS_DEFAULT_DAYS = DEFAULT_DAYS;
export const FAILURE_METRICS_MAX_DAYS = MAX_DAYS;
