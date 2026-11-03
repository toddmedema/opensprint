// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskDetailHeader } from "./TaskDetailHeader";

const noop = () => {};
const asyncNoop = async () => {};

const baseProps = {
  title: "Test task",
  hasActions: true,
  isBlockedTask: false,
  isDoneTask: false,
  markDoneLoading: false,
  unblockLoading: false,
  deleteLoading: false,
  forceRetryLoading: false,
  onClose: noop,
  onMarkDone: noop,
  onUnblock: noop,
  onDeleteTask: asyncNoop,
  onForceRetry: asyncNoop,
  deleteConfirmOpen: false,
  setDeleteConfirmOpen: vi.fn(),
  deleteLinkConfirm: null as null,
  setDeleteLinkConfirm: vi.fn(),
  removeLinkRemovingId: null as string | null,
  onRemoveLink: asyncNoop,
};

function DeleteConfirmHarness() {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(true);
  return (
    <TaskDetailHeader
      {...baseProps}
      deleteConfirmOpen={deleteConfirmOpen}
      setDeleteConfirmOpen={setDeleteConfirmOpen}
    />
  );
}

describe("TaskDetailHeader", () => {
  it("directs governance holds to the docket and disables ordinary completion/retry", () => {
    render(
      <TaskDetailHeader
        {...baseProps}
        projectId="proj-1"
        taskId="os-1234"
        isBlockedTask
        isGovernanceHeld
        governanceCaseId="case-1"
      />
    );
    fireEvent.click(screen.getByTestId("sidebar-actions-menu-trigger"));
    expect(screen.getByRole("menuitem", { name: "Review governance docket" })).toHaveAttribute(
      "href",
      "/projects/proj-1/settings?tab=governance&case=case-1"
    );
    expect(screen.getByTestId("sidebar-retry-btn")).toBeDisabled();
    expect(screen.getByTestId("sidebar-force-retry-btn")).toBeDisabled();
    expect(screen.getByTestId("sidebar-mark-done-btn")).toBeDisabled();
  });
  it("closes delete confirmation dialog on Escape via useModalA11y", () => {
    render(<DeleteConfirmHarness />);

    expect(screen.getByTestId("sidebar-delete-task-dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("sidebar-delete-task-dialog")).not.toBeInTheDocument();
  });

  describe("Open in Editor button", () => {
    it("renders the open-editor button when projectId and taskId are provided", () => {
      render(
        <TaskDetailHeader
          {...baseProps}
          projectId="proj-1"
          taskId="os-1234.1"
          isInProgressTask
          worktreePath="/tmp/worktree/os-1234.1"
        />
      );
      const btn = screen.getByTestId("open-editor-btn");
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
    });

    it("does not render the open-editor button when projectId or taskId is missing", () => {
      render(<TaskDetailHeader {...baseProps} />);
      expect(screen.queryByTestId("open-editor-btn")).not.toBeInTheDocument();
    });

    it("is enabled when task is in progress and worktreePath is present", () => {
      render(
        <TaskDetailHeader
          {...baseProps}
          projectId="proj-1"
          taskId="os-1234.1"
          isInProgressTask
          worktreePath="/tmp/worktree/os-1234.1"
        />
      );
      const btn = screen.getByTestId("open-editor-btn");
      expect(btn).not.toBeDisabled();
      expect(btn).toHaveAttribute("title", "Open in editor");
    });

    it("is disabled with 'Task not in progress' tooltip when task is not in progress", () => {
      render(
        <TaskDetailHeader
          {...baseProps}
          projectId="proj-1"
          taskId="os-1234.1"
          isInProgressTask={false}
          worktreePath="/tmp/worktree/os-1234.1"
        />
      );
      const btn = screen.getByTestId("open-editor-btn");
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("title", "Task not in progress");
    });

    it("is disabled with 'No active worktree' tooltip when worktreePath is null", () => {
      render(
        <TaskDetailHeader
          {...baseProps}
          projectId="proj-1"
          taskId="os-1234.1"
          isInProgressTask
          worktreePath={null}
        />
      );
      const btn = screen.getByTestId("open-editor-btn");
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("title", "No active worktree");
    });

    it("shows 'Shared checkout' badge in branches mode for in-progress task", () => {
      render(
        <TaskDetailHeader
          {...baseProps}
          projectId="proj-1"
          taskId="os-1234.1"
          isInProgressTask
          worktreePath="/tmp/repo-root"
          isBranchesMode
        />
      );
      const badge = screen.getByTestId("shared-checkout-badge");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent("Shared checkout");
    });

    it("does not show 'Shared checkout' badge when not in branches mode", () => {
      render(
        <TaskDetailHeader
          {...baseProps}
          projectId="proj-1"
          taskId="os-1234.1"
          isInProgressTask
          worktreePath="/tmp/worktree/os-1234.1"
          isBranchesMode={false}
        />
      );
      expect(screen.queryByTestId("shared-checkout-badge")).not.toBeInTheDocument();
    });

    it("does not show 'Shared checkout' badge when task is not in progress even in branches mode", () => {
      render(
        <TaskDetailHeader
          {...baseProps}
          projectId="proj-1"
          taskId="os-1234.1"
          isInProgressTask={false}
          worktreePath="/tmp/repo-root"
          isBranchesMode
        />
      );
      expect(screen.queryByTestId("shared-checkout-badge")).not.toBeInTheDocument();
    });

    it("shows 'Open shared checkout in editor' tooltip in branches mode", () => {
      render(
        <TaskDetailHeader
          {...baseProps}
          projectId="proj-1"
          taskId="os-1234.1"
          isInProgressTask
          worktreePath="/tmp/repo-root"
          isBranchesMode
        />
      );
      const btn = screen.getByTestId("open-editor-btn");
      expect(btn).toHaveAttribute("title", "Open shared checkout in editor");
    });
  });
});
