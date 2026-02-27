import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, useSelector } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import type { RootState } from "../../store";
import { TaskDetailSidebar } from "./TaskDetailSidebar";
import executeReducer, {
  fetchTaskDetail,
  setSelectedTaskId,
  initialExecuteState,
  selectTasks,
} from "../../store/slices/executeSlice";
import evalReducer from "../../store/slices/evalSlice";
import planReducer from "../../store/slices/planSlice";
import projectReducer from "../../store/slices/projectSlice";
import websocketReducer from "../../store/slices/websocketSlice";

const mockGet = vi.fn();
const mockUpdatePriority = vi.fn();
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      feedback: { get: (...args: unknown[]) => mockGet(...args) },
      tasks: {
        ...((actual.api as { tasks?: Record<string, unknown> }).tasks ?? {}),
        updatePriority: (...args: unknown[]) => mockUpdatePriority(...args),
      },
    },
  };
});

const basePlan = {
  metadata: {
    planId: "plan-1",
    epicId: "epic-1",
    complexity: "medium" as const,
  },
  content: "# Plan",
  status: "building" as const,
  taskCount: 1,
  doneTaskCount: 0,
  dependencyCount: 0,
};

function createMinimalProps(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "proj-1",
    selectedTask: "epic-1.1",
    selectedTaskData: {
      id: "epic-1.1",
      title: "Task A",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority: 0,
      assignee: null,
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      description: "",
      createdAt: "",
      updatedAt: "",
    },
    taskDetailLoading: false,
    taskDetailError: null,
    agentOutput: [],
    completionState: null,
    archivedSessions: [],
    archivedLoading: false,
    markDoneLoading: false,
    unblockLoading: false,
    taskIdToStartedAt: {},
    plans: [basePlan],
    tasks: [],
    activeTasks: [],
    wsConnected: false,
    isDoneTask: false,
    isBlockedTask: false,
    sourceFeedbackExpanded: {},
    setSourceFeedbackExpanded: vi.fn(),
    descriptionSectionExpanded: true,
    setDescriptionSectionExpanded: vi.fn(),
    artifactsSectionExpanded: true,
    setArtifactsSectionExpanded: vi.fn(),
    onClose: vi.fn(),
    onMarkDone: vi.fn(),
    onUnblock: vi.fn(),
    onSelectTask: vi.fn(),
    ...overrides,
  };
}

function createStore() {
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      websocket: websocketReducer,
    },
    preloadedState: {
      execute: initialExecuteState,
      websocket: {
        connected: false,
        hilRequest: null,
        hilNotification: null,
        deliverToast: null,
      },
      plan: {
        plans: [basePlan],
        dependencyGraph: null,
        selectedPlanId: null,
        chatMessages: {},
        loading: false,
        decomposing: false,
        executingPlanId: null,
        reExecutingPlanId: null,
        archivingPlanId: null,
        error: null,
      },
    },
  });
}

describe("TaskDetailSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockUpdatePriority.mockResolvedValue({});
  });

  it("renders task title from selectedTaskData", () => {
    const props = createMinimalProps();
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Task A");
  });

  it("shows task title immediately from cached list data while detail loads (feedback t586o4)", () => {
    const props = createMinimalProps({
      taskDetailLoading: true,
      selectedTaskData: {
        id: "epic-1.1",
        title: "Cached Task Title",
        epicId: "epic-1",
        kanbanColumn: "ready" as const,
        priority: 1,
        assignee: "agent@test",
        type: "task" as const,
        status: "open" as const,
        labels: [],
        dependencies: [],
        description: "",
        createdAt: "",
        updatedAt: "",
      },
    });
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Cached Task Title");
    expect(screen.getByTestId("task-detail-loading")).toBeInTheDocument();
  });

  it("keeps task title visible when detail fetch fails (error shown below name)", () => {
    const props = createMinimalProps({
      taskDetailError: "Failed to load task details",
      taskDetailLoading: false,
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task With Error",
        epicId: "epic-1",
        kanbanColumn: "ready" as const,
        priority: 1,
        assignee: null,
        type: "task" as const,
        status: "open" as const,
        labels: [],
        dependencies: [],
        description: "",
        createdAt: "",
        updatedAt: "",
      },
    });
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Task With Error");
    expect(screen.getByTestId("task-detail-error")).toHaveTextContent(
      "Failed to load task details"
    );
  });

  it("renders actions menu with Mark done when task is not done and not blocked", async () => {
    const user = userEvent.setup();
    const props = createMinimalProps();
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("sidebar-actions-menu-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-unblock-btn")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    expect(screen.getByTestId("sidebar-mark-done-btn")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /mark done/i })).toBeInTheDocument();
  });

  it("renders actions menu trigger to the right of title, close to the left of X", () => {
    const props = createMinimalProps();
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const title = screen.getByTestId("task-detail-title");
    const menuTrigger = screen.getByTestId("sidebar-actions-menu-trigger");
    const closeBtn = screen.getByRole("button", { name: "Close task detail" });
    // Title before menu trigger before close
    expect(
      title.compareDocumentPosition(menuTrigger) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      menuTrigger.compareDocumentPosition(closeBtn) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders actions menu with Unblock when task is blocked", async () => {
    const user = userEvent.setup();
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Blocked Task",
        epicId: "epic-1",
        kanbanColumn: "blocked" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "blocked" as const,
        labels: [],
        dependencies: [],
        description: "",
        createdAt: "",
        updatedAt: "",
      },
      isBlockedTask: true,
    });
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("sidebar-actions-menu-trigger")).toBeInTheDocument();
    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    expect(screen.getByTestId("sidebar-unblock-btn")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /mark done/i })).not.toBeInTheDocument();
  });

  it("shows block reason below status/priority row when task is blocked", () => {
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Blocked Task",
        epicId: "epic-1",
        kanbanColumn: "blocked" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "blocked" as const,
        labels: [],
        dependencies: [],
        description: "",
        createdAt: "",
        updatedAt: "",
        blockReason: "Merge Failure",
      },
      isBlockedTask: true,
    });
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const blockReason = screen.getByTestId("task-block-reason");
    expect(blockReason).toBeInTheDocument();
    expect(blockReason).toHaveTextContent("Merge Failure");
  });

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const props = createMinimalProps({ onClose });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await user.click(screen.getByRole("button", { name: "Close task detail" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onMarkDone when Mark done is clicked from actions menu", async () => {
    const user = userEvent.setup();
    const onMarkDone = vi.fn();
    const props = createMinimalProps({ onMarkDone });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    await user.click(screen.getByTestId("sidebar-mark-done-btn"));
    expect(onMarkDone).toHaveBeenCalledTimes(1);
  });

  it("calls onUnblock when Unblock is clicked from actions menu", async () => {
    const user = userEvent.setup();
    const onUnblock = vi.fn();
    const props = createMinimalProps({
      onUnblock,
      selectedTaskData: {
        id: "epic-1.1",
        title: "Blocked Task",
        epicId: "epic-1",
        kanbanColumn: "blocked" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "blocked" as const,
        labels: [],
        dependencies: [],
        description: "",
        createdAt: "",
        updatedAt: "",
      },
      isBlockedTask: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    await user.click(screen.getByTestId("sidebar-unblock-btn"));
    expect(onUnblock).toHaveBeenCalledTimes(1);
  });

  it("does not render actions menu when task is done", () => {
    const props = createMinimalProps({ isDoneTask: true });
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.queryByTestId("sidebar-actions-menu-trigger")).not.toBeInTheDocument();
  });

  it("closes actions menu on outside click", async () => {
    const user = userEvent.setup();
    const props = createMinimalProps();
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    expect(screen.getByTestId("sidebar-actions-menu")).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByTestId("sidebar-actions-menu")).not.toBeInTheDocument();
  });

  it("uses scrollable div with ReactMarkdown for live output (not pre)", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: ["Hello **world**"],
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const container = screen.getByTestId("live-agent-output");
    expect(container.tagName).toBe("DIV");
    expect(container).toHaveClass("overflow-y-auto");
    expect(container).toHaveClass("prose-execute-task");
    expect(container).toHaveTextContent("world");
  });

  it("renders live agent output as markdown with code blocks and formatting", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: ["**Bold text** and `inline code`\n\n```\ncode block\n```"],
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const container = screen.getByTestId("live-agent-output");
    expect(container).toBeInTheDocument();
    expect(container).toHaveTextContent("Bold text");
    expect(container).toHaveTextContent("inline code");
    expect(container).toHaveTextContent("code block");
  });

  it("applies prose-execute-task and theme-aware code block classes to live output", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: ["```\ncode\n```"],
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const container = screen.getByTestId("live-agent-output");
    expect(container).toHaveClass("prose-execute-task");
    expect(container).toHaveClass("prose-pre:bg-theme-code-bg");
    expect(container).toHaveClass("prose-pre:text-theme-code-text");
  });

  it("filters archived outputLog when showing fallback (agentOutput empty, completionState set)", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: [],
      completionState: { status: "approved", testResults: null },
      archivedSessions: [
        {
          attempt: 1,
          status: "approved",
          agentType: "coder",
          outputLog:
            '{"type":"text","text":"Visible"}\n{"type":"tool_use","name":"edit"}\n{"type":"text","text":" content"}\n',
          gitDiff: null,
          testResults: null,
          failureReason: null,
        },
      ],
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const container = screen.getByTestId("live-agent-output");
    expect(container).toHaveTextContent("Visible content");
    expect(container).not.toHaveTextContent("tool_use");
  });

  it("shows Jump to bottom button when user scrolls up in live agent output", async () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: ["Line 1\n", "Line 2\n", "Line 3\n"],
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const pre = screen.getByTestId("live-agent-output");
    expect(pre).toBeInTheDocument();
    expect(screen.queryByTestId("jump-to-bottom")).not.toBeInTheDocument();

    // Simulate scroll up: user is at top, far from bottom
    Object.defineProperty(pre, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(pre, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(pre, "scrollTop", { value: 0, configurable: true }); // at top
    fireEvent.scroll(pre);

    expect(screen.getByTestId("jump-to-bottom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeInTheDocument();
  });

  it("Jump to bottom button scrolls to bottom and hides when clicked", async () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: ["Line 1\n", "Line 2\n", "Line 3\n"],
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const pre = screen.getByTestId("live-agent-output");
    Object.defineProperty(pre, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(pre, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(pre, "scrollTop", {
      value: 0,
      writable: true,
      configurable: true,
    });
    fireEvent.scroll(pre);

    const jumpBtn = screen.getByTestId("jump-to-bottom");
    expect(jumpBtn).toBeInTheDocument();

    fireEvent.click(jumpBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("jump-to-bottom")).not.toBeInTheDocument();
    });
  });

  it("shows connecting state when wsConnected is false and task is not done", () => {
    const props = createMinimalProps({ wsConnected: false, isDoneTask: false });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("live-output-connecting")).toBeInTheDocument();
    expect(screen.getByText("Connecting to live output…")).toBeInTheDocument();
  });

  it("shows task detail error when taskDetailError is set", () => {
    const props = createMinimalProps({ taskDetailError: "Network error" });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("task-detail-error")).toHaveTextContent("Network error");
  });

  it("renders Depends on above Description in DOM order", () => {
    const depTask = {
      id: "epic-1.2",
      title: "Prerequisite Task",
      epicId: "epic-1",
      kanbanColumn: "done" as const,
      priority: 1,
      assignee: null,
      type: "task" as const,
      status: "closed" as const,
      labels: [],
      dependencies: [],
      description: "",
      createdAt: "",
      updatedAt: "",
    };
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [{ targetId: "epic-1.2", type: "blocks" }],
        description: "## Steps\n\n1. Implement feature",
        createdAt: "",
        updatedAt: "",
      },
      tasks: [depTask],
      descriptionSectionExpanded: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const dependsOn = screen.getByText("Depends on:");
    const descriptionHeader = screen.getByRole("button", { name: /collapse description/i });
    expect(
      dependsOn.compareDocumentPosition(descriptionHeader) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("hides Depends on section when epic is the only dependency", () => {
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [{ targetId: "epic-1", type: "blocks" }],
        description: "",
        createdAt: "",
        updatedAt: "",
      },
      tasks: [],
      descriptionSectionExpanded: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.queryByText("Depends on:")).not.toBeInTheDocument();
  });

  it("shows Depends on only non-epic dependencies when epic and others exist", () => {
    const depTask = {
      id: "epic-1.2",
      title: "Prerequisite Task",
      epicId: "epic-1",
      kanbanColumn: "done" as const,
      priority: 1,
      assignee: null,
      type: "task" as const,
      status: "closed" as const,
      labels: [],
      dependencies: [],
      description: "",
      createdAt: "",
      updatedAt: "",
    };
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [
          { targetId: "epic-1", type: "blocks" },
          { targetId: "epic-1.2", type: "blocks" },
        ],
        description: "",
        createdAt: "",
        updatedAt: "",
      },
      tasks: [depTask],
      descriptionSectionExpanded: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByText("Depends on:")).toBeInTheDocument();
    expect(screen.getByText("Prerequisite Task")).toBeInTheDocument();
    expect(screen.queryByText("epic-1")).not.toBeInTheDocument();
  });

  it("shows Depends on when task has only non-epic dependencies", () => {
    const depTask = {
      id: "epic-1.2",
      title: "Other Task",
      epicId: "epic-1",
      kanbanColumn: "ready" as const,
      priority: 1,
      assignee: null,
      type: "task" as const,
      status: "open" as const,
      labels: [],
      dependencies: [],
      description: "",
      createdAt: "",
      updatedAt: "",
    };
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [{ targetId: "epic-1.2", type: "blocks" }],
        description: "",
        createdAt: "",
        updatedAt: "",
      },
      tasks: [depTask],
      descriptionSectionExpanded: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByText("Depends on:")).toBeInTheDocument();
    expect(screen.getByText("Other Task")).toBeInTheDocument();
  });

  it("renders task description markdown when selectedTaskData has description", () => {
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "## Steps\n\n1. Implement feature",
        createdAt: "",
        updatedAt: "",
      },
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("task-description-markdown")).toBeInTheDocument();
    expect(screen.getByText("Steps")).toBeInTheDocument();
    // Markdown renders list items; "1." is from <ol>, content is "Implement feature"
    expect(screen.getByText("Implement feature")).toBeInTheDocument();
  });

  it("renders task description markdown with theme-aware prose styles for WCAG contrast", () => {
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "Plain paragraph",
        createdAt: "",
        updatedAt: "",
      },
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const markdownEl = screen.getByTestId("task-description-markdown");
    expect(markdownEl).toHaveClass("prose-task-description");
    expect(markdownEl).toHaveClass("prose-execute-task");
  });

  describe("Priority dropdown", () => {
    const taskDetailWithPriority = (priority: number) => ({
      id: "epic-1.1",
      title: "Task A",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority,
      assignee: null,
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      description: "",
      createdAt: "",
      updatedAt: "",
    });

    it("shows priority as editable dropdown for status open", () => {
      const props = createMinimalProps({
        selectedTaskData: { ...taskDetailWithPriority(1), status: "open" as const },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      expect(screen.getByTestId("priority-dropdown-trigger")).toBeInTheDocument();
      expect(screen.queryByTestId("priority-read-only")).not.toBeInTheDocument();
    });

    it("shows current priority as clickable element when selectedTaskData is loaded", () => {
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const trigger = screen.getByTestId("priority-dropdown-trigger");
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveTextContent("High");
      expect(trigger).toHaveAttribute("aria-label", "Priority: High. Click to change");
    });

    it("renders PriorityIcon in the priority dropdown trigger", () => {
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const trigger = screen.getByTestId("priority-dropdown-trigger");
      expect(within(trigger).getByRole("img", { name: "High" })).toBeInTheDocument();
    });

    it("renders PriorityIcon in each dropdown option with correct priority", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(2),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      await user.click(screen.getByTestId("priority-dropdown-trigger"));
      const labels = ["Critical", "High", "Medium", "Low", "Lowest"] as const;
      for (let p = 0; p <= 4; p++) {
        const option = screen.getByTestId(`priority-option-${p}`);
        expect(within(option).getByRole("img", { name: labels[p] })).toBeInTheDocument();
      }
    });

    it("opens dropdown with all 5 priority levels when clicked", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(2),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      await user.click(screen.getByTestId("priority-dropdown-trigger"));
      const dropdown = screen.getByTestId("priority-dropdown");
      expect(dropdown).toBeInTheDocument();
      expect(dropdown).toHaveAttribute("role", "listbox");
      for (const p of [0, 1, 2, 3, 4]) {
        expect(screen.getByTestId(`priority-option-${p}`)).toBeInTheDocument();
      }
      expect(screen.getByText("0: Critical")).toBeInTheDocument();
      expect(screen.getByText("1: High")).toBeInTheDocument();
      expect(screen.getByText("2: Medium")).toBeInTheDocument();
      expect(screen.getByText("3: Low")).toBeInTheDocument();
      expect(screen.getByText("4: Lowest")).toBeInTheDocument();
    });

    it("persists via API and closes dropdown when selecting a new priority", async () => {
      const user = userEvent.setup();
      mockUpdatePriority.mockResolvedValue({ ...taskDetailWithPriority(0), priority: 0 });
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      await user.click(screen.getByTestId("priority-dropdown-trigger"));
      expect(screen.getByTestId("priority-dropdown")).toBeInTheDocument();
      await user.click(screen.getByTestId("priority-option-0"));
      expect(mockUpdatePriority).toHaveBeenCalledWith("proj-1", "epic-1.1", 0);
      expect(screen.queryByTestId("priority-dropdown")).not.toBeInTheDocument();
    });

    it("does not call API when selecting the same priority", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(2),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      await user.click(screen.getByTestId("priority-dropdown-trigger"));
      await user.click(screen.getByTestId("priority-option-2"));
      expect(mockUpdatePriority).not.toHaveBeenCalled();
    });

    it("closes dropdown on outside click", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(2),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      await user.click(screen.getByTestId("priority-dropdown-trigger"));
      expect(screen.getByTestId("priority-dropdown")).toBeInTheDocument();
      await user.click(document.body);
      expect(screen.queryByTestId("priority-dropdown")).not.toBeInTheDocument();
    });

    it("shows priority as read-only static text when task is done (closed)", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...taskDetailWithPriority(2),
          kanbanColumn: "done" as const,
          status: "closed" as const,
        },
        isDoneTask: true,
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      expect(screen.getByTestId("priority-read-only")).toBeInTheDocument();
      expect(screen.getByTestId("priority-read-only")).toHaveTextContent("Medium");
      expect(screen.getByTestId("priority-read-only")).toHaveClass("cursor-default");
      expect(screen.queryByTestId("priority-dropdown-trigger")).not.toBeInTheDocument();
    });

    it("does not open dropdown when priority is read-only (done task)", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        selectedTaskData: {
          ...taskDetailWithPriority(1),
          kanbanColumn: "done" as const,
          status: "closed" as const,
        },
        isDoneTask: true,
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const readOnly = screen.getByTestId("priority-read-only");
      await user.click(readOnly);
      expect(screen.queryByTestId("priority-dropdown")).not.toBeInTheDocument();
    });

    it("updates to read-only when task transitions to done while sidebar is open", async () => {
      const store = createStore();
      const taskDetail = taskDetailWithPriority(1);
      store.dispatch(
        fetchTaskDetail.fulfilled(taskDetail, "", {
          projectId: "proj-1",
          taskId: "epic-1.1",
        })
      );
      const { rerender } = render(
        <Provider store={store}>
          <TaskDetailSidebar
            {...createMinimalProps({
              selectedTaskData: { ...taskDetail, kanbanColumn: "in_progress" as const },
              isDoneTask: false,
            })}
          />
        </Provider>
      );
      expect(screen.getByTestId("priority-dropdown-trigger")).toBeInTheDocument();

      rerender(
        <Provider store={store}>
          <TaskDetailSidebar
            {...createMinimalProps({
              selectedTaskData: {
                ...taskDetail,
                kanbanColumn: "done" as const,
                status: "closed" as const,
              },
              isDoneTask: true,
            })}
          />
        </Provider>
      );
      expect(screen.getByTestId("priority-read-only")).toBeInTheDocument();
      expect(screen.queryByTestId("priority-dropdown-trigger")).not.toBeInTheDocument();
    });

    it("reverts UI and shows toast when API fails", async () => {
      const user = userEvent.setup();
      mockUpdatePriority.mockRejectedValue(new Error("Validation failed"));
      const store = createStore();
      const taskDetail = taskDetailWithPriority(1);
      store.dispatch(setSelectedTaskId("epic-1.1"));
      store.dispatch(
        fetchTaskDetail.fulfilled(taskDetail, "", {
          projectId: "proj-1",
          taskId: "epic-1.1",
        })
      );
      function Wrapper() {
        const selectedTaskId = useSelector((s: RootState) => s.execute.selectedTaskId);
        const tasks = useSelector(selectTasks);
        const selectedTaskData = selectedTaskId
          ? (tasks.find((t) => t.id === selectedTaskId) ?? null)
          : null;
        const loading = useSelector((s: RootState) => s.execute.async.taskDetail.loading);
        const error = useSelector((s: RootState) => s.execute.async.taskDetail.error);
        const props = createMinimalProps({
          selectedTaskData,
          taskDetailLoading: loading,
          taskDetailError: error,
        });
        return <TaskDetailSidebar {...props} />;
      }
      render(
        <Provider store={store}>
          <Wrapper />
        </Provider>
      );
      expect(screen.getByTestId("priority-dropdown-trigger")).toHaveTextContent("High");
      await user.click(screen.getByTestId("priority-dropdown-trigger"));
      await user.click(screen.getByTestId("priority-option-0"));
      await vi.waitFor(() => {
        expect(screen.getByTestId("priority-dropdown-trigger")).toHaveTextContent("High");
      });
      expect(store.getState().websocket.deliverToast).toEqual({
        message: "Failed to update priority",
        variant: "failed",
      });
    });
  });

  describe("Task complexity", () => {
    it("shows Simple when task has complexity simple", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...createMinimalProps().selectedTaskData,
          complexity: "simple" as const,
        },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveTextContent("Simple");
      expect(complexity).toHaveAttribute("aria-label", "Complexity: simple");
      expect(screen.getByRole("img", { name: "Simple complexity" })).toBeInTheDocument();
    });

    it("shows Complex when task has complexity complex", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...createMinimalProps().selectedTaskData,
          complexity: "complex" as const,
        },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveTextContent("Complex");
      expect(complexity).toHaveAttribute("aria-label", "Complexity: complex");
      expect(screen.getByRole("img", { name: "Complex complexity" })).toBeInTheDocument();
    });

    it("shows em dash when task has no complexity", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...createMinimalProps().selectedTaskData,
          complexity: undefined,
        },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveTextContent("—");
      expect(complexity).toHaveAttribute("aria-label", "Complexity: not set");
    });

    it("displays complexity in same row as priority", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...createMinimalProps().selectedTaskData,
          complexity: "complex" as const,
        },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const row = screen.getByTestId("task-detail-priority-state-row");
      expect(row).toContainElement(screen.getByTestId("task-complexity"));
      expect(row).toHaveTextContent("Complex");
      expect(row).toHaveTextContent("In Progress");
    });
  });

  describe("Task duration", () => {
    it("shows Took MM:SS for completed tasks with startedAt and completedAt", () => {
      const props = createMinimalProps({
        isDoneTask: true,
        selectedTaskData: {
          ...createMinimalProps().selectedTaskData,
          kanbanColumn: "done" as const,
          status: "closed" as const,
          startedAt: "2026-02-16T12:00:00.000Z",
          completedAt: "2026-02-16T12:05:30.000Z",
        },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const duration = screen.getByTestId("task-duration");
      expect(duration).toHaveTextContent("Took 5:30");
      expect(duration).toHaveAttribute("aria-label", "Took 5:30");
    });

    it("does not show duration for in-progress tasks", () => {
      const props = createMinimalProps({
        isDoneTask: false,
        selectedTaskData: {
          ...createMinimalProps().selectedTaskData,
          kanbanColumn: "in_progress" as const,
          startedAt: "2026-02-16T12:00:00.000Z",
          completedAt: null,
        },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      expect(screen.queryByTestId("task-duration")).not.toBeInTheDocument();
    });

    it("does not show duration for completed tasks without completedAt", () => {
      const props = createMinimalProps({
        isDoneTask: true,
        selectedTaskData: {
          ...createMinimalProps().selectedTaskData,
          kanbanColumn: "done" as const,
          status: "closed" as const,
          startedAt: "2026-02-16T12:00:00.000Z",
          completedAt: null,
        },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      expect(screen.queryByTestId("task-duration")).not.toBeInTheDocument();
    });

    it("does not show duration for completed tasks without startedAt", () => {
      const props = createMinimalProps({
        isDoneTask: true,
        selectedTaskData: {
          ...createMinimalProps().selectedTaskData,
          kanbanColumn: "done" as const,
          status: "closed" as const,
          startedAt: null,
          completedAt: "2026-02-16T12:05:30.000Z",
        },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      expect(screen.queryByTestId("task-duration")).not.toBeInTheDocument();
    });
  });

  describe("Layout: priority/state row and active-agent/time row", () => {
    const taskDetailWithPriority = (priority: number) => ({
      id: "epic-1.1",
      title: "Task A",
      epicId: "epic-1",
      kanbanColumn: "in_progress" as const,
      priority,
      assignee: null,
      type: "task" as const,
      status: "in_progress" as const,
      labels: [],
      dependencies: [],
      description: "",
      createdAt: "",
      updatedAt: "",
    });

    it("renders status and priority on first row below header", () => {
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const row = screen.getByTestId("task-detail-priority-state-row");
      expect(row).toBeInTheDocument();
      expect(within(row).getByTestId("priority-dropdown-trigger")).toHaveTextContent("High");
      expect(row).toHaveTextContent("In Progress");
    });

    it("renders all priority levels inline with state", () => {
      const labels = ["Critical", "High", "Medium", "Low", "Lowest"] as const;
      for (let p = 0; p <= 4; p++) {
        const props = createMinimalProps({
          selectedTaskData: taskDetailWithPriority(p),
        });
        const { unmount } = render(
          <Provider store={createStore()}>
            <TaskDetailSidebar {...props} />
          </Provider>
        );
        const row = screen.getByTestId("task-detail-priority-state-row");
        expect(row).toBeInTheDocument();
        expect(within(row).getByText(labels[p])).toBeInTheDocument();
        unmount();
      }
    });

    it("Active callout displays agent role, name, and elapsed time", () => {
      const startedAt = new Date(Date.now() - 4 * 60 * 1000 - 4 * 1000).toISOString();
      const props = createMinimalProps({
        selectedTaskData: {
          ...taskDetailWithPriority(1),
          assignee: "Frodo",
        },
        activeTasks: [
          {
            taskId: "epic-1.1",
            phase: "coding",
            startedAt,
          },
        ],
        taskIdToStartedAt: { "epic-1.1": startedAt },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const callout = screen.getByTestId("task-detail-active-callout");
      expect(callout).toBeInTheDocument();
      expect(callout).toHaveTextContent("Active: Coder");
      expect(callout).toHaveTextContent("Frodo");
      expect(callout.textContent).toMatch(/4m/);
      expect(callout.textContent).toMatch(/4s/);
    });

    it("Active callout shows Reviewer when phase is review with running time", () => {
      const startedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(2),
        activeTasks: [
          {
            taskId: "epic-1.1",
            phase: "review",
            startedAt,
          },
        ],
        taskIdToStartedAt: { "epic-1.1": startedAt },
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const callout = screen.getByTestId("task-detail-active-callout");
      expect(callout).toHaveTextContent("Active: Reviewer");
      expect(callout.textContent).toMatch(/2m/);
    });

    it("Active callout shows agent role without time when taskIdToStartedAt is missing", () => {
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
        activeTasks: [
          {
            taskId: "epic-1.1",
            phase: "coding",
            startedAt: new Date().toISOString(),
          },
        ],
        taskIdToStartedAt: {},
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const callout = screen.getByTestId("task-detail-active-callout");
      expect(callout).toHaveTextContent("Active: Coder");
    });

    it("priority-state row uses flex-wrap for responsive layout at narrow widths", () => {
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
      });
      render(
        <Provider store={createStore()}>
          <TaskDetailSidebar {...props} />
        </Provider>
      );
      const row = screen.getByTestId("task-detail-priority-state-row");
      expect(row).toHaveClass("flex");
      expect(row).toHaveClass("flex-wrap");
    });
  });

  it("Source Feedback and Live Output use matching content wrapper (p-4 pt-0)", async () => {
    mockGet.mockResolvedValue({
      id: "fb-1",
      text: "Add feature",
      category: "feature",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "",
        sourceFeedbackId: "fb-1",
        createdAt: "",
        updatedAt: "",
      },
      sourceFeedbackExpanded: { "fb-1": true },
      artifactsSectionExpanded: true,
    });

    const { container } = render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await screen.findByText("Add feature");

    const sourceFeedbackContent = container.querySelector("#source-feedback-content-fb-1");
    const artifactsContent = container.querySelector("#artifacts-content");
    expect(sourceFeedbackContent).toBeInTheDocument();
    expect(artifactsContent).toBeInTheDocument();
    expect(sourceFeedbackContent).toHaveClass("p-4", "pt-0");
    expect(artifactsContent).toHaveClass("p-4", "pt-0");
  });

  it("Description uses same content wrapper (p-4 pt-0) as Source Feedback and Live Output", () => {
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task with description",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "Implement the feature",
        createdAt: "",
        updatedAt: "",
      },
      descriptionSectionExpanded: true,
      artifactsSectionExpanded: true,
    });

    const { container } = render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const descriptionContent = container.querySelector("#description-content");
    const artifactsContent = container.querySelector("#artifacts-content");
    expect(descriptionContent).toBeInTheDocument();
    expect(artifactsContent).toBeInTheDocument();
    expect(descriptionContent).toHaveClass("p-4", "pt-0");
    expect(artifactsContent).toHaveClass("p-4", "pt-0");
  });

  it("Description, Source Feedback, and Live Output headers use identical component structure and classes", async () => {
    mockGet.mockResolvedValue({
      id: "fb-1",
      text: "Add feature",
      category: "feature",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task with both",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "Task description content",
        sourceFeedbackId: "fb-1",
        createdAt: "",
        updatedAt: "",
      },
      sourceFeedbackExpanded: { "fb-1": true },
      descriptionSectionExpanded: true,
      artifactsSectionExpanded: true,
    });

    const { container } = render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await screen.findByText("Add feature");

    const sourceFeedbackHeader = container.querySelector("#source-feedback-header-fb-1");
    const descriptionHeader = container.querySelector("#description-header");
    const artifactsHeader = container.querySelector("#artifacts-header");

    expect(sourceFeedbackHeader).toBeInTheDocument();
    expect(descriptionHeader).toBeInTheDocument();
    expect(artifactsHeader).toBeInTheDocument();

    const sharedHeaderClasses = [
      "w-full",
      "flex",
      "items-center",
      "justify-between",
      "p-4",
      "text-left",
      "hover:bg-theme-border-subtle/50",
      "transition-colors",
    ];
    for (const header of [sourceFeedbackHeader, descriptionHeader, artifactsHeader]) {
      for (const cls of sharedHeaderClasses) {
        expect(header).toHaveClass(cls);
      }
    }

    const sharedH4Classes = [
      "text-xs",
      "font-medium",
      "text-theme-muted",
      "uppercase",
      "tracking-wide",
    ];
    for (const header of [sourceFeedbackHeader, descriptionHeader, artifactsHeader]) {
      const h4 = header?.querySelector("h4");
      expect(h4).toBeInTheDocument();
      for (const cls of sharedH4Classes) {
        expect(h4).toHaveClass(cls);
      }
    }

    // Verify outer wrapper (section container) has identical structure for spacing consistency
    const sourceFeedbackSection = sourceFeedbackHeader?.closest(".border-b");
    const descriptionSection = descriptionHeader?.closest(".border-b");
    const artifactsSection = artifactsHeader?.closest(".border-b");
    expect(sourceFeedbackSection).toHaveClass("border-theme-border-subtle");
    expect(descriptionSection).toHaveClass("border-theme-border-subtle");
    expect(artifactsSection).toHaveClass("border-theme-border-subtle");

    // Verify chevron icon placement is identical (same span with text-xs)
    for (const header of [sourceFeedbackHeader, descriptionHeader, artifactsHeader]) {
      const chevron = header?.querySelector("span.text-theme-muted.text-xs");
      expect(chevron).toBeInTheDocument();
    }

    // Verify section containers have identical outer classes for spacing consistency
    const sectionClassNames = [
      sourceFeedbackSection?.className ?? "",
      descriptionSection?.className ?? "",
      artifactsSection?.className ?? "",
    ];
    expect(sectionClassNames[0]).toBe(sectionClassNames[1]);
    expect(sectionClassNames[1]).toBe(sectionClassNames[2]);
  });

  it("collapse/expand interaction is identical for Description, Source Feedback, and Live Output", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({
      id: "fb-1",
      text: "Add feature",
      category: "feature",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const setSourceFeedbackExpanded = vi.fn();
    const setDescriptionSectionExpanded = vi.fn();
    const setArtifactsSectionExpanded = vi.fn();
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task with both",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "Task description content",
        sourceFeedbackId: "fb-1",
        createdAt: "",
        updatedAt: "",
      },
      sourceFeedbackExpanded: { "fb-1": true },
      setSourceFeedbackExpanded,
      descriptionSectionExpanded: true,
      setDescriptionSectionExpanded,
      artifactsSectionExpanded: true,
      setArtifactsSectionExpanded,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await screen.findByText("Add feature");

    const descBtn = screen.getByRole("button", { name: /collapse description/i });
    const sourceBtn = screen.getByRole("button", { name: /collapse source feedback/i });
    const artifactsBtn = screen.getByRole("button", {
      name: /collapse live agent output/i,
    });

    await user.click(descBtn);
    expect(setDescriptionSectionExpanded).toHaveBeenCalledTimes(1);

    await user.click(sourceBtn);
    expect(setSourceFeedbackExpanded).toHaveBeenCalledTimes(1);

    await user.click(artifactsBtn);
    expect(setArtifactsSectionExpanded).toHaveBeenCalledTimes(1);
  });

  it("visual regression: Description, Source Feedback, Live Output headers have identical structure (no unintended style differences)", async () => {
    mockGet.mockResolvedValue({
      id: "fb-1",
      text: "Add feature",
      category: "feature",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task with both",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "Task description content",
        sourceFeedbackId: "fb-1",
        createdAt: "",
        updatedAt: "",
      },
      sourceFeedbackExpanded: { "fb-1": true },
      descriptionSectionExpanded: true,
      artifactsSectionExpanded: true,
    });

    const { container } = render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await screen.findByText("Add feature");

    const headers = [
      container.querySelector("#source-feedback-header-fb-1"),
      container.querySelector("#description-header"),
      container.querySelector("#artifacts-header"),
    ];
    expect(headers.every(Boolean)).toBe(true);

    // All three must be <button> elements (same tag)
    for (const h of headers) {
      expect(h?.tagName).toBe("BUTTON");
    }

    // All three must have identical className on the header button
    const classNames = headers.map((h) => (h as HTMLElement).className);
    expect(classNames[0]).toBe(classNames[1]);
    expect(classNames[1]).toBe(classNames[2]);

    // All three must have identical h4 child structure
    const h4ClassNames = headers.map((h) => h?.querySelector("h4")?.className ?? "");
    expect(h4ClassNames[0]).toBe(h4ClassNames[1]);
    expect(h4ClassNames[1]).toBe(h4ClassNames[2]);
  });

  it("shows failure reason when completionState.status is failed and reason is set", () => {
    const props = createMinimalProps({
      completionState: {
        status: "failed",
        testResults: null,
        reason: "Cursor agent requires authentication. Run agent login.",
      },
      artifactsSectionExpanded: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByTestId("completion-failure-reason")).toHaveTextContent(
      "Cursor agent requires authentication. Run agent login."
    );
  });

  it("shows multiple linked feedback sections when task has sourceFeedbackIds", async () => {
    mockGet
      .mockResolvedValueOnce({
        id: "fb-1",
        text: "First feedback",
        category: "feature",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: "2026-02-17T10:00:00Z",
      })
      .mockResolvedValueOnce({
        id: "fb-2",
        text: "Second feedback",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: "2026-02-17T10:00:00Z",
      });
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task with multiple feedback",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "",
        sourceFeedbackIds: ["fb-1", "fb-2"],
        createdAt: "",
        updatedAt: "",
      },
      sourceFeedbackExpanded: { "fb-1": true, "fb-2": false },
      artifactsSectionExpanded: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByRole("button", { name: /source feedback \(1 of 2\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /source feedback \(2 of 2\)/i })).toBeInTheDocument();
    expect(await screen.findByText("First feedback")).toBeInTheDocument();
    expect(screen.queryByText("Second feedback")).not.toBeInTheDocument();
  });

  it("first feedback expanded by default, rest collapsed when multiple sourceFeedbackIds", async () => {
    mockGet.mockResolvedValue({
      id: "fb-x",
      text: "Feedback text",
      category: "feature",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "",
        sourceFeedbackIds: ["fb-a", "fb-b"],
        createdAt: "",
        updatedAt: "",
      },
      sourceFeedbackExpanded: {},
      artifactsSectionExpanded: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const firstHeader = screen.getByRole("button", { name: /source feedback \(1 of 2\)/i });
    const secondHeader = screen.getByRole("button", { name: /source feedback \(2 of 2\)/i });
    expect(firstHeader).toHaveAttribute("aria-expanded", "true");
    expect(secondHeader).toHaveAttribute("aria-expanded", "false");
  });

  it("each feedback section can be expanded/collapsed independently when multiple", async () => {
    mockGet.mockResolvedValue({
      id: "fb-x",
      text: "Feedback text",
      category: "feature",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const setSourceFeedbackExpanded = vi.fn();
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "",
        sourceFeedbackIds: ["fb-1", "fb-2"],
        createdAt: "",
        updatedAt: "",
      },
      sourceFeedbackExpanded: { "fb-1": true, "fb-2": false },
      setSourceFeedbackExpanded,
      artifactsSectionExpanded: true,
    });

    const user = userEvent.setup();
    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    await user.click(screen.getByRole("button", { name: /collapse source feedback \(1 of 2\)/i }));
    expect(setSourceFeedbackExpanded).toHaveBeenCalledWith(
      expect.any(Function)
    );
    const updater = setSourceFeedbackExpanded.mock.calls[0][0];
    expect(updater({ "fb-1": true, "fb-2": false })).toEqual({ "fb-1": false, "fb-2": false });

    setSourceFeedbackExpanded.mockClear();
    await user.click(screen.getByRole("button", { name: /expand source feedback \(2 of 2\)/i }));
    expect(setSourceFeedbackExpanded).toHaveBeenCalledWith(expect.any(Function));
    const updater2 = setSourceFeedbackExpanded.mock.calls[0][0];
    expect(updater2({ "fb-1": true, "fb-2": false })).toEqual({ "fb-1": true, "fb-2": true });
  });

  it("uses sourceFeedbackId when sourceFeedbackIds is absent (backward compat)", async () => {
    mockGet.mockResolvedValue({
      id: "fb-legacy",
      text: "Legacy single feedback",
      category: "feature",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });
    const props = createMinimalProps({
      selectedTaskData: {
        id: "epic-1.1",
        title: "Legacy task",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [],
        description: "",
        sourceFeedbackId: "fb-legacy",
        createdAt: "",
        updatedAt: "",
      },
      sourceFeedbackExpanded: { "fb-legacy": true },
      artifactsSectionExpanded: true,
    });

    render(
      <Provider store={createStore()}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.getByRole("button", { name: /source feedback/i })).toBeInTheDocument();
    expect(await screen.findByText("Legacy single feedback")).toBeInTheDocument();
  });
});
