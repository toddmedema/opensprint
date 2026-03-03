import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentReferenceModal } from "./AgentReferenceModal";

describe("AgentReferenceModal", () => {
  it("renders title and all 9 agents", () => {
    const onClose = vi.fn();
    render(<AgentReferenceModal onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: /meet the agent team/i })).toBeInTheDocument();
    expect(screen.getByText("Meet the Agent Team")).toBeInTheDocument();

    expect(screen.getByText("Dreamer")).toBeInTheDocument();
    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText("Harmonizer")).toBeInTheDocument();
    expect(screen.getByText("Analyst")).toBeInTheDocument();
    expect(screen.getByText("Summarizer")).toBeInTheDocument();
    expect(screen.getByText("Auditor")).toBeInTheDocument();
    expect(screen.getByText("Coder")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Merger")).toBeInTheDocument();
  });

  it("renders agent descriptions", () => {
    render(<AgentReferenceModal onClose={vi.fn()} />);

    expect(
      screen.getByText(
        /Refines your idea into a PRD; asks the hard questions before the journey begins/
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Decomposes the PRD into epics, tasks, and dependency graph/)
    ).toBeInTheDocument();
  });

  it("renders phase badges", () => {
    render(<AgentReferenceModal onClose={vi.fn()} />);

    expect(screen.getByText("Sketch")).toBeInTheDocument();
    expect(screen.getAllByText("Plan").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Execute").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Evaluate").length).toBeGreaterThan(0);
  });

  it("phase name left-aligns with agent role name in each card", () => {
    render(<AgentReferenceModal onClose={vi.fn()} />);

    const sketchBadge = screen.getByText("Sketch");
    expect(sketchBadge).toBeInTheDocument();
    expect(sketchBadge.className).toMatch(/\bpl-0\b/);

    const dreamerCard = sketchBadge.closest("article");
    const dreamerRole = dreamerCard?.querySelector("h3");
    expect(dreamerRole).toHaveTextContent("Dreamer");

    // Content wrapper uses flex-col items-start so role and phase share the same left edge
    const contentWrapper = dreamerRole?.parentElement;
    expect(contentWrapper?.className).toMatch(/\bflex-col\b/);
    expect(contentWrapper?.className).toMatch(/\bitems-start\b/);
  });

  it("renders 9 agent cards in grid", () => {
    render(<AgentReferenceModal onClose={vi.fn()} />);

    const listItems = screen.getAllByRole("listitem");
    expect(listItems).toHaveLength(9);
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AgentReferenceModal onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: /meet the agent team/i });
    await user.click(within(dialog).getByRole("button", { name: /close agent reference/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<AgentReferenceModal onClose={onClose} />);

    const backdrop = screen.getByTestId("agent-reference-backdrop");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(<AgentReferenceModal onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: /meet the agent team/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is accessible with aria attributes", () => {
    render(<AgentReferenceModal onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: /meet the agent team/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "agent-reference-title");
  });
});
