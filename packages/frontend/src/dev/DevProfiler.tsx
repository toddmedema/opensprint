/**
 * Development-time profiling: React Profiler + PerformanceObserver.
 * Only active when import.meta.env.DEV is true (Vite dev mode).
 *
 * - React.Profiler: Logs render duration for the app root
 * - PerformanceObserver: Logs long tasks (>50ms) to help identify CPU spikes
 *
 * Enable in dev to profile phase switches, sidebar open/close, etc.
 */

import { type ReactNode, useEffect, Profiler } from "react";

const LONG_TASK_THRESHOLD_MS = 50;

function onRenderCallback(
  id: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
  baseDuration: number
) {
  if (actualDuration > LONG_TASK_THRESHOLD_MS) {
    console.debug(
      `[DevProfiler] ${id} ${phase}: ${actualDuration.toFixed(1)}ms (base: ${baseDuration.toFixed(1)}ms)`
    );
  }
}

function usePerformanceObserver() {
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > LONG_TASK_THRESHOLD_MS) {
          console.debug(`[DevProfiler] Long task: ${entry.duration.toFixed(1)}ms`, entry.name);
        }
      }
    });

    try {
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      // longtask may not be supported in all browsers
    }

    return () => observer.disconnect();
  }, []);
}

interface DevProfilerProps {
  children: ReactNode;
}

/**
 * Wraps the app in dev mode with React.Profiler and PerformanceObserver.
 * No-op in production.
 */
export function DevProfiler({ children }: DevProfilerProps) {
  const isDev = import.meta.env.DEV;

  usePerformanceObserver();

  if (!isDev) {
    return <>{children}</>;
  }

  return (
    <Profiler id="App" onRender={onRenderCallback}>
      {children}
    </Profiler>
  );
}
