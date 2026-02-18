import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import type { Plan, PlanDependencyGraph } from "@opensprint/shared";

interface DependencyGraphProps {
  graph: PlanDependencyGraph | null;
  onPlanClick?: (plan: Plan) => void;
}

interface Dimensions {
  width: number;
  height: number;
}

/** Read theme token from CSS variable (D3/SVG cannot inherit Tailwind classes). */
function getThemeColor(varName: string): string {
  if (typeof document === "undefined") return "#6b7280";
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || "#6b7280";
}

/** Compute critical path edges (longest path in DAG). Returns Set of "from->to" keys. */
function computeCriticalPathEdges(planIds: string[], edges: { from: string; to: string }[]): Set<string> {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of planIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const e of edges) {
    outgoing.get(e.from)?.push(e.to);
    incoming.get(e.to)?.push(e.from);
  }

  const sources = planIds.filter((id) => incoming.get(id)!.length === 0);
  const sinks = planIds.filter((id) => outgoing.get(id)!.length === 0);

  // Topological sort
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const to of outgoing.get(id) ?? []) visit(to);
    order.push(id);
  };
  for (const id of planIds) visit(id);
  order.reverse();

  // Longest path from any source to each node
  const distFromSource = new Map<string, number>();
  const prevFromSource = new Map<string, string>();
  for (const id of planIds) distFromSource.set(id, sources.includes(id) ? 0 : -Infinity);
  for (const id of order) {
    const d = distFromSource.get(id)!;
    for (const to of outgoing.get(id) ?? []) {
      const newD = d + 1;
      if (newD > (distFromSource.get(to) ?? -Infinity)) {
        distFromSource.set(to, newD);
        prevFromSource.set(to, id);
      }
    }
  }

  // Find sink with max distance
  let maxSink = "";
  let maxDist = -1;
  for (const s of sinks) {
    const d = distFromSource.get(s) ?? -Infinity;
    if (d > maxDist) {
      maxDist = d;
      maxSink = s;
    }
  }
  if (maxSink === "" || maxDist < 0) return new Set();

  // Backtrack to get critical path edges
  const criticalEdges = new Set<string>();
  let cur = maxSink;
  while (prevFromSource.has(cur)) {
    const prev = prevFromSource.get(cur)!;
    criticalEdges.add(`${prev}->${cur}`);
    cur = prev;
  }
  return criticalEdges;
}

/** D3 force-directed dependency graph with critical path highlighting. PRD §7.2.2 */
export function DependencyGraph({ graph, onPlanClick }: DependencyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);

  // Track container size so graph fills full area when layout changes (e.g. sidebar open/close)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateDimensions = () => {
      const width = el.clientWidth || 600;
      const height = Math.max(280, Math.min(400, (graph?.plans.length ?? 3) * 50));
      setDimensions((prev) => {
        if (prev && prev.width === width && prev.height === height) return prev;
        return { width, height };
      });
    };

    updateDimensions();
    const ro = new ResizeObserver(updateDimensions);
    ro.observe(el);
    return () => ro.disconnect();
  }, [graph?.plans.length]);

  useEffect(() => {
    if (!graph || graph.plans.length === 0 || !containerRef.current || !svgRef.current || !dimensions) return;

    const { plans, edges } = graph;
    const planById = new Map(plans.map((p) => [p.metadata.planId, p]));
    const planIds = plans.map((p) => p.metadata.planId);
    const criticalEdges = computeCriticalPathEdges(planIds, edges);

    const { width, height } = dimensions;

    d3.select(svgRef.current).selectAll("*").remove();

    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", [0, 0, width, height]);

    const g = svg.append("g");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on("zoom", (event) => g.attr("transform", event.transform));
    svg.call(zoom);

    const nodeData = planIds.map((id) => ({
      id,
      plan: planById.get(id)!,
    }));

    const linkData = edges
      .map((e) => ({
        source: e.from,
        target: e.to,
        isCritical: criticalEdges.has(`${e.from}->${e.to}`),
      }))
      .filter((l) => planById.has(l.source) && planById.has(l.target));

    const tokens = {
      edge: getThemeColor("--color-graph-edge"),
      edgeCritical: getThemeColor("--color-graph-edge-critical"),
      text: getThemeColor("--color-graph-text"),
      nodeDefaultFill: getThemeColor("--color-graph-node-default-fill"),
      nodeDefaultStroke: getThemeColor("--color-graph-node-default-stroke"),
      planningFill: getThemeColor("--color-graph-status-planning-fill"),
      planningStroke: getThemeColor("--color-graph-status-planning-stroke"),
      buildingFill: getThemeColor("--color-graph-status-building-fill"),
      buildingStroke: getThemeColor("--color-graph-status-building-stroke"),
      completeFill: getThemeColor("--color-graph-status-complete-fill"),
      completeStroke: getThemeColor("--color-graph-status-complete-stroke"),
      arrow: getThemeColor("--color-graph-arrow"),
      arrowCritical: getThemeColor("--color-graph-arrow-critical"),
    };

    const simulation = d3
      .forceSimulation(nodeData as d3.SimulationNodeDatum[])
      .force(
        "link",
        d3
          .forceLink(linkData)
          .id((d) => (d as { id: string }).id)
          .distance(80),
      )
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(50));

    const link = g
      .append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(linkData)
      .join("line")
      .attr("stroke", (d) => (d.isCritical ? tokens.edgeCritical : tokens.edge))
      .attr("stroke-width", (d) => (d.isCritical ? 2.5 : 1.5))
      .attr("stroke-opacity", (d) => (d.isCritical ? 0.9 : 0.5))
      .attr("marker-end", (d) => (d.isCritical ? "url(#arrow-critical)" : "url(#arrow-normal)"));

    const node = g
      .append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(nodeData)
      .join("g")
      .attr("cursor", "pointer")
      .call(
        d3
          .drag<SVGGElement, { id: string; plan: Plan }>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            const n = d as d3.SimulationNodeDatum & { fx?: number; fy?: number; x?: number; y?: number };
            n.fx = n.x;
            n.fy = n.y;
          })
          .on("drag", (event, d) => {
            const n = d as d3.SimulationNodeDatum & { fx?: number; fy?: number };
            n.fx = event.x;
            n.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            const n = d as d3.SimulationNodeDatum & { fx?: number; fy?: number };
            n.fx = undefined;
            n.fy = undefined;
          }) as never,
      )
      .on("click", (_, d) => onPlanClick?.(d.plan));

    const statusColors: Record<string, { fill: string; stroke: string }> = {
      planning: { fill: tokens.planningFill, stroke: tokens.planningStroke },
      building: { fill: tokens.buildingFill, stroke: tokens.buildingStroke },
      complete: { fill: tokens.completeFill, stroke: tokens.completeStroke },
    };
    const defaultNode = { fill: tokens.nodeDefaultFill, stroke: tokens.nodeDefaultStroke };

    node
      .append("rect")
      .attr("width", 100)
      .attr("height", 36)
      .attr("rx", 6)
      .attr("x", -50)
      .attr("y", -18)
      .attr("fill", (d) => (statusColors[d.plan.status] ?? defaultNode).fill)
      .attr("stroke", (d) => (statusColors[d.plan.status] ?? defaultNode).stroke)
      .attr("stroke-width", 1.5)
      .on("mouseover", function () {
        d3.select(this).attr("stroke-width", 2.5);
      })
      .on("mouseout", function () {
        d3.select(this).attr("stroke-width", 1.5);
      });

    node
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("font-size", "11px")
      .attr("font-weight", "500")
      .attr("fill", tokens.text)
      .text((d) => {
        const label = d.plan.metadata.planId.replace(/-/g, " ");
        return label.length > 14 ? label.slice(0, 12) + "…" : label;
      });

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => {
          const src = d.source as d3.SimulationNodeDatum & { x?: number; y?: number };
          return src.x ?? 0;
        })
        .attr("y1", (d) => {
          const src = d.source as d3.SimulationNodeDatum & { x?: number; y?: number };
          return src.y ?? 0;
        })
        .attr("x2", (d) => {
          const tgt = d.target as d3.SimulationNodeDatum & { x?: number; y?: number };
          return tgt.x ?? 0;
        })
        .attr("y2", (d) => {
          const tgt = d.target as d3.SimulationNodeDatum & { x?: number; y?: number };
          return tgt.y ?? 0;
        });

      node.attr("transform", (d) => {
        const n = d as d3.SimulationNodeDatum & { x?: number; y?: number };
        return `translate(${n.x ?? 0},${n.y ?? 0})`;
      });
    });

    const defs = svg.append("defs");
    defs
      .append("marker")
      .attr("id", "arrow-normal")
      .attr("markerWidth", 8)
      .attr("markerHeight", 8)
      .attr("refX", 6)
      .attr("refY", 4)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,0 L8,4 L0,8 Z")
      .attr("fill", tokens.arrow);
    defs
      .append("marker")
      .attr("id", "arrow-critical")
      .attr("markerWidth", 8)
      .attr("markerHeight", 8)
      .attr("refX", 6)
      .attr("refY", 4)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,0 L8,4 L0,8 Z")
      .attr("fill", tokens.arrowCritical);

    return () => {
      simulation.stop();
    };
  }, [graph, onPlanClick, dimensions]);

  if (!graph || graph.plans.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-theme-muted text-sm border-2 border-dashed border-theme-border rounded-lg">
        No plans to display
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full overflow-hidden rounded-lg border border-theme-border bg-theme-surface">
      <svg ref={svgRef} className="block" />
      {computeCriticalPathEdges(
        graph.plans.map((p) => p.metadata.planId),
        graph.edges,
      ).size > 0 && (
        <div className="px-3 py-1.5 text-xs text-theme-muted border-t border-theme-border-subtle flex items-center gap-2">
          <span className="inline-block w-3 h-0.5 bg-theme-graph-edge-critical rounded" />
          Critical path (longest dependency chain)
        </div>
      )}
    </div>
  );
}
