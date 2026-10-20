import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useRef } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { TaskLinkTooltip } from "./TaskLinkTooltip";

const mockTasksGet = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    tasks: {
      get: (...args: unknown[]) => mockTasksGet(...args),
    },
  },
}));

describe("TaskLinkTooltip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders children", () => {
    render(
      <TaskLinkTooltip projectId="proj-1" taskId="task-1">
        <span data-testid="child">Ticket task-1</span>
      </TaskLinkTooltip>
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.getByText("Ticket task-1")).toBeInTheDocument();
  });

  it("does not show tooltip before hover delay", () => {
    mockTasksGet.mockResolvedValue({
      id: "task-1",
      title: "Fix login button",
      description: "",
      type: "bug",
      status: "open",
      priority: 1,
      assignee: null,
      labels: [],
      dependencies: [],
      epicId: null,
      kanbanColumn: "backlog",
      createdAt: "",
      updatedAt: "",
    });

    render(
      <TaskLinkTooltip projectId="proj-1" taskId="task-1">
        <span>Link</span>
      </TaskLinkTooltip>
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const link = screen.getByText("Link");
    fireEvent.mouseEnter(link);

    vi.advanceTimersByTime(150);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows tooltip with cached title after hover delay", async () => {
    render(
      <TaskLinkTooltip projectId="proj-1" taskId="task-1" cachedTitle="Cached task title">
        <span>Link</span>
      </TaskLinkTooltip>
    );

    const link = screen.getByText("Link");
    fireEvent.mouseEnter(link);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Cached task title");
    expect(mockTasksGet).not.toHaveBeenCalled();
  });

  it("fetches title via API when not cached and shows tooltip", async () => {
    mockTasksGet.mockResolvedValue({
      id: "task-1",
      title: "Fix login button",
      description: "",
      type: "bug",
      status: "open",
      priority: 1,
      assignee: null,
      labels: [],
      dependencies: [],
      epicId: null,
      kanbanColumn: "backlog",
      createdAt: "",
      updatedAt: "",
    });

    render(
      <TaskLinkTooltip projectId="proj-1" taskId="task-1">
        <span>Link</span>
      </TaskLinkTooltip>
    );

    const link = screen.getByText("Link");
    fireEvent.mouseEnter(link);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(mockTasksGet).toHaveBeenCalledWith("proj-1", "task-1");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Fix login button");
  });

  it("does not show tooltip when fetch fails (e.g. deleted ticket)", async () => {
    mockTasksGet.mockRejectedValue(new Error("Task not found"));

    render(
      <TaskLinkTooltip projectId="proj-1" taskId="deleted-task">
        <span>Link</span>
      </TaskLinkTooltip>
    );

    const link = screen.getByText("Link");
    fireEvent.mouseEnter(link);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(mockTasksGet).toHaveBeenCalledWith("proj-1", "deleted-task");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("dismisses tooltip on mouse leave", async () => {
    render(
      <TaskLinkTooltip projectId="proj-1" taskId="task-1" cachedTitle="Cached title">
        <span>Link</span>
      </TaskLinkTooltip>
    );

    const link = screen.getByText("Link");
    fireEvent.mouseEnter(link);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.mouseLeave(link);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("uses theme tokens for styling", async () => {
    render(
      <TaskLinkTooltip projectId="proj-1" taskId="task-1" cachedTitle="Title">
        <span>Link</span>
      </TaskLinkTooltip>
    );

    const link = screen.getByText("Link");
    fireEvent.mouseEnter(link);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveClass("bg-theme-bg-elevated");
    expect(tooltip).toHaveClass("text-theme-text");
    expect(tooltip).toHaveClass("ring-theme-border");
  });
});

it("supports focused titles, retains existing descriptions and ignores fetch completion after Escape", async () => {
  let resolveTitle!: (value: unknown) => void;
  mockTasksGet.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveTitle = resolve;
      })
  );
  render(
    <>
      <span id="existing-description">Existing description</span>
      <TaskLinkTooltip projectId="A" taskId="task-focus">
        <button aria-describedby="existing-description">Focused task</button>
      </TaskLinkTooltip>
    </>
  );
  const button = screen.getByRole("button", { name: "Focused task" });
  fireEvent.focus(button);
  expect(mockTasksGet).toHaveBeenCalledWith("A", "task-focus");
  fireEvent.keyDown(button, { key: "Escape" });
  await act(async () => {
    resolveTitle({ title: "Late title" });
  });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(button).toHaveAccessibleDescription("Existing description");
});

it("keeps a focused cached title visible on mouseleave and dismisses on blur", async () => {
  render(
    <TaskLinkTooltip projectId="A" taskId="task-focus" cachedTitle="Full cached title">
      <button>Focused task</button>
    </TaskLinkTooltip>
  );
  const button = screen.getByRole("button");
  await act(async () => {
    button.focus();
  });
  expect(button).toHaveAccessibleDescription("Full cached title");
  fireEvent.mouseEnter(button);
  fireEvent.mouseLeave(button);
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  fireEvent.blur(button);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("fetches an uncached focused title and retains it while the pointer still owns it", async () => {
  mockTasksGet.mockResolvedValueOnce({ title: "Fetched keyboard title" });
  render(
    <TaskLinkTooltip projectId="A" taskId="focus-fetch">
      <button>Task</button>
    </TaskLinkTooltip>
  );
  const button = screen.getByRole("button");
  await act(async () => {
    button.focus();
  });
  expect(button).toHaveAccessibleDescription("Fetched keyboard title");
  fireEvent.mouseEnter(button);
  fireEvent.blur(button);
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  fireEvent.mouseLeave(button);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("rejects a focused task fetch from an obsolete project identity", async () => {
  let resolveOld!: (value: unknown) => void;
  mockTasksGet.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      })
  );
  const view = render(
    <TaskLinkTooltip projectId="A" taskId="same">
      <button>Task</button>
    </TaskLinkTooltip>
  );
  await act(async () => {
    screen.getByRole("button").focus();
  });
  view.rerender(
    <TaskLinkTooltip projectId="B" taskId="same">
      <button>Task</button>
    </TaskLinkTooltip>
  );
  await act(async () => {
    resolveOld({ title: "Obsolete project title" });
  });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("dismisses a focused tooltip before its containing modal, then lets the next Escape close the modal", () => {
  const close = vi.fn();
  function ModalWithTooltip() {
    const containerRef = useRef<HTMLDivElement>(null);
    useModalA11y({ containerRef, onClose: close });
    return (
      <div role="dialog" aria-label="Task dialog" tabIndex={-1} ref={containerRef}>
        <TaskLinkTooltip projectId="A" taskId="task" cachedTitle="Full task title">
          <button>Task chip</button>
        </TaskLinkTooltip>
      </div>
    );
  }
  render(<ModalWithTooltip />);
  const button = screen.getByRole("button", { name: "Task chip" });
  act(() => button.focus());
  expect(screen.getByRole("tooltip")).toHaveTextContent("Full task title");
  fireEvent.keyDown(button, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Task dialog" })).toBeInTheDocument();
  expect(button).toHaveFocus();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(1);
});
