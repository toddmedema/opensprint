/**
 * Performance baseline comparison: compare current metrics to a baseline with allowed regression deltas.
 * Used by scripts/perf.ts --ci to fail CI when metrics regress beyond threshold.
 */
export const DEFAULT_PERF_DELTAS = {
  loadCompletePct: 20,
  ttiPct: 20,
  fcpPct: 20,
  heapUsedPct: 20,
  sidebarClosePct: 30,
  peakSidebarHeapPct: 20,
};
/**
 * Compare current metrics to baseline with allowed deltas. Returns list of regressions (empty if pass).
 */
export function checkPerfRegressions(baseline, current, deltas = DEFAULT_PERF_DELTAS) {
  const regressions = [];
  if (baseline.load.loadComplete > 0 && current.load.loadComplete > 0) {
    const deltaPct =
      ((current.load.loadComplete - baseline.load.loadComplete) / baseline.load.loadComplete) * 100;
    if (deltaPct > deltas.loadCompletePct) {
      regressions.push({
        metric: "loadComplete",
        baseline: baseline.load.loadComplete,
        current: current.load.loadComplete,
        deltaPct,
        maxAllowedPct: deltas.loadCompletePct,
      });
    }
  }
  const baselineTti = baseline.load.timeToInteractive ?? 0;
  const currentTti = current.load.timeToInteractive ?? 0;
  if (baselineTti > 0 && currentTti > 0) {
    const deltaPct = ((currentTti - baselineTti) / baselineTti) * 100;
    if (deltaPct > deltas.ttiPct) {
      regressions.push({
        metric: "timeToInteractive",
        baseline: baselineTti,
        current: currentTti,
        deltaPct,
        maxAllowedPct: deltas.ttiPct,
      });
    }
  }
  const baselineFcp = baseline.load.firstContentfulPaint ?? 0;
  const currentFcp = current.load.firstContentfulPaint ?? 0;
  if (baselineFcp > 0 && currentFcp > 0) {
    const deltaPct = ((currentFcp - baselineFcp) / baselineFcp) * 100;
    if (deltaPct > deltas.fcpPct) {
      regressions.push({
        metric: "firstContentfulPaint",
        baseline: baselineFcp,
        current: currentFcp,
        deltaPct,
        maxAllowedPct: deltas.fcpPct,
      });
    }
  }
  if (baseline.memory.jsHeapUsed > 0 && current.memory.jsHeapUsed > 0) {
    const deltaPct =
      ((current.memory.jsHeapUsed - baseline.memory.jsHeapUsed) / baseline.memory.jsHeapUsed) * 100;
    if (deltaPct > deltas.heapUsedPct) {
      regressions.push({
        metric: "jsHeapUsed",
        baseline: baseline.memory.jsHeapUsed,
        current: current.memory.jsHeapUsed,
        deltaPct,
        maxAllowedPct: deltas.heapUsedPct,
      });
    }
  }
  const baselineClose = baseline.sidebar.closeToHidden ?? 0;
  const currentClose = current.sidebar.closeToHidden ?? 0;
  if (baseline.sidebarOpened && current.sidebarOpened && baselineClose > 0 && currentClose > 0) {
    const deltaPct = ((currentClose - baselineClose) / baselineClose) * 100;
    if (deltaPct > deltas.sidebarClosePct) {
      regressions.push({
        metric: "sidebarCloseToHidden",
        baseline: baselineClose,
        current: currentClose,
        deltaPct,
        maxAllowedPct: deltas.sidebarClosePct,
      });
    }
  }
  const baselinePeak = baseline.memory.peakAfterSidebarOpen ?? 0;
  const currentPeak = current.memory.peakAfterSidebarOpen ?? 0;
  if (baseline.sidebarOpened && current.sidebarOpened && baselinePeak > 0 && currentPeak > 0) {
    const deltaPct = ((currentPeak - baselinePeak) / baselinePeak) * 100;
    if (deltaPct > deltas.peakSidebarHeapPct) {
      regressions.push({
        metric: "peakAfterSidebarOpen",
        baseline: baselinePeak,
        current: currentPeak,
        deltaPct,
        maxAllowedPct: deltas.peakSidebarHeapPct,
      });
    }
  }
  return regressions;
}
//# sourceMappingURL=perf-regression.js.map
