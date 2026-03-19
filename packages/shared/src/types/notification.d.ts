/** Source of an open question (agent clarification request) */
export type NotificationSource = "plan" | "prd" | "execute" | "eval" | "self-improvement";
/** Kind of notification — open_question = agent clarification; api_blocked = API/auth failure; hil_approval = HIL approval; agent_failed = agent run failed; self_improvement_approval = approve/reject agent improvement candidate */
export type NotificationKind = "open_question" | "api_blocked" | "hil_approval" | "agent_failed" | "self_improvement_approval";
/** Error code for api_blocked notifications (rate_limit, auth, out_of_credit, scope_compliance) */
export type ApiBlockedErrorCode = "rate_limit" | "auth" | "out_of_credit" | "scope_compliance";
export interface OpenQuestionItem {
  id: string;
  text: string;
  createdAt: string;
}
/** User response to an open question (persisted when resolving with answer). */
export interface NotificationResponseItem {
  questionId: string;
  answer: string;
}
/** Proposed PRD section update with content for diff display */
export interface ScopeChangeProposedUpdate {
  section: string;
  changeLogEntry?: string;
  content: string;
}
/** Metadata for scope-change HIL (proposed PRD updates for diff) */
export interface ScopeChangeMetadata {
  scopeChangeSummary: string;
  scopeChangeProposedUpdates: ScopeChangeProposedUpdate[];
}
/** Payload for self_improvement_approval notifications (deep-link path and extra JSON). */
export interface SelfImprovementApprovalPayload {
  deepLinkPath?: string;
  [key: string]: unknown;
}
/** Open question / notification (agent clarification request or API-blocked human notification) */
export interface Notification {
  id: string;
  projectId: string;
  source: NotificationSource;
  sourceId: string;
  questions: OpenQuestionItem[];
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  /** open_question = agent clarification; api_blocked = API/auth failure requiring user action */
  kind?: NotificationKind;
  /** For api_blocked: rate_limit | auth | out_of_credit | scope_compliance — distinguishes failure type */
  errorCode?: ApiBlockedErrorCode;
  /** For hil_approval + scopeChanges: proposed PRD updates for diff display; for self_improvement_approval: deep-link and extra payload */
  scopeChangeMetadata?: ScopeChangeMetadata | SelfImprovementApprovalPayload;
  /** When resolved with answers: persisted response per question (agent-question protocol). */
  responses?: NotificationResponseItem[];
}
//# sourceMappingURL=notification.d.ts.map
