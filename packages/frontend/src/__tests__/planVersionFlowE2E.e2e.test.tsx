/**
 * E2E: Plan version flow — create plan, execute (v1 locked), edit plan (v2 created),
 * open version dropdown, select v1, see read-only v1; click 'Execute v1' and confirm
 * execution uses v1 content.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import { PlanPhase } from "../pages/phases/PlanPhase";
import projectReducer from "../store/slices/projectSlice";
import planReducer from "../store/slices/planSlice";
import executeReducer, {
  initialExecuteState,
  toTasksByIdAndOrder,
} from "../store/slices/executeSlice";
import evalReducer from "../store/slices/evalSlice";
import websocketReducer from "../store/slices/websocketSlice";
import openQuestionsReducer from "../store/slices/openQuestionsSlice";
import notificationReducer from "../store/slices/notificationSlice";
import unreadPhaseReducer from "../store/slices/unreadPhaseSlice";

const mockPlansList = vi.fn();
const mockPlansGet = vi.fn();
const mockPlansListVersions = vi.fn();
const mockPlansGetVersion = vi.fn();
const mockPlansExecute = vi.fn();
const mockGetCrossEpicDependencies = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    plans: {
      list: (...args: unknown[]) => mockPlansList(...args),
      get: (...args: unknown[]) => mockPlansGet(...args),
      listVersions: (...args: unknown[]) => mockPlansListVersions(...args),
      getVersion: (...args: unknown[]) => mockPlansGetVersion(...args),
      execute: (...args: unknown[]) => mockPlansExecute(...args),
      getCrossEpicDependencies: (...args: unknown[]) =>
        mockGetCrossEpicDependencies(...args),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      delete: vi.fn(),
      generate: vi.fn(),
      planTasks: vi.fn(),
      markPlanComplete: vi.fn(),
      auditorRuns: vi.fn().mockResolvedValue([]),
    },
    tasks: { list: vi.fn().mockResolvedValue([]) },
    chat: {
      history: vi.fn().mockResolvedValue({ messages: [] }),
      send: vi.fn().mockResolvedValue({ message: "" }),
    },
    notifications: { listByProject: vi.fn().mockResolvedValue([]), resolve: vi.fn(), retryRateLimit: vi.fn() },
  },
}));

const PLAN_ID = "plan-version-e2e";
const EPIC_ID = "epic-version-e2e";

// Status "planning" so EpicCard shows "Execute v1" (when status is "building" it shows "Re-execute" only).
const planWithV1ExecutedV2Current = {
  metadata: {
    planId: PLAN_ID,
    epicId: EPIC_ID,
    complexity: "medium" as const,
  },
  content: "# Plan v2 (current)\n\nCurrent body content.",
  status: "planning" as const,
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
  currentVersionNumber: 2,
  lastExecutedVersionNumber: 1,
};

const v1Content = {
  version_number: 1,
  title: "Plan v1 (executed)",
  content: "# Plan v1 (executed)\n\nV1 body content only.",
  created_at: "2025-01-01T00:00:00Z",
  is_executed_version: true,
};

const versionsList = [
  { id: "v2", version_number: 2, created_at: "2025-01-02T00:00:00Z", is_executed_version: false },
  { id: "v1", version_number: 1, created_at: "2025-01-01T00:00:00Z", is_executed_version: true },
];

const executeTasks = [
  {
    id: `${EPIC_ID}.1`,
    title: "Task 1",
    epicId: EPIC_ID,
    kanbanColumn: "ready" as const,
    priority: 0,
    assignee: null,
    description: "",
    type: "task" as const,
    status: "open" as const,
    labels: [] as string[],
    dependencies: [] as { targetId: string; type: string }[],
    createdAt: "",
    updatedAt: "",
  },
  {
    id: `${EPIC_ID}.2`,
    title: "Task 2",
    epicId: EPIC_ID,
    kanbanColumn: "ready" as const,
    priority: 1,
    assignee: null,
    description: "",
    type: "task" as const,
    status: "open" as const,
    labels: [] as string[],
    dependencies: [] as { targetId: string; type: string }[],
    createdAt: "",
    updatedAt: "",
  },
];

function createStore() {
  const { tasksById, taskIdsOrder } = toTasksByIdAndOrder(executeTasks as never);
  return configureStore({
    reducer: {
      project: projectReducer,
      plan: planReducer,
      execute: executeReducer,
      eval: evalReducer,
      websocket: websocketReducer,
      openQuestions: openQuestionsReducer,
      notification: notificationReducer,
      unreadPhase: unreadPhaseReducer,
    },
    preloadedState: {
      plan: {
        plans: [planWithV1ExecutedV2Current],
        dependencyGraph: null,
        selectedPlanId: PLAN_ID,
        chatMessages: {},
        loading: false,
        plansInFlightCount: 0,
        decomposing: false,
        executingPlanId: null,
        reExecutingPlanId: null,
        archivingPlanId: null,
        deletingPlanId: null,
        planTasksPlanIds: [],
        optimisticPlans: [],
        error: null,
        executeError: null,
        backgroundError: null,
        auditorOutputByPlanId: {},
        generating: false,
        planStatus: null,
      },
      execute: {
        ...initialExecuteState,
        tasksById,
        taskIdsOrder,
        selectedTaskId: null,
      },
      eval: {},
      websocket: { connected: true, deliverToast: null },
      openQuestions: { byProject: {}, global: [], async: { project: {}, global: { loading: false } } },
      notification: { items: [] },
      unreadPhase: {},
    },
  });
}

function PlanPhaseWrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("E2E: Plan version flow (execute, edit, version dropdown, Execute vN)", () => {
  beforeAll(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlansList.mockResolvedValue({
      plans: [planWithV1ExecutedV2Current],
      edges: [],
    });
    mockPlansGet.mockResolvedValue(planWithV1ExecutedV2Current);
    mockPlansListVersions.mockResolvedValue(versionsList);
    mockPlansGetVersion.mockImplementation(
      async (_projectId: string, _planId: string, versionNumber: number) => {
        if (versionNumber === 1) return v1Content;
        throw new Error(`Unexpected version ${versionNumber}`);
      }
    );
    mockPlansExecute.mockResolvedValue(undefined);
    mockGetCrossEpicDependencies.mockResolvedValue({ prerequisitePlanIds: [] });
  });

  it("full user flow: select v1 in version dropdown, see read-only v1, click Execute v1 and confirm execution uses v1 content", async () => {
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

    // Sidebar is open with plan selected (selectedPlanId set). Version selector and Execute v1 on card.
    await waitFor(() => {
      expect(screen.getByTestId("plan-version-selector")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("plan-current-version")).toHaveTextContent("v2");
    });

    // Open version dropdown and select v1
    const dropdown = screen.getByTestId("plan-version-dropdown");
    expect(dropdown).toBeInTheDocument();
    await user.selectOptions(dropdown, "1");

    // See read-only v1: "Viewing v1" and v1 content
    await waitFor(() => {
      expect(screen.getByTestId("plan-viewing-version")).toHaveTextContent("Viewing v1");
    });
    await waitFor(() => {
      expect(screen.getByTestId("plan-viewing-title")).toHaveTextContent("Plan v1 (executed)");
    });
    expect(screen.getByText("V1 body content only.")).toBeInTheDocument();

    // Click Execute v1 (on the EpicCard in the main area)
    const executeV1Btn = screen.getByRole("button", { name: "Execute v1" });
    await user.click(executeV1Btn);

    // Confirm execution was called with version_number: 1 (uses v1 content on backend)
    await waitFor(() => {
      expect(mockPlansExecute).toHaveBeenCalledWith("proj-1", PLAN_ID, {
        version_number: 1,
      });
    });
  });
});
