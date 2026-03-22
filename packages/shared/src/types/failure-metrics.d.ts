export interface FailureMetricBucket {
  event: string;
  failureType: string | null;
  mergeStage: string | null;
  phase: string | null;
  count: number;
}
export interface FailureMetricsSummary {
  projectId: string;
  since: string;
  until: string;
  totalEventsMatched: number;
  buckets: FailureMetricBucket[];
}
