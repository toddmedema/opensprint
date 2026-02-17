/** Plan complexity estimate */
export type PlanComplexity = "low" | "medium" | "high" | "very_high";

/** Plan status derived from beads epic state */
export type PlanStatus = "planning" | "building" | "done";

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

/** Plan status CTA action for Dream phase (PRD §7.1.5) */
export type PlanStatusAction = "plan" | "replan" | "none";

/** Response from GET /projects/:id/plan-status */
export interface PlanStatusResponse {
  hasPlanningRun: boolean;
  prdChangedSinceLastRun: boolean;
  action: PlanStatusAction;
}
