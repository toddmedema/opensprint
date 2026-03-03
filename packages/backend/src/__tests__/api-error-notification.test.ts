import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiErrorNotificationMiddleware } from "../middleware/api-error-notification.js";
import { AppError } from "../middleware/error-handler.js";

const mockCreateApiBlocked = vi.fn();
const mockBroadcastToProject = vi.fn();

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    createApiBlocked: (...args: unknown[]) => mockCreateApiBlocked(...args),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
}));

describe("apiErrorNotificationMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates and broadcasts an API-blocked notification for actionable agent errors", async () => {
    mockCreateApiBlocked.mockResolvedValue({
      id: "notif-1",
      projectId: "proj-1",
      source: "plan",
      sourceId: "plan-1",
      questions: [],
      createdAt: "2026-03-03T00:00:00Z",
      errorCode: "auth",
    });
    const next = vi.fn();

    apiErrorNotificationMiddleware(
      new AppError(502, "AGENT_INVOKE_FAILED", "401 unauthorized"),
      {
        params: { projectId: "proj-1" },
        path: "/api/projects/proj-1/plans/plan-1/execute",
      } as never,
      {} as never,
      next
    );

    await vi.waitFor(() => {
      expect(mockCreateApiBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          source: "plan",
          sourceId: "plan-1",
          errorCode: "auth",
        })
      );
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          type: "notification.added",
          notification: expect.objectContaining({ id: "notif-1" }),
        })
      );
      expect(next).toHaveBeenCalled();
    });
  });

  it("passes through ignored errors without side effects", () => {
    const next = vi.fn();

    apiErrorNotificationMiddleware(
      new AppError(400, "VALIDATION", "Bad request"),
      { params: { projectId: "proj-1" }, path: "/api/projects/proj-1/plans" } as never,
      {} as never,
      next
    );

    expect(mockCreateApiBlocked).not.toHaveBeenCalled();
    expect(mockBroadcastToProject).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it("prefers structured notificationMessage/details and recognizes GOOGLE_API_ERROR", async () => {
    mockCreateApiBlocked.mockResolvedValue({
      id: "notif-2",
      projectId: "proj-1",
      source: "prd",
      sourceId: "global",
      questions: [],
      createdAt: "2026-03-03T00:00:00Z",
      errorCode: "rate_limit",
    });
    const next = vi.fn();

    apiErrorNotificationMiddleware(
      new AppError(502, "GOOGLE_API_ERROR", "noisy raw provider payload", {
        kind: "rate_limit",
        agentType: "google",
        raw: "RESOURCE_EXHAUSTED",
        userMessage: "Google Gemini hit a rate limit.",
        notificationMessage: "Google Gemini hit a rate limit. Add another key in Settings.",
        isLimitError: true,
      }),
      {
        params: { projectId: "proj-1" },
        path: "/api/projects/proj-1/prd/generate-from-codebase",
      } as never,
      {} as never,
      next
    );

    await vi.waitFor(() => {
      expect(mockCreateApiBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          source: "prd",
          sourceId: "global",
          errorCode: "rate_limit",
          message: "Google Gemini hit a rate limit. Add another key in Settings.",
        })
      );
      expect(next).toHaveBeenCalled();
    });
  });
});
