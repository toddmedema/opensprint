import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhaseEmptyState, PhaseEmptyStateLogo } from "./PhaseEmptyState";
import { EMPTY_STATE_COPY } from "../lib/emptyStateCopy";

describe("PhaseEmptyState", () => {
  it("renders full pattern: copy, illustration, and primary action", async () => {
    const onClick = vi.fn();
    render(
      <PhaseEmptyState
        title={EMPTY_STATE_COPY.plan.title}
        description={EMPTY_STATE_COPY.plan.description}
        illustration={<PhaseEmptyStateLogo />}
        primaryAction={{ label: EMPTY_STATE_COPY.plan.primaryActionLabel, onClick, "data-testid": "empty-state-new-plan" }}
      />
    );
    expect(screen.getByText(EMPTY_STATE_COPY.plan.title)).toBeInTheDocument();
    expect(screen.getByText(EMPTY_STATE_COPY.plan.description)).toBeInTheDocument();
    expect(screen.getByTestId("phase-empty-state").querySelector("svg")).toBeInTheDocument();
    const button = screen.getByTestId("empty-state-new-plan");
    expect(button).toHaveTextContent(EMPTY_STATE_COPY.plan.primaryActionLabel);
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders title and description", () => {
    render(
      <PhaseEmptyState
        title="No plans yet"
        description="Create a plan to break down your spec."
      />
    );
    expect(screen.getByText("No plans yet")).toBeInTheDocument();
    expect(screen.getByText("Create a plan to break down your spec.")).toBeInTheDocument();
  });

  it("renders illustration when provided", () => {
    render(
      <PhaseEmptyState
        title="No plans yet"
        description="Create a plan."
        illustration={<PhaseEmptyStateLogo />}
      />
    );
    const container = screen.getByTestId("phase-empty-state");
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders primary action button when provided", async () => {
    const onClick = vi.fn();
    render(
      <PhaseEmptyState
        title="No plans yet"
        description="Create a plan."
        primaryAction={{ label: "New Plan", onClick }}
      />
    );
    const button = screen.getByRole("button", { name: "New Plan" });
    expect(button).toBeInTheDocument();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not render primary action when not provided", () => {
    render(
      <PhaseEmptyState
        title="No plans yet"
        description="Create a plan."
      />
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("uses custom data-testid for primary action when provided", () => {
    render(
      <PhaseEmptyState
        title="No plans yet"
        description="Create a plan."
        primaryAction={{
          label: "New Plan",
          onClick: () => {},
          "data-testid": "custom-action",
        }}
      />
    );
    expect(screen.getByTestId("custom-action")).toBeInTheDocument();
  });

  it("renders documented copy for all phases (Plan, Execute, Eval, Deliver)", () => {
    const phases = ["plan", "execute", "eval", "deliver"] as const;
    for (const phase of phases) {
      const spec = EMPTY_STATE_COPY[phase];
      const { unmount } = render(
        <PhaseEmptyState
          title={spec.title}
          description={spec.description}
          illustration={<PhaseEmptyStateLogo />}
          primaryAction={{ label: spec.primaryActionLabel, onClick: () => {}, "data-testid": `empty-state-${spec.primaryActionLabel.toLowerCase().replace(/\s+/g, "-")}` }}
        />
      );
      expect(screen.getByText(spec.title)).toBeInTheDocument();
      expect(screen.getByText(spec.description)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: spec.primaryActionLabel })).toBeInTheDocument();
      unmount();
    }
  });
});

describe("PhaseEmptyStateLogo", () => {
  it("renders SVG with three polygons", () => {
    const { container } = render(<PhaseEmptyStateLogo />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    const polygons = container.querySelectorAll("polygon");
    expect(polygons).toHaveLength(3);
  });
});
