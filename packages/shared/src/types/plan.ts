import { PLAN_STATUS_ORDER } from "../constants/index.js";

/** Plan complexity estimate */
export type PlanComplexity = "low" | "medium" | "high" | "very_high";

/** Plan status derived from beads epic state */
export type PlanStatus = "planning" | "building" | "complete";

/** Sort plans by status order (planning → building → complete) */
export function sortPlansByStatus<T extends { status: PlanStatus }>(plans: T[]): T[] {
  return [...plans].sort((a, b) => {
    const orderA = PLAN_STATUS_ORDER[a.status] ?? 999;
    const orderB = PLAN_STATUS_ORDER[b.status] ?? 999;
    return orderA - orderB;
  });
}

/** A UI/UX mockup attached to a Plan (ASCII wireframe or text description) */
export interface PlanMockup {
  /** Short label for this mockup (e.g. "Login Screen", "Dashboard Layout") */
  title: string;
  /** ASCII wireframe or textual description of the UI */
  content: string;
}

/** Metadata for a Plan (stored alongside markdown at .opensprint/plans/<plan-id>.md) */
export interface PlanMetadata {
  planId: string;
  beadEpicId: string;
  gateTaskId: string;
  /** Gate for delta tasks from Re-execute (PRD §7.2.2); when set, Execute! closes this gate */
  reExecuteGateTaskId?: string;
  shippedAt: string | null;
  complexity: PlanComplexity;
  /** UI/UX mockups for this plan */
  mockups?: PlanMockup[];
}

/** Plan with its content and metadata */
export interface Plan {
  metadata: PlanMetadata;
  content: string;
  status: PlanStatus;
  taskCount: number;
  doneTaskCount: number;
  dependencyCount: number;
  /** ISO date string of plan markdown file mtime */
  lastModified?: string;
}

/** Dependency edge between Plans for the dependency graph */
export interface PlanDependencyEdge {
  from: string;
  to: string;
  type: "blocks" | "related";
}

/** Dependency graph data */
export interface PlanDependencyGraph {
  plans: Plan[];
  edges: PlanDependencyEdge[];
}

/** Plan creation request */
export interface CreatePlanRequest {
  title: string;
  content: string;
  complexity?: PlanComplexity;
  mockups?: PlanMockup[];
  tasks?: Array<{ title: string; description: string; priority?: number; dependsOn?: string[] }>;
}

/** Plan update request (content only) */
export interface UpdatePlanRequest {
  content: string;
}

/** Suggested task from AI decomposition (before creation) */
export interface SuggestedTask {
  title: string;
  description: string;
  priority?: number;
  dependsOn?: string[];
}

/** Suggested plan from AI decomposition (returned by POST /plans/suggest) */
export interface SuggestedPlan {
  title: string;
  content: string;
  complexity?: PlanComplexity;
  dependsOnPlans?: string[];
  mockups?: PlanMockup[];
  tasks?: SuggestedTask[];
}

/** Response from POST /plans/suggest */
export interface SuggestPlansResponse {
  plans: SuggestedPlan[];
}

/** Plan status CTA action for Sketch phase (PRD §7.1.5) */
export type PlanStatusAction = "plan" | "replan" | "none";

/** Response from GET /projects/:id/plan-status */
export interface PlanStatusResponse {
  hasPlanningRun: boolean;
  prdChangedSinceLastRun: boolean;
  action: PlanStatusAction;
}

/** Response from GET /projects/:id/plans/:planId/cross-epic-dependencies */
export interface CrossEpicDependenciesResponse {
  /** Plan IDs that must be executed first (in dependency order) */
  prerequisitePlanIds: string[];
}
