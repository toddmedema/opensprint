import type { Middleware } from "@reduxjs/toolkit";
import {
  appendAgentOutput,
  setAgentOutputBackfill,
  setSelectedTaskId,
  fetchLiveOutputBackfill,
  resetExecute,
} from "../slices/executeSlice";
import { createAgentOutputFilter, filterAgentOutput } from "../../utils/agentOutputFilter";

/**
 * Max time to hold buffered chunks (background tabs throttle rAF; this caps latency).
 */
const BATCH_MAX_MS = 150;

const hasRaf =
  typeof globalThis.requestAnimationFrame === "function" &&
  typeof globalThis.cancelAnimationFrame === "function";

/**
 * Middleware that holds an isolated agent output filter instance.
 * Intercepts appendAgentOutput to filter chunks, buffers WS chunks, then flushes
 * on the next animation frame (when available) and/or after a short interval so
 * Redux/React update at a stable rate instead of once per chunk.
 * Flushes pending content on setSelectedTaskId to ensure no loss.
 * Also filters setAgentOutputBackfill and resets filter on setSelectedTaskId.
 */
export const agentOutputFilterMiddleware: Middleware = (store) => {
  const filter = createAgentOutputFilter();
  const buffer = new Map<string, string[]>();
  const activeBackfillRequests = new Set<string>();
  let selectionOwned = false;
  const selectedTaskId = () =>
    (store.getState() as { execute?: { selectedTaskId?: string | null } }).execute?.selectedTaskId;
  const isStale = (taskId: string) => selectionOwned && selectedTaskId() !== taskId;
  let rafId: number | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelScheduledFlush = (): void => {
    if (rafId != null && hasRaf) {
      globalThis.cancelAnimationFrame!(rafId);
      rafId = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  const flush = (
    next: (a: ReturnType<typeof appendAgentOutput>) => unknown,
    preserveCompletion?: boolean
  ) => {
    cancelScheduledFlush();
    for (const [taskId, chunks] of buffer) {
      if (isStale(taskId)) continue;
      const concatenated = chunks.join("");
      if (concatenated) {
        next(
          appendAgentOutput({
            taskId,
            chunk: concatenated,
            ...(preserveCompletion ? { preserveCompletion: true } : {}),
          })
        );
      }
    }
    buffer.clear();
  };

  const scheduleBufferedFlush = (
    next: (a: ReturnType<typeof appendAgentOutput>) => unknown
  ): void => {
    if (hasRaf && rafId == null) {
      rafId = globalThis.requestAnimationFrame!(() => {
        rafId = null;
        if (buffer.size === 0) {
          if (maxWaitTimer) {
            clearTimeout(maxWaitTimer);
            maxWaitTimer = null;
          }
          return;
        }
        flush(next);
      });
    }
    if (maxWaitTimer == null) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null;
        if (buffer.size === 0) {
          if (rafId != null && hasRaf) {
            globalThis.cancelAnimationFrame!(rafId);
            rafId = null;
          }
          return;
        }
        flush(next);
      }, BATCH_MAX_MS);
    }
  };

  return (next) => (action) => {
    if (resetExecute.match(action)) {
      cancelScheduledFlush();
      buffer.clear();
      activeBackfillRequests.clear();
      filter.reset();
      // A project reset establishes a boundary: old output stays blocked until
      // the next project's current task explicitly owns the subscription.
      selectionOwned = true;
      return next(action);
    }
    if (setSelectedTaskId.match(action)) {
      const changed = selectedTaskId() !== action.payload;
      selectionOwned = true;
      // Flush runs before deselection is applied; without preserveCompletion, append would clear
      // per-task completion state that was set after the original chunks were buffered.
      flush(next, true);
      if (changed) {
        filter.reset();
        activeBackfillRequests.clear();
      }
      return next(action);
    }
    if (fetchLiveOutputBackfill.pending.match(action) && !isStale(action.meta.arg.taskId)) {
      activeBackfillRequests.add(action.meta.requestId);
    }
    if (fetchLiveOutputBackfill.rejected.match(action)) {
      activeBackfillRequests.delete(action.meta.requestId);
    }
    if (fetchLiveOutputBackfill.fulfilled.match(action)) {
      const owned = activeBackfillRequests.delete(action.meta.requestId);
      if (!owned || isStale(action.payload.taskId)) return;
    }
    if (appendAgentOutput.match(action)) {
      if (isStale(action.payload.taskId)) return;
      const { taskId, chunk } = action.payload;
      const filtered = filter.filter(chunk);
      if (filtered) {
        const list = buffer.get(taskId) ?? [];
        list.push(filtered);
        buffer.set(taskId, list);
      }
      scheduleBufferedFlush(next);
      return next({ type: "@@agentOutputFilter/batched" });
    }
    if (setAgentOutputBackfill.match(action)) {
      if (isStale(action.payload.taskId)) return;
      const { taskId } = action.payload;
      const filtered = filterAgentOutput(action.payload.output);

      // Skip stale backfills: when a REST or late-arriving WS backfill
      // contains less content than the current state (which already
      // incorporates a fresher backfill + live chunks), applying it would
      // rewind the output.  Subsequent live chunks then re-append the tail
      // that was already displayed — the "duplicate final sentence" bug.
      const current = (store.getState() as { execute?: { agentOutput?: Record<string, string[]> } })
        .execute?.agentOutput?.[taskId];
      if (current) {
        const currentLen = current.reduce((sum, c) => sum + c.length, 0);
        if (currentLen > filtered.length) {
          return;
        }
      }

      // Discard buffered chunks for this task — the backfill supersedes them.
      buffer.delete(taskId);
      if (buffer.size === 0) {
        cancelScheduledFlush();
      }
      // Reset incremental filter so subsequent WS chunks are not processed
      // against stale partial-line state from before the backfill.
      filter.reset();
      return next(setAgentOutputBackfill({ taskId, output: filtered }));
    }
    return next(action);
  };
};
