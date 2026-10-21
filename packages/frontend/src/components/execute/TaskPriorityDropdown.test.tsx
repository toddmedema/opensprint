import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "../../store";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@opensprint/shared";
import { queryKeys } from "../../api/queryKeys";
import { TaskPriorityDropdown } from "./TaskPriorityDropdown";

const update = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: "task", priority: 2, revision: 3 })
);
vi.mock("../../api/client", () => ({ api: { tasks: { updatePriority: update } } }));

describe("task priority collaborative revision", () => {
  it("uses the revision displayed when the editor opened after background refresh", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.tasks.list("p"), [
      { id: "task", title: "Task", priority: 1, revision: 1 } as Task,
    ]);
    render(
      <Provider store={configureStore({ reducer: rootReducer })}>
        <QueryClientProvider client={client}>
          <TaskPriorityDropdown projectId="p" taskId="task" isDoneTask={false} />
        </QueryClientProvider>
      </Provider>
    );
    fireEvent.click(screen.getByTestId("priority-dropdown-trigger"));
    act(() =>
      client.setQueryData(queryKeys.tasks.list("p"), [
        { id: "task", title: "Task", priority: 3, revision: 2 } as Task,
      ])
    );
    fireEvent.click(screen.getByTestId("priority-option-2"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("p", "task", 2, { expectedRevision: 1 })
    );
    client.clear();
  });
});
