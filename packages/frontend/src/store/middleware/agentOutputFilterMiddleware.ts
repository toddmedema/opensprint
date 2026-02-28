import type { Middleware } from "@reduxjs/toolkit";
import {
  appendAgentOutput,
  setAgentOutputBackfill,
  setSelectedTaskId,
} from "../slices/executeSlice";
import {
  createAgentOutputFilter,
  filterAgentOutput,
} from "../../utils/agentOutputFilter";

/** Batch window in ms: collect chunks for this duration before dispatching. */
const BATCH_MS = 150;

/**
 * Middleware that holds an isolated agent output filter instance.
 * Intercepts appendAgentOutput to filter chunks, batches them for ~100-200ms,
 * then dispatches a single append with concatenated content to reduce Redux
 * dispatch frequency and React re-renders during heavy streaming.
 * Flushes pending content on setSelectedTaskId to ensure no loss.
 * Also filters setAgentOutputBackfill and resets filter on setSelectedTaskId.
 */
export const agentOutputFilterMiddleware: Middleware = () => {
  const filter = createAgentOutputFilter();
  const buffer = new Map<string, string[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (next: (a: ReturnType<typeof appendAgentOutput>) => unknown) => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const [taskId, chunks] of buffer) {
      const concatenated = chunks.join("");
      if (concatenated) {
        next(appendAgentOutput({ taskId, chunk: concatenated }));
      }
    }
    buffer.clear();
  };

  return (next) => (action) => {
    if (setSelectedTaskId.match(action)) {
      flush(next);
      filter.reset();
      return next(action);
    }
    if (appendAgentOutput.match(action)) {
      const { taskId, chunk } = action.payload;
      const filtered = filter.filter(chunk);
      if (filtered) {
        const list = buffer.get(taskId) ?? [];
        list.push(filtered);
        buffer.set(taskId, list);
      }
      if (!flushTimer) {
        flushTimer = setTimeout(() => flush(next), BATCH_MS);
      }
      return next({ type: "@@agentOutputFilter/batched" });
    }
    if (setAgentOutputBackfill.match(action)) {
      const filtered = filterAgentOutput(action.payload.output);
      return next(
        setAgentOutputBackfill({ taskId: action.payload.taskId, output: filtered })
      );
    }
    return next(action);
  };
};
