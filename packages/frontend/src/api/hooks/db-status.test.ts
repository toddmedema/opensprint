import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDbStatus, getBackoffDelayMs } from "./db-status";

vi.mock("../client", () => ({
  api: {
    dbStatus: {
      get: vi.fn(),
    },
  },
}));

const { api } = await import("../client");

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  Wrapper.displayName = "DbStatusTestWrapper";
  return Wrapper;
}

describe("getBackoffDelayMs", () => {
  it("returns 1s for first retry (attempt 0)", () => {
    expect(getBackoffDelayMs(0)).toBe(1000);
  });

  it("returns 2s for second retry (attempt 1)", () => {
    expect(getBackoffDelayMs(1)).toBe(2000);
  });

  it("returns 3s for third retry (attempt 2)", () => {
    expect(getBackoffDelayMs(2)).toBe(3000);
  });

  it("returns 5s cap for fourth and subsequent retries", () => {
    expect(getBackoffDelayMs(3)).toBe(5000);
    expect(getBackoffDelayMs(4)).toBe(5000);
    expect(getBackoffDelayMs(10)).toBe(5000);
  });
});

describe("useDbStatus backoff", () => {
  beforeEach(() => {
    vi.mocked(api.dbStatus!.get).mockResolvedValue({
      ok: false,
      state: "disconnected",
      message: "No PostgreSQL server running",
      lastCheckedAt: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches db status and uses backoff when disconnected", async () => {
    const getSpy = vi.mocked(api.dbStatus!.get);
    const wrapper = createWrapper();

    const { result } = renderHook(() => useDbStatus(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(result.current.data).toMatchObject({
      ok: false,
      state: "disconnected",
    });
  });

  it("uses 10s interval when connected", async () => {
    vi.mocked(api.dbStatus!.get).mockResolvedValue({
      ok: true,
      state: "connected",
      lastCheckedAt: new Date().toISOString(),
    });
    const wrapper = createWrapper();

    const { result } = renderHook(() => useDbStatus(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(true);
  });
});
