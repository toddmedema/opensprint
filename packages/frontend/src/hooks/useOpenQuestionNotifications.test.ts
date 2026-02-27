import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useOpenQuestionNotifications } from "./useOpenQuestionNotifications";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    notifications: {
      listByProject: vi.fn(),
    },
  },
}));

describe("useOpenQuestionNotifications", () => {
  beforeEach(() => {
    vi.mocked(api.notifications.listByProject).mockResolvedValue([]);
  });

  it("returns empty notifications and refetch when projectId is null", () => {
    const { result } = renderHook(() => useOpenQuestionNotifications(null));
    expect(result.current.notifications).toEqual([]);
    expect(typeof result.current.refetch).toBe("function");
    expect(api.notifications.listByProject).not.toHaveBeenCalled();
  });

  it("fetches notifications for project and returns them", async () => {
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
    vi.mocked(api.notifications.listByProject).mockResolvedValue(mockNotifications);

    const { result } = renderHook(() => useOpenQuestionNotifications("p1"));

    await waitFor(() => {
      expect(result.current.notifications).toEqual(mockNotifications);
    });
    expect(api.notifications.listByProject).toHaveBeenCalledWith("p1");
  });

  it("handles fetch error by returning empty array", async () => {
    vi.mocked(api.notifications.listByProject).mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useOpenQuestionNotifications("p1"));

    await waitFor(() => {
      expect(result.current.notifications).toEqual([]);
    });
  });
});
