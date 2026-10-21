import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";
import type { ReactNode } from "react";
import { useOpenQuestionNotifications } from "./useOpenQuestionNotifications";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    notifications: {
      listByProject: vi.fn(),
    },
  },
}));

function createWrapper(preloadedNotifications: unknown[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.notifications.project("p1"), preloadedNotifications);

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useOpenQuestionNotifications", () => {
  beforeEach(() => {
    vi.mocked(api.notifications.listByProject).mockResolvedValue([]);
  });

  it("returns empty notifications and a refetch function when projectId is null", () => {
    const { result } = renderHook(() => useOpenQuestionNotifications(null), {
      wrapper: createWrapper(),
    });

    expect(result.current.notifications).toEqual([]);
    expect(typeof result.current.refetch).toBe("function");
    expect(api.notifications.listByProject).not.toHaveBeenCalled();
  });

  it("reads notifications from the project query", () => {
    const mockNotifications = [
      {
        id: "notif-1",
        projectId: "p1",
        source: "plan" as const,
        sourceId: "plan-1",
        questions: [{ id: "q1", text: "Question?", createdAt: "2025-01-01T00:00:00Z" }],
        status: "open" as const,
        createdAt: "2025-01-01T00:00:00Z",
        resolvedAt: null,
      },
    ];

    const { result } = renderHook(() => useOpenQuestionNotifications("p1"), {
      wrapper: createWrapper(mockNotifications),
    });

    expect(result.current.notifications).toEqual(mockNotifications);
  });

  it("refetches notifications through the project query", async () => {
    const mockNotifications = [
      {
        id: "notif-2",
        projectId: "p1",
        source: "eval" as const,
        sourceId: "feedback-1",
        questions: [{ id: "q2", text: "Need more detail", createdAt: "2025-01-01T00:00:00Z" }],
        status: "open" as const,
        createdAt: "2025-01-01T00:00:00Z",
        resolvedAt: null,
      },
    ];
    vi.mocked(api.notifications.listByProject).mockResolvedValue(mockNotifications);

    const { result } = renderHook(() => useOpenQuestionNotifications("p1"), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.notifications).toEqual(mockNotifications);
    });
    expect(api.notifications.listByProject).toHaveBeenCalledWith("p1");
  });
});
