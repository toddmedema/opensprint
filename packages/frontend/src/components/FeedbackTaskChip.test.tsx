import { describe, it, expect } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { FeedbackTaskChip } from "./FeedbackTaskChip";
import executeReducer, {
  taskUpdated,
  initialExecuteState,
  toTasksByIdAndOrder,
} from "../store/slices/executeSlice";
import type { Task } from "@opensprint/shared";

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
  it("shows live task status and updates when task state changes via Redux", async () => {
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
      store.dispatch(taskUpdated({ taskId: "task-1", status: "closed" }));
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
      store.dispatch(taskUpdated({ taskId: "task-1", status: "in_progress" }));
    });
    await waitFor(() => {
      expect(screen.getByText("In Progress")).toBeInTheDocument();
      expect(screen.queryByText("Backlog")).not.toBeInTheDocument();
    });

    act(() => {
      store.dispatch(taskUpdated({ taskId: "task-1", status: "closed" }));
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
      store.dispatch(taskUpdated({ taskId: "task-1", status: "closed" }));
    });

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("In Progress")).toBeInTheDocument();
    });
  });
});
