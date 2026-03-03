import type { HilConfig } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { notificationService } from "./notification.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("hil");
type HilCategory = keyof HilConfig;

/** Internal HIL category for test failures — always automated, never configurable (PRD §6.5.1) */
export type HilDecisionCategory = HilCategory | "testFailuresAndRetries";

/** Proposed PRD section update with content for diff display */
export interface ScopeChangeProposedUpdate {
  section: string;
  changeLogEntry?: string;
  content: string;
}

/** Optional metadata for scope-change HIL requests (AI-generated summary + proposed content for diff) */
export interface ScopeChangeHilMetadata {
  scopeChangeSummary: string;
  scopeChangeProposedUpdates: ScopeChangeProposedUpdate[];
}

/** How often to sweep stale HIL notifications */
const HIL_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Human-in-the-loop service.
 * Routes all approval requests through the Human Notification System (notification bell).
 * No legacy pop-up modals or toasts.
 */
export class HilService {
  private projectService = new ProjectService();
  /** Callbacks for blocking HIL approvals: notificationId -> (approved: boolean) => void */
  private notificationResolveCallbacks = new Map<string, (approved: boolean) => void>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.sweepStaleCallbacks(), HIL_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Auto-resolve stale callbacks to prevent unbounded growth */
  private sweepStaleCallbacks(): void {
    // Callbacks are stored without timestamp; we rely on notification TTL or user action.
    // For now, keep callbacks until resolved; no sweep by age (notification.resolve clears them).
  }

  /**
   * Evaluate a decision against the HIL config.
   * Returns immediately for 'automated' and 'notify_and_proceed'.
   * Blocks (via promise) for 'requires_approval' until user responds via notification bell.
   */
  async evaluateDecision(
    projectId: string,
    category: HilDecisionCategory,
    description: string,
    options?: Array<{ id: string; label: string; description: string }>,
    defaultApproved = true,
    scopeChangeMetadata?: ScopeChangeHilMetadata,
    source: "eval" | "prd" = "eval",
    sourceId: string = ""
  ): Promise<{ approved: boolean; notes?: string }> {
    // PRD §6.5.1: Test failures are always automated — never configurable
    if (category === "testFailuresAndRetries") {
      log.info("Automated decision for testFailuresAndRetries", { description });
      return { approved: defaultApproved };
    }

    const settings = await this.projectService.getSettings(projectId);
    const mode = settings.hilConfig[category];

    switch (mode) {
      case "automated":
        log.info("Automated decision", { category, description });
        return { approved: defaultApproved };

      case "notify_and_proceed": {
        // Create notification, broadcast, proceed immediately (no blocking)
        const notification = await notificationService.createHilApproval({
          projectId,
          source,
          sourceId: sourceId || (source === "eval" ? "scope" : "architecture"),
          description,
          category,
          scopeChangeMetadata: scopeChangeMetadata
            ? {
                scopeChangeSummary: scopeChangeMetadata.scopeChangeSummary,
                scopeChangeProposedUpdates: scopeChangeMetadata.scopeChangeProposedUpdates,
              }
            : undefined,
        });
        broadcastToProject(projectId, {
          type: "notification.added",
          notification: {
            id: notification.id,
            projectId: notification.projectId,
            source: notification.source,
            sourceId: notification.sourceId,
            questions: notification.questions,
            status: notification.status,
            createdAt: notification.createdAt,
            resolvedAt: notification.resolvedAt,
            kind: "hil_approval",
            scopeChangeMetadata: notification.scopeChangeMetadata,
          },
        });
        log.info("Notify-and-proceed", { category, description });
        return { approved: defaultApproved };
      }

      case "requires_approval": {
        // Create notification, register callback, broadcast; block until user resolves via bell
        const notification = await notificationService.createHilApproval({
          projectId,
          source,
          sourceId: sourceId || (source === "eval" ? "scope" : "architecture"),
          description,
          category,
          scopeChangeMetadata: scopeChangeMetadata
            ? {
                scopeChangeSummary: scopeChangeMetadata.scopeChangeSummary,
                scopeChangeProposedUpdates: scopeChangeMetadata.scopeChangeProposedUpdates,
              }
            : undefined,
        });

        broadcastToProject(projectId, {
          type: "notification.added",
          notification: {
            id: notification.id,
            projectId: notification.projectId,
            source: notification.source,
            sourceId: notification.sourceId,
            questions: notification.questions,
            status: notification.status,
            createdAt: notification.createdAt,
            resolvedAt: notification.resolvedAt,
            kind: "hil_approval",
            scopeChangeMetadata: notification.scopeChangeMetadata,
          },
        });

        log.info("Waiting for approval via notification", {
          category,
          notificationId: notification.id,
        });

        return new Promise<{ approved: boolean; notes?: string }>((resolve) => {
          this.notificationResolveCallbacks.set(notification.id, (approved) => {
            this.notificationResolveCallbacks.delete(notification.id);
            resolve({ approved });
          });
        });
      }

      default:
        return { approved: defaultApproved };
    }
  }

  /**
   * Called when a hil_approval notification is resolved via PATCH.
   * Resolves the waiting promise for requires_approval.
   */
  notifyResolved(notificationId: string, approved: boolean): void {
    const callback = this.notificationResolveCallbacks.get(notificationId);
    if (callback) {
      callback(approved);
      this.notificationResolveCallbacks.delete(notificationId);
      log.info("HIL notification resolved", { notificationId, approved });
    }
  }
}

export const hilService = new HilService();
