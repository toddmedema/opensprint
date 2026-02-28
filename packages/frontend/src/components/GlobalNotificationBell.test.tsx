import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { GlobalNotificationBell } from "./GlobalNotificationBell";
import executeReducer from "../store/slices/executeSlice";
import planReducer from "../store/slices/planSlice";
import openQuestionsReducer from "../store/slices/openQuestionsSlice";

const mockListGlobal = vi.fn();
const mockProjectsList = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    notifications: {
      listGlobal: (...args: unknown[]) => mockListGlobal(...args),
    },
    projects: {
      list: (...args: unknown[]) => mockProjectsList(...args),
    },
  },
}));

const defaultProjects = [
  { id: "proj-1", name: "Project Alpha", path: "/tmp/proj1" },
  { id: "proj-2", name: "Project Beta", path: "/tmp/proj2" },
];

beforeEach(() => {
  mockListGlobal.mockResolvedValue([]);
  mockProjectsList.mockResolvedValue(defaultProjects);
});

function renderGlobalNotificationBell(
  notifications: Array<{
    id: string;
    projectId: string;
    source: "plan" | "prd" | "execute" | "eval";
    sourceId: string;
    questions: Array<{ id: string; text: string; createdAt: string }>;
    status: "open" | "resolved";
    createdAt: string;
    resolvedAt: string | null;
  }> = [],
  projects = defaultProjects
) {
  mockListGlobal.mockResolvedValue(notifications);
  mockProjectsList.mockResolvedValue(projects);
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
        <GlobalNotificationBell />
      </MemoryRouter>
    </Provider>
  );
}

describe("GlobalNotificationBell", () => {
  it("renders nothing when no notifications", async () => {
    const { container } = renderGlobalNotificationBell([]);
    await waitFor(() => {
      expect(mockListGlobal).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("fetches global notifications and projects", async () => {
    renderGlobalNotificationBell([]);
    await waitFor(() => {
      expect(mockListGlobal).toHaveBeenCalled();
      expect(mockProjectsList).toHaveBeenCalled();
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
    renderGlobalNotificationBell(notifications);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 notification/ })).toBeInTheDocument();
    });
    expect(screen.getByTitle("Open questions")).toBeInTheDocument();
  });

  it("opens dropdown on click and shows project name with notification preview", async () => {
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
    renderGlobalNotificationBell(notifications);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 notification/ })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Open questions"));
    expect(screen.getByText(/Project Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Plan/)).toBeInTheDocument();
    expect(screen.getByText(/What is the scope of this feature/)).toBeInTheDocument();
  });

  it("shows project ID when project name is unknown", async () => {
    const notifications = [
      {
        id: "oq-1",
        projectId: "unknown-proj",
        source: "execute" as const,
        sourceId: "task-1",
        questions: [{ id: "q1", text: "Clarify task?", createdAt: "2025-01-01T00:00:00Z" }],
        status: "open" as const,
        createdAt: "2025-01-01T00:00:00Z",
        resolvedAt: null,
      },
    ];
    renderGlobalNotificationBell(notifications);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1 notification/ })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Open questions"));
    expect(screen.getByText(/unknown-proj/)).toBeInTheDocument();
    expect(screen.getByText(/Execute/)).toBeInTheDocument();
  });

  it("displays multiple notifications from different projects", async () => {
    const notifications = [
      {
        id: "oq-1",
        projectId: "proj-1",
        source: "plan" as const,
        sourceId: "plan-1",
        questions: [{ id: "q1", text: "Plan question?", createdAt: "2025-01-01T00:00:00Z" }],
        status: "open" as const,
        createdAt: "2025-01-01T00:00:00Z",
        resolvedAt: null,
      },
      {
        id: "oq-2",
        projectId: "proj-2",
        source: "eval" as const,
        sourceId: "fb-1",
        questions: [{ id: "q2", text: "Feedback question?", createdAt: "2025-01-01T01:00:00Z" }],
        status: "open" as const,
        createdAt: "2025-01-01T01:00:00Z",
        resolvedAt: null,
      },
    ];
    renderGlobalNotificationBell(notifications);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /2 notification/ })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Open questions"));
    expect(screen.getByText(/Project Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Project Beta/)).toBeInTheDocument();
    expect(screen.getByText(/Plan question/)).toBeInTheDocument();
    expect(screen.getByText(/Feedback question/)).toBeInTheDocument();
  });
});
