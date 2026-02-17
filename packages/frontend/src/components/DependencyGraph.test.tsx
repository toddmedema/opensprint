import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DependencyGraph } from "./DependencyGraph";
import type { PlanDependencyGraph } from "@opensprint/shared";

const mockPlan = (planId: string, status: "planning" | "building" | "done" = "planning") => ({
  metadata: {
    planId,
    beadEpicId: `epic-${planId}`,
    gateTaskId: `epic-${planId}.0`,
    shippedAt: null,
    complexity: "medium" as const,
  },
  content: `# ${planId}\n\nContent.`,
  status,
  taskCount: 2,
  doneTaskCount: 0,
  dependencyCount: 0,
});

const mockGraph: PlanDependencyGraph = {
  plans: [mockPlan("auth"), mockPlan("dashboard"), mockPlan("api")],
  edges: [
    { from: "auth", to: "dashboard", type: "blocks" },
    { from: "api", to: "dashboard", type: "blocks" },
  ],
};

describe("DependencyGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ResizeObserver is not available in jsdom; provide a no-op mock
    global.ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));
  });

  it("renders 'No plans to display' when graph is null", () => {
    render(<DependencyGraph graph={null} />);
    expect(screen.getByText("No plans to display")).toBeInTheDocument();
  });

  it("renders 'No plans to display' when graph has no plans", () => {
    render(<DependencyGraph graph={{ plans: [], edges: [] }} />);
    expect(screen.getByText("No plans to display")).toBeInTheDocument();
  });

  it("renders graph container with SVG when graph has plans", async () => {
    render(<DependencyGraph graph={mockGraph} />);

    // Wait for ResizeObserver and D3 to run (dimensions state + effect)
    await vi.waitFor(() => {
      const svg = document.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });

    const container = document.querySelector(".overflow-hidden.rounded-lg");
    expect(container).toBeInTheDocument();
    const svg = container?.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("calls onPlanClick when a plan node is clicked", async () => {
    const onPlanClick = vi.fn();
    render(<DependencyGraph graph={mockGraph} onPlanClick={onPlanClick} />);

    await vi.waitFor(() => {
      const svg = document.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });

    // D3 renders nodes as g elements with rect and text; find by text content
    const authText = screen.getByText("auth");
    await userEvent.click(authText);

    expect(onPlanClick).toHaveBeenCalledTimes(1);
    expect(onPlanClick).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ planId: "auth" }),
      }),
    );
  });

  it("shows critical path legend when graph has critical path edges", async () => {
    const graphWithCriticalPath: PlanDependencyGraph = {
      plans: [mockPlan("a"), mockPlan("b"), mockPlan("c")],
      edges: [
        { from: "a", to: "b", type: "blocks" },
        { from: "b", to: "c", type: "blocks" },
      ],
    };

    render(<DependencyGraph graph={graphWithCriticalPath} />);

    await vi.waitFor(() => {
      expect(screen.getByText(/Critical path/)).toBeInTheDocument();
    });
  });

  it("does not show critical path legend when no critical path", async () => {
    const graphNoCriticalPath: PlanDependencyGraph = {
      plans: [mockPlan("a"), mockPlan("b")],
      edges: [], // No edges = no critical path
    };

    render(<DependencyGraph graph={graphNoCriticalPath} />);

    await vi.waitFor(() => {
      const svg = document.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });

    expect(screen.queryByText(/Critical path/)).not.toBeInTheDocument();
  });

  it("renders node rects with fill and stroke from the start (not black during animation)", async () => {
    const graphWithStatuses: PlanDependencyGraph = {
      plans: [
        mockPlan("planning-plan", "planning"),
        mockPlan("building-plan", "building"),
        mockPlan("done-plan", "done"),
      ],
      edges: [],
    };

    render(<DependencyGraph graph={graphWithStatuses} />);

    await vi.waitFor(() => {
      const rects = document.querySelectorAll("svg rect");
      expect(rects.length).toBeGreaterThanOrEqual(3);
    });

    const rects = document.querySelectorAll("svg rect");
    const nodeRects = Array.from(rects).filter((r) => r.getAttribute("width") === "100");
    expect(nodeRects.length).toBe(3);

    // Each node rect must have fill and stroke set (not default black)
    for (const rect of nodeRects) {
      const fill = rect.getAttribute("fill");
      const stroke = rect.getAttribute("stroke");
      expect(fill).toBeTruthy();
      expect(stroke).toBeTruthy();
      expect(fill).not.toBe("black");
      expect(fill).not.toBe("#000");
      expect(fill).not.toBe("#000000");
    }

    // Verify status-specific colors are applied
    const planningFill = "#fef3c7";
    const buildingFill = "#dbeafe";
    const doneFill = "#d1fae5";
    const fills = nodeRects.map((r) => r.getAttribute("fill"));
    expect(fills).toContain(planningFill);
    expect(fills).toContain(buildingFill);
    expect(fills).toContain(doneFill);
  });
});
