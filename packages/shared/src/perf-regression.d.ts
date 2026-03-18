/**
 * Performance baseline comparison: compare current metrics to a baseline with allowed regression deltas.
 * Used by scripts/perf.ts --ci to fail CI when metrics regress beyond threshold.
 */
export interface PerfMetrics {
  timestamp: string;
  load: {
    domContentLoaded: number;
    loadComplete: number;
    firstContentfulPaint?: number;
    timeToInteractive?: number;
  };
  memory: {
    jsHeapUsed: number;
    jsHeapTotal: number;
    peakAfterSidebarOpen?: number;
    afterSidebarClose?: number;
  };
  sidebar: {
    openToVisible?: number;
    closeToHidden?: number;
    cpuSpikeDurationMs?: number;
  };
  sidebarOpened: boolean;
}
export interface PerfDeltas {
  loadCompletePct: number;
  ttiPct: number;
  fcpPct: number;
  heapUsedPct: number;
  sidebarClosePct: number;
  peakSidebarHeapPct: number;
}
export declare const DEFAULT_PERF_DELTAS: PerfDeltas;
export interface PerfRegression {
  metric: string;
  baseline: number;
  current: number;
  deltaPct: number;
  maxAllowedPct: number;
}
/**
 * Compare current metrics to baseline with allowed deltas. Returns list of regressions (empty if pass).
 */
export declare function checkPerfRegressions(
  baseline: PerfMetrics,
  current: PerfMetrics,
  deltas?: PerfDeltas
): PerfRegression[];
//# sourceMappingURL=perf-regression.d.ts.map
