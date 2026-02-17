import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { PlanPhase } from "./PlanPhase";
import projectReducer from "../../store/slices/projectSlice";
import planReducer from "../../store/slices/planSlice";
import buildReducer from "../../store/slices/buildSlice";

const mockArchive = vi.fn().mockResolvedValue(undefined);
const mockShip = vi.fn().mockResolvedValue(undefined);
const mockReship = vi.fn().mockResolvedValue(undefined);
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
      archive: (...args: unknown[]) => mockArchive(...args),
      ship: (...args: unknown[]) => mockShip(...args),
      reship: (...args: unknown[]) => mockReship(...args),
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
      build: buildReducer,
    },
    preloadedState: {
      plan: {
        plans,
        dependencyGraph: null,
        selectedPlanId: "archive-test-feature",
        chatMessages: {},
        loading: false,
        decomposing: false,
        shippingPlanId: null,
        reshippingPlanId: null,
        archivingPlanId: null,
        error: null,
      },
      build: {
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

describe("PlanPhase Rebuild button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows Rebuild button when plan is complete and lastModified > shippedAt", () => {
    const plans = [
      {
        ...basePlan,
        status: "done" as const,
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

    expect(screen.getByRole("button", { name: /rebuild/i })).toBeInTheDocument();
  });

  it("hides Rebuild button when plan is complete but lastModified <= shippedAt", () => {
    const plans = [
      {
        ...basePlan,
        status: "done" as const,
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

    expect(screen.queryByRole("button", { name: /rebuild/i })).not.toBeInTheDocument();
  });

  it("hides Rebuild button when plan is complete but lastModified === shippedAt (no changes after ship)", () => {
    const plans = [
      {
        ...basePlan,
        status: "done" as const,
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

    expect(screen.queryByRole("button", { name: /rebuild/i })).not.toBeInTheDocument();
  });

  it("hides Rebuild button when plan is complete but lastModified is missing", () => {
    const plans = [
      {
        ...basePlan,
        status: "done" as const,
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

    expect(screen.queryByRole("button", { name: /rebuild/i })).not.toBeInTheDocument();
  });

  it("hides Rebuild button when plan is complete but shippedAt is null", () => {
    const plans = [
      {
        ...basePlan,
        status: "done" as const,
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

    expect(screen.queryByRole("button", { name: /rebuild/i })).not.toBeInTheDocument();
  });
});

describe("PlanPhase shipPlan thunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("dispatches shipPlan thunk when Build It! is clicked", async () => {
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

    const buildButton = screen.getByRole("button", { name: /build it!/i });
    await user.click(buildButton);

    expect(mockShip).toHaveBeenCalledWith("proj-1", "archive-test-feature");
  });
});

describe("PlanPhase reshipPlan thunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("dispatches reshipPlan thunk when Rebuild is clicked", async () => {
    const plans = [
      {
        ...basePlan,
        status: "done" as const,
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

    const rebuildButton = screen.getByRole("button", { name: /rebuild/i });
    await user.click(rebuildButton);

    expect(mockReship).toHaveBeenCalledWith("proj-1", "archive-test-feature");
  });
});

describe("PlanPhase sendPlanMessage thunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
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
