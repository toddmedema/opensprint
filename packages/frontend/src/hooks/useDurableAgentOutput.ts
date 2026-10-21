import { useEffect, useState } from "react";
import { runtimeApi, type ExecutionState, type RuntimeAttempt } from "../api/runtime";
interface Stream {
  offset: number;
  text: string;
  gap: boolean;
}
interface ReplayState {
  content: string | null;
  retentionGap: boolean;
  state: ExecutionState | null;
  receivedAt: string | null;
}
const empty: ReplayState = { content: null, retentionGap: false, state: null, receivedAt: null };
const ACTIVE = new Set<ExecutionState>(["queued", "running", "stop_requested", "uncertain"]);

/** Output cursors belong to attempts. Network reconnects resume them; a successor starts its own cursor. */
export function useDurableAgentOutput(
  projectId: string,
  taskId: string,
  enabled = true
): ReplayState {
  const key = `${projectId}:${taskId}`;
  const [state, setState] = useState<ReplayState & { key: string }>({ ...empty, key: "" });
  useEffect(() => {
    setState({ ...empty, key });
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const streams = new Map<string, Stream>();
    const poll = async () => {
      let delay = 1000;
      try {
        const observations = await runtimeApi.attempts(projectId, taskId, controller.signal);
        if (disposed) return;
        const active = observations.filter((run) => ACTIVE.has(run.state));
        const attempts = (
          active.length
            ? active
            : [...observations].sort((a, b) => b.expiresAt.localeCompare(a.expiresAt)).slice(0, 1)
        ).sort((a, b) => a.runKey.localeCompare(b.runKey));
        if (!attempts.length) {
          setState({ ...empty, key });
          return;
        }
        if (!active.length) delay = 5000;
        let received = false;
        for (const attempt of attempts) {
          const stream = streams.get(attempt.attemptId) ?? { offset: 0, text: "", gap: false };
          streams.set(attempt.attemptId, stream);
          for (let pageCount = 0; pageCount < 8; pageCount++) {
            const page = await runtimeApi.output(
              projectId,
              attempt.attemptId,
              stream.offset,
              controller.signal
            );
            if (disposed) return;
            if (page.status === "unknown_attempt") break;
            if (page.status === "offset_expired") {
              stream.text = "";
              stream.offset = page.nextOffset;
              stream.gap = true;
              continue;
            }
            if (page.content) {
              stream.text = (stream.text + page.content).slice(-5 * 1024 * 1024);
              received = true;
            }
            const previous = stream.offset;
            stream.offset = page.nextOffset;
            if (stream.offset >= page.endOffset || stream.offset <= previous) break;
          }
        }
        if (disposed) return;
        const visibleIds = new Set(attempts.map((run) => run.attemptId));
        for (const key of streams.keys()) if (!visibleIds.has(key)) streams.delete(key);
        const label = (run: RuntimeAttempt) =>
          run.runKey.includes(":coding:") ? "Coding" : "Review";
        const content = attempts
          .map(
            (run) =>
              `${attempts.length > 1 ? `### ${label(run)}\n\n` : ""}${streams.get(run.attemptId)?.text ?? ""}`
          )
          .join("\n\n");
        const observedState =
          attempts.find((run) => run.state === "uncertain")?.state ??
          attempts.find((run) => run.state === "stop_requested")?.state ??
          attempts[0]!.state;
        setState((previous) => ({
          key,
          content,
          retentionGap: [...streams.values()].some((stream) => stream.gap),
          state: observedState,
          receivedAt: received ? new Date().toISOString() : previous.receivedAt,
        }));
      } catch {
        // Keep the last committed cursor/content; retry resumes without duplicating accepted chunks.
        delay = 3000;
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), delay);
      }
    };
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, taskId, enabled, key]);
  return state.key === key ? state : empty;
}
