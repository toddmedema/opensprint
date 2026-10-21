import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { useDurableAgentOutput } from "./useDurableAgentOutput";
import { runtimeApi, type RuntimeAttempt, type RuntimeOutputPage } from "../api/runtime";
vi.mock("../api/runtime", () => ({ runtimeApi: { attempts: vi.fn(), output: vi.fn() } }));
const run: RuntimeAttempt = {
  projectId: "p",
  taskId: "t",
  runKey: "t:coding:coder",
  attemptId: "a1",
  ownerId: "owner",
  generation: 1,
  state: "running",
  expiresAt: "2026-10-21T00:00:00Z",
};
const page = (content: string, nextOffset: number): RuntimeOutputPage => ({
  attemptId: "a1",
  startOffset: 0,
  endOffset: nextOffset,
  nextOffset,
  content,
  status: "ok",
});
describe("durable agent output consumer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runtimeApi.attempts).mockReset().mockResolvedValue([run]);
    vi.mocked(runtimeApi.output).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("resumes retained offsets after a gap and network failure without duplicate text", async () => {
    vi.mocked(runtimeApi.output)
      .mockResolvedValueOnce({ ...page("", 100), status: "offset_expired", startOffset: 100 })
      .mockResolvedValueOnce(page("hello", 105));
    const { result, unmount } = renderHook(() => useDurableAgentOutput("p", "t"));
    await act(async () => {});
    expect(result.current.content).toBe("hello");
    expect(result.current.retentionGap).toBe(true);
    expect(runtimeApi.output).toHaveBeenNthCalledWith(2, "p", "a1", 100, expect.any(AbortSignal));
    vi.mocked(runtimeApi.output).mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.content).toBe("hello");
    vi.mocked(runtimeApi.output).mockResolvedValueOnce(page(" world", 111));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(runtimeApi.output).toHaveBeenLastCalledWith("p", "a1", 105, expect.any(AbortSignal));
    expect(result.current.content).toBe("hello world");
    unmount();
  });
  it("starts a successor attempt at its own offset and exposes uncertain ownership", async () => {
    vi.mocked(runtimeApi.output).mockResolvedValueOnce(page("previous", 8));
    const { result, unmount } = renderHook(() => useDurableAgentOutput("p", "t"));
    await act(async () => {});
    vi.mocked(runtimeApi.attempts).mockResolvedValue([
      { ...run, attemptId: "a2", generation: 2, state: "uncertain" },
    ]);
    vi.mocked(runtimeApi.output).mockResolvedValueOnce({
      ...page("new attempt", 11),
      attemptId: "a2",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(runtimeApi.output).toHaveBeenLastCalledWith("p", "a2", 0, expect.any(AbortSignal));
    expect(result.current.content).toBe("new attempt");
    expect(result.current.state).toBe("uncertain");
    unmount();
  });
  it("discards a delayed response after task selection changes", async () => {
    let resolve!: (value: RuntimeOutputPage) => void;
    vi.mocked(runtimeApi.output).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const { result, rerender, unmount } = renderHook(
      ({ task }) => useDurableAgentOutput("p", task),
      { initialProps: { task: "t" } }
    );
    await act(async () => {});
    vi.mocked(runtimeApi.attempts).mockResolvedValue([
      { ...run, taskId: "other", attemptId: "other-attempt" },
    ]);
    vi.mocked(runtimeApi.output).mockResolvedValueOnce({
      ...page("selected", 8),
      attemptId: "other-attempt",
    });
    rerender({ task: "other" });
    await act(async () => {});
    await act(async () => {
      resolve(page("obsolete", 8));
    });
    expect(result.current.content).toBe("selected");
    unmount();
  });
});
