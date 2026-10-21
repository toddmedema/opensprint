import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { seedServerFixtureFromElement } from "../test/seedServerFixtures";
import { queryKeys } from "../api/queryKeys";
import { describe, it, expect } from "vitest";
import { render as rtlRender, screen, waitFor, act } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { FeedbackTaskChip } from "./FeedbackTaskChip";
import executeReducer, {
  initialExecuteState,
  toTasksByIdAndOrder,
} from "../store/slices/executeSlice";
import type { Task } from "@opensprint/shared";

let client: QueryClient;
function render(ui: React.ReactElement) {
  client = new QueryClient();
  seedServerFixtureFromElement(client, ui);
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
function updateTask(taskId: string, status: string) {
  client.setQueryData<Task[]>(queryKeys.tasks.list("proj-1"), (previous) =>
    (previous ?? []).map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: status as Task["status"],
            kanbanColumn:
              status === "closed" ? "done" : status === "in_progress" ? "in_progress" : "backlog",
          }
        : task
    )
  );
}

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
    kanbanColumn: "backlog",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("FeedbackTaskChip", () => {
  it("shows live task status and updates when its project query cache changes", async () => {
    const store = configureStore({
      reducer: { execute: executeReducer },
      preloadedState: {
        execute: {
          ...initialExecuteState,
          ...toTasksByIdAndOrder([
            createMockTask({ id: "task-1", kanbanColumn: "backlog", status: "open" }),
          ]),
        },
      },
    });

    render(
      <Provider store={store}>
        <FeedbackTaskChip taskId="task-1" projectId="proj-1" />
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByText("Backlog")).toBeInTheDocument();
    });

    act(() => {
      updateTask("task-1", "closed");
    });

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.queryByText("Backlog")).not.toBeInTheDocument();
    });
  });

  it("reflects full state transition (backlog -> in_progress -> done)", async () => {
    const store = configureStore({
      reducer: { execute: executeReducer },
      preloadedState: {
        execute: {
          ...initialExecuteState,
          ...toTasksByIdAndOrder([
            createMockTask({ id: "task-1", kanbanColumn: "backlog", title: "Fix bug" }),
          ]),
        },
      },
    });

    render(
      <Provider store={store}>
        <FeedbackTaskChip taskId="task-1" projectId="proj-1" />
      </Provider>
    );

    await waitFor(() => expect(screen.getByText("Backlog")).toBeInTheDocument());

    act(() => {
      updateTask("task-1", "in_progress");
    });
    await waitFor(() => {
      expect(screen.getByText("In Progress")).toBeInTheDocument();
      expect(screen.queryByText("Backlog")).not.toBeInTheDocument();
    });

    act(() => {
      updateTask("task-1", "closed");
    });
    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.queryByText("In Progress")).not.toBeInTheDocument();
    });
  });

  it("updates only the affected chip when one of two tasks changes (isolation)", async () => {
    const store = configureStore({
      reducer: { execute: executeReducer },
      preloadedState: {
        execute: {
          ...initialExecuteState,
          ...toTasksByIdAndOrder([
            createMockTask({ id: "task-1", kanbanColumn: "backlog", title: "Task A" }),
            createMockTask({ id: "task-2", kanbanColumn: "in_progress", title: "Task B" }),
          ]),
        },
      },
    });

    render(
      <Provider store={store}>
        <>
          <FeedbackTaskChip taskId="task-1" projectId="proj-1" />
          <FeedbackTaskChip taskId="task-2" projectId="proj-1" />
        </>
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByText("Backlog")).toBeInTheDocument();
      expect(screen.getByText("In Progress")).toBeInTheDocument();
    });

    act(() => {
      updateTask("task-1", "closed");
    });

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("In Progress")).toBeInTheDocument();
    });
  });
});

it("describes the real keyboard-focused chip button with its full cached title", async () => {
  const title = "Full keyboard accessible task title";
  const store = configureStore({
    reducer: { execute: executeReducer },
    preloadedState: {
      execute: { ...initialExecuteState, ...toTasksByIdAndOrder([createMockTask({ title })]) },
    },
  });
  render(
    <Provider store={store}>
      <FeedbackTaskChip projectId="A" taskId="task-1" onNavigateToBuildTask={() => {}} />
    </Provider>
  );
  const button = screen.getByRole("button");
  await act(async () => {
    button.focus();
  });
  expect(button).toHaveAccessibleDescription(title);
  expect(screen.getByRole("tooltip")).toHaveTextContent(title);
});
