import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  renderWithProviders,
  wrapWithProviders,
  createTestStore,
  type RootState,
} from "../../test/test-utils";
import {
  EvalPhase,
  EVALUATE_FEEDBACK_FILTER_KEY,
  FEEDBACK_LOADING_DEBOUNCE_MS,
} from "./EvalPhase";
import { FEEDBACK_FORM_DRAFT_KEY_PREFIX } from "../../lib/feedbackFormStorage";
import { CONTENT_CONTAINER_CLASS } from "../../lib/constants";
import {
  taskUpdated,
  fetchTasks,
  fetchTasksByIds,
  toTasksByIdAndOrder,
} from "../../store/slices/executeSlice";
import { updateFeedbackItem } from "../../store/slices/evalSlice";
import type { ReactElement } from "react";
import type { FeedbackItem, Task } from "@opensprint/shared";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function render(ui: React.ReactElement) {
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

vi.mock("../../api/client", () => ({
  api: {
    feedback: {
      list: vi.fn().mockResolvedValue([]),
      submit: vi.fn().mockResolvedValue({
        id: "fb-new",
        text: "Test feedback",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
      }),
      resolve: vi.fn().mockImplementation((_projectId: string, feedbackId: string) =>
        Promise.resolve({
          id: feedbackId,
          text: "Resolved feedback",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "resolved",
          createdAt: new Date().toISOString(),
        })
      ),
      cancel: vi.fn().mockImplementation((_projectId: string, feedbackId: string) =>
        Promise.resolve({
          id: feedbackId,
          text: "Cancelled feedback",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "cancelled",
          createdAt: new Date().toISOString(),
        })
      ),
      recategorize: vi.fn().mockImplementation(
        (_projectId: string, feedbackId: string, answer?: string) =>
          Promise.resolve({
            id: feedbackId,
            text: answer ? `Feedback with answer: ${answer}` : "Recategorized feedback",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: new Date().toISOString(),
          })
      ),
    },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
      resolve: vi.fn().mockResolvedValue({ id: "oq-1", status: "resolved" }),
    },
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockImplementation((_projectId: string, taskId: string) =>
        Promise.resolve({
          id: taskId,
          title: `Task title for ${taskId}`,
          description: "",
          type: "task",
          status: "open",
          priority: 1,
          assignee: null,
          labels: [],
          dependencies: [],
          epicId: null,
          kanbanColumn: "backlog",
          createdAt: "",
          updatedAt: "",
        })
      ),
    },
  },
}));

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Fix login bug",
    description: "",
    type: "task",
    status: "open",
    priority: 0,
    assignee: null,
    labels: [],
    dependencies: [],
    epicId: null,
    kanbanColumn: "in_progress",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function createStore(overrides?: {
  evalFeedback?: FeedbackItem[];
  executeTasks?: Task[];
  feedbackLoading?: boolean;
}) {
  const preloadedState: Partial<RootState> = {
    project: {
      data: {
        id: "proj-1",
        name: "Test Project",
        repoPath: "/tmp/test",
        currentPhase: "eval",
        createdAt: "",
        updatedAt: "",
      },
      loading: false,
      error: null,
    },
  };
  if (overrides?.evalFeedback !== undefined || overrides?.feedbackLoading) {
    preloadedState.eval = {
      feedback: overrides?.evalFeedback ?? [],
      feedbackItemCache: {},
      feedbackItemErrorId: null,
      feedbackItemLoadingId: null,
      async: {
        feedback: { loading: overrides?.feedbackLoading ?? false, error: null },
        submit: { loading: false, error: null },
        feedbackItem: { loading: false, error: null },
      },
      error: null,
    };
  }
  if (overrides?.executeTasks !== undefined) {
    preloadedState.execute = {
      ...toTasksByIdAndOrder(overrides.executeTasks),
      tasksInFlightCount: 0,
      orchestratorRunning: false,
      awaitingApproval: false,
      activeTasks: [],
      activeAgents: [],
      activeAgentsLoadedOnce: false,
      taskIdToStartedAt: {},
      totalDone: 0,
      totalFailed: 0,
      queueDepth: 0,
      selectedTaskId: null,
      agentOutput: {},
      completionState: null,
      archivedSessions: [],
      async: {
        tasks: { loading: false, error: null },
        status: { loading: false, error: null },
        taskDetail: { loading: false, error: null },
        archived: { loading: false, error: null },
        markDone: { loading: false, error: null },
        unblock: { loading: false, error: null },
        activeAgents: { loading: false, error: null },
      },
      error: null,
    };
  }
  return createTestStore(preloadedState);
}

const mockFeedbackItems: FeedbackItem[] = [
  {
    id: "fb-1",
    text: "Bug 1",
    category: "bug",
    mappedPlanId: null,
    createdTaskIds: [],
    status: "pending",
    createdAt: "2024-01-01T00:00:01Z",
  },
  {
    id: "fb-2",
    text: "Bug 2",
    category: "bug",
    mappedPlanId: null,
    createdTaskIds: [],
    status: "pending",
    createdAt: "2024-01-01T00:00:02Z",
  },
  {
    id: "fb-3",
    text: "Bug 3",
    category: "bug",
    mappedPlanId: "auth-plan",
    createdTaskIds: [],
    status: "pending",
    createdAt: "2024-01-01T00:00:03Z",
  },
  {
    id: "fb-4",
    text: "Bug 4",
    category: "bug",
    mappedPlanId: "auth-plan",
    createdTaskIds: [],
    status: "pending",
    createdAt: "2024-01-01T00:00:04Z",
  },
  {
    id: "fb-5",
    text: "Bug 5",
    category: "bug",
    mappedPlanId: "auth-plan",
    createdTaskIds: [],
    status: "pending",
    createdAt: "2024-01-01T00:00:05Z",
  },
  {
    id: "fb-6",
    text: "Bug 6",
    category: "bug",
    mappedPlanId: null,
    createdTaskIds: [],
    status: "resolved",
    createdAt: "2024-01-01T00:00:06Z",
  },
];

/** Same as mockFeedbackItems but with one cancelled item (Bug 7). */
const mockFeedbackWithCancelled: FeedbackItem[] = [
  ...mockFeedbackItems,
  {
    id: "fb-7",
    text: "Bug 7",
    category: "bug",
    mappedPlanId: null,
    createdTaskIds: [],
    status: "cancelled",
    createdAt: "2024-01-01T00:00:07Z",
  },
];

describe("EvalPhase feedback loading state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading spinner when fetch takes longer than debounce threshold", async () => {
    vi.useFakeTimers();
    const store = createStore({ evalFeedback: [], feedbackLoading: true });
    render(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );
    expect(screen.queryByTestId("feedback-loading-spinner")).not.toBeInTheDocument();
    await act(() => {
      vi.advanceTimersByTime(FEEDBACK_LOADING_DEBOUNCE_MS);
    });
    expect(screen.getByTestId("feedback-loading-spinner")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /Loading feedback/i })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("does not show spinner when response is fast (no flicker)", () => {
    vi.useFakeTimers();
    const store = createStore({ evalFeedback: [], feedbackLoading: true });
    render(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );
    vi.advanceTimersByTime(FEEDBACK_LOADING_DEBOUNCE_MS - 1);
    expect(screen.queryByTestId("feedback-loading-spinner")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows empty state only after fetch completes with no feedback", () => {
    const store = createStore({ evalFeedback: [] });
    render(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );
    expect(screen.getByText(/No feedback submitted yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("feedback-loading-spinner")).not.toBeInTheDocument();
  });
});

describe("EvalPhase feedback form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("feedback content uses CONTENT_CONTAINER_CLASS", () => {
    const store = createStore();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );
    const content = screen.getByTestId("eval-feedback-content");
    for (const cls of CONTENT_CONTAINER_CLASS.split(" ")) {
      expect(content).toHaveClass(cls);
    }
  });

  it("focuses feedback input when Evaluate tab activates", async () => {
    const store = createStore();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      const input = screen.getByTestId("eval-feedback-input");
      expect(document.activeElement).toBe(input);
    });
  });

  it("refocuses feedback input after submitting new feedback via Submit button", async () => {
    const { api } = await import("../../api/client");
    vi.mocked(api.feedback.submit).mockResolvedValue({
      id: "fb-new",
      text: "Test feedback",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    const store = createStore();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const input = screen.getByTestId("eval-feedback-input");
    await user.type(input, "Some feedback");
    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it("refocuses feedback input after submitting new feedback via Enter key", async () => {
    const { api } = await import("../../api/client");
    vi.mocked(api.feedback.submit).mockResolvedValue({
      id: "fb-new",
      text: "Test feedback",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    const store = createStore();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const input = screen.getByTestId("eval-feedback-input");
    await user.type(input, "Some feedback{Enter}");

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it("renders priority dropdown with placeholder and options", async () => {
    const store = createStore();
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      expect(screen.getByTestId("feedback-priority-select")).toBeInTheDocument();
    });

    const trigger = screen.getByTestId("feedback-priority-select");
    expect(trigger).toHaveAttribute("aria-label", "Priority (optional)");
    expect(trigger).toHaveClass("input");
    expect(trigger).toHaveClass("h-10");

    await user.click(trigger);

    // Placeholder / clear option
    expect(screen.getByTestId("feedback-priority-option-clear")).toHaveTextContent("No priority");
    // Priority options with icons
    expect(screen.getByTestId("feedback-priority-option-0")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-priority-option-1")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-priority-option-2")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-priority-option-3")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-priority-option-4")).toBeInTheDocument();
  });

  it("closes priority dropdown on Escape key", async () => {
    const store = createStore();
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      expect(screen.getByTestId("feedback-priority-select")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("feedback-priority-select"));
    expect(screen.getByTestId("feedback-priority-dropdown")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("feedback-priority-dropdown")).not.toBeInTheDocument();
  });

  it("passes selected priority when submitting feedback", async () => {
    const { api } = await import("../../api/client");
    const store = createStore();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Describe a bug/), "Critical auth bug");
    await user.click(screen.getByTestId("feedback-priority-select"));
    await user.click(screen.getByTestId("feedback-priority-option-0"));
    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(api.feedback.submit).toHaveBeenCalledWith(
        "proj-1",
        "Critical auth bug",
        undefined,
        undefined,
        0
      );
    });
  });

  it("clears priority after submission", async () => {
    const { api } = await import("../../api/client");
    vi.mocked(api.feedback.submit).mockResolvedValue({
      id: "fb-new",
      text: "Test feedback",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    const store = createStore();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Describe a bug/), "Some feedback");
    await user.click(screen.getByTestId("feedback-priority-select"));
    await user.click(screen.getByTestId("feedback-priority-option-2"));
    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(api.feedback.submit).toHaveBeenCalled();
    });

    // After submission, input and priority should be cleared
    const trigger = screen.getByTestId("feedback-priority-select");
    expect(trigger).toHaveTextContent("Priority (optional)");
    expect(screen.getByPlaceholderText(/Describe a bug/)).toHaveValue("");
  });

  it("omits priority from submission when none selected", async () => {
    const { api } = await import("../../api/client");
    const store = createStore();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Describe a bug/), "Feedback without priority");
    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(api.feedback.submit).toHaveBeenCalledWith(
        "proj-1",
        "Feedback without priority",
        undefined,
        undefined,
        undefined
      );
    });
  });

  it("disables priority dropdown while submitting", async () => {
    const { api } = await import("../../api/client");
    let resolveSubmit: (value: unknown) => void;
    vi.mocked(api.feedback.submit).mockImplementation(
      () =>
        new Promise((r) => {
          resolveSubmit = r;
        })
    );

    const store = createStore();
    renderWithProviders(
      <MemoryRouter>
        <EvalPhase projectId="proj-1" />
      </MemoryRouter>,
      { store }
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/Describe a bug/), "Test feedback");
    await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

    await waitFor(() => {
      expect(screen.getByTestId("feedback-priority-select")).toBeDisabled();
    });

    resolveSubmit!({
      id: "fb-new",
      text: "Test feedback",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("feedback-priority-select")).not.toBeDisabled();
    });
  });

  describe("open questions (Analyst clarification)", () => {
    const openQuestionNotification = {
      id: "oq-1",
      projectId: "proj-1",
      source: "eval" as const,
      sourceId: "fb-1",
      questions: [
        { id: "q1", text: "Which screen does this happen on?", createdAt: "2024-01-01T00:00:00Z" },
      ],
      status: "open" as const,
      createdAt: "2024-01-01T00:00:00Z",
      resolvedAt: null,
    };

    it("renders open questions when notification exists for feedback", async () => {
      const { api } = await import("../../api/client");
      vi.mocked(api.notifications.listByProject).mockResolvedValue([openQuestionNotification]);

      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-open-questions")).toBeInTheDocument();
      });

      expect(screen.getByText(/The Analyst needs clarification before categorizing/)).toBeInTheDocument();
      expect(screen.getByText("Which screen does this happen on?")).toBeInTheDocument();
      expect(screen.getByTestId("feedback-answer-input")).toBeInTheDocument();
      expect(screen.getByTestId("feedback-answer-submit")).toBeInTheDocument();
      expect(screen.getByTestId("feedback-dismiss-question")).toBeInTheDocument();
    });

    it("Answer button resolves notification and recategorizes with answer", async () => {
      const { api } = await import("../../api/client");
      vi.mocked(api.notifications.listByProject).mockResolvedValue([openQuestionNotification]);

      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-open-questions")).toBeInTheDocument();
      });

      const answerInput = screen.getByTestId("feedback-answer-input");
      await user.type(answerInput, "Login screen");
      await user.click(screen.getByTestId("feedback-answer-submit"));

      await waitFor(() => {
        expect(api.notifications.resolve).toHaveBeenCalledWith("proj-1", "oq-1");
      });
      expect(api.feedback.recategorize).toHaveBeenCalledWith("proj-1", "fb-1", "Login screen");
    });

    it("Dismiss button resolves notification without recategorizing", async () => {
      const { api } = await import("../../api/client");
      vi.mocked(api.notifications.listByProject).mockResolvedValue([openQuestionNotification]);

      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-open-questions")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("feedback-dismiss-question"));

      await waitFor(() => {
        expect(api.notifications.resolve).toHaveBeenCalledWith("proj-1", "oq-1");
      });
      expect(api.feedback.recategorize).not.toHaveBeenCalled();
    });
  });

  describe("feedback form draft persistence (localStorage)", () => {
    const DRAFT_KEY = `${FEEDBACK_FORM_DRAFT_KEY_PREFIX}-proj-1`;

    beforeEach(() => {
      localStorage.removeItem(DRAFT_KEY);
    });

    it("restores text and priority from localStorage on mount", async () => {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ text: "Draft feedback text", images: [], priority: 2 })
      );

      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
      });

      const textarea = screen.getByPlaceholderText(/Describe a bug/);
      expect(textarea).toHaveValue("Draft feedback text");

      await userEvent.setup().click(screen.getByTestId("feedback-priority-select"));
      expect(screen.getByTestId("feedback-priority-option-2")).toHaveClass("font-medium");
    });

    it("persists text to localStorage on change", async () => {
      const store = createStore();
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/Describe a bug/), "Typed feedback");
      const stored = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
      expect(stored.text).toBe("Typed feedback");
    });

    it("persists priority to localStorage when selected", async () => {
      const store = createStore();
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-priority-select")).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/Describe a bug/), "x");
      await user.click(screen.getByTestId("feedback-priority-select"));
      await user.click(screen.getByTestId("feedback-priority-option-1"));
      const stored = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
      expect(stored.priority).toBe(1);
    });

    it("clears localStorage when feedback is successfully submitted", async () => {
      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.submit).mockResolvedValue({
        id: "fb-new",
        text: "Submitted feedback",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
      });

      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ text: "Draft before submit", images: [], priority: 0 })
      );

      const store = createStore();
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe a bug/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Submit Feedback/i }));

      await waitFor(() => {
        expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
      });
    });
  });

  describe("feedback form control heights", () => {
    it("applies consistent h-10 height to priority select and both buttons", async () => {
      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-priority-select")).toBeInTheDocument();
      });

      const prioritySelect = screen.getByTestId("feedback-priority-select");
      const attachButton = screen.getByRole("button", { name: /Attach image/i });
      const submitButton = screen.getByRole("button", { name: /Submit Feedback/i });

      expect(prioritySelect).toHaveClass("h-10");
      expect(prioritySelect).toHaveClass("min-h-10");
      expect(attachButton).toHaveClass("h-10");
      expect(submitButton).toHaveClass("h-10");
    });

    it("priority select has equal left and right padding", async () => {
      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-priority-select")).toBeInTheDocument();
      });

      const prioritySelect = screen.getByTestId("feedback-priority-select");
      expect(prioritySelect).toHaveClass("px-3");
    });

    it("status filter select has chevron right padding (pl-3, pr from select.input)", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      const statusFilter = screen.getByTestId("feedback-status-filter");
      expect(statusFilter).toHaveClass("input");
      expect(statusFilter).toHaveClass("pl-3");
    });

    it("actions row uses items-stretch so all controls share the same height", async () => {
      const store = createStore();
      const { container } = renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-priority-select")).toBeInTheDocument();
      });

      const actionsRow = container.querySelector('[data-testid="feedback-priority-select"]')
        ?.parentElement?.parentElement;
      expect(actionsRow).toBeTruthy();
      expect(actionsRow).toHaveClass("items-stretch");
    });

    it("actions row has flex-wrap to prevent overflow at narrow viewports", async () => {
      const store = createStore();
      const { container } = renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-priority-select")).toBeInTheDocument();
      });

      const actionsRow = container.querySelector('[data-testid="feedback-priority-select"]')
        ?.parentElement?.parentElement;
      expect(actionsRow).toBeTruthy();
      expect(actionsRow).toHaveClass("flex-wrap");
    });

    it("reply form applies consistent h-10 height to Cancel, Attach, and Submit buttons", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Bug 1")).toBeInTheDocument());
      const bug1Card = screen.getByText("Bug 1").closest(".card");
      await user.click(within(bug1Card!).getByRole("button", { name: /^Reply$/ }));
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Write a reply...")).toBeInTheDocument();
      });

      const replyForm = screen.getByPlaceholderText("Write a reply...").closest(".card");
      const cancelButton = within(replyForm!).getByRole("button", { name: /^Cancel$/ });
      const attachButton = within(replyForm!).getByTestId("reply-attach-images");
      const submitButton = within(replyForm!).getByRole("button", { name: /^Submit$/ });

      expect(cancelButton).toHaveClass("h-10");
      expect(attachButton).toHaveClass("h-10");
      expect(submitButton).toHaveClass("h-10");
    });
  });

  describe("Submit Feedback button tooltip", () => {
    const originalNavigator = global.navigator;

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.stubGlobal("navigator", { ...originalNavigator });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.stubGlobal("navigator", originalNavigator);
    });

    it("shows Enter or Cmd + Enter tooltip on macOS after hover delay", async () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      });

      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Submit Feedback/i })).toBeInTheDocument();
      });

      const submitButton = screen.getByRole("button", { name: /Submit Feedback/i });
      await userEvent.hover(submitButton);
      await waitFor(
        () => {
          const tooltip = screen.getByRole("tooltip");
          expect(tooltip).toHaveTextContent("Enter or Cmd + Enter to submit");
          expect(tooltip).toHaveTextContent("Shift+Enter for new line");
        },
        { timeout: 500 }
      );
    });

    it("shows Enter or Ctrl + Enter tooltip on Windows after hover delay", async () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      });

      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Submit Feedback/i })).toBeInTheDocument();
      });

      const submitButton = screen.getByRole("button", { name: /Submit Feedback/i });
      await userEvent.hover(submitButton);
      await waitFor(
        () => {
          const tooltip = screen.getByRole("tooltip");
          expect(tooltip).toHaveTextContent("Enter or Ctrl + Enter to submit");
          expect(tooltip).toHaveTextContent("Shift+Enter for new line");
        },
        { timeout: 500 }
      );
    });

    it("dismisses tooltip when cursor leaves button", async () => {
      vi.stubGlobal("navigator", {
        ...originalNavigator,
        platform: "Win32",
        userAgent: "Mozilla/5.0",
      });

      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Submit Feedback/i })).toBeInTheDocument();
      });

      const submitButton = screen.getByRole("button", { name: /Submit Feedback/i });
      await userEvent.hover(submitButton);
      await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument(), {
        timeout: 500,
      });

      await userEvent.unhover(submitButton);
      await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(), {
        timeout: 200,
      });
    });
  });

  describe("Attach image button tooltip", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows Attach image(s) tooltip on main feedback form after hover delay", async () => {
      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-attach-image")).toBeInTheDocument();
      });

      const attachButton = screen.getByRole("button", { name: /Attach image/i });
      await userEvent.hover(attachButton);
      act(() => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const tooltip = screen.getByRole("tooltip");
        expect(tooltip).toHaveTextContent("Attach image(s)");
      });
    });

    it("dismisses attach image tooltip when cursor leaves button", async () => {
      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-attach-image")).toBeInTheDocument();
      });

      const attachButton = screen.getByRole("button", { name: /Attach image/i });
      await userEvent.hover(attachButton);
      act(() => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());

      await userEvent.unhover(attachButton);

      await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    });

    it("dismisses attach image tooltip on Escape key", async () => {
      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-attach-image")).toBeInTheDocument();
      });

      const attachButton = screen.getByRole("button", { name: /Attach image/i });
      await userEvent.hover(attachButton);
      act(() => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());

      await userEvent.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    });

    it("shows Attach image(s) tooltip on reply form after hover delay", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Bug 1")).toBeInTheDocument());
      const bug1Card = screen.getByText("Bug 1").closest(".card");
      await user.click(within(bug1Card!).getByRole("button", { name: /^Reply$/ }));
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Write a reply...")).toBeInTheDocument();
      });

      const attachButton = screen.getByTestId("reply-attach-images");
      await user.hover(attachButton);
      act(() => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const tooltip = screen.getByRole("tooltip");
        expect(tooltip).toHaveTextContent("Attach image(s)");
      });
    });

    it("shows Submit keyboard shortcut tooltip on reply form after hover delay", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Bug 1")).toBeInTheDocument());
      const bug1Card = screen.getByText("Bug 1").closest(".card");
      await user.click(within(bug1Card!).getByRole("button", { name: /^Reply$/ }));
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Write a reply...")).toBeInTheDocument();
      });

      const replyForm = screen.getByPlaceholderText("Write a reply...").closest(".card");
      const submitButton = within(replyForm!).getByRole("button", { name: /^Submit$/ });
      await user.hover(submitButton);
      act(() => {
        vi.advanceTimersByTime(300);
      });

      await waitFor(() => {
        const tooltip = screen.getByRole("tooltip");
        expect(tooltip).toHaveTextContent(/Enter or (Cmd|Ctrl) \+ Enter to submit/);
      });
    });
  });

  describe("feedback status filter", () => {
    beforeEach(() => {
      localStorage.removeItem(EVALUATE_FEEDBACK_FILTER_KEY);
    });

    it("defaults to Pending when no localStorage key exists", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      expect(filterSelect.value).toBe("pending");
    });

    it("title does not display a count", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Feedback History" })).toBeInTheDocument();
      });

      const heading = screen.getByRole("heading", { name: "Feedback History" });
      expect(heading.textContent).toBe("Feedback History");
      expect(heading.textContent).not.toMatch(/\(\d+\)/);
    });

    it("each dropdown option displays its count (All, Pending = pending+mapped, Resolved)", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      expect(screen.getByRole("option", { name: "All (6)" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Pending (5)" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Resolved (1)" })).toBeInTheDocument();
    });

    it("dropdown shows All first, then Pending and Resolved options", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      const options = Array.from(filterSelect.options).map((o) => o.value);
      expect(options).toEqual(["all", "pending", "resolved"]);
    });

    it("writes filter selection to localStorage on change", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      expect(localStorage.getItem(EVALUATE_FEEDBACK_FILTER_KEY)).toBeNull();

      await user.selectOptions(screen.getByTestId("feedback-status-filter"), "all");
      expect(localStorage.getItem(EVALUATE_FEEDBACK_FILTER_KEY)).toBe("all");

      await user.selectOptions(screen.getByTestId("feedback-status-filter"), "resolved");
      expect(localStorage.getItem(EVALUATE_FEEDBACK_FILTER_KEY)).toBe("resolved");

      await user.selectOptions(screen.getByTestId("feedback-status-filter"), "pending");
      expect(localStorage.getItem(EVALUATE_FEEDBACK_FILTER_KEY)).toBe("pending");
    });

    it("restores previously selected filter from localStorage on mount", async () => {
      localStorage.setItem(EVALUATE_FEEDBACK_FILTER_KEY, "resolved");

      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      expect(filterSelect.value).toBe("resolved");
    });

    it("restores 'all' from localStorage when present", async () => {
      localStorage.setItem(EVALUATE_FEEDBACK_FILTER_KEY, "all");

      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      expect(filterSelect.value).toBe("all");
    });

    it("treats invalid filter value as Pending", async () => {
      localStorage.setItem(EVALUATE_FEEDBACK_FILTER_KEY, "mapped");

      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      expect(filterSelect.value).toBe("pending");
    });

    it("falls back to Pending when localStorage has invalid value", async () => {
      localStorage.setItem(EVALUATE_FEEDBACK_FILTER_KEY, "invalid");

      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument();
      });

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      expect(filterSelect.value).toBe("pending");
    });

    it("Pending filter shows both pending and mapped items", async () => {
      localStorage.setItem(EVALUATE_FEEDBACK_FILTER_KEY, "pending");
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      expect(filterSelect.value).toBe("pending");

      // Pending filter shows 5 items: 2 pending + 3 mapped
      expect(screen.getByText("Bug 1")).toBeInTheDocument();
      expect(screen.getByText("Bug 2")).toBeInTheDocument();
      expect(screen.getByText("Bug 3")).toBeInTheDocument();
      expect(screen.getByText("Bug 4")).toBeInTheDocument();
      expect(screen.getByText("Bug 5")).toBeInTheDocument();
      expect(screen.queryByText("Bug 6")).not.toBeInTheDocument();
    });

    it("All filter shows all feedback items", async () => {
      localStorage.setItem(EVALUATE_FEEDBACK_FILTER_KEY, "all");
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      expect(filterSelect.value).toBe("all");

      // All filter shows all 6 items (2 pending + 3 mapped + 1 resolved)
      expect(screen.getByText("Bug 1")).toBeInTheDocument();
      expect(screen.getByText("Bug 2")).toBeInTheDocument();
      expect(screen.getByText("Bug 3")).toBeInTheDocument();
      expect(screen.getByText("Bug 4")).toBeInTheDocument();
      expect(screen.getByText("Bug 5")).toBeInTheDocument();
      expect(screen.getByText("Bug 6")).toBeInTheDocument();
    });

    it("Resolved filter shows only resolved items", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      await user.selectOptions(screen.getByTestId("feedback-status-filter"), "resolved");

      expect(screen.getByText("Bug 6")).toBeInTheDocument();
      expect(screen.queryByText("Bug 1")).not.toBeInTheDocument();
      expect(screen.queryByText("Bug 3")).not.toBeInTheDocument();
    });

    it("does not show Cancelled option when no feedback has status cancelled", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      const options = Array.from(filterSelect.options).map((o) => o.value);
      expect(options).toEqual(["all", "pending", "resolved"]);
      expect(options).not.toContain("cancelled");
    });

    it("shows Cancelled option when at least one feedback has status cancelled", async () => {
      const store = createStore({ evalFeedback: mockFeedbackWithCancelled });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      expect(screen.getByRole("option", { name: "Cancelled (1)" })).toBeInTheDocument();
      const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
      const options = Array.from(filterSelect.options).map((o) => o.value);
      expect(options).toContain("cancelled");
    });

    it("Cancelled filter shows only cancelled items", async () => {
      const store = createStore({ evalFeedback: mockFeedbackWithCancelled });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      await user.selectOptions(screen.getByTestId("feedback-status-filter"), "cancelled");

      expect(screen.getByText("Bug 7")).toBeInTheDocument();
      expect(screen.queryByText("Bug 6")).not.toBeInTheDocument();
      expect(screen.queryByText("Bug 1")).not.toBeInTheDocument();
    });

    it("Resolved filter excludes cancelled items", async () => {
      const store = createStore({ evalFeedback: mockFeedbackWithCancelled });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      await user.selectOptions(screen.getByTestId("feedback-status-filter"), "resolved");

      expect(screen.getByText("Bug 6")).toBeInTheDocument();
      expect(screen.queryByText("Bug 7")).not.toBeInTheDocument();
    });

    it("resets to Pending when cancelled is selected but no cancelled items exist", async () => {
      const store = createStore({ evalFeedback: mockFeedbackWithCancelled });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());
      await user.selectOptions(screen.getByTestId("feedback-status-filter"), "cancelled");

      // Simulate feedback changing: cancelled item gets resolved (e.g. via WebSocket update)
      act(() => {
        store.dispatch(
          updateFeedbackItem({ ...mockFeedbackWithCancelled[6], status: "resolved" })
        );
      });

      await waitFor(() => {
        const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
        expect(filterSelect.value).toBe("pending");
      });
    });

    it("writes and restores cancelled filter to localStorage", async () => {
      const store = createStore({ evalFeedback: mockFeedbackWithCancelled });
      const user = userEvent.setup();
      const { rerender } = renderWithProviders(
        <MemoryRouter>
          <EvalPhase key="first" projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      await user.selectOptions(screen.getByTestId("feedback-status-filter"), "cancelled");
      expect(localStorage.getItem(EVALUATE_FEEDBACK_FILTER_KEY)).toBe("cancelled");

      // Re-mount with new key to force fresh mount and verify restore from localStorage
      rerender(
        wrapWithProviders(
          <MemoryRouter>
            <EvalPhase key="second" projectId="proj-1" />
          </MemoryRouter>,
          { store }
        )
      );

      await waitFor(() => {
        const filterSelect = screen.getByTestId("feedback-status-filter") as HTMLSelectElement;
        expect(filterSelect.value).toBe("cancelled");
      });
    });

    it("default Pending filter shows both pending and mapped items on first load", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("feedback-status-filter")).toBeInTheDocument());

      // Default is Pending, shows 5 items (2 pending + 3 mapped)
      expect(screen.getByText("Bug 1")).toBeInTheDocument();
      expect(screen.getByText("Bug 2")).toBeInTheDocument();
      expect(screen.getByText("Bug 3")).toBeInTheDocument();
      expect(screen.getByText("Bug 4")).toBeInTheDocument();
      expect(screen.getByText("Bug 5")).toBeInTheDocument();
      expect(screen.queryByText("Bug 6")).not.toBeInTheDocument();
    });
  });

  describe("collapse button total reply count", () => {
    it("shows total count including nested replies for direct children only", async () => {
      const feedbackWithReplies: FeedbackItem[] = [
        {
          id: "fb-parent",
          text: "Parent feedback",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          id: "fb-reply-1",
          text: "Reply 1",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:02Z",
          parent_id: "fb-parent",
        },
        {
          id: "fb-reply-2",
          text: "Reply 2",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:03Z",
          parent_id: "fb-reply-1",
        },
      ];
      const store = createStore({ evalFeedback: feedbackWithReplies });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Parent feedback")).toBeInTheDocument());

      // Parent has 2 total replies (reply-1 + reply-2 nested under reply-1)
      const collapseBtn = screen.getByTestId("collapse-replies-fb-parent");
      expect(collapseBtn).toHaveTextContent("Collapse (2 replies)");
    });

    it("shows total count for arbitrary nesting depth", async () => {
      const feedbackDeepNesting: FeedbackItem[] = [
        {
          id: "fb-root",
          text: "Root",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          id: "fb-a",
          text: "A",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:02Z",
          parent_id: "fb-root",
        },
        {
          id: "fb-b",
          text: "B",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:03Z",
          parent_id: "fb-a",
        },
        {
          id: "fb-c",
          text: "C",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:04Z",
          parent_id: "fb-b",
        },
      ];
      const store = createStore({ evalFeedback: feedbackDeepNesting });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Root")).toBeInTheDocument());

      // Root has 3 total replies (A, B, C)
      const collapseBtn = screen.getByTestId("collapse-replies-fb-root");
      expect(collapseBtn).toHaveTextContent("Collapse (3 replies)");
    });

    it("shows singular 'reply' when count is 1", async () => {
      const feedbackSingleReply: FeedbackItem[] = [
        {
          id: "fb-parent",
          text: "Parent",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          id: "fb-reply",
          text: "Only reply",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:02Z",
          parent_id: "fb-parent",
        },
      ];
      const store = createStore({ evalFeedback: feedbackSingleReply });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Parent")).toBeInTheDocument());

      const collapseBtn = screen.getByTestId("collapse-replies-fb-parent");
      expect(collapseBtn).toHaveTextContent("Collapse (1 reply)");
    });

    it("count updates when replies are added via Redux", async () => {
      const initialFeedback: FeedbackItem[] = [
        {
          id: "fb-parent",
          text: "Parent",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          id: "fb-reply-1",
          text: "Reply 1",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:02Z",
          parent_id: "fb-parent",
        },
      ];
      const store = createStore({ evalFeedback: initialFeedback });
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Parent")).toBeInTheDocument());
      expect(screen.getByTestId("collapse-replies-fb-parent")).toHaveTextContent("Collapse (1 reply)");

      // Add a nested reply via Redux (simulates WebSocket feedback.updated)
      const newReply: FeedbackItem = {
        id: "fb-reply-2",
        text: "Reply 2",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: "2024-01-01T00:00:03Z",
        parent_id: "fb-reply-1",
      };
      act(() => {
        store.dispatch(updateFeedbackItem(newReply));
      });

      await waitFor(() => {
        expect(screen.getByTestId("collapse-replies-fb-parent")).toHaveTextContent(
          "Collapse (2 replies)"
        );
      });
    });
  });

  describe("feedback card task chips", () => {
    it("shows priority icon in each created-task chip", async () => {
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Auth bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1", "task-2"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [
        createMockTask({ id: "task-1", priority: 0 }),
        createMockTask({ id: "task-2", priority: 2 }),
      ];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      // PriorityIcon uses role="img" and aria-label for each priority level
      expect(screen.getByRole("img", { name: "Critical" })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Medium" })).toBeInTheDocument();
    });

    it("defaults to High icon when task not found in state", async () => {
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Orphan task",
          category: "feature",
          mappedPlanId: null,
          createdTaskIds: ["unknown-task-id"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks: [],
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      // Unknown task defaults to priority 1 (High)
      expect(screen.getByRole("img", { name: "High" })).toBeInTheDocument();
    });

    it("shows task title as link text instead of task ID when task is in execute state", async () => {
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Auth bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [
        createMockTask({ id: "task-1", title: "Fix login button styling" }),
      ];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      expect(screen.getByText("Fix login button styling")).toBeInTheDocument();
      expect(screen.queryByText("task-1")).not.toBeInTheDocument();
    });

    it("truncates task title to 30 characters with ellipsis when longer", async () => {
      const longTitle = "This is a very long task title that exceeds thirty characters";
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Feature request",
          category: "feature",
          mappedPlanId: null,
          createdTaskIds: ["task-long"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [createMockTask({ id: "task-long", title: longTitle })];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      expect(screen.getByText("This is a very long task title…")).toBeInTheDocument();
      expect(screen.queryByText(longTitle)).not.toBeInTheDocument();
    });

    it("shows tooltip with full title on hover (including when link is truncated)", async () => {
      const longTitle = "This is a very long task title that exceeds thirty characters";
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Feature request",
          category: "feature",
          mappedPlanId: null,
          createdTaskIds: ["task-long"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [createMockTask({ id: "task-long", title: longTitle })];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      const link = screen.getByText("This is a very long task title…");
      const user = userEvent.setup();
      await user.hover(link);

      await waitFor(
        () => {
          expect(screen.getByRole("tooltip")).toBeInTheDocument();
          expect(screen.getByRole("tooltip")).toHaveTextContent(longTitle);
        },
        { timeout: 500 }
      );
    });

    it("shows tooltip with full title on hover", async () => {
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Auth bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [createMockTask({ id: "task-1" })];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      const link = screen.getByText("Fix login bug");
      const user = userEvent.setup();
      await user.hover(link);

      await waitFor(
        () => {
          expect(screen.getByRole("tooltip")).toBeInTheDocument();
          expect(screen.getByRole("tooltip")).toHaveTextContent("Fix login bug");
        },
        { timeout: 500 }
      );
    });

    it("updates only the affected feedback card when Analyst creates ticket (incremental update)", async () => {
      const feedbackWithTwoItems: FeedbackItem[] = [
        {
          id: "fb-a",
          text: "First bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          id: "fb-b",
          text: "Second bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:02Z",
        },
      ];
      const executeTasks: Task[] = [
        createMockTask({ id: "task-new", title: "Fix first bug", priority: 1 }),
      ];
      const store = createStore({
        evalFeedback: feedbackWithTwoItems,
        executeTasks,
      });

      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.list).mockClear();

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByText("First bug")).toBeInTheDocument();
        expect(screen.getByText("Second bug")).toBeInTheDocument();
      });

      // Initially neither card has ticket chips
      expect(screen.queryByTestId("feedback-card-ticket-info")).not.toBeInTheDocument();

      // Simulate Analyst creating ticket for fb-a (via WebSocket feedback.updated → updateFeedbackItem)
      await act(async () => {
        store.dispatch(
          updateFeedbackItem({
            ...feedbackWithTwoItems[0],
            createdTaskIds: ["task-new"],
            mappedPlanId: "plan-1",
          })
        );
      });

      // Only fb-a's card should show the ticket chip; fb-b unchanged
      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
        expect(screen.getByText("Fix first bug")).toBeInTheDocument();
      });
      expect(screen.getByText("First bug")).toBeInTheDocument();
      expect(screen.getByText("Second bug")).toBeInTheDocument();
      // No full page refresh — feedback.list not called
      expect(api.feedback.list).not.toHaveBeenCalled();
    });

    it("shows created task on feedback card after fetchTasksByIds completes (live update flow)", async () => {
      const feedbackItem: FeedbackItem = {
        id: "2f8lu1",
        text: "Login button is broken",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: "2024-01-01T00:00:01Z",
      };
      const store = createStore({
        evalFeedback: [feedbackItem],
        executeTasks: [],
      });

      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.list).mockClear();
      vi.mocked(api.tasks.get).mockResolvedValue({
        id: "os-abc1",
        title: "Fix login button",
        description: "",
        type: "task",
        status: "open",
        priority: 1,
        assignee: null,
        labels: [],
        dependencies: [],
        epicId: null,
        kanbanColumn: "backlog",
        createdAt: "",
        updatedAt: "",
      } as Task);

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByText("Login button is broken")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("feedback-card-ticket-info")).not.toBeInTheDocument();

      // Simulate WebSocket feedback.updated (updateFeedbackItem + fetchTasksByIds)
      await act(async () => {
        store.dispatch(
          updateFeedbackItem({
            ...feedbackItem,
            createdTaskIds: ["os-abc1"],
            mappedPlanId: "plan-1",
          })
        );
      });

      // Chip appears immediately (shows taskId or title once fetch completes)
      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      // fetchTasksByIds fetches the task; chip shows title when it arrives
      await act(async () => {
        await store.dispatch(fetchTasksByIds({ projectId: "proj-1", taskIds: ["os-abc1"] }));
      });

      expect(screen.getByText("Fix login button")).toBeInTheDocument();
      expect(api.feedback.list).not.toHaveBeenCalled();
    });

    it("updates category badge when Analyst categorizes (bug→feature) without full refetch", async () => {
      const feedbackWithOneItem: FeedbackItem[] = [
        {
          id: "fb-cat",
          text: "Add dark mode",
          category: "bug",
          mappedPlanId: "plan-1",
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const store = createStore({ evalFeedback: feedbackWithOneItem });

      const { api } = await import("../../api/client");
      vi.mocked(api.feedback.list).mockClear();

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByText("Add dark mode")).toBeInTheDocument();
        expect(screen.getByText("Bug")).toBeInTheDocument();
      });

      // Simulate Analyst recategorizing as feature (via WebSocket feedback.updated → updateFeedbackItem)
      await act(async () => {
        store.dispatch(
          updateFeedbackItem({
            ...feedbackWithOneItem[0],
            category: "feature",
            mappedPlanId: "plan-1",
          })
        );
      });

      // Card should show Feature badge, not Bug
      await waitFor(() => {
        expect(screen.getByText("Feature")).toBeInTheDocument();
        expect(screen.queryByText("Bug")).not.toBeInTheDocument();
      });
      expect(screen.getByText("Add dark mode")).toBeInTheDocument();
      // No full page refresh — feedback.list not called
      expect(api.feedback.list).not.toHaveBeenCalled();
    });

    it("preserves scroll position when clicking Resolve", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Bug 3")).toBeInTheDocument());

      const scrollContainer = screen.getByTestId("eval-feedback-feed-scroll");
      const scrollPosition = 200;
      scrollContainer.scrollTop = scrollPosition;

      const bug3Card = screen.getByText("Bug 3").closest(".card");
      await user.click(within(bug3Card!).getByRole("button", { name: /^Resolve$/ }));

      await waitFor(() => {
        expect(scrollContainer.scrollTop).toBe(scrollPosition);
      });
    });

    it("collapses height during resolve fade-out animation (no empty gap)", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Bug 3")).toBeInTheDocument());

      const bug3Card = screen.getByText("Bug 3").closest(".card");
      const root = bug3Card?.closest("[data-feedback-id]");
      expect(root).toBeTruthy();

      await user.click(within(bug3Card!).getByRole("button", { name: /^Resolve$/ }));

      // During fade-out, root collapses: overflow hidden, max-height transition, margin 0
      // so no empty vertical gap remains during or after animation
      await waitFor(() => {
        const style = (root as HTMLElement).getAttribute("style") ?? "";
        expect(style).toMatch(/overflow:\s*hidden/);
        expect(style).toMatch(/max-height|maxHeight/);
        expect(style).toMatch(/transition/);
      });
    });

    it("does not refresh page when clicking Resolve (prevents form submit)", async () => {
      const formSubmit = vi.fn();
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <form
          onSubmit={(e) => {
            e.preventDefault();
            formSubmit();
          }}
        >
          <MemoryRouter>
            <EvalPhase projectId="proj-1" />
          </MemoryRouter>
        </form>
      );

      await waitFor(() => expect(screen.getByText("Bug 3")).toBeInTheDocument());

      const bug3Card = screen.getByText("Bug 3").closest(".card");
      await user.click(within(bug3Card!).getByRole("button", { name: /^Resolve$/ }));

      expect(formSubmit).not.toHaveBeenCalled();
    });

    describe("Cancel button", () => {
      it("shows Cancel button when no linked tasks are in progress, in review, or done", async () => {
        const feedbackWithTasks: FeedbackItem[] = [
          {
            id: "fb-cancel-1",
            text: "Cancel me",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: ["task-1"],
            status: "pending",
            createdAt: "2024-01-01T00:00:01Z",
          },
        ];
        const executeTasks: Task[] = [
          createMockTask({ id: "task-1", kanbanColumn: "backlog" }),
        ];
        const store = createStore({
          evalFeedback: feedbackWithTasks,
          executeTasks,
        });

        renderWithProviders(
          <MemoryRouter>
            <EvalPhase projectId="proj-1" />
          </MemoryRouter>
        );

        await waitFor(() => {
          expect(screen.getByTestId("feedback-cancel-button")).toBeInTheDocument();
        });
        expect(screen.getByRole("button", { name: /^Cancel$/ })).toBeInTheDocument();
      });

      it("hides Cancel button when linked task is in progress", async () => {
        const feedbackWithTasks: FeedbackItem[] = [
          {
            id: "fb-cancel-2",
            text: "In progress",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: ["task-1"],
            status: "pending",
            createdAt: "2024-01-01T00:00:01Z",
          },
        ];
        const executeTasks: Task[] = [
          createMockTask({ id: "task-1", kanbanColumn: "in_progress" }),
        ];
        const store = createStore({
          evalFeedback: feedbackWithTasks,
          executeTasks,
        });

        renderWithProviders(
          <MemoryRouter>
            <EvalPhase projectId="proj-1" />
          </MemoryRouter>
        );

        await waitFor(() => {
          expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
        });
        expect(screen.queryByTestId("feedback-cancel-button")).not.toBeInTheDocument();
      });

      it("shows Cancel button for feedback with no linked tasks", async () => {
        const feedbackNoTasks: FeedbackItem[] = [
          {
            id: "fb-cancel-3",
            text: "No tasks yet",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            taskTitles: ["Fix something"],
            createdAt: "2024-01-01T00:00:01Z",
          },
        ];
        const store = createStore({ evalFeedback: feedbackNoTasks });

        renderWithProviders(
          <MemoryRouter>
            <EvalPhase projectId="proj-1" />
          </MemoryRouter>
        );

        await waitFor(() => {
          expect(screen.getByTestId("feedback-cancel-button")).toBeInTheDocument();
        });
      });

      it("calls cancel API and updates state when Cancel is clicked", async () => {
        const { api } = await import("../../api/client");
        const feedbackWithTasks: FeedbackItem[] = [
          {
            id: "fb-cancel-4",
            text: "Cancel this",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: ["task-1"],
            status: "pending",
            createdAt: "2024-01-01T00:00:01Z",
          },
        ];
        const executeTasks: Task[] = [
          createMockTask({ id: "task-1", kanbanColumn: "backlog" }),
        ];
        const store = createStore({
          evalFeedback: feedbackWithTasks,
          executeTasks,
        });

        renderWithProviders(
          <MemoryRouter>
            <EvalPhase projectId="proj-1" />
          </MemoryRouter>
        );

        await waitFor(() => {
          expect(screen.getByTestId("feedback-cancel-button")).toBeInTheDocument();
        });

        const user = userEvent.setup();
        await user.click(screen.getByTestId("feedback-cancel-button"));

        expect(api.feedback.cancel).toHaveBeenCalledWith("proj-1", "fb-cancel-4");

        await waitFor(() => {
          expect(store.getState().eval.feedback[0].status).toBe("cancelled");
        });
      });
    });

    it("shows plan link when mappedPlanId is set and feedback is plan-linked (no created tasks)", async () => {
      const planLinkedFeedback: FeedbackItem[] = [
        {
          id: "fb-plan-linked",
          text: "This relates to the auth plan",
          category: "feature",
          mappedPlanId: "auth-feature-plan",
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const store = createStore({ evalFeedback: planLinkedFeedback, executeTasks: [] });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-plan-link")).toBeInTheDocument();
      });

      expect(screen.getByRole("button", { name: /View plan Auth Feature Plan/i })).toBeInTheDocument();
      expect(screen.getByText(/Plan: Auth Feature Plan/)).toBeInTheDocument();
      expect(screen.queryByTestId("feedback-card-ticket-info")).not.toBeInTheDocument();
    });

    it("does not show plan link when feedback has created tasks (task-linked)", async () => {
      const taskLinkedFeedback: FeedbackItem[] = [
        {
          id: "fb-task-linked",
          text: "Auth bug",
          category: "bug",
          mappedPlanId: "auth-feature-plan",
          createdTaskIds: ["task-1"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [createMockTask({ id: "task-1" })];
      const store = createStore({
        evalFeedback: taskLinkedFeedback,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("feedback-card-plan-link")).not.toBeInTheDocument();
    });

    it("plan link navigates to plan view when clicked", async () => {
      function LocationCapture() {
        const loc = useLocation();
        return (
          <div
            data-testid="location-capture"
            data-pathname={loc.pathname}
            data-search={loc.search}
          />
        );
      }

      const planLinkedFeedback: FeedbackItem[] = [
        {
          id: "fb-plan-linked",
          text: "Plan-related feedback",
          category: "feature",
          mappedPlanId: "my-feature-plan",
          createdTaskIds: [],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const store = createStore({ evalFeedback: planLinkedFeedback, executeTasks: [] });

      renderWithProviders(
        <MemoryRouter initialEntries={["/projects/proj-1/eval"]}>
          <>
            <LocationCapture />
            <EvalPhase projectId="proj-1" />
          </>
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-plan-link")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const planLink = screen.getByRole("button", { name: /View plan My Feature Plan/i });
      await user.click(planLink);

      await waitFor(() => {
        const capture = screen.getByTestId("location-capture");
        expect(capture.getAttribute("data-pathname")).toBe("/projects/proj-1/plan");
        expect(capture.getAttribute("data-search")).toContain("plan=my-feature-plan");
      });
    });

    it("navigates to correct task when link is clicked", async () => {
      const onNavigateToBuildTask = vi.fn();
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Auth bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [createMockTask({ id: "task-1" })];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" onNavigateToBuildTask={onNavigateToBuildTask} />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("feedback-card-ticket-info")).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.click(screen.getByText("Fix login bug"));

      expect(onNavigateToBuildTask).toHaveBeenCalledWith("task-1");
    });

    it("updates task chip when task state changes via Redux (e.g. taskUpdated from WebSocket)", async () => {
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Auth bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [
        createMockTask({ id: "task-1", kanbanColumn: "backlog", title: "Fix login" }),
      ];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByText("Backlog")).toBeInTheDocument();
      });

      act(() => {
        store.dispatch(taskUpdated({ taskId: "task-1", status: "closed" }));
      });

      await waitFor(() => {
        expect(screen.getByText("Done")).toBeInTheDocument();
        expect(screen.queryByText("Backlog")).not.toBeInTheDocument();
      });
    });

    it("updates only the affected chip when one task state changes (isolation)", async () => {
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Two bugs",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1", "task-2"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [
        createMockTask({ id: "task-1", kanbanColumn: "backlog", title: "Bug A" }),
        createMockTask({ id: "task-2", kanbanColumn: "in_progress", title: "Bug B" }),
      ];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByText("Backlog")).toBeInTheDocument();
        expect(screen.getByText("In Progress")).toBeInTheDocument();
      });

      act(() => {
        store.dispatch(taskUpdated({ taskId: "task-1", status: "closed" }));
      });

      await waitFor(() => {
        expect(screen.getByText("Done")).toBeInTheDocument();
        expect(screen.getByText("In Progress")).toBeInTheDocument();
      });
    });

    it("updates task chip when fetchTasks returns updated task data (poll scenario)", async () => {
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-mapped",
          text: "Auth bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const executeTasks: Task[] = [
        createMockTask({
          id: "task-1",
          kanbanColumn: "in_progress",
          title: "Fix login",
          status: "in_progress",
        }),
      ];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByText("In Progress")).toBeInTheDocument();
      });

      act(() => {
        store.dispatch(
          fetchTasks.fulfilled(
            [
              createMockTask({
                id: "task-1",
                kanbanColumn: "done",
                title: "Fix login",
                status: "closed",
              }),
            ],
            "fetchTasks",
            "proj-1"
          )
        );
      });

      await waitFor(() => {
        expect(screen.getByText("Done")).toBeInTheDocument();
        expect(screen.queryByText("In Progress")).not.toBeInTheDocument();
      });
    });

    it("updates only the affected card's chip when task on another card changes", async () => {
      const feedbackWithTasks: FeedbackItem[] = [
        {
          id: "fb-1",
          text: "Bug A",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1"],
          status: "pending",
          createdAt: "2024-01-01T00:00:01Z",
        },
        {
          id: "fb-2",
          text: "Bug B",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-2"],
          status: "pending",
          createdAt: "2024-01-01T00:00:02Z",
        },
      ];
      const executeTasks: Task[] = [
        createMockTask({ id: "task-1", kanbanColumn: "backlog", title: "Fix A" }),
        createMockTask({ id: "task-2", kanbanColumn: "in_progress", title: "Fix B" }),
      ];
      const store = createStore({
        evalFeedback: feedbackWithTasks,
        executeTasks,
      });

      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByText("Bug A")).toBeInTheDocument();
        expect(screen.getByText("Bug B")).toBeInTheDocument();
        expect(screen.getByText("Backlog")).toBeInTheDocument();
        expect(screen.getByText("In Progress")).toBeInTheDocument();
      });

      act(() => {
        store.dispatch(taskUpdated({ taskId: "task-1", status: "closed" }));
      });

      await waitFor(() => {
        expect(screen.getByText("Done")).toBeInTheDocument();
        expect(screen.getByText("In Progress")).toBeInTheDocument();
        expect(screen.getByText("Bug A")).toBeInTheDocument();
        expect(screen.getByText("Bug B")).toBeInTheDocument();
      });
    });
  });

  describe("reply image attachment", () => {
    it("shows Attach icon button in reply composer to the left of Submit", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Bug 1")).toBeInTheDocument());

      const bug1Card = screen.getByText("Bug 1").closest(".card");
      await user.click(within(bug1Card!).getByRole("button", { name: /^Reply$/ }));
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Write a reply...")).toBeInTheDocument();
      });

      const replyForm = screen.getByPlaceholderText("Write a reply...").closest(".card");
      const attachButton = within(replyForm!).getByTestId("reply-attach-images");
      const submitButton = within(replyForm!).getByRole("button", { name: /^Submit$/ });
      expect(attachButton).toBeInTheDocument();
      expect(attachButton).toHaveAttribute("aria-label", "Attach image");

      // Attach button should appear before Submit in DOM order
      const actionsRow = submitButton.closest(".flex");
      expect(actionsRow).toBeTruthy();
      const buttons = actionsRow!.querySelectorAll("button");
      const attachIndex = Array.from(buttons).findIndex((b) => b === attachButton);
      const submitIndex = Array.from(buttons).findIndex((b) => b === submitButton);
      expect(attachIndex).toBeGreaterThanOrEqual(0);
      expect(submitIndex).toBeGreaterThan(attachIndex);
    });

    it("persists attached images when submitting reply", async () => {
      const { api } = await import("../../api/client");
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Bug 1")).toBeInTheDocument());

      const bug1Card = screen.getByText("Bug 1").closest(".card");
      await user.click(within(bug1Card!).getByRole("button", { name: /^Reply$/ }));
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Write a reply...")).toBeInTheDocument();
      });

      // Create minimal valid PNG (1x1 pixel)
      const base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], "test.png", { type: "image/png" });

      const fileInput = screen.getByTestId("reply-attach-images-input");
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(screen.getByAltText("Attachment 1")).toBeInTheDocument();
      });

      const replyForm = screen.getByPlaceholderText("Write a reply...").closest(".card");
      await user.type(screen.getByPlaceholderText("Write a reply..."), "Here is a screenshot");
      await user.click(within(replyForm!).getByRole("button", { name: /^Submit$/ }));

      await waitFor(() => {
        expect(api.feedback.submit).toHaveBeenCalledWith(
          "proj-1",
          "Here is a screenshot",
          expect.any(Array),
          "fb-1",
          undefined
        );
      });
      const call = vi.mocked(api.feedback.submit).mock.calls[0];
      expect(call[2]).toHaveLength(1);
      expect(call[2]![0]).toContain("data:image/png;base64,");
    });
  });

  describe("image drag targets", () => {
    it("renders main feedback drop zone", async () => {
      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => {
        expect(screen.getByTestId("main-feedback-drop-zone")).toBeInTheDocument();
      });
    });

    it("renders reply drop zone when reply form is open", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByText("Bug 1")).toBeInTheDocument());

      const bug1Card = screen.getByText("Bug 1").closest(".card");
      await user.click(within(bug1Card!).getByRole("button", { name: /^Reply$/ }));

      await waitFor(() => {
        expect(screen.getByTestId("reply-drop-zone")).toBeInTheDocument();
      });
    });

    it("main and reply drop zones are valid drop targets with drag handlers", async () => {
      const store = createStore({ evalFeedback: mockFeedbackItems });
      const user = userEvent.setup();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("main-feedback-drop-zone")).toBeInTheDocument());

      const mainZone = screen.getByTestId("main-feedback-drop-zone");
      expect(mainZone).toBeInTheDocument();

      await waitFor(() => expect(screen.getByText("Bug 1")).toBeInTheDocument());
      const bug1Card = screen.getByText("Bug 1").closest(".card");
      await user.click(within(bug1Card!).getByRole("button", { name: /^Reply$/ }));

      await waitFor(() => {
        expect(screen.getByTestId("reply-drop-zone")).toBeInTheDocument();
      });
      const replyZone = screen.getByTestId("reply-drop-zone");
      expect(replyZone).toBeInTheDocument();
    });

    it("drop target hides immediately when image is dropped onto it", async () => {
      const store = createStore();
      renderWithProviders(
        <MemoryRouter>
          <EvalPhase projectId="proj-1" />
        </MemoryRouter>,
      { store }
      );

      await waitFor(() => expect(screen.getByTestId("main-feedback-drop-zone")).toBeInTheDocument());

      const dataTransfer = {
        types: ["Files"],
        items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList,
        files: [] as FileList,
      } as DataTransfer;

      const dragEnterEvent = new Event("dragenter", { bubbles: true }) as DragEvent;
      Object.defineProperty(dragEnterEvent, "dataTransfer", { value: dataTransfer, writable: false });

      await act(async () => {
        document.dispatchEvent(dragEnterEvent);
      });

      await waitFor(() => {
        expect(screen.getByText("Drop here for new feedback")).toBeInTheDocument();
      });

      const dropEvent = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(dropEvent, "dataTransfer", { value: dataTransfer, writable: false });
      Object.defineProperty(dropEvent, "preventDefault", { value: vi.fn(), writable: false });
      Object.defineProperty(dropEvent, "stopPropagation", { value: vi.fn(), writable: false });

      const mainZone = screen.getByTestId("main-feedback-drop-zone");
      await act(async () => {
        mainZone.dispatchEvent(dropEvent);
      });

      await waitFor(() => {
        expect(screen.queryByText("Drop here for new feedback")).not.toBeInTheDocument();
      });
    });
  });
});
