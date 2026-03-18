import type { Notification } from "./notification.js";
/** Plan complexity estimate */
export type PlanComplexity = "low" | "medium" | "high" | "very_high";
/** Plan status derived from epic state */
export type PlanStatus = "planning" | "building" | "in_review" | "complete";
/** Sort plans by status order (planning → building → in_review → complete) */
export declare function sortPlansByStatus<
  T extends {
    status: PlanStatus;
  },
>(plans: T[]): T[];
/** A UI/UX mockup attached to a Plan (ASCII wireframe or text description) */
export interface PlanMockup {
  /** Short label for this mockup (e.g. "Login Screen", "Dashboard Layout") */
  title: string;
  /** ASCII wireframe or textual description of the UI */
  content: string;
}
/** Summary of a plan version (for list/API) */
export interface PlanVersionSummary {
  id: string;
  version_number: number;
  created_at: string;
  is_executed_version?: boolean;
}
/** Full content of a plan version (for display/API) */
export interface PlanVersionContent {
  version_number: number;
  title: string;
  content: string;
  metadata?: PlanMetadata;
  created_at: string;
  is_executed_version?: boolean;
}
/** Metadata for a Plan (stored in task store plans.metadata) */
export interface PlanMetadata {
  planId: string;
  epicId: string;
  shippedAt: string | null;
  /** ISO timestamp when plan was marked complete (human approval); null until then */
  reviewedAt?: string | null;
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
  /** Current (latest) plan version number; present when versioning is used */
  currentVersionNumber?: number;
  /** Version number that was last executed; present when versioning is used */
  lastExecutedVersionNumber?: number;
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
/**
 * Plan creation request — accepts camelCase or snake_case from Planner/API.
 * Required: title or plan_title. content/plan_content default to "# {title}\n\nNo content." if omitted.
 * tasks/task_list, mockups/mock_ups, dependsOnPlans/depends_on_plans accept both conventions.
 */
export interface CreatePlanRequest {
  title?: string;
  plan_title?: string;
  content?: string;
  plan_content?: string;
  complexity?: PlanComplexity;
  mockups?: PlanMockup[];
  mock_ups?: PlanMockup[];
  dependsOnPlans?: string[];
  depends_on_plans?: string[];
  tasks?: Array<{
    title?: string;
    task_title?: string;
    description?: string;
    task_description?: string;
    priority?: number;
    task_priority?: number;
    dependsOn?: string[];
    depends_on?: (string | number)[];
    files?: {
      modify?: string[];
      create?: string[];
      test?: string[];
    };
  }>;
  task_list?: Array<{
    title?: string;
    task_title?: string;
    description?: string;
    task_description?: string;
    priority?: number;
    task_priority?: number;
    dependsOn?: string[];
    depends_on?: (string | number)[];
    files?: {
      modify?: string[];
      create?: string[];
      test?: string[];
    };
  }>;
}
/** Plan update request (content only) */
export interface UpdatePlanRequest {
  content: string;
}
/** Predicted file scope for a task (for parallel scheduling) */
export interface TaskFileScope {
  modify?: string[];
  create?: string[];
  test?: string[];
}
/** Suggested task from AI decomposition (before creation) */
export interface SuggestedTask {
  title: string;
  description: string;
  priority?: number;
  dependsOn?: string[];
  files?: TaskFileScope;
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
/** Auditor run record (final review Auditor execution; enables plan-centric lookup and deep-linking) */
export interface AuditorRun {
  id: number;
  projectId: string;
  planId: string;
  epicId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  assessment: string | null;
}
/** Request body for POST /projects/:id/plans/generate — AI generates plan from freeform description */
export interface GeneratePlanRequest {
  description: string;
}
export interface GeneratePlanCreatedResult {
  status: "created";
  plan: Plan;
}
export interface GeneratePlanNeedsClarificationResult {
  status: "needs_clarification";
  draftId: string;
  resumeContext: `plan-draft:${string}`;
  notification: Notification;
}
export type GeneratePlanResult = GeneratePlanCreatedResult | GeneratePlanNeedsClarificationResult;
//# sourceMappingURL=plan.d.ts.map
