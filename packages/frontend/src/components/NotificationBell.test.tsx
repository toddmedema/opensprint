import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { NotificationBell } from "./NotificationBell";
import executeReducer from "../store/slices/executeSlice";
import planReducer from "../store/slices/planSlice";
import openQuestionsReducer from "../store/slices/openQuestionsSlice";

const mockListByProject = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    notifications: {
      listByProject: (...args: unknown[]) => mockListByProject(...args),
    },
  },
}));

beforeEach(() => {
  mockListByProject.mockResolvedValue([]);
});

function renderNotificationBell(
  notifications: Array<{
    id: string;
    projectId: string;
    source: "plan" | "prd" | "execute" | "eval";
    sourceId: string;
    questions: Array<{ id: string; text: string; createdAt: string }>;
    status: "open" | "resolved";
    createdAt: string;
    resolvedAt: string | null;
  }> = []
) {
  mockListByProject.mockResolvedValue(notifications);
  const store = configureStore({
    reducer: {
      execute: executeReducer,
      plan: planReducer,
      openQuestions: openQuestionsReducer,
    },
  });
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <NotificationBell projectId="proj-1" />
      </MemoryRouter>
    </Provider>
  );
}

describe("NotificationBell", () => {
  it("renders nothing when no notifications", async () => {
    const { container } = renderNotificationBell([]);
    await waitFor(() => {
      expect(mockListByProject).toHaveBeenCalledWith("proj-1");
    });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("shows bell with red dot when notifications exist", async () => {
    const notifications = [
      {
        id: "oq-1",
        projectId: "proj-1",
        source: "plan" as const,
        sourceId: "plan-1",
        questions: [{ id: "q1", text: "What is the scope?", createdAt: "2025-01-01T00:00:00Z" }],
        status: "open" as const,
        createdAt: "2025-01-01T00:00:00Z",
        resolvedAt: null,
      },
    ];
    renderNotificationBell(notifications);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 notification/ })).toBeInTheDocument();
    });
    expect(screen.getByTitle("Notifications (open questions & API issues)")).toBeInTheDocument();
  });

  it("opens dropdown on click and shows notification preview", async () => {
    const notifications = [
      {
        id: "oq-1",
        projectId: "proj-1",
        source: "plan" as const,
        sourceId: "plan-1",
        questions: [{ id: "q1", text: "What is the scope of this feature?", createdAt: "2025-01-01T00:00:00Z" }],
        status: "open" as const,
        createdAt: "2025-01-01T00:00:00Z",
        resolvedAt: null,
      },
    ];
    renderNotificationBell(notifications);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 notification/ })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Notifications (open questions & API issues)"));
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/What is the scope of this feature/)).toBeInTheDocument();
  });

  it("shows API-blocked badge for api_blocked notifications", async () => {
    const notifications = [
      {
        id: "ab-1",
        projectId: "proj-1",
        source: "execute" as const,
        sourceId: "task-1",
        questions: [{ id: "q1", text: "Rate limit exceeded", createdAt: "2025-01-01T00:00:00Z" }],
        status: "open" as const,
        createdAt: "2025-01-01T00:00:00Z",
        resolvedAt: null,
        kind: "api_blocked" as const,
        errorCode: "rate_limit" as const,
      },
    ];
    renderNotificationBell(notifications);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 notification/ })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Notifications (open questions & API issues)"));
    expect(screen.getByText("Rate limit")).toBeInTheDocument();
    expect(screen.getByText(/Rate limit exceeded/)).toBeInTheDocument();
  });
});
