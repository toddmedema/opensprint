import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { Plan, PlanDependencyGraph } from "@opensprint/shared";

interface DependencyGraphProps {
  graph: PlanDependencyGraph | null;
  onPlanClick?: (plan: Plan) => void;
}

/** Compute critical path edges (longest path in DAG). Returns Set of "from->to" keys. */
function computeCriticalPathEdges(
  planIds: string[],
  edges: { from: string; to: string }[]
): Set<string> {
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

  useEffect(() => {
    if (!graph || graph.plans.length === 0 || !containerRef.current || !svgRef.current) return;

    const { plans, edges } = graph;
    const planById = new Map(plans.map((p) => [p.metadata.planId, p]));
    const planIds = plans.map((p) => p.metadata.planId);
    const criticalEdges = computeCriticalPathEdges(planIds, edges);

    const width = containerRef.current.clientWidth || 600;
    const height = Math.max(280, Math.min(400, plans.length * 50));

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

    const simulation = d3
      .forceSimulation(nodeData as d3.SimulationNodeDatum[])
      .force(
        "link",
        d3
          .forceLink(linkData)
          .id((d) => (d as { id: string }).id)
          .distance(80)
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
      .attr("stroke", (d) => (d.isCritical ? "#dc2626" : "#d1d5db"))
      .attr("stroke-width", (d) => (d.isCritical ? 2.5 : 1.5))
      .attr("stroke-opacity", (d) => (d.isCritical ? 0.9 : 0.5))
      .attr("marker-end", (d) =>
        d.isCritical ? "url(#arrow-critical)" : "url(#arrow-normal)"
      );

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
          }) as never
      )
      .on("click", (_, d) => onPlanClick?.(d.plan));

    const statusColors: Record<string, { fill: string; stroke: string }> = {
      planning: { fill: "#fef3c7", stroke: "#f59e0b" },
      shipped: { fill: "#dbeafe", stroke: "#3b82f6" },
      complete: { fill: "#d1fae5", stroke: "#10b981" },
    };

    node.append("rect").attr("width", 100).attr("height", 36).attr("rx", 6).attr("x", -50).attr("y", -18);

    node
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("font-size", "11px")
      .attr("font-weight", "500")
      .attr("fill", "#374151")
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

    simulation.on("end", () => {
      node.each(function (d) {
        const style = statusColors[d.plan.status] ?? { fill: "#f9fafb", stroke: "#e5e7eb" };
        d3.select(this)
          .select("rect")
          .attr("fill", style.fill)
          .attr("stroke", style.stroke)
          .attr("stroke-width", 1.5)
          .on("mouseover", function () {
            d3.select(this).attr("stroke-width", 2.5);
          })
          .on("mouseout", function () {
            d3.select(this).attr("stroke-width", 1.5);
          });
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
      .attr("fill", "#9ca3af");
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
      .attr("fill", "#dc2626");

    return () => {
      simulation.stop();
    };
  }, [graph, onPlanClick]);

  if (!graph || graph.plans.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg">
        No plans to display
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full overflow-hidden rounded-lg border border-gray-200 bg-white">
      <svg ref={svgRef} className="block" />
      {computeCriticalPathEdges(
        graph.plans.map((p) => p.metadata.planId),
        graph.edges
      ).size > 0 && (
        <div className="px-3 py-1.5 text-xs text-gray-500 border-t border-gray-100 flex items-center gap-2">
          <span className="inline-block w-3 h-0.5 bg-red-500 rounded" />
          Critical path (longest dependency chain)
        </div>
      )}
    </div>
  );
}
