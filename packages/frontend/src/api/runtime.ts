import { request, ApiError } from "./client";
import { sessionHeaders } from "./session";
export type ExecutionState =
  | "queued"
  | "running"
  | "stop_requested"
  | "stopped"
  | "completed"
  | "uncertain";
export interface RuntimeAttempt {
  projectId: string;
  taskId: string;
  runKey: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  state: ExecutionState;
  expiresAt: string;
}
export interface RuntimeOutputPage {
  attemptId: string;
  startOffset: number;
  endOffset: number;
  nextOffset: number;
  content: string;
  status: "ok" | "offset_expired" | "unknown_attempt";
}
const base = `${(import.meta.env.VITE_API_BASE as string | undefined) ?? ""}/api/v1`;
export const runtimeApi = {
  attempts: (projectId: string, taskId: string, signal?: AbortSignal) =>
    request<RuntimeAttempt[]>(
      `/projects/${encodeURIComponent(projectId)}/runtime/attempts?taskId=${encodeURIComponent(taskId)}`,
      { signal }
    ),
  async output(
    projectId: string,
    attemptId: string,
    offset: number,
    signal?: AbortSignal
  ): Promise<RuntimeOutputPage> {
    const response = await fetch(
      `${base}/projects/${encodeURIComponent(projectId)}/runtime/attempts/${encodeURIComponent(attemptId)}/output?offset=${offset}`,
      {
        credentials: "same-origin",
        headers: sessionHeaders(),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      }
    );
    const body = await response.json();
    if (!response.ok && response.status !== 410 && response.status !== 404)
      throw new ApiError(
        body.error?.message ?? "Output replay failed",
        body.error?.code ?? "UNKNOWN",
        body.error?.details
      );
    if (!body.data) throw new ApiError("Output replay is unavailable", "OUTPUT_UNAVAILABLE");
    return body.data as RuntimeOutputPage;
  },
};
