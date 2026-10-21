import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@opensprint/shared";
import { rootReducer } from "../store";
import { setTasks } from "../store/slices/executeSlice";
import { useTasks } from "../api/hooks/tasks";
import { useProjectReplay } from "./useProjectReplay";

const server = vi.hoisted(() => ({ title: "Original", cursor: 0, minimum: 0, snapshots: 0 }));
vi.mock("../api/client", () => ({
  api: {
    tasks: {
      list: async () => [
        { id: "task", title: server.title, status: "open", kanbanColumn: "ready" },
      ],
    },
  },
}));
vi.mock("../api/collaboration", () => ({
  collaborationApi: () => ({
    snapshot: async () => {
      server.snapshots++;
      return { cursor: server.cursor };
    },
    replay: async (after: number) => {
      if (after < server.minimum) throw { details: { resetRequired: true } };
      return {
        events: after < server.cursor ? [{ cursor: server.cursor, type: "task_changed" }] : [],
        nextCursor: server.cursor,
        hasMore: false,
      };
    },
  }),
}));

function View({ name, enabled }: { name: string; enabled: boolean }) {
  useProjectReplay("project", enabled);
  const tasks = useTasks("project");
  return <div data-testid={name}>{tasks.data?.[0]?.title ?? "loading"}</div>;
}
describe("project replay with independent clients", () => {
  afterEach(() => vi.useRealTimers());
  it("converges after disconnect and an expired cursor with Query as the only server owner", async () => {
    vi.useFakeTimers();
    Object.assign(server, { title: "Original", cursor: 0, minimum: 0, snapshots: 0 });
    const a = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const b = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const storeA = configureStore({ reducer: rootReducer });
    const storeB = configureStore({ reducer: rootReducer });
    const ui = (connected: boolean) => (
      <>
        <QueryClientProvider client={a}>
          <Provider store={storeA}>
            <View name="a" enabled />
          </Provider>
        </QueryClientProvider>
        <QueryClientProvider client={b}>
          <Provider store={storeB}>
            <View name="b" enabled={connected} />
          </Provider>
        </QueryClientProvider>
      </>
    );
    const view = render(ui(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId("a")).toHaveTextContent("Original");
    expect(screen.getByTestId("b")).toHaveTextContent("Original");
    view.rerender(ui(false));
    server.title = "Accepted by Alice";
    server.cursor = 1;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByTestId("a")).toHaveTextContent("Accepted by Alice");
    expect(screen.getByTestId("b")).toHaveTextContent("Original");
    // A delayed legacy fetch cannot restore an old Redux server snapshot.
    storeA.dispatch(setTasks([{ id: "task", title: "Stale response" } as Task]));
    expect(storeA.getState().execute.tasksById).toEqual({});
    expect(screen.getByTestId("a")).toHaveTextContent("Accepted by Alice");
    view.rerender(ui(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId("b")).toHaveTextContent("Accepted by Alice");
    server.title = "After event retention";
    server.cursor = 4;
    server.minimum = 3;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(screen.getByTestId("a")).toHaveTextContent("After event retention");
    expect(screen.getByTestId("b")).toHaveTextContent("After event retention");
    expect(server.snapshots).toBeGreaterThanOrEqual(5);
    expect(storeA.getState().execute.tasksById).toEqual({});
    expect(storeB.getState().execute.tasksById).toEqual({});
    view.unmount();
    a.clear();
    b.clear();
  });
});
