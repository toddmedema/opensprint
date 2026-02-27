import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KillAgentConfirmDialog } from "./KillAgentConfirmDialog";
import * as killAgentConfirmStorage from "../lib/killAgentConfirmStorage";

vi.mock("../lib/killAgentConfirmStorage", () => ({
  setKillAgentConfirmDisabled: vi.fn(),
}));

describe("KillAgentConfirmDialog", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders dialog with message and actions", () => {
    render(<KillAgentConfirmDialog onConfirm={onConfirm} onCancel={onCancel} />);

    expect(screen.getByRole("dialog", { name: /kill agent/i })).toBeInTheDocument();
    expect(screen.getByText("Are you sure you want to kill this agent?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByLabelText(/don't show this again/i)).toBeInTheDocument();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<KillAgentConfirmDialog onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onConfirm when Confirm is clicked", async () => {
    const user = userEvent.setup();
    render(<KillAgentConfirmDialog onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("persists dontShowAgain=false when checkbox unchecked and Confirm clicked", async () => {
    const user = userEvent.setup();
    render(<KillAgentConfirmDialog onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(killAgentConfirmStorage.setKillAgentConfirmDisabled).toHaveBeenCalledWith(false);
  });

  it("persists dontShowAgain=true when checkbox checked and Confirm clicked", async () => {
    const user = userEvent.setup();
    render(<KillAgentConfirmDialog onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByLabelText(/don't show this again/i));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(killAgentConfirmStorage.setKillAgentConfirmDisabled).toHaveBeenCalledWith(true);
  });

  it("shows Killing… when confirming", () => {
    render(<KillAgentConfirmDialog onConfirm={onConfirm} onCancel={onCancel} confirming />);

    expect(screen.getByRole("button", { name: /killing…/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /killing…/i })).toBeDisabled();
  });

  it("closes when backdrop is clicked", async () => {
    render(<KillAgentConfirmDialog onConfirm={onConfirm} onCancel={onCancel} />);

    const backdrop = document.querySelector(".bg-theme-overlay");
    expect(backdrop).toBeInTheDocument();
    fireEvent.click(backdrop!);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
