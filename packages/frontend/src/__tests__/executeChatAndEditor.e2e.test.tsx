/**
 * E2E tests for Execute-phase chat and Open in Editor.
 *
 * Scenario A — API backend: chat tab visible, send message → optimistic UI → WS response.
 * Scenario B — CLI backend: chat disabled with spec copy message.
 * Scenario C — Open in Editor: IPC path (Electron) or copy-path fallback (web).
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { render as testingRender, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { ExecutePhase } from "../pages/phases/ExecutePhase";
import { TaskDetailSidebar } from "../components/execute/TaskDetailSidebar";
import projectReducer from "../store/slices/projectSlice";
import planReducer from "../store/slices/planSlice";
import executeReducer, {
  initialExecuteState,
  toTasksByIdAndOrder,
} from "../store/slices/executeSlice";
import evalReducer from "../store/slices/evalSlice";
import websocketReducer from "../store/slices/websocketSlice";
import agentChatReducer, {
  initialAgentChatState,
  chatMessageReceived,
  chatResponseReceived,
  chatUnsupported,
} from "../store/slices/agentChatSlice";

import type { ReactElement } from "react";
import { seedServerFixtureFromElement } from "../test/seedServerFixtures";
import { queryKeys } from "../api/queryKeys";

function render(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seedServerFixtureFromElement(queryClient, ui);
  return testingRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/* ─── API mocks ─── */

const mockTasksList = vi.fn();
const mockTaskGet = vi.fn();
const mockSessions = vi.fn();
const mockLiveOutput = vi.fn();
const mockAgentsActive = vi.fn();
const mockTaskDiagnostics = vi.fn();
const mockExecuteStatus = vi.fn();
const mockChatHistory = vi.fn();
const mockChatSupport = vi.fn();
const mockOpenEditor = vi.fn();
const mockGetSettings = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    tasks: {
      list: (...args: unknown[]) => mockTasksList(...args),
      get: (...args: unknown[]) => mockTaskGet(...args),
      sessions: (...args: unknown[]) => mockSessions(...args),
      markDone: vi.fn().mockResolvedValue(undefined),
      unblock: vi.fn().mockResolvedValue({ taskUnblocked: true }),
      chatHistory: (...args: unknown[]) => mockChatHistory(...args),
      chatSupport: (...args: unknown[]) => mockChatSupport(...args),
      openEditor: (...args: unknown[]) => mockOpenEditor(...args),
    },
    plans: {
      list: vi.fn().mockResolvedValue({ plans: [], edges: [] }),
    },
    projects: {
      get: vi.fn().mockResolvedValue({
        id: "proj-1",
        name: "Test",
        repoPath: "/tmp",
        currentPhase: "execute",
        createdAt: "",
        updatedAt: "",
      }),
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
    },
    execute: {
      status: (...args: unknown[]) => mockExecuteStatus(...args),
      liveOutput: (...args: unknown[]) => mockLiveOutput(...args),
      taskDiagnostics: (...args: unknown[]) => mockTaskDiagnostics(...args),
    },
    agents: {
      active: (...args: unknown[]) => mockAgentsActive(...args),
    },
    feedback: {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    },
    notifications: {
      listByProject: vi.fn().mockResolvedValue([]),
    },
  },
}));

/* ─── Fixtures ─── */

const basePlan = {
  metadata: { planId: "plan-1", epicId: "epic-1", complexity: "medium" as const },
  content: "# Plan",
  status: "building" as const,
  taskCount: 1,
  doneTaskCount: 0,
  dependencyCount: 0,
};

const inProgressTask = {
  id: "epic-1.1",
  title: "Implement auth",
  epicId: "epic-1",
  kanbanColumn: "in_progress" as const,
  priority: 0,
  assignee: "agent",
  description: "Implement authentication service",
  type: "task" as const,
  status: "in_progress" as const,
  labels: [] as string[],
  dependencies: [] as { targetId: string; type: string }[],
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

/* ─── Store helpers ─── */

function createFullPageStore() {
  const tasks = [inProgressTask];
  const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(tasks as never);
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      websocket: websocketReducer,
      agentChat: agentChatReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: { ignoredActions: ["ws/connect", "ws/disconnect", "ws/send"] },
      }),
    preloadedState: {
      websocket: { connected: true },
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
      execute: {
        ...initialExecuteState,
        tasksById,
        taskIdsOrder,
        selectedTaskId: "epic-1.1",
        activeTasks: [
          {
            taskId: "epic-1.1",
            state: "running",
            worktreePath: "/tmp/opensprint-worktrees/os-test",
            phase: "coding",
            name: "Coder",
          },
        ],
      },
      agentChat: {
        ...initialAgentChatState,
        supportByTaskId: { "epic-1.1": { supported: true } },
      },
    },
  });
}

function createSidebarStore(opts?: { chatSupported?: boolean }) {
  const tasks = [inProgressTask];
  const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(tasks as never);
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      websocket: websocketReducer,
      agentChat: agentChatReducer,
    },
    preloadedState: {
      websocket: { connected: true },
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
      execute: {
        ...initialExecuteState,
        tasksById,
        taskIdsOrder,
        selectedTaskId: "epic-1.1",
        activeTasks: [
          {
            taskId: "epic-1.1",
            state: "running",
            worktreePath: "/tmp/opensprint-worktrees/os-test",
            phase: "coding",
            name: "Coder",
          },
        ],
      },
      agentChat: {
        ...initialAgentChatState,
        supportByTaskId: {
          "epic-1.1": {
            supported: opts?.chatSupported ?? true,
          },
        },
      },
    },
  });
}

async function renderExecutePhase(store: ReturnType<typeof createFullPageStore>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Provider store={store}>
          <ExecutePhase projectId="proj-1" />
        </Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, queryClient };
}

async function openExecuteChatTab(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: "Chat" })).toBeInTheDocument();
  });
  await user.click(screen.getByRole("tab", { name: "Chat" }));
  await waitFor(() => {
    expect(screen.getByTestId("execute-agent-chat-panel")).toBeInTheDocument();
  });
}

function createSidebarProps(overrides?: {
  chatSupported?: boolean;
  chatUnsupportedReason?: string;
  isInProgressTask?: boolean;
  worktreePath?: string | null;
}) {
  return {
    projectId: "proj-1",
    selectedTask: "epic-1.1",
    taskDetail: {
      selectedTaskData: inProgressTask,
      taskDetailLoading: false,
      taskDetailError: null,
    },
    agentOutput: [] as string[],
    completionState: null,
    diagnostics: null,
    diagnosticsLoading: false,
    archivedSessions: [],
    archivedLoading: false,
    markDoneLoading: false,
    unblockLoading: false,
    deleteLoading: false,
    forceRetryLoading: false,
    taskIdToStartedAt: {},
    planByEpicId: { [basePlan.metadata.epicId]: basePlan },
    taskById: {},
    activeTasks: [
      {
        taskId: "epic-1.1",
        state: "running" as const,
        worktreePath: "/tmp/opensprint-worktrees/os-test",
        phase: "coding" as const,
        name: "Coder",
      },
    ],
    wsConnected: true,
    isDoneTask: false,
    isBlockedTask: false,
    isInProgressTask: overrides?.isInProgressTask ?? true,
    sections: {
      sourceFeedbackExpanded: {},
      setSourceFeedbackExpanded: vi.fn(),
      descriptionSectionExpanded: true,
      setDescriptionSectionExpanded: vi.fn(),
      artifactsSectionExpanded: true,
      setArtifactsSectionExpanded: vi.fn(),
      diagnosticsSectionExpanded: true,
      setDiagnosticsSectionExpanded: vi.fn(),
    },
    callbacks: {
      onClose: vi.fn(),
      onMarkDone: vi.fn(),
      onUnblock: vi.fn(),
      onDeleteTask: vi.fn(),
      onForceRetry: vi.fn(),
      onSelectTask: vi.fn(),
    },
    chatSupported: overrides?.chatSupported ?? true,
    chatUnsupportedReason: overrides?.chatUnsupportedReason,
    chatMessages: [],
    chatSending: false,
    onChatSend: vi.fn(),
    chatDraftStorageKey: "test-chat-draft",
    worktreePath: overrides?.worktreePath,
  };
}

/* ─── Setup ─── */

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockTasksList.mockResolvedValue([]);
  mockTaskGet.mockResolvedValue(inProgressTask);
  mockSessions.mockResolvedValue([]);
  mockLiveOutput.mockResolvedValue({ output: "" });
  mockAgentsActive.mockResolvedValue([
    { taskId: "epic-1.1", state: "running", phase: "coding", name: "Coder" },
  ]);
  mockTaskDiagnostics.mockResolvedValue(null);
  mockExecuteStatus.mockResolvedValue({
    activeTasks: [
      {
        taskId: "epic-1.1",
        state: "running",
        worktreePath: "/tmp/opensprint-worktrees/os-test",
      },
    ],
    queueDepth: 0,
  });
  mockGetSettings.mockResolvedValue({
    teamMembers: [],
    enableHumanTeammates: false,
    gitWorkingMode: "worktrees",
  });
  mockChatHistory.mockResolvedValue({
    messages: [],
    attempt: 1,
    chatSupported: true,
  });
  mockChatSupport.mockResolvedValue({
    supported: true,
    backend: "claude",
    reason: null,
  });
  mockOpenEditor.mockResolvedValue({
    worktreePath: "/tmp/opensprint-worktrees/os-test",
    editor: "cursor",
    opened: true,
  });
});

afterEach(() => {
  delete (window as Record<string, unknown>).electron;
});

/* ─── Scenario A: API backend — chat tab, send, optimistic UI, WS response ─── */

describe("E2E: Execute chat — API backend (Scenario A)", () => {
  it("shows chat section and sends a message with optimistic UI", async () => {
    const store = createFullPageStore();
    await renderExecutePhase(store);

    const user = userEvent.setup();
    await openExecuteChatTab(user);

    const input = screen.getByPlaceholderText("Message the agent…");
    expect(input).not.toBeDisabled();
    await user.type(input, "Focus on error handling first{Enter}");

    await waitFor(() => {
      const state = store.getState();
      const msgs = state.agentChat.messagesByTaskId["epic-1.1"];
      expect(msgs).toBeDefined();
      expect(msgs.length).toBe(1);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toBe("Focus on error handling first");
      expect(msgs[0].delivered).toBe(false);
    });

    expect(store.getState().agentChat.sendingByTaskId["epic-1.1"]).toBe(true);
  });

  it("marks user message as delivered on agent.chat.received and shows agent response", async () => {
    const store = createFullPageStore();
    const { queryClient } = await renderExecutePhase(store);

    const user = userEvent.setup();
    await openExecuteChatTab(user);
    const input = screen.getByPlaceholderText("Message the agent…");
    await user.type(input, "Hello agent{Enter}");

    await waitFor(() => {
      const msgs = store.getState().agentChat.messagesByTaskId["epic-1.1"];
      expect(msgs?.length).toBe(1);
    });

    act(() => {
      store.dispatch(
        chatMessageReceived({
          taskId: "epic-1.1",
          clientMessageId:
            store.getState().agentChat.messagesByTaskId["epic-1.1"][0].clientMessageId,
          status: "queued",
          messageId: "msg-server-1",
          timestamp: "2026-03-28T12:00:00Z",
        })
      );
    });

    await waitFor(() => {
      const msgs = store.getState().agentChat.messagesByTaskId["epic-1.1"];
      const userMsg = msgs?.find((m) => m.role === "user");
      expect(userMsg?.status).toBe("queued");
      expect(userMsg?.id).toBe("msg-server-1");
    });

    act(() => {
      store.dispatch(
        chatResponseReceived({
          taskId: "epic-1.1",
          messageId: "msg-server-1",
          content: "Got it — prioritizing error handling.",
        })
      );
    });

    act(() =>
      queryClient.setQueryData(queryKeys.tasks.chatHistory("proj-1", "epic-1.1"), {
        messages: [
          { ...store.getState().agentChat.messagesByTaskId["epic-1.1"][0], status: "included" },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Got it — prioritizing error handling.",
            timestamp: "2026-03-28T12:00:01Z",
          },
        ],
      })
    );
    await waitFor(() =>
      expect(screen.getByText("Got it — prioritizing error handling.")).toBeInTheDocument()
    );
    expect(
      store
        .getState()
        .agentChat.messagesByTaskId["epic-1.1"]?.every((message) => message.role === "user")
    ).toBe(true);

    expect(store.getState().agentChat.sendingByTaskId["epic-1.1"]).toBe(false);
  });

  it("shows delivery checkmark on delivered user messages in the UI", async () => {
    const store = createFullPageStore();
    await renderExecutePhase(store);

    const user = userEvent.setup();
    await openExecuteChatTab(user);
    const input = screen.getByPlaceholderText("Message the agent…");
    await user.type(input, "Test delivery{Enter}");

    await waitFor(() => {
      const msgs = store.getState().agentChat.messagesByTaskId["epic-1.1"];
      expect(msgs?.length).toBe(1);
    });

    expect(screen.getAllByText("Saving guidance…").length).toBeGreaterThan(0);

    act(() => {
      store.dispatch(
        chatMessageReceived({
          taskId: "epic-1.1",
          clientMessageId:
            store.getState().agentChat.messagesByTaskId["epic-1.1"][0].clientMessageId,
          status: "queued",
          messageId: "msg-delivered",
          timestamp: "2026-03-28T12:00:00Z",
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("delivery-checkmark")).toBeInTheDocument();
    });
  });

  it("disables send button while waiting for agent response", async () => {
    const store = createFullPageStore();
    await renderExecutePhase(store);

    const user = userEvent.setup();
    await openExecuteChatTab(user);
    const input = screen.getByPlaceholderText("Message the agent…");
    await user.type(input, "First message{Enter}");

    await waitFor(() => {
      expect(store.getState().agentChat.sendingByTaskId["epic-1.1"]).toBe(true);
    });

    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();
  });
});

/* ─── Scenario B: CLI backend — disabled chat with spec copy ─── */

describe("E2E: Execute chat — CLI backend disabled (Scenario B)", () => {
  const CLI_UNSUPPORTED_MSG =
    "Chat is not available for CLI-based agent backends. Switch to API mode (Project Settings → Agent Config) to chat with running agents.";

  it("shows unsupported notice with exact spec message for CLI backend", async () => {
    const user = userEvent.setup();
    const store = createSidebarStore({ chatSupported: false });
    const props = createSidebarProps({
      chatSupported: false,
      chatUnsupportedReason: CLI_UNSUPPORTED_MSG,
    });

    render(
      <Provider store={store}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    expect(screen.queryByText("Chat with agent")).not.toBeInTheDocument();
    await openExecuteChatTab(user);

    expect(screen.getByTestId("chat-unsupported-notice")).toBeInTheDocument();
    expect(screen.getByText(CLI_UNSUPPORTED_MSG)).toBeInTheDocument();

    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();

    expect(screen.getByPlaceholderText("Chat unavailable with CLI backend")).toBeInTheDocument();
  });

  it("handles chatUnsupported WS event and updates Redux state", () => {
    const store = createSidebarStore({ chatSupported: true });

    expect(store.getState().agentChat.supportByTaskId["epic-1.1"]?.supported).toBe(true);

    act(() => {
      store.dispatch(
        chatUnsupported({
          taskId: "epic-1.1",
          reason: CLI_UNSUPPORTED_MSG,
        })
      );
    });

    const support = store.getState().agentChat.supportByTaskId["epic-1.1"];
    expect(support?.supported).toBe(false);
    expect(support?.reason).toBe(CLI_UNSUPPORTED_MSG);
  });

  it("shows not-running notice when agent is idle and chat is supported", async () => {
    const user = userEvent.setup();
    const store = createSidebarStore();
    const props = createSidebarProps({ chatSupported: true });
    const propsWithNoActiveAgent = {
      ...props,
      activeTasks: [],
    };

    render(
      <Provider store={store}>
        <TaskDetailSidebar {...propsWithNoActiveAgent} />
      </Provider>
    );

    await openExecuteChatTab(user);

    expect(screen.getByTestId("chat-not-running-notice")).toBeInTheDocument();
    expect(screen.getByText(/The agent is not currently running/)).toBeInTheDocument();
  });

  it("unsupported notice takes priority over not-running notice", async () => {
    const user = userEvent.setup();
    const store = createSidebarStore({ chatSupported: false });
    const props = createSidebarProps({
      chatSupported: false,
      chatUnsupportedReason: CLI_UNSUPPORTED_MSG,
    });
    const propsWithNoActiveAgent = {
      ...props,
      activeTasks: [],
    };

    render(
      <Provider store={store}>
        <TaskDetailSidebar {...propsWithNoActiveAgent} />
      </Provider>
    );

    await openExecuteChatTab(user);

    expect(screen.getByTestId("chat-unsupported-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-not-running-notice")).not.toBeInTheDocument();
  });
});

/* ─── Scenario C: Open in Editor ─── */

describe("E2E: Open in Editor (Scenario C)", () => {
  it("triggers IPC openInEditor when Electron is available", async () => {
    const ipcMock = vi.fn().mockResolvedValue({ success: true });
    (window as Record<string, unknown>).electron = { openInEditor: ipcMock };

    const store = createFullPageStore();
    await renderExecutePhase(store);

    await waitFor(() => {
      expect(screen.getByTestId("open-editor-btn")).toBeInTheDocument();
    });

    const btn = screen.getByTestId("open-editor-btn");
    expect(btn).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(btn);

    await waitFor(() => {
      expect(mockOpenEditor).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    await waitFor(() => {
      expect(ipcMock).toHaveBeenCalledWith("/tmp/opensprint-worktrees/os-test", "cursor");
    });
  });

  it("shows copy-path popover in web mode (no Electron)", async () => {
    const store = createFullPageStore();
    await renderExecutePhase(store);

    await waitFor(() => {
      expect(screen.getByTestId("open-editor-btn")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId("open-editor-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("copy-path-popover")).toBeInTheDocument();
    });

    expect(screen.getByText("/tmp/opensprint-worktrees/os-test")).toBeInTheDocument();

    expect(screen.getByTestId("copy-path-btn")).toBeInTheDocument();

    expect(screen.getByText(/cursor \/tmp\/opensprint-worktrees\/os-test/)).toBeInTheDocument();
  });

  it("copy-path popover shows editor command and Copy button is interactive", async () => {
    const { OpenInEditorButton } = await import("../components/OpenInEditorButton");

    const store = createSidebarStore();
    render(
      <Provider store={store}>
        <OpenInEditorButton
          projectId="proj-1"
          taskId="epic-1.1"
          isInProgress={true}
          worktreePath="/tmp/opensprint-worktrees/os-test"
        />
      </Provider>
    );

    const user = userEvent.setup();
    const btn = screen.getByTestId("open-editor-btn");
    await user.click(btn);

    await waitFor(() => {
      expect(mockOpenEditor).toHaveBeenCalledWith("proj-1", "epic-1.1");
    });

    await waitFor(() => {
      expect(screen.getByTestId("copy-path-popover")).toBeInTheDocument();
    });

    expect(screen.getByText("/tmp/opensprint-worktrees/os-test")).toBeInTheDocument();
    expect(screen.getByText(/cursor \/tmp\/opensprint-worktrees\/os-test/)).toBeInTheDocument();

    const copyBtn = screen.getByTestId("copy-path-btn");
    expect(copyBtn).toBeInTheDocument();
    expect(copyBtn).not.toBeDisabled();

    // Clicking Copy should not throw (clipboard may not exist in jsdom)
    await user.click(copyBtn);
  });

  it("disables Open in Editor button when worktree path is not available", async () => {
    const store = createSidebarStore();
    const props = createSidebarProps({
      isInProgressTask: true,
    });
    const propsWithNoWorktree = {
      ...props,
      activeTasks: [
        {
          taskId: "epic-1.1",
          state: "running" as const,
          phase: "coding" as const,
          name: "Coder",
        },
      ],
    };

    render(
      <Provider store={store}>
        <TaskDetailSidebar {...propsWithNoWorktree} />
      </Provider>
    );

    const btn = screen.getByTestId("open-editor-btn");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "No active worktree");
  });

  it("disables Open in Editor button when task is not in progress", async () => {
    const store = createSidebarStore();
    const props = createSidebarProps({
      isInProgressTask: false,
      worktreePath: "/tmp/opensprint-worktrees/os-test",
    });

    render(
      <Provider store={store}>
        <TaskDetailSidebar {...props} />
      </Provider>
    );

    const btn = screen.getByTestId("open-editor-btn");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Task not in progress");
  });
});
