import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CrossEpicConfirmModal } from "./CrossEpicConfirmModal";

describe("CrossEpicConfirmModal", () => {
  it("renders prerequisite plan names and message", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CrossEpicConfirmModal
        planId="feature-x"
        prerequisitePlanIds={["user-auth", "feature-base"]}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText(/Cross-epic dependencies/)).toBeInTheDocument();
    expect(screen.getByText(/User Auth, Feature Base/)).toBeInTheDocument();
    expect(screen.getByText(/must be implemented first/)).toBeInTheDocument();
    expect(screen.getByText(/Queueing will also queue those features/)).toBeInTheDocument();
  });

  it("calls onConfirm when Proceed is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CrossEpicConfirmModal
        planId="feature-x"
        prerequisitePlanIds={["user-auth"]}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Proceed/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CrossEpicConfirmModal
        planId="feature-x"
        prerequisitePlanIds={["user-auth"]}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows Executing… when confirming", () => {
    render(
      <CrossEpicConfirmModal
        planId="feature-x"
        prerequisitePlanIds={["user-auth"]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        confirming={true}
      />,
    );

    expect(screen.getByRole("button", { name: /Executing…/ })).toBeInTheDocument();
  });
});
