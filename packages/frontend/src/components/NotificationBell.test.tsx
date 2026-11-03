import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationBell } from "./NotificationBell";
import executeReducer from "../store/slices/executeSlice";
import planReducer from "../store/slices/planSlice";
import openQuestionsReducer from "../store/slices/openQuestionsSlice";

const mockListByProject = vi.fn();
const mockClearAllByProject = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    notifications: {
      listByProject: (...args: unknown[]) => mockListByProject(...args),
      clearAllByProject: (...args: unknown[]) => mockClearAllByProject(...args),
    },
  },
}));

beforeEach(() => {
  mockListByProject.mockResolvedValue([]);
  mockClearAllByProject.mockResolvedValue({ deletedCount: 1 });
});

function LocationCapture() {
  const loc = useLocation();
  return (
    <div data-testid="current-location">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderNotificationBell(
  notifications: Array<{
    id: string;
    projectId: string;
    source: "plan" | "prd" | "execute" | "eval" | "self-improvement";
    sourceId: string;
    questions: Array<{ id: string; text: string; createdAt: string }>;
    status: "open" | "resolved";
    createdAt: string;
    resolvedAt: string | null;
    kind?: string;
    errorCode?: string;
  }> = []
) {
  mockListByProject.mockResolvedValue(notifications);
  const store = configureStore({
    reducer: {
      execute: executeReducer,
      plan: planReducer,
      openQuestions: openQuestionsReducer,
    },
    preloadedState: {
      openQuestions: {
        byProject: { "proj-1": notifications },
        global: [],
        async: {
          project: {},
          global: { loading: false },
        },
      },
    },
  });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <Provider store={store}>
        <MemoryRouter>
          <LocationCapture />
          <NotificationBell projectId="proj-1" />
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>
  );
}

describe("NotificationBell", () => {
  it("opens the dedicated docket for a governance hold", async () => {
    renderNotificationBell([
      {
        id: "governance-1",
        projectId: "proj-1",
        source: "execute",
        sourceId: "case-1",
        questions: [
          {
            id: "q1",
            text: "Repository rule needs a human decision",
            createdAt: "2026-10-30T00:00:00Z",
          },
        ],
        status: "open",
        createdAt: "2026-10-30T00:00:00Z",
        resolvedAt: null,
        kind: "governance",
      },
    ]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "1 notification" }));
    expect(screen.getByRole("button", { name: "Clear other notifications" })).toBeInTheDocument();
    await user.click(screen.getByText("Repository rule needs a human decision"));
    expect(screen.getByTestId("current-location")).toHaveTextContent(
      "/projects/proj-1/settings?tab=governance&case=case-1"
    );
    expect(mockClearAllByProject).not.toHaveBeenCalled();
  });
  it("renders nothing when no notifications", () => {
    renderNotificationBell([]);
    expect(
      screen.queryByTitle("Notifications (open questions & API issues)")
    ).not.toBeInTheDocument();
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
        questions: [
          {
            id: "q1",
            text: "What is the scope of this feature?",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ],
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

  it("shows Clear all button and clears project notifications on click", async () => {
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
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Notifications (open questions & API issues)"));
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => {
      expect(mockClearAllByProject).toHaveBeenCalledWith("proj-1");
    });
  });

  it("navigates to project settings with Global tab when clicking rate_limit notification", async () => {
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
    await user.click(screen.getByText(/Rate limit exceeded/));

    await waitFor(() => {
      const loc = screen.getByTestId("current-location");
      expect(loc).toHaveTextContent("/projects/proj-1/settings");
      expect(loc).toHaveTextContent("level=global");
    });
  });

  it("navigates to project settings workflow tab when clicking self_improvement_approval notification", async () => {
    const notifications = [
      {
        id: "si-1",
        projectId: "proj-1",
        source: "self-improvement" as const,
        sourceId: "cand-42",
        questions: [
          {
            id: "q1",
            text: "Agent improvement candidate awaiting approval",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ],
        status: "open" as const,
        createdAt: "2025-01-01T00:00:00Z",
        resolvedAt: null,
        kind: "self_improvement_approval" as const,
      },
    ];
    renderNotificationBell(notifications);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 notification/ })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Notifications (open questions & API issues)"));
    await user.click(screen.getByText(/Agent improvement candidate/));

    await waitFor(() => {
      const loc = screen.getByTestId("current-location");
      expect(loc).toHaveTextContent("/projects/proj-1/settings");
      expect(loc).toHaveTextContent("tab=workflow");
      expect(loc).toHaveTextContent("focus=self-improvement");
    });
  });

  it("navigates draft plan notifications without setting a plan query param", async () => {
    const notifications = [
      {
        id: "oq-draft-1",
        projectId: "proj-1",
        source: "plan" as const,
        sourceId: "draft:draft-1",
        questions: [
          { id: "q1", text: "Clarify volunteer scope?", createdAt: "2025-01-01T00:00:00Z" },
        ],
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
    await user.click(screen.getByText(/Clarify volunteer scope/));

    await waitFor(() => {
      const loc = screen.getByTestId("current-location");
      expect(loc).toHaveTextContent("/projects/proj-1/plan");
      expect(loc).toHaveTextContent("question=oq-draft-1");
      expect(loc).not.toHaveTextContent("plan=draft%3Adraft-1");
    });
  });
});
