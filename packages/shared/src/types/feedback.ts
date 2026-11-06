import type { ReviewAngle } from "./settings.js";

export type AutomatedQaPerspective = "general" | ReviewAngle;

export interface AutomatedQaRequest {
  perspectives: AutomatedQaPerspective[];
  instructions?: string;
}

export interface AutomatedQaResult {
  runId: string;
  results: {
    perspective: AutomatedQaPerspective;
    status: "completed" | "failed";
    summary: string;
    feedbackIds: string[];
  }[];
}

/** Feedback categorization */
export type FeedbackCategory = "bug" | "feature" | "ux" | "scope";

/** Feedback resolution status. Pending = not yet resolved (includes both awaiting categorization and categorized). Cancelled = user cancelled; no tasks in progress. */
export type FeedbackStatus = "pending" | "resolved" | "cancelled";

/** Proposed task in indexed Planner format (PRD §12.3.4) */
export interface ProposedTask {
  index: number;
  title: string;
  description: string;
  priority: number;
  depends_on: number[];
  /** Task-level complexity (1-10). When absent, inferred from plan or default. */
  complexity?: number;
}

/** Feedback item stored at .opensprint/feedback/<id>.json */
export interface FeedbackItem {
  id: string;
  text: string;
  category: FeedbackCategory;
  mappedPlanId: string | null;
  createdTaskIds: string[];
  status: FeedbackStatus;
  createdAt: string;
  /** Suggested task titles from AI categorization */
  taskTitles?: string[];
  /** Full proposed tasks in Planner format (PRD §12.3.4) */
  proposedTasks?: ProposedTask[];
  /** Resolved epic (task) ID for task creation (from Plan epicId or AI response) */
  mappedEpicId?: string | null;
  /** Explicit scope change flag (PRD §12.3.4); when true triggers Harmonizer */
  isScopeChange?: boolean;
  /** Task ID of the feedback source (chore) used for discovered-from provenance */
  feedbackSourceTaskId?: string;
  /** Base64-encoded image attachments (data URLs or raw base64) */
  images?: string[];
  /** ID of the parent feedback item (null for top-level feedback). PRD §7.4.1 threaded replies */
  parent_id?: string | null;
  /** Nesting depth computed from the parent chain (0 for top-level). PRD §7.4.1 */
  depth?: number;
  /** User-specified priority (0=Critical, 1=High, 2=Medium, 3=Low, 4=Lowest) from submission */
  userPriority?: number | null;
  /** Internal: retry count when link_to_existing_task_ids had invalid IDs (cap at 2, then fall back to create) */
  linkInvalidRetryCount?: number;
  /** When true, feedback was routed to Planner to create a new Epic/Plan instead of individual tickets (PRD §7.4.2) */
  isLargeScope?: boolean;
  /** Plan version for reply-to-plan thread context; used when created tasks are actually mapped back to that plan. */
  planVersionNumber?: number | null;
  /** When set, feedback was submitted from this plan's thread. This is contextual metadata, not a forced task/plan mapping. */
  submittedPlanId?: string | null;
  /** Import source (e.g. "todoist") — set via extra when feedback is imported from an integration */
  source?: string;
  /** Todoist task ID when source is "todoist" */
  todoistTaskId?: string;
  /** Todoist project ID when source is "todoist" */
  todoistProjectId?: string;
  /** ISO timestamp when the feedback was imported from the external source */
  importedAt?: string;
}
