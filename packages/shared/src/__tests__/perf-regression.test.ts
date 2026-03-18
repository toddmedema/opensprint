import { describe, it, expect } from "vitest";
import {
  checkPerfRegressions,
  DEFAULT_PERF_DELTAS,
  type PerfMetrics,
  type PerfDeltas,
} from "../perf-regression.js";

function minimalMetrics(overrides: Partial<PerfMetrics> = {}): PerfMetrics {
  return {
    timestamp: "",
    load: {
      domContentLoaded: 0,
      loadComplete: 1000,
      firstContentfulPaint: 500,
      timeToInteractive: 2000,
    },
    memory: { jsHeapUsed: 100_000_000, jsHeapTotal: 120_000_000 },
    sidebar: {},
    sidebarOpened: false,
    ...overrides,
  };
}

describe("checkPerfRegressions", () => {
  it("returns empty when current equals baseline", () => {
    const m = minimalMetrics();
    expect(checkPerfRegressions(m, m)).toEqual([]);
  });

  it("returns empty when current is better than baseline", () => {
    const baseline = minimalMetrics({
      load: {
        domContentLoaded: 100,
        loadComplete: 2000,
        firstContentfulPaint: 800,
        timeToInteractive: 5000,
      },
    });
    const current = minimalMetrics({
      load: {
        domContentLoaded: 50,
        loadComplete: 1500,
        firstContentfulPaint: 400,
        timeToInteractive: 3000,
      },
    });
    expect(checkPerfRegressions(baseline, current)).toEqual([]);
  });

  it("returns empty when regression is within allowed delta", () => {
    const base = minimalMetrics();
    const baseline = minimalMetrics({
      load: { ...base.load, loadComplete: 1000 },
      memory: { ...base.memory, jsHeapUsed: 100_000_000 },
    });
    const cur = minimalMetrics();
    const current = minimalMetrics({
      load: { ...cur.load, loadComplete: 1150 },
      memory: { ...cur.memory, jsHeapUsed: 115_000_000 },
    }); // +15%
    expect(checkPerfRegressions(baseline, current)).toEqual([]);
  });

  it("returns regression when loadComplete exceeds delta", () => {
    const baseline = minimalMetrics({ load: { ...minimalMetrics().load, loadComplete: 1000 } });
    const current = minimalMetrics({ load: { ...minimalMetrics().load, loadComplete: 1250 } }); // +25%, max 20%
    const regressions = checkPerfRegressions(baseline, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].metric).toBe("loadComplete");
    expect(regressions[0].deltaPct).toBe(25);
    expect(regressions[0].maxAllowedPct).toBe(20);
  });

  it("returns regression when TTI exceeds delta", () => {
    const baseline = minimalMetrics({
      load: { ...minimalMetrics().load, timeToInteractive: 5000 },
    });
    const current = minimalMetrics({ load: { ...minimalMetrics().load, timeToInteractive: 7000 } }); // +40%, max 20%
    const regressions = checkPerfRegressions(baseline, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].metric).toBe("timeToInteractive");
    expect(regressions[0].deltaPct).toBe(40);
  });

  it("returns regression when FCP exceeds delta", () => {
    const baseline = minimalMetrics({
      load: { ...minimalMetrics().load, firstContentfulPaint: 1000 },
    });
    const current = minimalMetrics({
      load: { ...minimalMetrics().load, firstContentfulPaint: 1300 },
    }); // +30%, max 20%
    const regressions = checkPerfRegressions(baseline, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].metric).toBe("firstContentfulPaint");
  });

  it("returns regression when jsHeapUsed exceeds delta", () => {
    const baseline = minimalMetrics({
      memory: { ...minimalMetrics().memory, jsHeapUsed: 200_000_000 },
    });
    const current = minimalMetrics({
      memory: { ...minimalMetrics().memory, jsHeapUsed: 250_000_000 },
    }); // +25%, max 20%
    const regressions = checkPerfRegressions(baseline, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].metric).toBe("jsHeapUsed");
  });

  it("returns multiple regressions when several metrics exceed delta", () => {
    const base = minimalMetrics();
    const baseline = minimalMetrics({
      load: { ...base.load, loadComplete: 1000, timeToInteractive: 5000 },
      memory: { ...base.memory, jsHeapUsed: 100_000_000 },
    });
    const cur = minimalMetrics();
    const current = minimalMetrics({
      load: { ...cur.load, loadComplete: 1300, timeToInteractive: 7000 },
      memory: { ...cur.memory, jsHeapUsed: 130_000_000 },
    });
    const regressions = checkPerfRegressions(baseline, current);
    expect(regressions.length).toBeGreaterThanOrEqual(2);
    const metrics = regressions.map((r) => r.metric);
    expect(metrics).toContain("loadComplete");
    expect(metrics).toContain("timeToInteractive");
    expect(metrics).toContain("jsHeapUsed");
  });

  it("uses custom deltas when provided", () => {
    const baseline = minimalMetrics({ load: { ...minimalMetrics().load, loadComplete: 1000 } });
    const current = minimalMetrics({ load: { ...minimalMetrics().load, loadComplete: 1250 } }); // +25%
    const strict: PerfDeltas = { ...DEFAULT_PERF_DELTAS, loadCompletePct: 20 };
    expect(checkPerfRegressions(baseline, current, strict)).toHaveLength(1);
    const loose: PerfDeltas = { ...DEFAULT_PERF_DELTAS, loadCompletePct: 30 };
    expect(checkPerfRegressions(baseline, current, loose)).toHaveLength(0);
  });

  it("skips sidebar metrics when sidebar was not opened", () => {
    const baseline = minimalMetrics({ sidebarOpened: false });
    const current = minimalMetrics({ sidebarOpened: false });
    expect(checkPerfRegressions(baseline, current)).toEqual([]);
  });

  it("reports sidebar close regression when both opened and close time exceeds delta", () => {
    const base = minimalMetrics();
    const baseline = minimalMetrics({
      sidebarOpened: true,
      sidebar: { ...base.sidebar, closeToHidden: 400 },
    });
    const cur = minimalMetrics();
    const current = minimalMetrics({
      sidebarOpened: true,
      sidebar: { ...cur.sidebar, closeToHidden: 600 },
    }); // +50%, max 30%
    const regressions = checkPerfRegressions(baseline, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].metric).toBe("sidebarCloseToHidden");
  });
});
