/** Feedback categorization */
export type FeedbackCategory = "bug" | "feature" | "ux" | "scope";

/** Feedback resolution status */
export type FeedbackStatus = "pending" | "mapped" | "resolved";

/** Proposed task in indexed Planner format (PRD §12.3.4) */
export interface ProposedTask {
  index: number;
  title: string;
  description: string;
  priority: number;
  depends_on: number[];
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
  /** Resolved bead epic ID for task creation (from Plan beadEpicId or AI response) */
  mappedEpicId?: string | null;
  /** Explicit scope change flag (PRD §12.3.4); when true triggers Harmonizer */
  isScopeChange?: boolean;
  /** Bead ID of the feedback source (chore) used for discovered-from provenance */
  feedbackSourceBeadId?: string;
  /** Base64-encoded image attachments (data URLs or raw base64) */
  images?: string[];
  /** ID of the parent feedback item (null for top-level feedback). PRD §7.4.1 threaded replies */
  parent_id?: string | null;
  /** Nesting depth computed from the parent chain (0 for top-level). PRD §7.4.1 */
  depth?: number;
}
