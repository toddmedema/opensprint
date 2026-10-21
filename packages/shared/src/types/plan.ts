import { PLAN_STATUS_ORDER } from "../constants/index.js";
import type { Notification } from "./notification.js";

/** Plan complexity estimate */
export type PlanComplexity = "low" | "medium" | "high" | "very_high";

/** Plan status derived from epic state */
export type PlanStatus = "planning" | "building" | "in_review" | "complete";

/** Sort plans by status order (planning → building → in_review → complete) */
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
  /** Parent plan ID for sub-plan hierarchy; undefined for root plans */
  parentPlanId?: string;
  /** Depth in the hierarchy (1 = root) when persisted for sub-plans */
  depth?: number;
}

/** Plan with its content and metadata */
export interface Plan {
  revision?: number;
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
  /** Version number for which plan task generation last ran (if tracked). */
  lastTaskGenerationVersionNumber?: number;
  /** True when task generation has run for currentVersionNumber. */
  hasGeneratedPlanTasksForCurrentVersion?: boolean;
  /** Depth in the sub-plan hierarchy (1 = root); computed from parent chain */
  depth?: number;
  /** Same as metadata.parentPlanId; duplicated at top level for list/detail API consumers */
  parentPlanId?: string | null;
  /** IDs of immediate child plans for tree rendering */
  childPlanIds?: string[];
  /**
   * When true, leaf task generation should be deferred or consolidated (e.g. plan body too large).
   * Set by backend or surfaced after failed batch generation.
   */
  tooLargeForLeaf?: boolean;

  /**
   * POST /plan-tasks response only: recursive task generation outcome.
   * Omitted on GET plan and other endpoints.
   */
  totalTasksCreated?: number;
  failedPlanIds?: string[];
  successPlanIds?: string[];
}

/** Dependency edge between Plans for the dependency graph */
export interface PlanDependencyEdge {
  from: string;
  to: string;
  type: "blocks" | "related";
}

/** Parent→child link between plans (sub-plan hierarchy), separate from blocking edges. */
export interface PlanHierarchyEdge {
  parentPlanId: string;
  childPlanId: string;
}

/** Dependency graph data */
export interface PlanDependencyGraph {
  plans: Plan[];
  edges: PlanDependencyEdge[];
  /** Hierarchy links derived from parent_plan_id / metadata.parentPlanId for graph UIs. */
  hierarchyEdges?: PlanHierarchyEdge[];
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
  /** Parent plan ID when creating a sub-plan */
  parentPlanId?: string;
  /** Persisted hierarchy depth (1 = root); sub-plans are typically parent depth + 1 */
  depth?: number;
  plan_depth?: number;
  tasks?: Array<{
    title?: string;
    task_title?: string;
    description?: string;
    task_description?: string;
    priority?: number;
    task_priority?: number;
    dependsOn?: string[];
    depends_on?: (string | number)[];
    files?: { modify?: string[]; create?: string[]; test?: string[] };
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
    files?: { modify?: string[]; create?: string[]; test?: string[] };
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

/** One entry in POST /projects/:id/plans/execute-batch — same semantics as single-plan execute */
export interface PlanExecuteBatchItem {
  planId: string;
  prerequisitePlanIds?: string[];
  version_number?: number;
}

export type PlanExecuteBatchRunStatus = "running" | "completed" | "failed";

/** Status of a persisted execute-all batch (GET by id or active) */
export interface PlanExecuteBatchStatus {
  batchId: string;
  projectId: string;
  status: PlanExecuteBatchRunStatus;
  currentIndex: number;
  total: number;
  errorPlanId?: string;
  errorMessage?: string;
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

/** Attachment sent with a plan-generation request. */
export interface PlanAttachment {
  /** Original file name (e.g. "design.png") */
  name: string;
  /** MIME type (e.g. "image/png", "text/markdown", "application/pdf") */
  mimeType: string;
  /** For text-based files (.md): the raw UTF-8 text content. */
  textContent?: string;
  /** For binary files (images, PDFs): base64-encoded data. */
  base64?: string;
  /** File size in bytes (used for client-side validation display). */
  size: number;
}

/** Accepted MIME types for plan attachments. */
export const PLAN_ATTACHMENT_ACCEPT: Record<string, string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "text/markdown": [".md"],
  "application/pdf": [".pdf"],
};

/** Flat list of accepted extensions. */
export const PLAN_ATTACHMENT_EXTENSIONS: string[] = Object.values(PLAN_ATTACHMENT_ACCEPT).flat();

/** Max single file size: 10 MB */
export const PLAN_ATTACHMENT_MAX_SIZE = 10 * 1024 * 1024;

/** Max number of attachments per request. */
export const PLAN_ATTACHMENT_MAX_COUNT = 10;

/** Request body for POST /projects/:id/plans/generate — AI generates plan from freeform description */
export interface GeneratePlanRequest {
  description: string;
  attachments?: PlanAttachment[];
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

/** Recursive tree node for the plan hierarchy endpoint */
export interface PlanHierarchyNode {
  planId: string;
  epicId: string;
  parentPlanId?: string;
  depth: number;
  status: PlanStatus;
  taskCount: number;
  children: PlanHierarchyNode[];
}

/** Response shape for GET /projects/:id/plans/hierarchy */
export interface PlanHierarchyResponse {
  root: PlanHierarchyNode;
}
