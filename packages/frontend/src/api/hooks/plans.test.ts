import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  usePlanVersions,
  usePlanVersion,
  useExecutePlan,
} from "./plans";

vi.mock("../client", () => ({
  api: {
    plans: {
      listVersions: vi.fn(),
      getVersion: vi.fn(),
      execute: vi.fn(),
    },
  },
}));

const { api } = await import("../client");

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  Wrapper.displayName = "PlansTestWrapper";
  return Wrapper;
}

describe("usePlanVersions", () => {
  beforeEach(() => {
    vi.mocked(api.plans.listVersions).mockResolvedValue([
      { id: "v1", version_number: 1, created_at: "2025-01-01T00:00:00Z", is_executed_version: false },
      { id: "v2", version_number: 2, created_at: "2025-01-02T00:00:00Z", is_executed_version: true },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches versions when projectId and planId are set", async () => {
    const listSpy = vi.mocked(api.plans.listVersions);
    const wrapper = createWrapper();

    const { result } = renderHook(
      () => usePlanVersions("proj-1", "plan-1"),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listSpy).toHaveBeenCalledWith("proj-1", "plan-1");
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[0].version_number).toBe(1);
    expect(result.current.data?.[1].version_number).toBe(2);
  });

  it("does not fetch when projectId is undefined", async () => {
    const listSpy = vi.mocked(api.plans.listVersions);
    const wrapper = createWrapper();

    const { result } = renderHook(
      () => usePlanVersions(undefined, "plan-1"),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(listSpy).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("does not fetch when planId is undefined", async () => {
    const listSpy = vi.mocked(api.plans.listVersions);
    const wrapper = createWrapper();

    const { result } = renderHook(
      () => usePlanVersions("proj-1", undefined),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("exposes error when listVersions rejects", async () => {
    vi.mocked(api.plans.listVersions).mockRejectedValue(new Error("list versions failed"));
    const wrapper = createWrapper();

    const { result } = renderHook(
      () => usePlanVersions("proj-1", "plan-1"),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("list versions failed"));
    expect(result.current.data).toBeUndefined();
  });
});

describe("usePlanVersion", () => {
  const versionContent = {
    version_number: 2,
    title: "Plan v2",
    content: "# Plan v2\n\nContent.",
    created_at: "2025-01-02T00:00:00Z",
    is_executed_version: true,
  };

  beforeEach(() => {
    vi.mocked(api.plans.getVersion).mockResolvedValue(versionContent);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches a single version when projectId, planId and versionNumber are set", async () => {
    const getSpy = vi.mocked(api.plans.getVersion);
    const wrapper = createWrapper();

    const { result } = renderHook(
      () => usePlanVersion("proj-1", "plan-1", 2),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getSpy).toHaveBeenCalledWith("proj-1", "plan-1", 2);
    expect(result.current.data).toEqual(versionContent);
  });

  it("does not fetch when versionNumber is 0", async () => {
    const getSpy = vi.mocked(api.plans.getVersion);
    const wrapper = createWrapper();

    const { result } = renderHook(
      () => usePlanVersion("proj-1", "plan-1", 0),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("does not fetch when versionNumber is undefined", async () => {
    const getSpy = vi.mocked(api.plans.getVersion);
    const wrapper = createWrapper();

    renderHook(
      () => usePlanVersion("proj-1", "plan-1", undefined),
      { wrapper }
    );

    await waitFor(() => expect(getSpy).not.toHaveBeenCalled());
  });

  it("exposes error when getVersion rejects", async () => {
    vi.mocked(api.plans.getVersion).mockRejectedValue(new Error("get version failed"));
    const wrapper = createWrapper();

    const { result } = renderHook(
      () => usePlanVersion("proj-1", "plan-1", 2),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("get version failed"));
    expect(result.current.data).toBeUndefined();
  });
});

describe("useExecutePlan", () => {
  beforeEach(() => {
    vi.mocked(api.plans.execute).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls execute with version_number when provided", async () => {
    const executeSpy = vi.mocked(api.plans.execute);
    const wrapper = createWrapper();

    const { result } = renderHook(() => useExecutePlan("proj-1"), { wrapper });

    result.current.mutate({
      planId: "plan-1",
      version_number: 7,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(executeSpy).toHaveBeenCalledWith("proj-1", "plan-1", { version_number: 7 });
  });

  it("calls execute without version_number when omitted", async () => {
    const executeSpy = vi.mocked(api.plans.execute);
    const wrapper = createWrapper();

    const { result } = renderHook(() => useExecutePlan("proj-1"), { wrapper });

    result.current.mutate({ planId: "plan-1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(executeSpy).toHaveBeenCalledWith("proj-1", "plan-1", {
      prerequisitePlanIds: undefined,
      version_number: undefined,
    });
  });

  it("invalidates plan versions on success", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const Wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useExecutePlan("proj-1"), {
      wrapper: Wrapper,
    });

    result.current.mutate({ planId: "plan-1", version_number: 3 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["plans", "proj-1", "plan-1", "versions"],
    });
  });

  it("exposes error when execute rejects and does not invalidate versions", async () => {
    vi.mocked(api.plans.execute).mockRejectedValue(new Error("execute failed"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const Wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useExecutePlan("proj-1"), {
      wrapper: Wrapper,
    });

    result.current.mutate({ planId: "plan-1" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("execute failed"));
    const versionsCalls = invalidateSpy.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]?.queryKey) &&
        call[0].queryKey[3] === "versions"
    );
    expect(versionsCalls).toHaveLength(0);
  });
});
