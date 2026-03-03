# Performance Baseline Documentation

This document describes how to measure and document performance baselines before/after optimizations.

## Quick Start

1. Start the app: `npm run dev` (or `npm run dev:backend` and `npm run dev:frontend` separately)
2. Ensure you have at least one project with tasks (for sidebar open/close metrics)
3. Run the perf script: `npm run perf`

## Commands

| Command                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `npm run perf`          | Run performance measurement and print report       |
| `npm run perf:baseline` | Run measurement and save to `perf-baseline.json`   |
| `npm run perf:compare`  | Run measurement and compare against saved baseline |

## Metrics Collected

- **Load:** DOM Content Loaded, Load Complete, First Contentful Paint (FCP), Time to Interactive (TTI)
- **Memory:** JS Heap Used, JS Heap Total, peak after sidebar open, after sidebar close
- **Sidebar:** Open-to-visible time, close-to-hidden time

## Workflow for Optimizations

1. **Before optimization:** Run `npm run perf:baseline` to capture current metrics
2. **Implement optimization**
3. **After optimization:** Run `npm run perf:compare` to see delta vs baseline
4. Document results in this file or in PR description

## Acceptance Criteria (from plan)

- **RAM:** Reduce peak memory by ≥40% (target: <1.2GB under typical usage)
- **Initial load:** TTI reduced by ≥30%; FCP improved
- **Sidebar close:** CPU spike reduced; no sustained 100% CPU for >500ms
- **General responsiveness:** No perceptible lag when switching phases

## Development-Time Profiling

In dev mode (`npm run dev:frontend`), the app wraps the root in:

- **React.Profiler:** Logs render duration when it exceeds 50ms (check browser console)
- **PerformanceObserver (longtask):** Logs long tasks >50ms that may cause UI jank

Open DevTools console and perform actions (phase switch, sidebar open/close) to see `[DevProfiler]` logs.

## Notes

- Metrics vary by machine; use the same environment for before/after comparisons
- The script requires headless Chrome (Puppeteer); install with `npm install`
- If no projects/tasks exist, the script still reports load and memory; sidebar metrics are skipped
