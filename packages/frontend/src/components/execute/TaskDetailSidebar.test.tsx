import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useSelector } from "react-redux";
import {
  renderWithProviders,
  wrapWithProviders,
  createTestStore,
  type RootState,
} from "../../test/test-utils";
import type { RenderWithProvidersOptions } from "../../test/test-utils";

function renderSidebar(
  props: TaskDetailSidebarProps,
  options?: RenderWithProvidersOptions
) {
  return renderWithProviders(
    <MemoryRouter initialEntries={["/projects/proj-1/execute"]}>
      <TaskDetailSidebar {...props} />
    </MemoryRouter>,
    options
  );
}
import { TaskDetailSidebar, type TaskDetailSidebarProps } from "./TaskDetailSidebar";
import type { AgentSession, Plan, Task, TaskExecutionDiagnostics } from "@opensprint/shared";
import type { ActiveTaskInfo } from "../../store/slices/executeSlice";
import {
  fetchTaskDetail,
  setSelectedTaskId,
  initialExecuteState,
  selectTasks,
} from "../../store/slices/executeSlice";

const mockGet = vi.fn();
const mockUpdatePriority = vi.fn();
const mockAddDependency = vi.fn();
const mockRemoveDependency = vi.fn();
const mockTasksGet = vi.fn();
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      feedback: { get: (...args: unknown[]) => mockGet(...args) },
      tasks: {
        ...((actual.api as { tasks?: Record<string, unknown> }).tasks ?? {}),
        get: (...args: unknown[]) => mockTasksGet(...args),
        updatePriority: (...args: unknown[]) => mockUpdatePriority(...args),
        addDependency: (...args: unknown[]) => mockAddDependency(...args),
        removeDependency: (...args: unknown[]) => mockRemoveDependency(...args),
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

const defaultSelectedTaskData = {
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
};

function createMinimalProps(overrides: Record<string, unknown> = {}) {
  const flat = {
    projectId: "proj-1",
    selectedTask: "epic-1.1",
    selectedTaskData: defaultSelectedTaskData,
    taskDetailLoading: false,
    taskDetailError: null,
    descriptionSectionExpanded: true,
    setDescriptionSectionExpanded: vi.fn(),
    artifactsSectionExpanded: true,
    setArtifactsSectionExpanded: vi.fn(),
    diagnosticsSectionExpanded: true,
    setDiagnosticsSectionExpanded: vi.fn(),
    sourceFeedbackExpanded: {} as Record<string, boolean>,
    setSourceFeedbackExpanded: vi.fn(),
    onClose: vi.fn(),
    onMarkDone: vi.fn(),
    onUnblock: vi.fn(),
    onDeleteTask: vi.fn(),
    onSelectTask: vi.fn(),
    onNavigateToPlan: undefined as undefined | ((planId: string) => void),
    onOpenQuestionResolved: undefined as undefined | (() => void),
    isDoneTask: false,
    isBlockedTask: false,
    openQuestionNotification: undefined as unknown,
    ...overrides,
  };
  return {
    projectId: flat.projectId as string,
    selectedTask: flat.selectedTask as string,
    taskDetail: {
      selectedTaskData: flat.selectedTaskData,
      taskDetailLoading: flat.taskDetailLoading,
      taskDetailError: flat.taskDetailError,
    },
    agentOutput: (flat.agentOutput as string[]) ?? [],
    completionState: (flat.completionState as TaskDetailSidebarProps["completionState"]) ?? null,
    diagnostics: (flat.diagnostics as TaskExecutionDiagnostics) ?? null,
    diagnosticsLoading: (flat.diagnosticsLoading as boolean) ?? false,
    archivedSessions: (flat.archivedSessions as AgentSession[]) ?? [],
    archivedLoading: (flat.archivedLoading as boolean) ?? false,
    markDoneLoading: (flat.markDoneLoading as boolean) ?? false,
    unblockLoading: (flat.unblockLoading as boolean) ?? false,
    priorityUpdateLoading: (flat.priorityUpdateLoading as boolean) ?? false,
    deleteLoading: (flat.deleteLoading as boolean) ?? false,
    taskIdToStartedAt: (flat.taskIdToStartedAt as Record<string, string>) ?? {},
    planByEpicId: ((flat.plans as Plan[]) ?? [basePlan]).reduce<Record<string, Plan>>(
      (acc, plan) => {
        acc[plan.metadata.epicId] = plan;
        return acc;
      },
      {}
    ),
    taskById: ((flat.tasks as Task[]) ?? []).reduce<Record<string, Task>>((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {}),
    activeTasks: (flat.activeTasks as ActiveTaskInfo[]) ?? [],
    wsConnected: (flat.wsConnected as boolean) ?? false,
    isDoneTask: flat.isDoneTask as boolean,
    isBlockedTask: flat.isBlockedTask as boolean,
    sections: {
      descriptionSectionExpanded: flat.descriptionSectionExpanded as boolean,
      setDescriptionSectionExpanded: flat.setDescriptionSectionExpanded as React.Dispatch<
        React.SetStateAction<boolean>
      >,
      artifactsSectionExpanded: flat.artifactsSectionExpanded as boolean,
      setArtifactsSectionExpanded: flat.setArtifactsSectionExpanded as React.Dispatch<
        React.SetStateAction<boolean>
      >,
      diagnosticsSectionExpanded: flat.diagnosticsSectionExpanded as boolean,
      setDiagnosticsSectionExpanded: flat.setDiagnosticsSectionExpanded as React.Dispatch<
        React.SetStateAction<boolean>
      >,
      sourceFeedbackExpanded: flat.sourceFeedbackExpanded as Record<string, boolean>,
      setSourceFeedbackExpanded: flat.setSourceFeedbackExpanded as React.Dispatch<
        React.SetStateAction<Record<string, boolean>>
      >,
    },
    callbacks: {
      onClose: flat.onClose as () => void,
      onMarkDone: flat.onMarkDone as () => void,
      onUnblock: flat.onUnblock as () => void,
      onDeleteTask: flat.onDeleteTask as () => void | Promise<void>,
      onSelectTask: flat.onSelectTask as (taskId: string) => void,
      onNavigateToPlan: flat.onNavigateToPlan as undefined | ((planId: string) => void),
      onOpenQuestionResolved: flat.onOpenQuestionResolved as undefined | (() => void),
    },
    ...(flat.openQuestionNotification !== undefined &&
      flat.openQuestionNotification !== null && {
        openQuestionNotification: flat.openQuestionNotification,
      }),
  };
}

const defaultPreloadedState: Partial<RootState> = {
  execute: initialExecuteState,
  websocket: {
    connected: false,
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
};

describe("TaskDetailSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockUpdatePriority.mockResolvedValue({});
    mockAddDependency.mockResolvedValue(undefined);
    mockRemoveDependency.mockResolvedValue(undefined);
    mockTasksGet.mockResolvedValue({});
  });

  it("renders task title from selectedTaskData", () => {
    const props = createMinimalProps();
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Task A");
  });

  it("renders OpenQuestionsBlock when openQuestionNotification is provided", () => {
    const openQuestionNotification = {
      id: "oq-exec-1",
      projectId: "proj-1",
      source: "execute" as const,
      sourceId: "epic-1.1",
      questions: [
        {
          id: "q1",
          text: "Which database should I use for this feature?",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
      status: "open" as const,
      createdAt: "2025-01-01T00:00:00Z",
      resolvedAt: null,
    };
    const props = createMinimalProps({
      openQuestionNotification,
      onOpenQuestionResolved: vi.fn(),
    });
    renderSidebar(props, { preloadedState: defaultPreloadedState });

    expect(screen.getByTestId("open-questions-block")).toBeInTheDocument();
    expect(screen.getByText("Which database should I use for this feature?")).toBeInTheDocument();
    expect(screen.getByTestId("open-questions-answer-btn")).toBeInTheDocument();
    expect(screen.getByTestId("open-questions-dismiss-btn")).toBeInTheDocument();
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
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("task-detail-title")).toHaveTextContent("Task With Error");
    expect(screen.getByTestId("task-detail-error")).toHaveTextContent(
      "Failed to load task details"
    );
  });

  it("renders actions menu with Mark done when task is not done and not blocked", async () => {
    const user = userEvent.setup();
    const props = createMinimalProps();
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("sidebar-actions-menu-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-retry-btn")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    expect(screen.getByTestId("sidebar-mark-done-btn")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-delete-task-btn")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /mark done/i })).toBeInTheDocument();
  });

  it("renders actions menu trigger to the right of title, close to the left of X", () => {
    const props = createMinimalProps();
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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

  it("renders actions menu with Retry when task is blocked", async () => {
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
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("sidebar-actions-menu-trigger")).toBeInTheDocument();
    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    expect(screen.getByTestId("sidebar-retry-btn")).toBeInTheDocument();
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
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    const blockReason = screen.getByTestId("task-block-reason");
    expect(blockReason).toBeInTheDocument();
    expect(blockReason).toHaveTextContent("Merge Failure");
  });

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const props = createMinimalProps({ onClose });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    await user.click(screen.getByRole("button", { name: "Close task detail" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onMarkDone when Mark done is clicked from actions menu", async () => {
    const user = userEvent.setup();
    const onMarkDone = vi.fn();
    const props = createMinimalProps({ onMarkDone });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    await user.click(screen.getByTestId("sidebar-mark-done-btn"));
    expect(onMarkDone).toHaveBeenCalledTimes(1);
  });

  it("calls onUnblock when Retry is clicked from actions menu", async () => {
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    await user.click(screen.getByTestId("sidebar-retry-btn"));
    expect(onUnblock).toHaveBeenCalledTimes(1);
  });

  it("opens and closes delete confirmation dialog from actions menu", async () => {
    const user = userEvent.setup();
    const props = createMinimalProps();
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    await user.click(screen.getByTestId("sidebar-delete-task-btn"));
    expect(screen.getByTestId("sidebar-delete-task-dialog")).toBeInTheDocument();

    await user.click(screen.getByTestId("sidebar-delete-task-cancel-btn"));
    expect(screen.queryByTestId("sidebar-delete-task-dialog")).not.toBeInTheDocument();
  });

  it("calls onDeleteTask when delete is confirmed", async () => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn().mockResolvedValue(undefined);
    const props = createMinimalProps({ onDeleteTask });
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    await user.click(screen.getByTestId("sidebar-delete-task-btn"));
    await user.click(screen.getByTestId("sidebar-delete-task-confirm-btn"));
    expect(onDeleteTask).toHaveBeenCalledTimes(1);
  });

  it("does not render actions menu when task is done", () => {
    const props = createMinimalProps({ isDoneTask: true });
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.queryByTestId("sidebar-actions-menu-trigger")).not.toBeInTheDocument();
  });

  it("closes actions menu on outside click", async () => {
    const user = userEvent.setup();
    const props = createMinimalProps();
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    await user.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    expect(screen.getByTestId("sidebar-actions-menu")).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByTestId("sidebar-actions-menu")).not.toBeInTheDocument();
  });

  it("live output sits inside a single container with one border (no redundant nesting)", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: ["Line 1", "Line 2"],
      artifactsSectionExpanded: true,
    });

    const { container } = renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    const artifactsContent = container.querySelector("#artifacts-content");
    expect(artifactsContent).toBeInTheDocument();

    // Single bordered container: bg-theme-code-bg rounded-lg border border-theme-border
    const borderedContainers =
      artifactsContent?.querySelectorAll(
        ".bg-theme-code-bg.rounded-lg.border.border-theme-border"
      ) ?? [];
    expect(borderedContainers.length).toBe(1);

    const liveOutput = screen.getByTestId("live-agent-output");
    expect(liveOutput).toBeInTheDocument();
    expect(liveOutput).toHaveTextContent("Line 1");
    expect(liveOutput).toHaveTextContent("Line 2");
  });

  it("uses plain text rendering while live output is still streaming", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: ["Hello **world**"],
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    const container = screen.getByTestId("live-agent-output");
    expect(container.tagName).toBe("DIV");
    expect(container).toHaveClass("overflow-y-auto");
    expect(container).toHaveClass("text-theme-success-muted");
    expect(container).toHaveTextContent("Hello **world**");
  });

  it("upgrades to markdown rendering once the agent has finished", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      completionState: { status: "approved", testResults: null },
      agentOutput: ["**Bold text** and `inline code`\n\n```\ncode block\n```"],
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    const container = screen.getByTestId("live-agent-output");
    expect(container).toBeInTheDocument();
    expect(container).toHaveTextContent("Bold text");
    expect(container).toHaveTextContent("inline code");
    expect(container).toHaveTextContent("code block");
  });

  it("applies prose classes for completed markdown output", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      completionState: { status: "approved", testResults: null },
      agentOutput: ["```\ncode\n```"],
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    const container = screen.getByTestId("live-agent-output");
    expect(container).toHaveClass("prose-execute-task");
    expect(container).toHaveClass("prose-pre:bg-theme-code-bg");
    expect(container).toHaveClass("prose-pre:text-theme-code-text");
  });

  it("filters archived outputLog when showing fallback (agentOutput empty, archivedSessions present)", () => {
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    const container = screen.getByTestId("live-agent-output");
    expect(container).toHaveTextContent("Visible content");
    expect(container).not.toHaveTextContent("tool_use");
  });

  it("shows archived output for blocked task (merge failure) when agentOutput empty", () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      isBlockedTask: true,
      agentOutput: [],
      completionState: null,
      selectedTaskData: {
        id: "epic-1.1",
        title: "Task A",
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
      archivedSessions: [
        {
          attempt: 1,
          status: "failed",
          agentType: "coder",
          outputLog: "Merge conflict output from failed run",
          gitDiff: null,
          testResults: null,
          failureReason: "Merge Failure",
        },
      ],
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    const container = screen.getByTestId("live-agent-output");
    expect(container).toHaveTextContent("Merge conflict output from failed run");
    expect(container).not.toHaveTextContent("Waiting for agent output");
  });

  it("shows Jump to bottom button when user scrolls up in live agent output", async () => {
    const props = createMinimalProps({
      wsConnected: true,
      isDoneTask: false,
      agentOutput: ["Line 1\n", "Line 2\n", "Line 3\n"],
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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

  it("shows suspended placeholder when the selected task is suspended with no live output", () => {
    const props = createMinimalProps({
      activeTasks: [
        {
          taskId: "epic-1.1",
          phase: "coding",
          startedAt: "2026-02-16T12:00:00.000Z",
          state: "suspended",
        },
      ],
      archivedSessions: [],
      agentOutput: [],
      wsConnected: true,
      isDoneTask: false,
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("live-agent-output")).toHaveTextContent(
      "Agent suspended; waiting for reconnect or new output..."
    );
  });

  it("shows connecting state when wsConnected is false and task is not done", () => {
    const props = createMinimalProps({ wsConnected: false, isDoneTask: false });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("live-output-connecting")).toBeInTheDocument();
    expect(screen.getByText("Connecting to live output…")).toBeInTheDocument();
  });

  it("shows task detail error when taskDetailError is set", () => {
    const props = createMinimalProps({ taskDetailError: "Network error" });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("task-detail-error")).toHaveTextContent("Network error");
  });

  it("renders Links above Description in DOM order", () => {
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    const linksHeader = screen.getByText("Links:");
    const descriptionHeader = screen.getByRole("button", { name: /collapse description/i });
    expect(
      linksHeader.compareDocumentPosition(descriptionHeader) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("hides Links section when epic is the only dependency", () => {
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.queryByText("Links:")).not.toBeInTheDocument();
  });

  it("shows Plan as first item in Links when task has epicId, plan, onNavigateToPlan, and no other deps", () => {
    const onNavigateToPlan = vi.fn();
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
        createdAt: "",
        updatedAt: "",
      },
      tasks: [],
      onNavigateToPlan,
      descriptionSectionExpanded: true,
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByText("Links:")).toBeInTheDocument();
    const planLink = screen.getByTestId("sidebar-view-plan-btn");
    expect(planLink).toBeInTheDocument();
    expect(planLink).toHaveTextContent(/plan:\s*plan/i);
  });

  it("shows Plan as first item in Links before Blocked on, Parent, Related", () => {
    const blockedTask = {
      id: "epic-1.2",
      title: "Remove pagination",
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
    const onNavigateToPlan = vi.fn();
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
      tasks: [blockedTask],
      onNavigateToPlan,
      descriptionSectionExpanded: true,
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByText("Links:")).toBeInTheDocument();
    const planLink = screen.getByTestId("sidebar-view-plan-btn");
    expect(planLink).toBeInTheDocument();
    expect(planLink).toHaveTextContent(/plan:\s*plan/i);
    const linkButtons = screen.getAllByRole("button", { name: /plan|Remove pagination/i });
    expect(linkButtons[0]).toHaveAttribute("data-testid", "sidebar-view-plan-btn");
    expect(linkButtons[1].textContent).toContain("Remove pagination");
  });

  it("shows Links only non-epic dependencies when epic and others exist", () => {
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByText("Links:")).toBeInTheDocument();
    expect(screen.getByText("Prerequisite Task")).toBeInTheDocument();
    expect(screen.queryByText("epic-1")).not.toBeInTheDocument();
  });

  it("shows Links when task has only non-epic dependencies", () => {
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByText("Links:")).toBeInTheDocument();
    expect(screen.getByText("Other Task")).toBeInTheDocument();
  });

  it("shows link type per task and sorts by type (blocked, parent/child, related)", () => {
    const blockedTask = {
      id: "epic-1.2",
      title: "Remove pagination",
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
    const parentTask = {
      id: "epic-1.3",
      title: "Sync plan tasks when agent updates",
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
    const relatedTask = {
      id: "epic-1.4",
      title: "Add hover background",
      epicId: "epic-1",
      kanbanColumn: "backlog" as const,
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
        dependencies: [
          { targetId: "epic-1.4", type: "related" },
          { targetId: "epic-1.2", type: "blocks" },
          { targetId: "epic-1.3", type: "parent-child" },
        ],
        description: "",
        createdAt: "",
        updatedAt: "",
      },
      tasks: [blockedTask, parentTask, relatedTask],
      descriptionSectionExpanded: true,
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByText("Links:")).toBeInTheDocument();
    expect(screen.getByText("Blocked on:")).toBeInTheDocument();
    expect(screen.getByText("Parent:")).toBeInTheDocument();
    expect(screen.getByText("Related:")).toBeInTheDocument();
    expect(screen.getByText("Remove pagination")).toBeInTheDocument();
    expect(screen.getByText("Sync plan tasks when agent updates")).toBeInTheDocument();
    expect(screen.getByText("Add hover background")).toBeInTheDocument();

    const allMatchButtons = screen.getAllByRole("button", {
      name: /Remove pagination|Sync plan tasks|Add hover background/i,
    });
    const linkButtons = allMatchButtons.filter(
      (b) => !b.getAttribute("data-testid")?.startsWith("sidebar-remove-link-btn-")
    );
    expect(linkButtons).toHaveLength(3);
    const firstText = linkButtons[0].textContent ?? "";
    const secondText = linkButtons[1].textContent ?? "";
    const thirdText = linkButtons[2].textContent ?? "";
    expect(firstText).toContain("Remove pagination");
    expect(secondText).toContain("Sync plan tasks when agent updates");
    expect(thirdText).toContain("Add hover background");
  });

  describe("Add link", () => {
    it("shows Add link button in Execute sidebar", () => {
      const props = createMinimalProps({ tasks: [{ id: "epic-1.2", title: "Task B" }] });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      expect(screen.getByTestId("sidebar-add-link-btn")).toBeInTheDocument();
      expect(screen.getByTestId("sidebar-add-link-btn")).toHaveTextContent("Add link");
    });

    it("opens Add link flow with dropdown, input, save and cancel when Add link clicked", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        tasks: [
          {
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
          {
            id: "epic-1.2",
            title: "Task B",
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
        ],
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      await user.click(screen.getByTestId("sidebar-add-link-btn"));
      expect(screen.getByTestId("add-link-flow")).toBeInTheDocument();
      expect(screen.getByTestId("add-link-type-select")).toBeInTheDocument();
      expect(screen.getByTestId("add-link-input")).toBeInTheDocument();
      expect(screen.getByTestId("add-link-save-btn")).toBeInTheDocument();
      expect(screen.getByTestId("add-link-cancel-btn")).toBeInTheDocument();
      const select = screen.getByTestId("add-link-type-select");
      expect(select).toHaveValue("blocks");
      const options = within(select).getAllByRole("option");
      expect(options.map((o) => o.textContent)).toContain("Blocks");
      expect(options.map((o) => o.textContent)).toContain("Parent-child");
      expect(options.map((o) => o.textContent)).toContain("Related");
    });

    it("shows X button and confirmation when removing link", async () => {
      const user = userEvent.setup();
      mockRemoveDependency.mockResolvedValue(undefined);
      mockTasksGet.mockResolvedValue({
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
          dependencies: [{ targetId: "epic-1.2", type: "blocks" }],
          description: "",
          createdAt: "",
          updatedAt: "",
        },
        tasks: [
          {
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
          {
            id: "epic-1.2",
            title: "Task B",
            epicId: "epic-1",
            kanbanColumn: "backlog" as const,
            priority: 0,
            assignee: null,
            type: "task" as const,
            status: "open" as const,
            labels: [],
            dependencies: [],
            description: "",
            createdAt: "",
            updatedAt: "",
          },
        ],
      });
      renderSidebar(props, { preloadedState: defaultPreloadedState });
      const removeBtn = screen.getByTestId("sidebar-remove-link-btn-epic-1.2");
      expect(removeBtn).toBeInTheDocument();
      await user.click(removeBtn);
      expect(screen.getByTestId("sidebar-delete-link-dialog")).toBeInTheDocument();
      expect(screen.getByText(/Are you sure you want to delete the Blocked on link to Task B\?/)).toBeInTheDocument();
      await user.click(screen.getByTestId("sidebar-delete-link-confirm-btn"));
      await waitFor(() => {
        expect(mockRemoveDependency).toHaveBeenCalledWith("proj-1", "epic-1.1", "epic-1.2");
      });
      await waitFor(() => {
        expect(screen.queryByTestId("sidebar-delete-link-dialog")).not.toBeInTheDocument();
      });
    });

    it("cancel dismisses Add link flow without changes", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({ tasks: [{ id: "epic-1.2", title: "Task B" }] });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      await user.click(screen.getByTestId("sidebar-add-link-btn"));
      expect(screen.getByTestId("add-link-flow")).toBeInTheDocument();
      await user.click(screen.getByTestId("add-link-cancel-btn"));
      expect(screen.queryByTestId("add-link-flow")).not.toBeInTheDocument();
      expect(screen.getByTestId("sidebar-add-link-btn")).toBeInTheDocument();
      expect(mockAddDependency).not.toHaveBeenCalled();
    });

    it("save persists link via addDependency when task selected from suggestions", async () => {
      const user = userEvent.setup();
      mockTasksGet.mockResolvedValue({
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
      });
      const props = createMinimalProps({
        tasks: [
          {
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
          {
            id: "epic-1.2",
            title: "Task B",
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
        ],
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      await user.click(screen.getByTestId("sidebar-add-link-btn"));
      await user.type(screen.getByTestId("add-link-input"), "b");
      const suggestion = await screen.findByTestId("add-link-suggestions");
      expect(suggestion).toBeInTheDocument();
      const taskBOption = within(suggestion).getByText("Task B");
      await user.click(taskBOption);
      await waitFor(() => {
        expect(mockAddDependency).toHaveBeenCalledWith("proj-1", "epic-1.1", "epic-1.2", "blocks");
      });
    });

    it("navigates suggestions with arrow keys and Enter selects highlighted entry", async () => {
      const user = userEvent.setup();
      mockTasksGet.mockResolvedValue({
        id: "epic-1.1",
        title: "Task A",
        epicId: "epic-1",
        kanbanColumn: "in_progress" as const,
        priority: 0,
        assignee: null,
        type: "task" as const,
        status: "in_progress" as const,
        labels: [],
        dependencies: [{ targetId: "epic-1.3", type: "blocks" }],
        description: "",
        createdAt: "",
        updatedAt: "",
      });
      const taskB = {
        id: "epic-1.2",
        title: "Task B",
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
      };
      const taskC = {
        id: "epic-1.3",
        title: "Task C",
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
      };
      const props = createMinimalProps({
        tasks: [
          {
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
          taskB,
          taskC,
        ],
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      await user.click(screen.getByTestId("sidebar-add-link-btn"));
      await user.type(screen.getByTestId("add-link-input"), "task");
      const suggestionList = await screen.findByTestId("add-link-suggestions");
      expect(suggestionList).toBeInTheDocument();

      const options = within(suggestionList).getAllByRole("option");
      expect(options).toHaveLength(2);

      await user.keyboard("{ArrowDown}");
      expect(options[1]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{ArrowUp}");
      expect(options[0]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{ArrowDown}");
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(mockAddDependency).toHaveBeenCalledWith("proj-1", "epic-1.1", "epic-1.3", "blocks");
      });
    });

    it("selected suggestion has distinct background when navigating with arrow keys", async () => {
      const user = userEvent.setup();
      const taskB = {
        id: "epic-1.2",
        title: "Task B",
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
      };
      const taskC = {
        id: "epic-1.3",
        title: "Task C",
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
      };
      const props = createMinimalProps({
        tasks: [
          {
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
          taskB,
          taskC,
        ],
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      await user.click(screen.getByTestId("sidebar-add-link-btn"));
      await user.type(screen.getByTestId("add-link-input"), "task");
      const suggestionList = await screen.findByTestId("add-link-suggestions");
      const options = within(suggestionList).getAllByRole("option");

      // Initially first option is selected
      expect(options[0]).toHaveClass("bg-theme-info-bg");
      expect(options[1]).not.toHaveClass("bg-theme-info-bg");

      await user.keyboard("{ArrowDown}");
      expect(options[0]).not.toHaveClass("bg-theme-info-bg");
      expect(options[1]).toHaveClass("bg-theme-info-bg");

      await user.keyboard("{ArrowUp}");
      expect(options[0]).toHaveClass("bg-theme-info-bg");
      expect(options[1]).not.toHaveClass("bg-theme-info-bg");
    });

    it("Enter on first suggestion selects and saves without arrow navigation", async () => {
      const user = userEvent.setup();
      mockTasksGet.mockResolvedValue({
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
      });
      const props = createMinimalProps({
        tasks: [
          {
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
          {
            id: "epic-1.2",
            title: "Task B",
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
        ],
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      await user.click(screen.getByTestId("sidebar-add-link-btn"));
      await user.type(screen.getByTestId("add-link-input"), "b");
      await screen.findByTestId("add-link-suggestions");
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(mockAddDependency).toHaveBeenCalledWith("proj-1", "epic-1.1", "epic-1.2", "blocks");
      });
    });
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      expect(screen.getByTestId("priority-dropdown-trigger")).toBeInTheDocument();
      expect(screen.queryByTestId("priority-read-only")).not.toBeInTheDocument();
    });

    it("shows current priority as clickable element when selectedTaskData is loaded", () => {
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const trigger = screen.getByTestId("priority-dropdown-trigger");
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveTextContent("High");
      expect(trigger).toHaveAttribute("aria-label", "Priority: High. Click to change");
    });

    it("renders PriorityIcon in the priority dropdown trigger", () => {
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const trigger = screen.getByTestId("priority-dropdown-trigger");
      expect(within(trigger).getByRole("img", { name: "High" })).toBeInTheDocument();
    });

    it("renders PriorityIcon in each dropdown option with correct priority", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(2),
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      await user.click(screen.getByTestId("priority-dropdown-trigger"));
      expect(screen.getByTestId("priority-dropdown")).toBeInTheDocument();
      await user.click(screen.getByTestId("priority-option-0"));
      expect(mockUpdatePriority).toHaveBeenCalledWith("proj-1", "epic-1.1", 0);
      expect(screen.queryByTestId("priority-dropdown")).not.toBeInTheDocument();
    });

    it("shows Updating… and disables dropdown when priorityUpdateLoading is true", () => {
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(1),
        priorityUpdateLoading: true,
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const trigger = screen.getByTestId("priority-dropdown-trigger");
      expect(trigger).toHaveTextContent("Updating…");
      expect(trigger).toBeDisabled();
      expect(trigger).toHaveAttribute("aria-busy", "true");
    });

    it("does not call API when selecting the same priority", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(2),
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      await user.click(screen.getByTestId("priority-dropdown-trigger"));
      await user.click(screen.getByTestId("priority-option-2"));
      expect(mockUpdatePriority).not.toHaveBeenCalled();
    });

    it("closes dropdown on outside click", async () => {
      const user = userEvent.setup();
      const props = createMinimalProps({
        selectedTaskData: taskDetailWithPriority(2),
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const readOnly = screen.getByTestId("priority-read-only");
      await user.click(readOnly);
      expect(screen.queryByTestId("priority-dropdown")).not.toBeInTheDocument();
    });

    it("updates to read-only when task transitions to done while sidebar is open", async () => {
      const store = createTestStore(defaultPreloadedState);
      const taskDetail = taskDetailWithPriority(1);
      store.dispatch(
        fetchTaskDetail.fulfilled(taskDetail, "", {
          projectId: "proj-1",
          taskId: "epic-1.1",
        })
      );
      const { rerender } = render(
        wrapWithProviders(
          <MemoryRouter>
            <TaskDetailSidebar
              {...createMinimalProps({
                selectedTaskData: { ...taskDetail, kanbanColumn: "in_progress" as const },
                isDoneTask: false,
              })}
            />
          </MemoryRouter>,
          { store }
        )
      );
      expect(screen.getByTestId("priority-dropdown-trigger")).toBeInTheDocument();

      rerender(
        wrapWithProviders(
          <MemoryRouter>
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
          </MemoryRouter>,
          { store }
        )
      );
      expect(screen.getByTestId("priority-read-only")).toBeInTheDocument();
      expect(screen.queryByTestId("priority-dropdown-trigger")).not.toBeInTheDocument();
    });

    it("reverts UI and shows toast when API fails", async () => {
      const user = userEvent.setup();
      mockUpdatePriority.mockRejectedValue(new Error("Validation failed"));
      const store = createTestStore(defaultPreloadedState);
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
        return (
          <MemoryRouter>
            <TaskDetailSidebar {...props} />
          </MemoryRouter>
        );
      }
      render(wrapWithProviders(<Wrapper />, { store }));
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
    it("shows Simple when task has complexity 3", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...defaultSelectedTaskData,
          complexity: 3,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveTextContent("Simple");
      expect(complexity).toHaveAttribute("aria-label", "Complexity: Simple");
      expect(screen.getByRole("img", { name: "Simple complexity" })).toBeInTheDocument();
    });

    it("shows Complex when task has complexity 7", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...defaultSelectedTaskData,
          complexity: 7,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveTextContent("Complex");
      expect(complexity).toHaveAttribute("aria-label", "Complexity: Complex");
      expect(screen.getByRole("img", { name: "Complex complexity" })).toBeInTheDocument();
    });

    it("shows em dash when task has no complexity", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...defaultSelectedTaskData,
          complexity: undefined,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveTextContent("—");
      expect(complexity).toHaveAttribute("aria-label", "Complexity: not set");
    });

    it("shows Score: N/10 tooltip on hover when task has valid complexity", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...defaultSelectedTaskData,
          complexity: 5,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveAttribute("title", "Score: 5/10");
    });

    it("shows Score: 1/10 tooltip for complexity 1", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...defaultSelectedTaskData,
          complexity: 1,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveAttribute("title", "Score: 1/10");
    });

    it("shows Score: 10/10 tooltip for complexity 10", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...defaultSelectedTaskData,
          complexity: 10,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).toHaveAttribute("title", "Score: 10/10");
    });

    it("has no tooltip when task has no complexity", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...defaultSelectedTaskData,
          complexity: undefined,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const complexity = screen.getByTestId("task-complexity");
      expect(complexity).not.toHaveAttribute("title");
    });

    it("displays complexity in same row as priority", () => {
      const props = createMinimalProps({
        selectedTaskData: {
          ...defaultSelectedTaskData,
          complexity: 7,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
          ...defaultSelectedTaskData,
          kanbanColumn: "done" as const,
          status: "closed" as const,
          startedAt: "2026-02-16T12:00:00.000Z",
          completedAt: "2026-02-16T12:05:30.000Z",
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const duration = screen.getByTestId("task-duration");
      expect(duration).toHaveTextContent("Took 5:30");
      expect(duration).toHaveAttribute("aria-label", "Took 5:30");
    });

    it("does not show duration for in-progress tasks", () => {
      const props = createMinimalProps({
        isDoneTask: false,
        selectedTaskData: {
          ...defaultSelectedTaskData,
          kanbanColumn: "in_progress" as const,
          startedAt: "2026-02-16T12:00:00.000Z",
          completedAt: null,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      expect(screen.queryByTestId("task-duration")).not.toBeInTheDocument();
    });

    it("does not show duration for completed tasks without completedAt", () => {
      const props = createMinimalProps({
        isDoneTask: true,
        selectedTaskData: {
          ...defaultSelectedTaskData,
          kanbanColumn: "done" as const,
          status: "closed" as const,
          startedAt: "2026-02-16T12:00:00.000Z",
          completedAt: null,
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      expect(screen.queryByTestId("task-duration")).not.toBeInTheDocument();
    });

    it("does not show duration for completed tasks without startedAt", () => {
      const props = createMinimalProps({
        isDoneTask: true,
        selectedTaskData: {
          ...defaultSelectedTaskData,
          kanbanColumn: "done" as const,
          status: "closed" as const,
          startedAt: null,
          completedAt: "2026-02-16T12:05:30.000Z",
        },
      });
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
        const { unmount } = renderSidebar(props, {
          preloadedState: defaultPreloadedState,
        });
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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
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
      renderSidebar(props, {
        preloadedState: defaultPreloadedState,
      });
      const callout = screen.getByTestId("task-detail-active-callout");
      expect(callout).toHaveTextContent("Active: Coder");
    });

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
    const setDiagnosticsSectionExpanded = vi.fn();
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
      diagnostics: {
        taskId: "epic-1.1",
        taskStatus: "in_progress",
        blockReason: null,
        cumulativeAttempts: 1,
        latestSummary: "Running",
        latestFailureType: null,
        latestOutcome: "running" as const,
        latestNextAction: null,
        timeline: [],
        attempts: [],
      },
      sourceFeedbackExpanded: { "fb-1": true },
      setSourceFeedbackExpanded,
      descriptionSectionExpanded: true,
      setDescriptionSectionExpanded,
      artifactsSectionExpanded: true,
      setArtifactsSectionExpanded,
      diagnosticsSectionExpanded: true,
      setDiagnosticsSectionExpanded,
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    await screen.findByText("Add feature");

    const descBtn = screen.getByRole("button", { name: /collapse description/i });
    const sourceBtn = screen.getByRole("button", { name: /collapse source feedback/i });
    const diagnosticsBtn = screen.getByRole("button", {
      name: /collapse execution diagnostics/i,
    });
    const artifactsBtn = screen.getByRole("button", {
      name: /collapse live agent output/i,
    });

    await user.click(descBtn);
    expect(setDescriptionSectionExpanded).toHaveBeenCalledTimes(1);

    await user.click(sourceBtn);
    expect(setSourceFeedbackExpanded).toHaveBeenCalledTimes(1);

    await user.click(diagnosticsBtn);
    expect(setDiagnosticsSectionExpanded).toHaveBeenCalledTimes(1);

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

    const { container } = renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("completion-failure-reason")).toHaveTextContent(
      "Cursor agent requires authentication. Run agent login."
    );
  });

  it("renders execution diagnostics summary and attempt history", () => {
    const props = createMinimalProps({
      isBlockedTask: true,
      selectedTaskData: {
        ...defaultSelectedTaskData,
        kanbanColumn: "blocked" as const,
        status: "blocked" as const,
        blockReason: "Merge Failure",
      },
      diagnostics: {
        taskId: "epic-1.1",
        taskStatus: "blocked",
        blockReason: "Merge Failure",
        cumulativeAttempts: 6,
        latestSummary: "Attempt 6 merge failed during merge_to_main: fatal: no rebase in progress",
        latestFailureType: null,
        latestOutcome: "blocked" as const,
        latestNextAction: "Blocked pending investigation",
        timeline: [],
        attempts: [
          {
            attempt: 6,
            finalPhase: "merge" as const,
            finalOutcome: "blocked" as const,
            finalSummary:
              "Attempt 6 merge failed during merge_to_main: fatal: no rebase in progress",
            codingModel: "composer-1.5",
            reviewModel: "composer-1.5",
            mergeStage: "merge_to_main",
            conflictedFiles: ["packages/backend/src/routes/global-settings.ts"],
            sessionAttemptStatuses: [],
            startedAt: "2026-03-01T17:02:25.000Z",
            completedAt: "2026-03-01T17:04:21.000Z",
          },
          {
            attempt: 2,
            finalPhase: "coding" as const,
            finalOutcome: "failed" as const,
            finalSummary:
              "Attempt 2 failed before coding started because the selected OpenAI model was not supported by chat/completions",
            codingModel: "gpt-5.3-codex",
            reviewModel: null,
            mergeStage: null,
            conflictedFiles: [],
            sessionAttemptStatuses: ["failed"],
            startedAt: "2026-03-01T16:10:24.000Z",
            completedAt: "2026-03-01T16:10:26.000Z",
          },
          {
            attempt: 1,
            finalPhase: "coding" as const,
            finalOutcome: "failed" as const,
            finalSummary:
              "Attempt 1 failed before coding started because the selected OpenAI model was not supported by chat/completions",
            codingModel: "gpt-5.3-codex",
            reviewModel: null,
            mergeStage: null,
            conflictedFiles: [],
            sessionAttemptStatuses: ["failed"],
            startedAt: "2026-03-01T16:08:24.000Z",
            completedAt: "2026-03-01T16:08:26.000Z",
          },
        ],
      },
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByTestId("execution-diagnostics-block-reason")).toHaveTextContent(
      "Failures: Merge Failure"
    );
    expect(screen.getByTestId("execution-diagnostics-latest-summary")).toHaveTextContent(
      "fatal: no rebase in progress"
    );
    expect(screen.getByTestId("execution-diagnostics-earlier-failures")).toHaveTextContent(
      "Attempts 1-2"
    );
    expect(screen.getByTestId("execution-attempt-6")).toHaveTextContent("Merge · Failures");
    expect(screen.getByTestId("execution-attempt-6")).toHaveTextContent(
      "packages/backend/src/routes/global-settings.ts"
    );
  });

  it("hides Execution diagnostics content when diagnosticsSectionExpanded is false", () => {
    const props = createMinimalProps({
      diagnostics: {
        taskId: "epic-1.1",
        taskStatus: "blocked",
        blockReason: "Merge Failure",
        cumulativeAttempts: 1,
        latestSummary: "Merge failed",
        latestFailureType: null,
        latestOutcome: "blocked" as const,
        latestNextAction: null,
        timeline: [],
        attempts: [],
      },
      diagnosticsSectionExpanded: false,
    });

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByRole("button", { name: /expand execution diagnostics/i })).toBeInTheDocument();
    expect(screen.queryByTestId("execution-diagnostics-section")).not.toBeInTheDocument();
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

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
    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    await user.click(screen.getByRole("button", { name: /collapse source feedback \(1 of 2\)/i }));
    expect(setSourceFeedbackExpanded).toHaveBeenCalledWith(expect.any(Function));
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

    renderSidebar(props, {
      preloadedState: defaultPreloadedState,
    });

    expect(screen.getByRole("button", { name: /source feedback/i })).toBeInTheDocument();
    expect(await screen.findByText("Legacy single feedback")).toBeInTheDocument();
  });
});
