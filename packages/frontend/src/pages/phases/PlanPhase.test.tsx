// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { act, render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { PlanPhase, getPlanChatMessageDisplay } from "./PlanPhase";
import { api } from "../../api/client";
import { queryKeys } from "../../api/queryKeys";
import projectReducer from "../../store/slices/projectSlice";
import planReducer, { setPlansAndGraph, setSelectedPlanId } from "../../store/slices/planSlice";
import executeReducer, { taskUpdated, toTasksByIdAndOrder } from "../../store/slices/executeSlice";
import openQuestionsReducer, {
  addNotification as addOpenQuestionNotification,
} from "../../store/slices/openQuestionsSlice";
import notificationReducer from "../../store/slices/notificationSlice";
import unreadPhaseReducer, { setPhaseUnread } from "../../store/slices/unreadPhaseSlice";

function createPlanPhaseQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
}

const PlanPhaseWrapper = ({ children }: { children: React.ReactNode }) => {
  const [client] = React.useState(() => createPlanPhaseQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("getPlanChatMessageDisplay", () => {
  it("returns 'Plan updated' when content contains [PLAN_UPDATE]", () => {
    expect(getPlanChatMessageDisplay("[PLAN_UPDATE]\n# Plan\n\nContent.\n[/PLAN_UPDATE]")).toBe(
      "Plan updated"
    );
  });

  it("returns content unchanged when it does not contain [PLAN_UPDATE]", () => {
    const content = "I can help refine this plan. What would you like to change?";
    expect(getPlanChatMessageDisplay(content)).toBe(content);
  });
});

const mockArchive = vi.fn().mockResolvedValue(undefined);
const mockExecute = vi.fn().mockResolvedValue(undefined);
const mockReExecute = vi.fn().mockResolvedValue(undefined);
const mockGetCrossEpicDependencies = vi.fn().mockResolvedValue({ prerequisitePlanIds: [] });
const mockPlansUpdate = vi.fn().mockResolvedValue({
  metadata: {
    planId: "archive-test-feature",
    epicId: "epic-1",
    complexity: "medium",
  },
  content: "# Updated Plan\n\nUpdated content.",
  status: "building",
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
});
const mockChatSend = vi.fn().mockResolvedValue({ message: "AI response" });
const mockPlansList = vi.fn().mockResolvedValue({
  plans: [
    {
      metadata: {
        planId: "archive-test-feature",
        epicId: "epic-1",
        complexity: "medium",
      },
      content: "# Archive Test\n\nContent.",
      status: "building",
      taskCount: 2,
      doneTaskCount: 0,
      dependencyCount: 0,
    },
  ],
  edges: [],
});
const mockPlansGet = vi.fn().mockResolvedValue({
  metadata: {
    planId: "archive-test-feature",
    epicId: "epic-1",
    complexity: "medium",
  },
  content: "# Archive Test\n\nContent.",
  status: "building",
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
});
const mockPlansCreate = vi.fn().mockResolvedValue({
  metadata: { planId: "new-feature", epicId: "e1", complexity: "medium" },
  content: "# New Feature\n\nContent.",
  status: "planning",
  taskCount: 0,
  doneTaskCount: 0,
  dependencyCount: 0,
});
const mockGenerate = vi.fn().mockResolvedValue({
  status: "created",
  plan: {
    metadata: {
      planId: "generated-feature",
      epicId: "e2",
      complexity: "medium",
      shippedAt: null,
    },
    content: "# Generated Feature\n\nContent.",
    status: "planning",
    taskCount: 2,
    doneTaskCount: 0,
    dependencyCount: 0,
  },
});
const mockNotificationResolve = vi.fn().mockResolvedValue({});
const mockPlanTasks = vi.fn().mockResolvedValue({
  metadata: {
    planId: "plan-tasks-feature",
    epicId: "epic-pt",
    complexity: "medium",
  },
  content: "# Plan Tasks Feature\n\nContent.",
  status: "planning",
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
});
const mockMarkPlanComplete = vi.fn().mockResolvedValue({
  metadata: {
    planId: "in-review-feature",
    epicId: "epic-1",
    complexity: "medium",
    reviewedAt: new Date().toISOString(),
  },
  content: "# In Review Feature\n\nContent.",
  status: "complete",
  taskCount: 2,
  doneTaskCount: 2,
  dependencyCount: 0,
});
const mockPlansListVersions = vi.fn().mockResolvedValue([]);
const mockPlansAuditorRuns = vi.fn().mockResolvedValue([]);
vi.mock("../../api/client", () => ({
  api: {
    plans: {
      list: (...args: unknown[]) => mockPlansList(...args),
      get: (...args: unknown[]) => mockPlansGet(...args),
      listVersions: (...args: unknown[]) => mockPlansListVersions(...args),
      getVersion: vi
        .fn()
        .mockResolvedValue({ version_number: 1, title: "", content: "", created_at: "" }),
      create: (...args: unknown[]) => mockPlansCreate(...args),
      update: (...args: unknown[]) => mockPlansUpdate(...args),
      archive: (...args: unknown[]) => mockArchive(...args),
      delete: vi.fn().mockResolvedValue(undefined),
      getCrossEpicDependencies: (...args: unknown[]) => mockGetCrossEpicDependencies(...args),
      execute: (...args: unknown[]) => mockExecute(...args),
      reExecute: (...args: unknown[]) => mockReExecute(...args),
      generate: (...args: unknown[]) => mockGenerate(...args),
      planTasks: (...args: unknown[]) => mockPlanTasks(...args),
      markPlanComplete: (...args: unknown[]) => mockMarkPlanComplete(...args),
      auditorRuns: (...args: unknown[]) => mockPlansAuditorRuns(...args),
    },
    tasks: { list: vi.fn().mockResolvedValue([]) },
    chat: {
      history: vi.fn().mockResolvedValue({ messages: [] }),
      send: (...args: unknown[]) => mockChatSend(...args),
    },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
      resolve: (...args: unknown[]) => mockNotificationResolve(...args),
      retryRateLimit: vi.fn(),
    },
  },
}));

const basePlan = {
  metadata: {
    planId: "archive-test-feature",
    epicId: "epic-1",
    complexity: "medium" as const,
  },
  content: "# Archive Test\n\nContent.",
  status: "building" as const,
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
};

const defaultExecuteTasks = [
  {
    id: "epic-1.1",
    title: "Task A",
    epicId: "epic-1",
    kanbanColumn: "ready" as const,
    priority: 0,
    assignee: null,
  },
  {
    id: "epic-1.2",
    title: "Task B",
    epicId: "epic-1",
    kanbanColumn: "ready" as const,
    priority: 1,
    assignee: null,
  },
];

function syncSinglePlanMock(plans: (typeof basePlan)[]) {
  const planById = new Map(plans.map((plan) => [plan.metadata.planId, plan]));
  mockPlansGet.mockImplementation(async (_projectId: string, planId: string) => {
    return (
      planById.get(planId) ?? {
        ...basePlan,
        metadata: {
          ...basePlan.metadata,
          planId,
        },
      }
    );
  });
}

function createStore(
  plansOverride?: (typeof basePlan)[],
  planError?: string | null,
  executeTasksOverride?: typeof defaultExecuteTasks,
  planOverrides?: {
    selectedPlanId?: string;
    chatMessages?: Record<string, unknown[]>;
    planTasksPlanIds?: string[];
  }
) {
  const plans = plansOverride ?? [basePlan];
  const executeTasks = executeTasksOverride ?? defaultExecuteTasks;
  syncSinglePlanMock(plans);

  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      openQuestions: openQuestionsReducer,
      notification: notificationReducer,
      unreadPhase: unreadPhaseReducer,
    },
    preloadedState: {
      plan: {
        plans,
        dependencyGraph: null,
        selectedPlanId: planOverrides?.selectedPlanId ?? "archive-test-feature",
        chatMessages: planOverrides?.chatMessages ?? {},
        loading: false,
        decomposing: false,
        generating: false,
        planStatus: null,
        executingPlanId: null,
        reExecutingPlanId: null,
        archivingPlanId: null,
        deletingPlanId: null,
        planTasksPlanIds: planOverrides?.planTasksPlanIds ?? [],
        optimisticPlans: [],
        error: planError ?? null,
        executeError: null,
        backgroundError: null,
        auditorOutputByPlanId: {},
      },
      execute: {
        ...toTasksByIdAndOrder(executeTasks),
        orchestratorRunning: false,
        awaitingApproval: false,
        activeTasks: [],
        activeAgents: [],
        selectedTaskId: null,
        taskDetailLoading: false,
        taskDetailError: null,
        agentOutput: {},
        completionState: null,
        archivedSessions: [],
        archivedLoading: false,
        markDoneLoading: false,
        unblockLoading: false,
        statusLoading: false,
        loading: false,
        error: null,
      },
      openQuestions: {
        byProject: {},
        global: [],
        async: {
          project: {},
          global: { loading: false },
        },
      },
    },
  });
}

describe("PlanPhase Redux integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders compact epic cards with progress bar and nested subtasks", () => {
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByRole("progressbar", { name: /tasks done/i })).toBeInTheDocument();
    expect(screen.getAllByText("Task A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Task B").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/0\/2/)).toBeInTheDocument();
  });

  it("renders plans from Redux state via useAppSelector", () => {
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByText("Archive Test Feature")).toBeInTheDocument();
    expect(screen.getByText(/archive test/i)).toBeInTheDocument();
  });

  it("clears plan phase unread when mounted with projectId", () => {
    const store = createStore();
    store.dispatch(setPhaseUnread({ projectId: "proj-1", phase: "plan" }));
    expect(store.getState().unreadPhase["proj-1"]?.plan).toBe(true);

    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(store.getState().unreadPhase["proj-1"]?.plan).toBeFalsy();
  });

  it("displays error from Redux and allows dismiss", async () => {
    const store = createStore(undefined, "Failed to load plans");
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByText("Failed to load plans")).toBeInTheDocument();
    expect(screen.getByTestId("plan-error-banner")).toBeInTheDocument();
    const dismissBtn = screen.getByRole("button", { name: /Dismiss error/i });
    await user.click(dismissBtn);

    await waitFor(() => {
      expect(store.getState().plan.error).toBeNull();
    });
    expect(screen.queryByText("Failed to load plans")).not.toBeInTheDocument();
  });

  it("renders New Plan button in topbar; modal has textarea and Generate Plan button", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const addPlanBtn = screen.getByTestId("add-plan-button");
    expect(addPlanBtn).toBeInTheDocument();
    expect(addPlanBtn).toHaveTextContent("New Plan");
    expect(addPlanBtn).toHaveClass("btn-primary");
    expect(addPlanBtn).toHaveClass("hover:bg-brand-800");
    expect(screen.queryByTestId("add-plan-modal")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("add-plan-button"));
    expect(screen.getByTestId("add-plan-modal")).toBeInTheDocument();
    expect(screen.getByTestId("feature-description-input")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/describe your feature idea/i)).toBeInTheDocument();
    expect(screen.getByTestId("generate-plan-button")).toBeInTheDocument();
    expect(screen.getByText("Generate Plan")).toBeInTheDocument();
  });

  it("disables Generate Plan button when feature description is empty in Add Plan modal", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    const button = screen.getByTestId("generate-plan-button");
    expect(button).toBeDisabled();
  });

  it("updates task status in sidebar when task changes via Redux (e.g. taskUpdated from WebSocket)", async () => {
    const tasks = [
      {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-1.2",
        title: "Task B",
        epicId: "epic-1",
        kanbanColumn: "ready" as const,
        priority: 1,
        assignee: null,
      },
    ];
    const store = createStore(undefined, undefined, tasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    // Initially Task B shows "ready" (appears in EpicCard and sidebar)
    expect(screen.getAllByText("Task B").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("ready").length).toBeGreaterThanOrEqual(1);

    act(() => {
      store.dispatch(taskUpdated({ taskId: "epic-1.2", status: "closed" }));
    });

    // Task B should now show "done" (live update from Redux)
    await waitFor(() => {
      expect(screen.getByText("done")).toBeInTheDocument();
    });
  });

  it("sidebar shows only tasks for selected plan's epic (filter by epicId, epic-blocked model)", () => {
    const planA = {
      ...basePlan,
      metadata: { ...basePlan.metadata, planId: "plan-a", epicId: "epic-a" },
      status: "planning" as const,
      taskCount: 2,
      doneTaskCount: 0,
    };
    const planB = {
      ...basePlan,
      metadata: { ...basePlan.metadata, planId: "plan-b", epicId: "epic-b" },
      status: "planning" as const,
      taskCount: 1,
      doneTaskCount: 0,
    };
    const tasks = [
      {
        id: "epic-a.1",
        title: "Epic A Task 1",
        epicId: "epic-a",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-a.2",
        title: "Epic A Task 2",
        epicId: "epic-a",
        kanbanColumn: "ready" as const,
        priority: 1,
        assignee: null,
      },
      {
        id: "epic-b.1",
        title: "Epic B Task",
        epicId: "epic-b",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
    ];
    const store = createStore([planA, planB], undefined, tasks as typeof defaultExecuteTasks, {
      selectedPlanId: "plan-a",
    });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    // Sidebar Tasks count is 2 (epic-a only); if filter failed it would show 3
    expect(screen.getByText("Tasks (2)")).toBeInTheDocument();
    // Epic B Task appears only in Plan B card, not in sidebar (selectTasksForEpic filters by epicId)
    const tasksHeading = screen.getByText("Tasks (2)");
    expect(tasksHeading).toBeInTheDocument();
    const tasksSection = tasksHeading.closest("div")?.parentElement;
    expect(tasksSection).toBeInTheDocument();
    expect(within(tasksSection!).getByText("Epic A Task 1")).toBeInTheDocument();
    expect(within(tasksSection!).getByText("Epic A Task 2")).toBeInTheDocument();
    expect(within(tasksSection!).queryByText("Epic B Task")).not.toBeInTheDocument();
  });

  it("search filters plan cards by title and content", () => {
    vi.useFakeTimers();
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByText("Archive Test Feature")).toBeInTheDocument();
    const searchExpand = screen.getByTestId("plan-search-expand");
    fireEvent.click(searchExpand);
    expect(screen.getByTestId("plan-search-expanded")).toBeInTheDocument();
    const searchInput = screen.getByPlaceholderText("Search plans…");
    fireEvent.change(searchInput, { target: { value: "nonexistent" } });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("No plans match your search.")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("filter chips filter by plan status", async () => {
    const planPlanning = {
      ...basePlan,
      metadata: { ...basePlan.metadata, planId: "plan-planning", epicId: "epic-p" },
      status: "planning" as const,
      content: "# Planning Feature\n\nContent.",
    };
    const planBuilding = {
      ...basePlan,
      metadata: { ...basePlan.metadata, planId: "plan-building", epicId: "epic-b" },
      status: "building" as const,
      content: "# Building Feature\n\nContent.",
    };
    const store = createStore([planPlanning, planBuilding]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    // EpicCard uses formatPlanIdAsTitle(planId): plan-planning -> "Plan Planning", plan-building -> "Plan Building"
    expect(screen.getByText("Plan Planning")).toBeInTheDocument();
    expect(screen.getByText("Plan Building")).toBeInTheDocument();
    const planningChip = screen.getByTestId("plan-filter-chip-planning");
    await user.click(planningChip);
    expect(screen.getByText("Plan Planning")).toBeInTheDocument();
    expect(screen.queryByText("Plan Building")).not.toBeInTheDocument();
  });
});

describe("PlanPhase archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders plan sidebar 3-dot menu that opens to reveal Delete and Archive", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const menuTrigger = screen.getByTestId("plan-sidebar-actions-menu-trigger");
    expect(menuTrigger).toBeInTheDocument();
    expect(screen.queryByTestId("plan-sidebar-actions-menu")).not.toBeInTheDocument();

    await user.click(menuTrigger);
    const menu = screen.getByTestId("plan-sidebar-actions-menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId("plan-sidebar-archive-btn")).toHaveTextContent("Archive");
    expect(screen.getByTestId("plan-sidebar-delete-btn")).toHaveTextContent("Delete");
  });

  it("has main content area with overflow-auto, min-w-0, and min-h-0 for independent scroll", () => {
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    const mainContent = screen.getByText("Feature Plans").closest(".overflow-auto");
    expect(mainContent).toBeInTheDocument();
    expect(mainContent).toHaveClass("min-h-0");
    const mainWrapper = mainContent?.closest(".flex.flex-col");
    expect(mainWrapper).toHaveClass("min-w-0");
  });

  it("has root with flex flex-1 min-h-0 min-w-0 for proper fill and independent page/sidebar scroll", () => {
    const store = createStore();
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    const root = container.firstElementChild;
    expect(root).toHaveClass("flex");
    expect(root).toHaveClass("flex-1");
    expect(root).toHaveClass("min-h-0");
    expect(root).toHaveClass("min-w-0");
  });

  it("renders resizable sidebar with resize handle when a plan is selected", () => {
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByRole("slider", { name: "Resize sidebar" })).toBeInTheDocument();
  });

  it("keeps plan details sidebar header fixed at top when scrolling (matches Execute sidebar)", () => {
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    // Header (title + close) should be in a shrink-0 container so it stays pinned
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    const headerContainer = titleInput.closest(".shrink-0");
    expect(headerContainer).toBeInTheDocument();
    // Scrollable body is the header's next sibling within the sidebar (not main content)
    const scrollableBody = headerContainer?.nextElementSibling;
    expect(scrollableBody).toBeInTheDocument();
    expect(scrollableBody).toHaveClass("overflow-y-auto");
    expect(scrollableBody).toHaveClass("min-h-0");
    expect(scrollableBody).toHaveClass("flex-1");
  });

  it("opens plan sidebar with scroll position at top of plan content", () => {
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    const titleInput = screen.getByRole("textbox", { name: /title/i });
    const scrollableBody = titleInput.closest(".shrink-0")?.nextElementSibling as HTMLDivElement;
    expect(scrollableBody).toBeInTheDocument();
    expect(scrollableBody.scrollTop).toBe(0);
  });

  it("does not scroll to bottom or animate when opening sidebar with chat messages", () => {
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    const store = createStore(undefined, undefined, undefined, {
      chatMessages: {
        "plan:archive-test-feature": [
          { role: "user", content: "Hello", timestamp: "2024-01-01T00:00:00Z" },
          { role: "assistant", content: "Hi there", timestamp: "2024-01-01T00:00:01Z" },
        ],
      },
    });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    // On open we scroll to top (scrollTop = 0), not to bottom; no scrollIntoView on initial load
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("calls archive API when Archive is chosen from plan sidebar actions menu", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("plan-sidebar-actions-menu-trigger"));
    await user.click(screen.getByTestId("plan-sidebar-archive-btn"));

    expect(mockArchive).toHaveBeenCalledWith("proj-1", "archive-test-feature");
  });
});

describe("PlanPhase inline editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders inline editable plan title and markdown in details sidebar", () => {
    const store = createStore();
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByRole("textbox", { name: /title/i })).toBeInTheDocument();
    expect(container.querySelector('[data-testid="plan-markdown-editor"]')).toBeInTheDocument();
  });

  it("does not render duplicate plan title in sidebar header", () => {
    const store = createStore();
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    // The plan title may appear in EpicCard (h3) plus the editable input in sidebar,
    // but there should be no extra h3 inside the sidebar panel itself
    const sidebar = container.querySelector('[role="slider"]')?.closest(".relative");
    if (sidebar) {
      const sidebarH3s = sidebar.querySelectorAll("h3");
      const sidebarTitleH3 = Array.from(sidebarH3s).filter((h) =>
        h.textContent?.includes("Archive Test")
      );
      expect(sidebarTitleH3).toHaveLength(0);
    }
  });

  it("dispatches updatePlan when plan title is edited and blurred", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const titleInput = screen.getByRole("textbox", { name: /title/i });
    await user.clear(titleInput);
    await user.type(titleInput, "New Title");
    titleInput.blur();

    await waitFor(
      () => {
        expect(mockPlansUpdate).toHaveBeenCalledWith(
          "proj-1",
          "archive-test-feature",
          expect.objectContaining({
            content: expect.stringContaining("New Title"),
          })
        );
      },
      { timeout: 2000 }
    );
  });

  it("renders plan markdown in sidebar with collapsible section styling (Execute sidebar style)", () => {
    const store = createStore();
    const { container } = render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    const editorContainer = container.querySelector('[data-testid="plan-markdown-editor"]');
    expect(editorContainer).toBeInTheDocument();
    expect(editorContainer?.className).toContain("first-child");
  });
});

describe("PlanPhase Re-execute button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows Re-execute button when plan is complete and lastModified > shippedAt", () => {
    const plans = [
      {
        ...basePlan,
        status: "complete" as const,
        doneTaskCount: 2,
        metadata: {
          ...basePlan.metadata,
          shippedAt: "2026-02-16T08:00:00.000Z",
        },
        lastModified: "2026-02-16T10:00:00.000Z",
      },
    ];
    const store = createStore(plans);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByRole("button", { name: "Re-execute" })).toBeInTheDocument();
  });

  it("hides Re-execute button when plan is complete but lastModified <= shippedAt", () => {
    const plans = [
      {
        ...basePlan,
        status: "complete" as const,
        doneTaskCount: 2,
        metadata: {
          ...basePlan.metadata,
          shippedAt: "2026-02-16T10:00:00.000Z",
        },
        lastModified: "2026-02-16T08:00:00.000Z",
      },
    ];
    const store = createStore(plans);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.queryByRole("button", { name: /re-execute/i })).not.toBeInTheDocument();
  });

  it("hides Re-execute button when plan is complete but lastModified === shippedAt (no changes after ship)", () => {
    const plans = [
      {
        ...basePlan,
        status: "complete" as const,
        doneTaskCount: 2,
        metadata: {
          ...basePlan.metadata,
          shippedAt: "2026-02-16T10:00:00.000Z",
        },
        lastModified: "2026-02-16T10:00:00.000Z",
      },
    ];
    const store = createStore(plans);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.queryByRole("button", { name: /re-execute/i })).not.toBeInTheDocument();
  });

  it("hides Re-execute button when plan is complete but lastModified is missing", () => {
    const plans = [
      {
        ...basePlan,
        status: "complete" as const,
        doneTaskCount: 2,
        metadata: {
          ...basePlan.metadata,
          shippedAt: "2026-02-16T08:00:00.000Z",
        },
        lastModified: undefined,
      },
    ];
    const store = createStore(plans);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.queryByRole("button", { name: /re-execute/i })).not.toBeInTheDocument();
  });

  it("hides Re-execute button when plan is complete but shippedAt is null", () => {
    const plans = [
      {
        ...basePlan,
        status: "complete" as const,
        doneTaskCount: 2,
        metadata: {
          ...basePlan.metadata,
          shippedAt: null,
        },
        lastModified: "2026-02-16T10:00:00.000Z",
      },
    ];
    const store = createStore(plans);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.queryByRole("button", { name: /re-execute/i })).not.toBeInTheDocument();
  });
});

describe("PlanPhase dynamic plan button label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows Generate Tasks when plan has zero tasks (epic blocked, planning status)", async () => {
    const planningPlan = {
      ...basePlan,
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata },
    };
    mockPlansList.mockResolvedValue({ plans: [planningPlan], edges: [] });
    const store = createStore([planningPlan], undefined, []);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(await screen.findByTestId("plan-tasks-button")).toBeInTheDocument();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();
  });

  it("displays empty-state copy when plan sidebar has no tasks", async () => {
    const planningPlan = {
      ...basePlan,
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata },
    };
    mockPlansList.mockResolvedValue({ plans: [planningPlan], edges: [] });
    const store = createStore([planningPlan], undefined, [], {
      selectedPlanId: "archive-test-feature",
    });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await screen.findByText(/Archive Test Feature/i);
    expect(
      screen.getByText(
        /Use the chat to refine the plan, then click Generate Tasks when you're ready to break it down into specific tickets/
      )
    ).toBeInTheDocument();
  });

  it("shows Execute when plan has child tasks and epic is blocked", async () => {
    const planningPlan = {
      ...basePlan,
      status: "planning" as const,
      taskCount: 2,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata },
    };
    mockPlansList.mockResolvedValue({ plans: [planningPlan], edges: [] });
    const store = createStore([planningPlan]);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(await screen.findByTestId("execute-button")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-tasks-button")).not.toBeInTheDocument();
  });

  it("hides Generate Tasks and Execute when plan status is building", async () => {
    const buildingPlan = {
      ...basePlan,
      status: "building" as const,
      taskCount: 2,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata },
    };
    mockPlansList.mockResolvedValue({ plans: [buildingPlan], edges: [] });
    const store = createStore([buildingPlan]);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(await screen.findByText(/Archive Test Feature/i)).toBeInTheDocument();
    expect(screen.queryByTestId("plan-tasks-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();
  });

  it("hides Generate Tasks button and shows only loading spinner during plan generation", async () => {
    const planningPlan = {
      ...basePlan,
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata },
    };
    mockPlansList.mockResolvedValue({ plans: [planningPlan], edges: [] });
    const store = createStore([planningPlan], undefined, [], {
      selectedPlanId: "archive-test-feature",
      planTasksPlanIds: ["archive-test-feature"],
    });
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(await screen.findByText(/Archive Test Feature/i)).toBeInTheDocument();
    expect(screen.queryByTestId("plan-tasks-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-tasks-button-sidebar")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-tasks-loading")).toBeInTheDocument();
    expect(screen.getByTestId("plan-tasks-loading-sidebar")).toBeInTheDocument();
    // Only one loading spinner (large blue on card); sidebar shows text, not a duplicate spinner
    expect(
      screen.getByTestId("plan-tasks-loading-sidebar").querySelector(".animate-spin")
    ).toBeNull();
  });

  it("button updates reactively: Generate Tasks when tasks empty, Execute when tasks added", async () => {
    const planningPlan = {
      ...basePlan,
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata },
    };
    const planWithTasks = { ...planningPlan, taskCount: 2 };
    mockPlansList.mockResolvedValue({ plans: [planningPlan], edges: [] });
    const initialStore = createStore([planningPlan], undefined, [], { selectedPlanId: null });
    const initialRender = render(
      <MemoryRouter>
        <Provider store={initialStore}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(await screen.findByTestId("plan-tasks-button")).toBeInTheDocument();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();

    initialRender.unmount();

    mockPlansList.mockResolvedValue({ plans: [planWithTasks], edges: [] });
    const updatedStore = createStore([planWithTasks], undefined, defaultExecuteTasks, {
      selectedPlanId: null,
    });
    render(
      <MemoryRouter>
        <Provider store={updatedStore}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(await screen.findByTestId("execute-button")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-tasks-button")).not.toBeInTheDocument();
  });

  it("button updates reactively: hides Generate Tasks and Execute when plan status → building", async () => {
    const planningPlan = {
      ...basePlan,
      status: "planning" as const,
      taskCount: 2,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata },
    };
    mockPlansList.mockResolvedValue({ plans: [planningPlan], edges: [] });
    const initialStore = createStore([planningPlan], undefined, undefined, {
      selectedPlanId: null,
    });
    const initialRender = render(
      <MemoryRouter>
        <Provider store={initialStore}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(await screen.findByTestId("execute-button")).toBeInTheDocument();

    initialRender.unmount();

    const buildingPlan = { ...planningPlan, status: "building" as const };
    mockPlansList.mockResolvedValue({ plans: [buildingPlan], edges: [] });
    const updatedStore = createStore([buildingPlan], undefined, undefined, {
      selectedPlanId: null,
    });
    render(
      <MemoryRouter>
        <Provider store={updatedStore}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(screen.queryByTestId("plan-tasks-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execute-button")).not.toBeInTheDocument();
  });

  it("shows Execute when plan has delta tasks (taskCount > 0)", async () => {
    const planWithDeltaTasks = {
      ...basePlan,
      status: "planning" as const,
      taskCount: 2,
      doneTaskCount: 0,
      metadata: {
        ...basePlan.metadata,
        planId: "re-exec-plan",
        epicId: "epic-1",
      },
    };
    const tasksIncludingDelta = [
      {
        id: "epic-1.5",
        title: "Delta task from Auditor",
        epicId: "epic-1",
        kanbanColumn: "backlog" as const,
        priority: 1,
        assignee: null,
      },
    ];
    mockPlansList.mockResolvedValue({ plans: [planWithDeltaTasks], edges: [] });
    const store = createStore([planWithDeltaTasks], undefined, tasksIncludingDelta);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    expect(await screen.findByTestId("execute-button")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-tasks-button")).not.toBeInTheDocument();
  });
});

describe("Generate All Tasks button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows Generate All Tasks when there are 2+ plans with no tasks", async () => {
    const planA = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-a",
        epicId: "epic-a",
      },
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
    };
    const planB = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-b",
        epicId: "epic-b",
      },
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
    };
    mockPlansList.mockResolvedValue({ plans: [planA, planB], edges: [] });
    const store = createStore([planA, planB], undefined, []);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("plan-bulk-actions-button"));
    expect(await screen.findByTestId("plan-all-tasks-button")).toBeInTheDocument();
    expect(screen.getByTestId("plan-all-tasks-button")).toHaveTextContent("Generate All Tasks");
  });

  it("does not show Generate All Tasks when only one plan has no tasks", async () => {
    const planWithNoTasks = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-a",
        epicId: "epic-a",
      },
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
    };
    const planWithTasks = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-b",
        epicId: "epic-b",
      },
      status: "planning" as const,
      taskCount: 1,
      doneTaskCount: 0,
    };
    const tasksForB = [
      {
        id: "epic-b.1",
        title: "Task",
        epicId: "epic-b",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
    ];
    mockPlansList.mockResolvedValue({ plans: [planWithNoTasks, planWithTasks], edges: [] });
    const store = createStore([planWithNoTasks, planWithTasks], undefined, tasksForB);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await waitFor(() => {
      expect(screen.getByText("Feature Plans")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("plan-bulk-actions-button")).not.toBeInTheDocument();
  });

  it("queues all plans with no tasks sequentially when Generate All Tasks is clicked", async () => {
    const planA = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-a",
        epicId: "epic-a",
      },
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
    };
    const planB = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-b",
        epicId: "epic-b",
      },
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
    };
    mockPlansList.mockResolvedValue({ plans: [planA, planB], edges: [] });
    mockPlanTasks.mockResolvedValue({ ...planA, taskCount: 2 });
    const store = createStore([planA, planB], undefined, []);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await user.click(await screen.findByTestId("plan-bulk-actions-button"));
    const planAllBtn = await screen.findByTestId("plan-all-tasks-button");
    await user.click(planAllBtn);
    await waitFor(() => {
      expect(mockPlanTasks).toHaveBeenCalledWith("proj-1", "plan-a");
    });
    await waitFor(() => {
      expect(mockPlanTasks).toHaveBeenCalledWith("proj-1", "plan-b");
    });
    expect(mockPlanTasks).toHaveBeenCalledTimes(2);
  });

  it("calls planTasks in dependency order (foundational first) when graph has edges", async () => {
    const planA = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-a",
        epicId: "epic-a",
      },
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
    };
    const planB = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-b",
        epicId: "epic-b",
      },
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
    };
    const edges = [{ from: "plan-a", to: "plan-b", type: "blocks" as const }];
    mockPlansList.mockResolvedValue({ plans: [planA, planB], edges });
    mockPlanTasks.mockResolvedValue({ ...planA, taskCount: 2 });
    const store = createStore([planA, planB], undefined, []);
    store.dispatch(
      setPlansAndGraph({
        plans: [planA, planB],
        dependencyGraph: { plans: [planA, planB], edges },
      })
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await user.click(await screen.findByTestId("plan-bulk-actions-button"));
    const planAllBtn = await screen.findByTestId("plan-all-tasks-button");
    await user.click(planAllBtn);
    await waitFor(() => {
      expect(mockPlanTasks).toHaveBeenCalledWith("proj-1", "plan-a");
    });
    await waitFor(() => {
      expect(mockPlanTasks).toHaveBeenCalledWith("proj-1", "plan-b");
    });
    expect(mockPlanTasks).toHaveBeenCalledTimes(2);
    const callOrder = mockPlanTasks.mock.calls.map((c) => c[1]);
    expect(callOrder).toEqual(["plan-a", "plan-b"]);
  });
});

describe("Execute All button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
  });

  it("shows Execute All when there are 2+ plans ready to execute", async () => {
    const planA = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-a",
        epicId: "epic-a",
      },
      status: "planning" as const,
      taskCount: 1,
      doneTaskCount: 0,
    };
    const planB = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-b",
        epicId: "epic-b",
      },
      status: "planning" as const,
      taskCount: 1,
      doneTaskCount: 0,
    };
    const executeTasks = [
      {
        id: "epic-a.1",
        title: "Task A1",
        epicId: "epic-a",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-b.1",
        title: "Task B1",
        epicId: "epic-b",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
    ];
    mockPlansList.mockResolvedValue({ plans: [planA, planB], edges: [] });
    const store = createStore([planA, planB], undefined, executeTasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("plan-bulk-actions-button"));
    expect(await screen.findByTestId("execute-all-button")).toBeInTheDocument();
    expect(screen.getByTestId("execute-all-button")).toHaveTextContent("Execute All");
  });

  it("does not show Execute All when only one plan is ready to execute", async () => {
    const planA = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-a",
        epicId: "epic-a",
      },
      status: "planning" as const,
      taskCount: 1,
      doneTaskCount: 0,
    };
    const planB = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-b",
        epicId: "epic-b",
      },
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
    };
    const executeTasks = [
      {
        id: "epic-a.1",
        title: "Task A1",
        epicId: "epic-a",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
    ];
    mockPlansList.mockResolvedValue({ plans: [planA, planB], edges: [] });
    const store = createStore([planA, planB], undefined, executeTasks);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await waitFor(() => {
      expect(screen.getByText("Feature Plans")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("plan-bulk-actions-button")).not.toBeInTheDocument();
  });

  it("executes all plans in dependency order when Execute All is clicked", async () => {
    const planA = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-a",
        epicId: "epic-a",
      },
      status: "planning" as const,
      taskCount: 1,
      doneTaskCount: 0,
    };
    const planB = {
      ...basePlan,
      metadata: {
        ...basePlan.metadata,
        planId: "plan-b",
        epicId: "epic-b",
      },
      status: "planning" as const,
      taskCount: 1,
      doneTaskCount: 0,
    };
    const executeTasks = [
      {
        id: "epic-a.1",
        title: "Task A1",
        epicId: "epic-a",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
      {
        id: "epic-b.1",
        title: "Task B1",
        epicId: "epic-b",
        kanbanColumn: "ready" as const,
        priority: 0,
        assignee: null,
      },
    ];
    mockPlansList.mockResolvedValue({ plans: [planA, planB], edges: [] });
    const store = createStore([planA, planB], undefined, executeTasks);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await user.click(await screen.findByTestId("plan-bulk-actions-button"));
    const executeAllBtn = await screen.findByTestId("execute-all-button");
    await user.click(executeAllBtn);
    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledWith("proj-1", "plan-a", undefined);
    });
    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledWith("proj-1", "plan-b", undefined);
    });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    const callOrder = mockExecute.mock.calls.map((c) => c[1]);
    expect(callOrder).toEqual(["plan-a", "plan-b"]);
  });
});

describe("PlanPhase planTasks thunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("dispatches planTasks thunk when Generate Tasks is clicked and shows success notification", async () => {
    const planWithNoTasks = {
      ...basePlan,
      status: "planning" as const,
      taskCount: 0,
      doneTaskCount: 0,
      metadata: { ...basePlan.metadata },
    };
    const plans = [planWithNoTasks];
    mockPlansList.mockResolvedValue({ plans, edges: [] });
    const store = createStore(plans, undefined, []);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const planTasksBtn = await screen.findByTestId("plan-tasks-button");
    await user.click(planTasksBtn);

    await waitFor(() => {
      expect(mockPlanTasks).toHaveBeenCalledWith("proj-1", "archive-test-feature");
    });
    await waitFor(() => {
      const notifications = store.getState().notification.items;
      expect(
        notifications.some((n: { message: string }) => n.message === "Tasks generated successfully")
      ).toBe(true);
    });
  });
});

describe("PlanPhase executePlan thunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("dispatches executePlan thunk when Execute is clicked (no cross-epic deps)", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
    const plans = [
      {
        ...basePlan,
        status: "planning" as const,
        metadata: { ...basePlan.metadata },
      },
    ];
    mockPlansList.mockResolvedValue({ plans, edges: [] });
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const executeBtn = await screen.findByRole("button", { name: "Execute" });
    await user.click(executeBtn);

    await waitFor(() => {
      expect(mockGetCrossEpicDependencies).toHaveBeenCalledWith("proj-1", "archive-test-feature");
      expect(mockExecute).toHaveBeenCalledWith("proj-1", "archive-test-feature", undefined);
    });
  });

  it("dispatches executePlan with version_number when Execute vN is clicked", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
    const plans = [
      {
        ...basePlan,
        status: "planning" as const,
        metadata: { ...basePlan.metadata },
        lastExecutedVersionNumber: 1,
      },
    ];
    mockPlansList.mockResolvedValue({ plans, edges: [] });
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const executeBtn = await screen.findByRole("button", { name: "Execute v1" });
    await user.click(executeBtn);

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledWith("proj-1", "archive-test-feature", {
        version_number: 1,
      });
    });
  });

  it("hides Auditor Runs section when selected plan version is still in Planning", async () => {
    const planInPlanning = {
      ...basePlan,
      status: "planning" as const,
      metadata: { ...basePlan.metadata },
      currentVersionNumber: 1,
      // no lastExecutedVersionNumber => plan never executed
    };
    mockPlansList.mockResolvedValue({ plans: [planInPlanning], edges: [] });
    const store = createStore([planInPlanning]);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await waitFor(() => {
      expect(screen.getByTestId("plan-version-selector")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("auditor-runs-section")).not.toBeInTheDocument();
  });

  it("shows Auditor Runs section when selected version has been executed", async () => {
    // Current version is 1 and it has been executed → section visible
    const planExecuted = {
      ...basePlan,
      status: "building" as const,
      metadata: { ...basePlan.metadata },
      currentVersionNumber: 1,
      lastExecutedVersionNumber: 1,
    };
    mockPlansList.mockResolvedValue({ plans: [planExecuted], edges: [] });
    mockPlansListVersions.mockResolvedValue([
      { id: "v1", version_number: 1, created_at: "", is_executed_version: true },
    ]);
    const store = createStore([planExecuted]);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await waitFor(() => {
      expect(screen.getByTestId("auditor-runs-section")).toBeInTheDocument();
    });
  });

  it("hides Auditor Runs when current version is ahead of last executed (version in Planning)", async () => {
    // Current v2, only v1 executed → selected (current) version still in Planning
    const planCurrentInPlanning = {
      ...basePlan,
      status: "building" as const,
      metadata: { ...basePlan.metadata },
      currentVersionNumber: 2,
      lastExecutedVersionNumber: 1,
    };
    mockPlansList.mockResolvedValue({ plans: [planCurrentInPlanning], edges: [] });
    mockPlansListVersions.mockResolvedValue([
      { id: "v1", version_number: 1, created_at: "", is_executed_version: true },
      { id: "v2", version_number: 2, created_at: "", is_executed_version: false },
    ]);
    const store = createStore([planCurrentInPlanning]);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );
    await waitFor(() => {
      expect(screen.getByTestId("plan-version-selector")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("auditor-runs-section")).not.toBeInTheDocument();
  });

  it("shows cross-epic modal and passes prerequisites when user confirms", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({
      prerequisitePlanIds: ["user-auth", "feature-base"],
    });
    const plans = [
      {
        ...basePlan,
        status: "planning" as const,
        metadata: { ...basePlan.metadata },
      },
    ];
    mockPlansList.mockResolvedValue({ plans, edges: [] });
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const executeBtn = await screen.findByRole("button", { name: "Execute" });
    await user.click(executeBtn);

    await waitFor(() => {
      expect(screen.getByText(/Cross-epic dependencies/)).toBeInTheDocument();
      expect(screen.getByText(/User Auth, Feature Base/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Proceed/ }));

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledWith(
        "proj-1",
        "archive-test-feature",
        expect.objectContaining({ prerequisitePlanIds: ["user-auth", "feature-base"] })
      );
    });
  });
});

describe("PlanPhase Execute loading and double-click prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("disables Execute button immediately on click (before async resolves)", async () => {
    let resolveDeps: (v: { prerequisitePlanIds: string[] }) => void;
    mockGetCrossEpicDependencies.mockImplementation(
      () =>
        new Promise((r) => {
          resolveDeps = r;
        })
    );
    const plans = [
      { ...basePlan, status: "planning" as const, metadata: { ...basePlan.metadata } },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const executeBtn = await screen.findByRole("button", { name: "Execute" });
    await user.click(executeBtn);

    expect(store.getState().plan.executingPlanId).toBe("archive-test-feature");
    const btn = screen.getByTestId("execute-button");
    expect(btn).toBeDisabled();

    resolveDeps!({ prerequisitePlanIds: [] });
    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalled();
    });
  });

  it("shows spinner inside Execute button while executing", async () => {
    let resolveExec: () => void;
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
    mockExecute.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveExec = r;
        })
    );
    const plans = [
      { ...basePlan, status: "planning" as const, metadata: { ...basePlan.metadata } },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const executeBtn = await screen.findByRole("button", { name: "Execute" });
    await user.click(executeBtn);

    await waitFor(() => {
      expect(screen.getByTestId("execute-spinner")).toBeInTheDocument();
      expect(screen.getByText("Executing…")).toBeInTheDocument();
    });

    resolveExec!();
    await waitFor(() => {
      expect(store.getState().plan.executingPlanId).toBeNull();
    });
  });

  it("prevents duplicate executions on rapid clicks", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
    mockExecute.mockImplementation(() => new Promise<void>((r) => setTimeout(r, 100)));
    const plans = [
      { ...basePlan, status: "planning" as const, metadata: { ...basePlan.metadata } },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const executeBtn = await screen.findByRole("button", { name: "Execute" });
    await user.click(executeBtn);

    const btn = screen.getByTestId("execute-button");
    expect(btn).toBeDisabled();
  });

  it("shows inline error on the EpicCard when execution fails", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
    mockExecute.mockRejectedValue(new Error("Agent spawn failed"));
    mockPlansList.mockResolvedValue({
      plans: [{ ...basePlan, status: "planning" as const, metadata: { ...basePlan.metadata } }],
      edges: [],
    });
    const plans = [
      { ...basePlan, status: "planning" as const, metadata: { ...basePlan.metadata } },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const executeBtn = await screen.findByRole("button", { name: "Execute" });
    await user.click(executeBtn);

    await waitFor(() => {
      expect(store.getState().plan.executeError).toEqual({
        planId: "archive-test-feature",
        message: "Agent spawn failed",
      });
    });

    const inlineError = screen.getByTestId("execute-error-inline");
    expect(inlineError).toBeInTheDocument();
    expect(within(inlineError).getByText("Agent spawn failed")).toBeInTheDocument();

    const btn = screen.getByTestId("execute-button");
    expect(btn).not.toBeDisabled();
  });

  it("re-enables Execute button after failure so user can retry", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
    mockExecute.mockRejectedValue(new Error("Fail"));
    const plans = [
      { ...basePlan, status: "planning" as const, metadata: { ...basePlan.metadata } },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(await screen.findByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(store.getState().plan.executingPlanId).toBeNull();
    });

    const btn = screen.getByTestId("execute-button");
    expect(btn).not.toBeDisabled();
  });

  it("clears inline error when dismiss button is clicked", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
    mockExecute.mockRejectedValue(new Error("Fail"));
    const plans = [
      { ...basePlan, status: "planning" as const, metadata: { ...basePlan.metadata } },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(await screen.findByRole("button", { name: "Execute" }));
    await waitFor(() => {
      expect(screen.getByTestId("execute-error-inline")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /dismiss execute error/i }));
    expect(screen.queryByTestId("execute-error-inline")).not.toBeInTheDocument();
    expect(store.getState().plan.executeError).toBeNull();
  });

  it("re-enables button when cross-epic modal is shown (modal overlay blocks interaction)", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({
      prerequisitePlanIds: ["user-auth"],
    });
    const plans = [
      { ...basePlan, status: "planning" as const, metadata: { ...basePlan.metadata } },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(await screen.findByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(screen.getByText(/Cross-epic dependencies/)).toBeInTheDocument();
    });

    expect(store.getState().plan.executingPlanId).toBeNull();

    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(screen.queryByText(/Cross-epic dependencies/)).not.toBeInTheDocument();
  });
});

describe("PlanPhase reExecutePlan thunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("dispatches reExecutePlan thunk when Re-execute is clicked", async () => {
    const plans = [
      {
        ...basePlan,
        status: "complete" as const,
        doneTaskCount: 2,
        metadata: {
          ...basePlan.metadata,
          shippedAt: "2026-02-16T08:00:00.000Z",
        },
        lastModified: "2026-02-16T10:00:00.000Z",
      },
    ];
    mockPlansList.mockResolvedValue({ plans, edges: [] });
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const reExecuteBtn = await screen.findByRole("button", { name: "Re-execute" });
    await user.click(reExecuteBtn);

    await waitFor(() => {
      expect(mockReExecute).toHaveBeenCalledWith("proj-1", "archive-test-feature");
    });
  });
});

describe("PlanPhase plan sorting and status filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("sorts plans by status order: planning, building, in_review, complete", () => {
    const plans = [
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "done-feature" },
        status: "complete" as const,
      },
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "planning-feature" },
        status: "planning" as const,
      },
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "in-review-feature" },
        status: "in_review" as const,
      },
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "building-feature" },
        status: "building" as const,
      },
    ];
    const store = createStore(plans);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const planningCard = screen.getByText("Planning Feature").closest('[role="button"]');
    const buildingCard = screen.getByText("Building Feature").closest('[role="button"]');
    const inReviewCard = screen.getByText("In Review Feature").closest('[role="button"]');
    const doneCard = screen.getByText("Done Feature").closest('[role="button"]');
    expect(planningCard).toBeInTheDocument();
    expect(buildingCard).toBeInTheDocument();
    expect(inReviewCard).toBeInTheDocument();
    expect(doneCard).toBeInTheDocument();

    const order = [planningCard!, buildingCard!, inReviewCard!, doneCard!];
    for (let i = 0; i < order.length - 1; i++) {
      const pos = order[i].compareDocumentPosition(order[i + 1]);
      expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it("Mark complete button on in_review plan calls markPlanComplete and invalidates list", async () => {
    const plans = [
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "in-review-feature" },
        status: "in_review" as const,
        taskCount: 2,
        doneTaskCount: 2,
      },
    ];
    mockPlansList.mockResolvedValue({ plans, edges: [] });
    const store = createStore(plans);
    const queryClient = createPlanPhaseQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper }
    );

    await waitFor(() => {
      expect(screen.getByText("In Review Feature")).toBeInTheDocument();
    });
    const markCompleteBtn = screen.getByTestId("plan-mark-complete-button");
    expect(markCompleteBtn).toBeInTheDocument();
    expect(markCompleteBtn).toHaveTextContent(/^Mark complete$/);
    await user.click(markCompleteBtn);
    await waitFor(() => {
      expect(mockMarkPlanComplete).toHaveBeenCalledWith("proj-1", "in-review-feature");
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: queryKeys.plans.list("proj-1") })
      );
    });
  });

  it("renders status filter chips when plans exist", () => {
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const allChip = screen.getByRole("radio", { name: /all 1/i });
    expect(allChip).toBeInTheDocument();
    expect(allChip).toHaveAttribute("aria-checked", "true");
  });

  it("filters plans when status filter is changed", async () => {
    const plans = [
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "planning-feature" },
        status: "planning" as const,
      },
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "building-feature" },
        status: "building" as const,
      },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByText(/planning feature/i)).toBeInTheDocument();
    expect(screen.getByText(/building feature/i)).toBeInTheDocument();

    const planningChip = screen.getByRole("radio", { name: /planning 1/i });
    await user.click(planningChip);

    expect(screen.getByText(/planning feature/i)).toBeInTheDocument();
    expect(screen.queryByText(/building feature/i)).not.toBeInTheDocument();
  });

  it("hides filter chips when count is 0", () => {
    const plans = [
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "planning-feature" },
        status: "planning" as const,
      },
    ];
    const store = createStore(plans);
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByRole("radio", { name: /all 1/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /planning 1/i })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /building 0/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /complete 0/i })).not.toBeInTheDocument();
  });
});

describe("PlanPhase sendPlanMessage thunk", () => {
  const storage: Record<string, string> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    Object.keys(storage).forEach((k) => delete storage[k]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
      length: 0,
      key: () => null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders secondary top bar with filter chips and view toggle (Card/Graph)", async () => {
    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    // Filter chips (chips with count 0 are hidden)
    expect(screen.getByRole("radio", { name: /all 1/i })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /planning 0/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /building 1/i })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /complete 0/i })).not.toBeInTheDocument();

    // View toggle: Card (default) and Graph
    const cardView = screen.getByRole("radio", { name: /card view/i });
    const graphView = screen.getByRole("radio", { name: /graph view/i });
    expect(cardView).toBeInTheDocument();
    expect(graphView).toBeInTheDocument();
    expect(cardView).toHaveAttribute("aria-checked", "true");
    expect(graphView).toHaveAttribute("aria-checked", "false");

    // Card mode shows Feature Plans
    expect(screen.getByText("Feature Plans")).toBeInTheDocument();
  });

  it("switches between Card and Graph view modes", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    // Default: Card mode
    expect(screen.getByText("Feature Plans")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-graph-view")).not.toBeInTheDocument();

    // Switch to Graph mode
    const graphView = screen.getByRole("radio", { name: /graph view/i });
    await user.click(graphView);

    expect(screen.getByTestId("plan-graph-view")).toBeInTheDocument();
    expect(screen.queryByText("Feature Plans")).not.toBeInTheDocument();

    // Switch back to Card mode
    const cardView = screen.getByRole("radio", { name: /card view/i });
    await user.click(cardView);

    expect(screen.getByText("Feature Plans")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-graph-view")).not.toBeInTheDocument();
  });

  it("persists view mode to localStorage", async () => {
    const store = createStore();
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    // Switch to Graph mode
    const graphView = screen.getByRole("radio", { name: /graph view/i });
    await user.click(graphView);
    expect(storage["opensprint.planView"]).toBe("graph");

    // Switch to Card mode
    const cardView = screen.getByRole("radio", { name: /card view/i });
    await user.click(cardView);
    expect(storage["opensprint.planView"]).toBe("card");
  });

  it("restores view mode from localStorage on mount", async () => {
    storage["opensprint.planView"] = "graph";

    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    expect(screen.getByRole("radio", { name: /graph view/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(screen.getByTestId("plan-graph-view")).toBeInTheDocument();
  });

  it("positions dependency graph nodes on initial graph-view render without a click", async () => {
    storage["opensprint.planView"] = "graph";

    let resizeCallback: ((entries: unknown[]) => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: (entries: unknown[]) => void) {
          resizeCallback = cb;
        }

        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver
    );

    const planA = {
      ...basePlan,
      metadata: { ...basePlan.metadata, planId: "plan-a", epicId: "epic-a" },
      status: "planning" as const,
    };
    const planB = {
      ...basePlan,
      metadata: { ...basePlan.metadata, planId: "plan-b", epicId: "epic-b" },
      status: "building" as const,
    };
    const planC = {
      ...basePlan,
      metadata: { ...basePlan.metadata, planId: "plan-c", epicId: "epic-c" },
      status: "complete" as const,
    };
    const graph = {
      plans: [planA, planB, planC],
      edges: [
        { from: "plan-a", to: "plan-b", type: "blocks" as const },
        { from: "plan-b", to: "plan-c", type: "blocks" as const },
      ],
    };

    const store = createStore([planA, planB, planC]);
    act(() => {
      store.dispatch(setPlansAndGraph({ plans: graph.plans, dependencyGraph: graph }));
      store.dispatch(setSelectedPlanId(null));
    });

    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const graphView = screen.getByTestId("plan-graph-view");
    const graphRoot = graphView.firstElementChild as HTMLElement;
    Object.defineProperty(graphRoot, "clientWidth", { value: 900, configurable: true });
    Object.defineProperty(graphRoot, "clientHeight", { value: 420, configurable: true });
    act(() => resizeCallback?.([]));

    await waitFor(() => {
      expect(graphView.querySelectorAll("svg g.nodes g").length).toBe(3);
    });

    const transforms = Array.from(graphView.querySelectorAll("svg g.nodes g")).map((node) =>
      node.getAttribute("transform")
    );
    for (const transform of transforms) {
      expect(transform).toMatch(/^translate\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)$/);
    }
    expect(new Set(transforms).size).toBeGreaterThan(1);
  });

  it("dispatches sendPlanMessage thunk when chat message is sent", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const chatInput = screen.getByPlaceholderText(/refine this plan/i);
    await user.type(chatInput, "Add more detail to the auth section");
    const sendButton = screen.getByRole("button", { name: /send/i });
    await user.click(sendButton);

    expect(mockChatSend).toHaveBeenCalledWith(
      "proj-1",
      "Add more detail to the auth section",
      "plan:archive-test-feature"
    );
  });

  it("displays user and assistant messages in chat after sending", async () => {
    mockChatSend.mockResolvedValue({ message: "AI response" });
    // Initial fetch returns empty; refetch after send returns persisted messages (matches real server)
    const persistedAfterSend = [
      { role: "user" as const, content: "Add more detail", timestamp: "2025-01-01" },
      { role: "assistant" as const, content: "AI response", timestamp: "2025-01-01" },
    ];
    vi.mocked(api.chat.history)
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValue({ messages: persistedAfterSend });

    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    const chatInput = await screen.findByPlaceholderText(/refine this plan/i);
    await user.type(chatInput, "Add more detail");
    const sendButton = screen.getByRole("button", { name: /send/i });
    await user.click(sendButton);

    const chatMessages = screen.getByTestId("plan-chat-messages");
    await waitFor(
      () => {
        expect(within(chatMessages).getByText("Add more detail")).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
    await waitFor(
      () => {
        expect(within(chatMessages).getByText("AI response")).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it("displays persisted chat messages when plan is selected", async () => {
    const persistedMessages = [
      { role: "user" as const, content: "Can you add more detail?", timestamp: "2025-01-01" },
      {
        role: "assistant" as const,
        content: "Sure, I can help with that.",
        timestamp: "2025-01-01",
      },
    ];
    vi.mocked(api.chat.history).mockResolvedValueOnce({ messages: persistedMessages });

    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await waitFor(() => {
      expect(screen.getByText("Can you add more detail?")).toBeInTheDocument();
      expect(screen.getByText("Sure, I can help with that.")).toBeInTheDocument();
    });
  });

  it("displays 'Plan updated' instead of full plan content when assistant message contains [PLAN_UPDATE]", async () => {
    const persistedMessages = [
      { role: "user" as const, content: "Add OAuth support", timestamp: "2025-01-01" },
      {
        role: "assistant" as const,
        content: `[PLAN_UPDATE]
# Auth Plan

## Overview
Updated auth flow with OAuth support.

## Acceptance Criteria
- User can sign in with Google
[/PLAN_UPDATE]`,
        timestamp: "2025-01-01",
      },
    ];
    vi.mocked(api.chat.history).mockResolvedValueOnce({ messages: persistedMessages });

    const store = createStore();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await waitFor(() => {
      expect(screen.getByText("Add OAuth support")).toBeInTheDocument();
      expect(screen.getByText("Plan updated")).toBeInTheDocument();
      expect(screen.queryByText(/User can sign in with Google/)).not.toBeInTheDocument();
      expect(screen.queryByText(/\[PLAN_UPDATE\]/)).not.toBeInTheDocument();
    });
  });

  it("displays chat and persisted messages when selectedPlanId from URL but plan not yet in list (deep link)", async () => {
    const persistedMessages = [
      { role: "user" as const, content: "Add auth section", timestamp: "2025-01-01" },
      {
        role: "assistant" as const,
        content: "I added the auth section.",
        timestamp: "2025-01-01",
      },
    ];
    vi.mocked(api.chat.history).mockResolvedValueOnce({ messages: persistedMessages });

    const store = createStore([], null, defaultExecuteTasks, { selectedPlanId: "deep-link-plan" });

    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await waitFor(() => {
      expect(screen.getByText("Add auth section")).toBeInTheDocument();
      expect(screen.getByText("I added the auth section.")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/refine this plan/i)).toBeInTheDocument();
  });

  it("persists chat messages across reload (fetch replaces empty state with server data)", async () => {
    const persistedMessages = [
      { role: "user" as const, content: "Add more detail", timestamp: "2025-01-01" },
      {
        role: "assistant" as const,
        content: "I've updated the plan.",
        timestamp: "2025-01-01",
      },
    ];
    vi.mocked(api.chat.history).mockResolvedValue({ messages: persistedMessages });

    // Simulate reload: start with empty chatMessages (as after page refresh)
    const store = createStore(undefined, null, defaultExecuteTasks, {
      selectedPlanId: "archive-test-feature",
      chatMessages: {},
    });

    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await waitFor(() => {
      expect(screen.getByText("Add more detail")).toBeInTheDocument();
      expect(screen.getByText("I've updated the plan.")).toBeInTheDocument();
    });
    expect(api.chat.history).toHaveBeenCalledWith("proj-1", "plan:archive-test-feature");
  });
});

describe("PlanPhase open questions", () => {
  it("renders OpenQuestionsBlock in plan sidebar when planner has open questions", async () => {
    const planNotification = {
      id: "oq-plan-1",
      projectId: "proj-1",
      source: "plan" as const,
      sourceId: "archive-test-feature",
      questions: [
        { id: "q1", text: "What is the expected user flow?", createdAt: "2025-01-01T00:00:00Z" },
      ],
      status: "open" as const,
      createdAt: "2025-01-01T00:00:00Z",
      resolvedAt: null,
    };
    vi.mocked(api.notifications.listByProject).mockResolvedValue([planNotification]);

    const store = createStore(undefined, null, defaultExecuteTasks, {
      selectedPlanId: "archive-test-feature",
    });
    act(() => {
      store.dispatch(addOpenQuestionNotification(planNotification as never));
    });

    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await waitFor(() => {
      expect(screen.getByTestId("open-questions-block")).toBeInTheDocument();
    });
    expect(screen.getByText("What is the expected user flow?")).toBeInTheDocument();
    expect(screen.getByTestId("open-questions-answer-btn")).toBeInTheDocument();
    expect(screen.getByTestId("open-questions-dismiss-btn")).toBeInTheDocument();
  });
});

describe("PlanPhase Generate Plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("enables Generate Plan button when user types a description in Add Plan modal", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    const textarea = screen.getByTestId("feature-description-input");
    const button = screen.getByTestId("generate-plan-button");

    expect(button).toBeDisabled();
    await user.type(textarea, "A user authentication feature");
    expect(button).not.toBeDisabled();
  });

  it("keeps Generate Plan button disabled for whitespace-only input in Add Plan modal", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    const textarea = screen.getByTestId("feature-description-input");
    const button = screen.getByTestId("generate-plan-button");

    await user.type(textarea, "   ");
    expect(button).toBeDisabled();
  });

  it("calls generate API when Generate Plan is clicked in Add Plan modal and shows optimistic card", async () => {
    let resolveGenerate: (v: unknown) => void;
    const generatePromise = new Promise((r) => {
      resolveGenerate = r;
    });
    mockGenerate.mockReturnValueOnce(generatePromise as never);

    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    const textarea = screen.getByTestId("feature-description-input");
    await user.type(textarea, "Add dark mode support");

    const button = screen.getByTestId("generate-plan-button");
    await user.click(button);

    expect(screen.queryByTestId("add-plan-modal")).not.toBeInTheDocument();
    const { optimisticPlans } = store.getState().plan;
    expect(optimisticPlans).toHaveLength(1);
    expect(optimisticPlans[0].title).toBe("Add dark mode support");
    expect(mockGenerate).toHaveBeenCalledWith("proj-1", { description: "Add dark mode support" });

    resolveGenerate!({
      status: "created",
      plan: {
        metadata: {
          planId: "generated-feature",
          epicId: "e2",
          complexity: "medium",
          shippedAt: null,
        },
        content: "# Generated Feature\n\nContent.",
        status: "planning",
        taskCount: 2,
        doneTaskCount: 0,
        dependencyCount: 0,
      },
    });
    await waitFor(() => {
      expect(store.getState().plan.optimisticPlans).toHaveLength(0);
      expect(store.getState().plan.plans).toHaveLength(2);
    });
  });

  it("closes Add Plan modal after submitting", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    await user.type(screen.getByTestId("feature-description-input"), "Some feature");
    await user.click(screen.getByTestId("generate-plan-button"));

    expect(screen.queryByTestId("add-plan-modal")).not.toBeInTheDocument();
  });

  it("shows error notification when generation fails", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("Agent unavailable"));
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    await user.type(screen.getByTestId("feature-description-input"), "Feature idea");
    await user.click(screen.getByTestId("generate-plan-button"));

    await waitFor(() => {
      const notifications = store.getState().notification.items;
      const errorToast = notifications.find((n: { severity: string }) => n.severity === "error");
      expect(errorToast).toBeDefined();
    });
  });

  it("shows info notification when generation needs clarification", async () => {
    mockGenerate.mockResolvedValueOnce({
      status: "needs_clarification",
      draftId: "draft-1",
      resumeContext: "plan-draft:draft-1",
      notification: {
        id: "oq-draft-1",
        projectId: "proj-1",
        source: "plan",
        sourceId: "draft:draft-1",
        questions: [
          { id: "q1", text: "Which volunteer roles should be supported?", createdAt: "2025-01-01" },
        ],
        status: "open",
        createdAt: "2025-01-01",
        resolvedAt: null,
      },
    });
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    await user.type(screen.getByTestId("feature-description-input"), "Volunteer signup form");
    await user.click(screen.getByTestId("generate-plan-button"));

    await waitFor(() => {
      const notifications = store.getState().notification.items;
      expect(
        notifications.find(
          (n: { message: string }) =>
            n.message === "Planner needs clarification before generating this plan"
        )
      ).toBeDefined();
    });
  });

  it("renders draft planner questions without a selected plan and answers through plan-draft context", async () => {
    const draftNotification = {
      id: "oq-draft-2",
      projectId: "proj-1",
      source: "plan" as const,
      sourceId: "draft:draft-2",
      questions: [
        {
          id: "q1",
          text: "Which volunteer roles should be supported?",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
      status: "open" as const,
      createdAt: "2025-01-01T00:00:00Z",
      resolvedAt: null,
    };
    vi.mocked(api.notifications.listByProject).mockResolvedValue([draftNotification]);
    mockChatSend.mockResolvedValueOnce({
      message: "Plan generated",
      planGenerated: { planId: "volunteer-signup-form" },
    });

    const store = createStore([basePlan], null, defaultExecuteTasks, { selectedPlanId: null });
    const user = userEvent.setup();
    act(() => {
      store.dispatch(addOpenQuestionNotification(draftNotification as never));
    });

    render(
      <MemoryRouter initialEntries={["/projects/proj-1/plan?question=oq-draft-2"]}>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await waitFor(() => {
      expect(screen.getByText("Which volunteer roles should be supported?")).toBeInTheDocument();
    });

    const answer = screen.getByTestId("open-questions-answer-input");
    await user.type(answer, "General volunteers and mentors");
    await user.click(screen.getByTestId("open-questions-answer-btn"));

    await waitFor(() => {
      expect(mockChatSend).toHaveBeenCalledWith(
        "proj-1",
        "General volunteers and mentors",
        "plan-draft:draft-2"
      );
      expect(mockNotificationResolve).toHaveBeenCalledWith("proj-1", "oq-draft-2");
      expect(store.getState().plan.selectedPlanId).toBe("volunteer-signup-form");
    });
  });

  it("Add Plan modal has Feature plan idea label", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    expect(screen.getByText("Feature plan idea")).toBeInTheDocument();
    expect(screen.getByLabelText("Feature plan idea")).toBeInTheDocument();
  });

  it("Add Plan modal textarea accepts multi-line text (Shift+Enter for newline)", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    const textarea = screen.getByTestId("feature-description-input") as HTMLTextAreaElement;
    await user.type(textarea, "Line 1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(textarea, "Line 2");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(textarea, "Line 3");
    expect(textarea.value).toContain("Line 1");
    expect(textarea.value).toContain("Line 2");
    expect(textarea.value).toContain("Line 3");
  });

  it("keeps Add Plan modal usable for queuing multiple plans when generating (optimistic UX)", async () => {
    const store = configureStore({
      reducer: {
        project: projectReducer,
        plan: planReducer,
        execute: executeReducer,
        notification: notificationReducer,
        unreadPhase: unreadPhaseReducer,
      },
      preloadedState: {
        plan: {
          plans: [basePlan],
          dependencyGraph: null,
          selectedPlanId: "archive-test-feature",
          chatMessages: {},
          loading: false,
          decomposing: false,
          generating: true,
          planStatus: null,
          executingPlanId: null,
          reExecutingPlanId: null,
          archivingPlanId: null,
          planTasksPlanIds: [],
          optimisticPlans: [],
          error: null,
          executeError: null,
          backgroundError: null,
        },
        execute: {
          ...toTasksByIdAndOrder([]),
          orchestratorRunning: false,
          awaitingApproval: false,
          selectedTaskId: null,
          taskDetailLoading: false,
          taskDetailError: null,
          agentOutput: {},
          completionState: null,
          archivedSessions: [],
          archivedLoading: false,
          markDoneLoading: false,
          unblockLoading: false,
          statusLoading: false,
          loading: false,
          error: null,
        },
      },
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    expect(screen.getByTestId("add-plan-modal")).toBeInTheDocument();
    expect(screen.getByText("Generate Plan")).toBeInTheDocument();
    const textarea = screen.getByTestId("feature-description-input");
    expect(textarea).not.toBeDisabled();
  });

  it("queues multiple plans when user submits several in quick succession via Add Plan modal", async () => {
    let resolveFirst: (v: unknown) => void;
    const firstPromise = new Promise((r) => {
      resolveFirst = r;
    });
    mockGenerate.mockReturnValueOnce(firstPromise as never).mockResolvedValueOnce({
      status: "created",
      plan: {
        metadata: {
          planId: "second-feature",
          epicId: "e3",
          complexity: "medium",
          shippedAt: null,
        },
        content: "# Second\n\nContent.",
        status: "planning",
        taskCount: 0,
        doneTaskCount: 0,
        dependencyCount: 0,
      },
    });

    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    await user.type(screen.getByTestId("feature-description-input"), "First feature idea");
    await user.click(screen.getByTestId("generate-plan-button"));

    expect(store.getState().plan.optimisticPlans).toHaveLength(1);
    expect(store.getState().plan.optimisticPlans[0].title).toBe("First feature idea");

    await user.click(screen.getByTestId("add-plan-button"));
    await user.type(screen.getByTestId("feature-description-input"), "Second feature idea");
    await user.click(screen.getByTestId("generate-plan-button"));

    expect(store.getState().plan.optimisticPlans).toHaveLength(2);
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    resolveFirst!({
      status: "created",
      plan: {
        metadata: {
          planId: "first-feature",
          epicId: "e2",
          complexity: "medium",
          shippedAt: null,
        },
        content: "# First\n\nContent.",
        status: "planning",
        taskCount: 0,
        doneTaskCount: 0,
        dependencyCount: 0,
      },
    });

    await waitFor(() => {
      expect(store.getState().plan.optimisticPlans).toHaveLength(1);
      expect(mockGenerate).toHaveBeenCalledTimes(2);
    });
  });

  it("does not call generate API when description is empty in Add Plan modal", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Provider store={store}>
          <PlanPhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>,
      { wrapper: PlanPhaseWrapper }
    );

    await user.click(screen.getByTestId("add-plan-button"));
    const button = screen.getByTestId("generate-plan-button");
    expect(button).toBeDisabled();
    await user.click(button);

    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
