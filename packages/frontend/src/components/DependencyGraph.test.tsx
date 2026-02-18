import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DependencyGraph } from "./DependencyGraph";
import type { PlanDependencyGraph } from "@opensprint/shared";

const mockPlan = (planId: string, status: "planning" | "building" | "complete" = "planning") => ({
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

const LIGHT_THEME_TOKENS = {
  planningFill: "#fef3c7",
  buildingFill: "#dbeafe",
  completeFill: "#d1fae5",
  text: "#111827",
  nodeDefaultFill: "#f9fafb",
  nodeDefaultStroke: "#e5e7eb",
};

function setThemeTokens(tokens: typeof LIGHT_THEME_TOKENS) {
  const root = document.documentElement;
  root.style.setProperty("--color-graph-status-planning-fill", tokens.planningFill);
  root.style.setProperty("--color-graph-status-planning-stroke", "#f59e0b");
  root.style.setProperty("--color-graph-status-building-fill", tokens.buildingFill);
  root.style.setProperty("--color-graph-status-building-stroke", "#3b82f6");
  root.style.setProperty("--color-graph-status-complete-fill", tokens.completeFill);
  root.style.setProperty("--color-graph-status-complete-stroke", "#10b981");
  root.style.setProperty("--color-graph-text", tokens.text);
  root.style.setProperty("--color-graph-node-default-fill", tokens.nodeDefaultFill);
  root.style.setProperty("--color-graph-node-default-stroke", tokens.nodeDefaultStroke);
}

describe("DependencyGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setThemeTokens(LIGHT_THEME_TOKENS);
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
        mockPlan("done-plan", "complete"),
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

    for (const rect of nodeRects) {
      const fill = rect.getAttribute("fill");
      const stroke = rect.getAttribute("stroke");
      expect(fill).toBeTruthy();
      expect(stroke).toBeTruthy();
      expect(fill).not.toBe("black");
      expect(fill).not.toBe("#000");
      expect(fill).not.toBe("#000000");
    }

    const fills = nodeRects.map((r) => r.getAttribute("fill"));
    expect(fills).toContain(LIGHT_THEME_TOKENS.planningFill);
    expect(fills).toContain(LIGHT_THEME_TOKENS.buildingFill);
    expect(fills).toContain(LIGHT_THEME_TOKENS.completeFill);
  });

  it("uses theme tokens for node colors (theme-aware)", async () => {
    const graphWithStatuses: PlanDependencyGraph = {
      plans: [
        mockPlan("planning-plan", "planning"),
        mockPlan("building-plan", "building"),
        mockPlan("done-plan", "complete"),
      ],
      edges: [],
    };

    render(<DependencyGraph graph={graphWithStatuses} />);

    await vi.waitFor(() => {
      const rects = document.querySelectorAll("svg rect");
      expect(rects.length).toBeGreaterThanOrEqual(3);
    });

    const nodeRects = Array.from(document.querySelectorAll("svg rect")).filter(
      (r) => r.getAttribute("width") === "100",
    );
    const textEls = document.querySelectorAll("svg text");
    expect(textEls.length).toBeGreaterThanOrEqual(3);

    for (const text of textEls) {
      const fill = text.getAttribute("fill");
      expect(fill).toBe(LIGHT_THEME_TOKENS.text);
    }
  });

  it("uses dark theme tokens when data-theme is dark", async () => {
    const darkTokens = {
      planningFill: "#78350f",
      buildingFill: "#1e3a8a",
      completeFill: "#064e3b",
      text: "#f3f4f6",
      nodeDefaultFill: "#374151",
      nodeDefaultStroke: "#4b5563",
    };
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.style.setProperty("--color-graph-status-planning-fill", darkTokens.planningFill);
    document.documentElement.style.setProperty("--color-graph-status-planning-stroke", "#f59e0b");
    document.documentElement.style.setProperty("--color-graph-status-building-fill", darkTokens.buildingFill);
    document.documentElement.style.setProperty("--color-graph-status-building-stroke", "#60a5fa");
    document.documentElement.style.setProperty("--color-graph-status-complete-fill", darkTokens.completeFill);
    document.documentElement.style.setProperty("--color-graph-status-complete-stroke", "#34d399");
    document.documentElement.style.setProperty("--color-graph-text", darkTokens.text);
    document.documentElement.style.setProperty("--color-graph-node-default-fill", darkTokens.nodeDefaultFill);
    document.documentElement.style.setProperty("--color-graph-node-default-stroke", darkTokens.nodeDefaultStroke);

    const graphWithStatuses: PlanDependencyGraph = {
      plans: [
        mockPlan("planning-plan", "planning"),
        mockPlan("building-plan", "building"),
        mockPlan("done-plan", "complete"),
      ],
      edges: [],
    };

    render(<DependencyGraph graph={graphWithStatuses} />);

    await vi.waitFor(() => {
      const rects = document.querySelectorAll("svg rect");
      expect(rects.length).toBeGreaterThanOrEqual(3);
    });

    const fills = Array.from(document.querySelectorAll("svg rect"))
      .filter((r) => r.getAttribute("width") === "100")
      .map((r) => r.getAttribute("fill"));
    expect(fills).toContain(darkTokens.planningFill);
    expect(fills).toContain(darkTokens.buildingFill);
    expect(fills).toContain(darkTokens.completeFill);

    document.documentElement.removeAttribute("data-theme");
    setThemeTokens(LIGHT_THEME_TOKENS);
  });
});
