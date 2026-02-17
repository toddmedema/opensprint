import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { PlanPhase, DEPENDENCY_GRAPH_EXPANDED_KEY } from "./PlanPhase";
import projectReducer from "../../store/slices/projectSlice";
import planReducer from "../../store/slices/planSlice";
import executeReducer from "../../store/slices/executeSlice";

const mockArchive = vi.fn().mockResolvedValue(undefined);
const mockExecute = vi.fn().mockResolvedValue(undefined);
const mockReExecute = vi.fn().mockResolvedValue(undefined);
const mockGetCrossEpicDependencies = vi.fn().mockResolvedValue({ prerequisitePlanIds: [] });
const mockPlansUpdate = vi.fn().mockResolvedValue({
  metadata: {
    planId: "archive-test-feature",
    beadEpicId: "epic-1",
    gateTaskId: "epic-1.0",
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
        beadEpicId: "epic-1",
        gateTaskId: "epic-1.0",
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
    beadEpicId: "epic-1",
    gateTaskId: "epic-1.0",
    complexity: "medium",
  },
  content: "# Archive Test\n\nContent.",
  status: "building",
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
});
const mockPlansCreate = vi.fn().mockResolvedValue({
  metadata: { planId: "new-feature", beadEpicId: "e1", gateTaskId: "e1.0", complexity: "medium" },
  content: "# New Feature\n\nContent.",
  status: "planning",
  taskCount: 0,
  doneTaskCount: 0,
  dependencyCount: 0,
});
vi.mock("../../api/client", () => ({
  api: {
    plans: {
      list: (...args: unknown[]) => mockPlansList(...args),
      get: (...args: unknown[]) => mockPlansGet(...args),
      create: (...args: unknown[]) => mockPlansCreate(...args),
      update: (...args: unknown[]) => mockPlansUpdate(...args),
      archive: (...args: unknown[]) => mockArchive(...args),
      getCrossEpicDependencies: (...args: unknown[]) => mockGetCrossEpicDependencies(...args),
      execute: (...args: unknown[]) => mockExecute(...args),
      reExecute: (...args: unknown[]) => mockReExecute(...args),
    },
    tasks: { list: vi.fn().mockResolvedValue([]) },
    chat: {
      history: vi.fn().mockResolvedValue({ messages: [] }),
      send: (...args: unknown[]) => mockChatSend(...args),
    },
  },
}));

const basePlan = {
  metadata: {
    planId: "archive-test-feature",
    beadEpicId: "epic-1",
    gateTaskId: "epic-1.0",
    complexity: "medium" as const,
  },
  content: "# Archive Test\n\nContent.",
  status: "building" as const,
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
};

function createStore(plansOverride?: typeof basePlan[]) {
  const plans = plansOverride ?? [basePlan];

  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
    },
    preloadedState: {
      plan: {
        plans,
        dependencyGraph: null,
        selectedPlanId: "archive-test-feature",
        chatMessages: {},
        loading: false,
        decomposing: false,
        planStatus: null,
        executingPlanId: null,
        reExecutingPlanId: null,
        archivingPlanId: null,
        error: null,
      },
      execute: {
        tasks: [
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
        ],
        plans: [],
        awaitingApproval: false,
        selectedTaskId: null,
        taskDetail: null,
        agentOutput: [],
        completionState: null,
        archivedSessions: [],
        archivedLoading: false,
        loading: false,
        error: null,
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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByRole("progressbar", { name: /tasks done/i })).toBeInTheDocument();
    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.getByText("Task B")).toBeInTheDocument();
    expect(screen.getByText(/0\/2 done/)).toBeInTheDocument();
  });

  it("renders plans from Redux state via useAppSelector", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText("Archive Test Feature")).toBeInTheDocument();
    expect(screen.getByText(/archive test/i)).toBeInTheDocument();
  });

  it("keeps chatInput and showAddPlanModal as local state (Add Feature opens modal)", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const addButton = screen.getAllByRole("button", { name: /add feature/i })[0];
    await user.click(addButton);

    expect(screen.getByText("Feature Title")).toBeInTheDocument();
  });

  it("closes Add Plan modal when X close button is clicked", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    await user.click(screen.getAllByRole("button", { name: /add feature/i })[0]);
    expect(screen.getByText("Feature Title")).toBeInTheDocument();

    const closeBtn = screen.getByRole("button", { name: "Close add plan modal" });
    await user.click(closeBtn);

    expect(screen.queryByText("Feature Title")).not.toBeInTheDocument();
  });
});

describe("PlanPhase archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders archive icon button in plan details sidebar when a plan is selected", async () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const archiveButton = screen.getByTitle("Archive plan (mark all ready/open tasks as done)");
    expect(archiveButton).toBeInTheDocument();
  });

  it("has main content area with overflow-y-auto, min-w-0, and min-h-0 for independent scroll", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );
    const mainContent = screen.getByText("Feature Plans").closest(".overflow-y-auto");
    expect(mainContent).toBeInTheDocument();
    expect(mainContent).toHaveClass("min-w-0");
    expect(mainContent).toHaveClass("min-h-0");
  });

  it("has root with flex flex-1 min-h-0 min-w-0 for proper fill and independent page/sidebar scroll", () => {
    const store = createStore();
    const { container } = render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeInTheDocument();
  });

  it("calls archive API when archive button is clicked", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const archiveButton = screen.getByTitle("Archive plan (mark all ready/open tasks as done)");
    await user.click(archiveButton);

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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByRole("textbox", { name: /plan title/i })).toBeInTheDocument();
    expect(container.querySelector('[data-prd-section="plan-body"]')).toBeInTheDocument();
  });

  it("does not render duplicate plan title in sidebar header", () => {
    const store = createStore();
    const { container } = render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );
    // Plan title should appear only once (in the editable input), not in a sidebar header h3
    const headings = container.querySelectorAll("h3");
    const headingWithPlanTitle = Array.from(headings).filter(
      (h) => h.textContent?.includes("Archive Test") || h.textContent?.includes("archive test feature"),
    );
    expect(headingWithPlanTitle).toHaveLength(0);
  });

  it("dispatches updatePlan when plan title is edited and blurred", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const titleInput = screen.getByRole("textbox", { name: /plan title/i });
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
          }),
        );
      },
      { timeout: 2000 },
    );
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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByRole("button", { name: /re-execute/i })).toBeInTheDocument();
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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.queryByRole("button", { name: /re-execute/i })).not.toBeInTheDocument();
  });
});

describe("PlanPhase executePlan thunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("dispatches executePlan thunk when Execute! is clicked (no cross-epic deps)", async () => {
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
    const plans = [
      {
        ...basePlan,
        status: "planning" as const,
        metadata: { ...basePlan.metadata },
      },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const executeButton = screen.getByRole("button", { name: /execute!/i });
    await user.click(executeButton);

    await waitFor(() => {
      expect(mockGetCrossEpicDependencies).toHaveBeenCalledWith("proj-1", "archive-test-feature");
      expect(mockExecute).toHaveBeenCalledWith("proj-1", "archive-test-feature");
    });
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
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const executeButton = screen.getByRole("button", { name: /execute!/i });
    await user.click(executeButton);

    await waitFor(() => {
      expect(screen.getByText(/Cross-epic dependencies/)).toBeInTheDocument();
      expect(screen.getByText(/User Auth, Feature Base/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Proceed/ }));

    await waitFor(() => {
      expect(mockExecute).toHaveBeenCalledWith(
        "proj-1",
        "archive-test-feature",
        ["user-auth", "feature-base"],
      );
    });
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
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const reExecuteButton = screen.getByRole("button", { name: /re-execute/i });
    await user.click(reExecuteButton);

    expect(mockReExecute).toHaveBeenCalledWith("proj-1", "archive-test-feature");
  });
});

describe("PlanPhase plan sorting and status filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("sorts plans by status order: planning, building, complete", () => {
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
        metadata: { ...basePlan.metadata, planId: "building-feature" },
        status: "building" as const,
      },
    ];
    const store = createStore(plans);
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const planningCard = screen.getByText("Planning Feature").closest('[role="button"]');
    const buildingCard = screen.getByText("Building Feature").closest('[role="button"]');
    const doneCard = screen.getByText("Done Feature").closest('[role="button"]');
    expect(planningCard).toBeInTheDocument();
    expect(buildingCard).toBeInTheDocument();
    expect(doneCard).toBeInTheDocument();

    const order = [planningCard!, buildingCard!, doneCard!];
    for (let i = 0; i < order.length - 1; i++) {
      const pos = order[i].compareDocumentPosition(order[i + 1]);
      expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it("renders status filter dropdown when plans exist", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const filter = screen.getByRole("combobox", { name: /filter plans by status/i });
    expect(filter).toBeInTheDocument();
    expect(filter).toHaveValue("all");
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
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    expect(screen.getByText(/planning feature/i)).toBeInTheDocument();
    expect(screen.getByText(/building feature/i)).toBeInTheDocument();

    const filter = screen.getByRole("combobox", { name: /filter plans by status/i });
    await user.selectOptions(filter, "planning");

    expect(screen.getByText(/planning feature/i)).toBeInTheDocument();
    expect(screen.queryByText(/building feature/i)).not.toBeInTheDocument();
  });

  it("shows empty message when filter has no matches", async () => {
    const plans = [
      {
        ...basePlan,
        metadata: { ...basePlan.metadata, planId: "planning-feature" },
        status: "planning" as const,
      },
    ];
    const store = createStore(plans);
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const filter = screen.getByRole("combobox", { name: /filter plans by status/i });
    await user.selectOptions(filter, "complete");

    expect(screen.getByText(/no plans match/i)).toBeInTheDocument();
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

  it("renders Dependency Graph as collapsible container with expand/collapse toggle", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const header = screen.getByRole("button", { name: /dependency graph/i });
    expect(header).toBeInTheDocument();
    expect(header).toHaveAttribute("aria-expanded", "true");

    // Content visible when expanded
    const content = document.getElementById("dependency-graph-content");
    expect(content).toBeInTheDocument();

    // Click to collapse
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("dependency-graph-content")).toBeNull();

    // Click to expand again
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("dependency-graph-content")).toBeInTheDocument();
  });

  it("persists dependency graph expanded state to localStorage", async () => {
    const store = createStore();
    const user = userEvent.setup();

    // Default: no stored value → expanded (true)
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );
    const header = screen.getByRole("button", { name: /dependency graph/i });
    expect(header).toHaveAttribute("aria-expanded", "true");

    // Collapse → persists "false"
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(storage[DEPENDENCY_GRAPH_EXPANDED_KEY]).toBe("false");

    // Expand → persists "true"
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(storage[DEPENDENCY_GRAPH_EXPANDED_KEY]).toBe("true");
  });

  it("restores dependency graph expanded state from localStorage on mount", async () => {
    storage[DEPENDENCY_GRAPH_EXPANDED_KEY] = "false";

    const store = createStore();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const header = screen.getByRole("button", { name: /dependency graph/i });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("dependency-graph-content")).toBeNull();
  });

  it("dispatches sendPlanMessage thunk when chat message is sent", async () => {
    const store = createStore();
    const user = userEvent.setup();
    render(
      <Provider store={store}>
        <PlanPhase projectId="proj-1" />
      </Provider>,
    );

    const chatInput = screen.getByPlaceholderText(/refine this plan/i);
    await user.type(chatInput, "Add more detail to the auth section");
    const sendButton = screen.getByRole("button", { name: /send/i });
    await user.click(sendButton);

    expect(mockChatSend).toHaveBeenCalledWith(
      "proj-1",
      "Add more detail to the auth section",
      "plan:archive-test-feature",
    );
  });
});
