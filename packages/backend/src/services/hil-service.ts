import { randomUUID } from "node:crypto";
import { prdToSpecMarkdown, type HilConfig } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { notificationService } from "./notification.service.js";
import { prdProposalStore } from "./prd-proposal-store.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";
import { PrdService } from "./prd.service.js";
import { specPublicationService } from "./spec-publication.service.js";

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

/**
 * Human-in-the-loop service.
 * Routes all approval requests through the Human Notification System (notification bell).
 * No legacy pop-up modals or toasts.
 */
export class HilService {
  private projectService = new ProjectService();
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
    sourceId: string = "",
    proposedSpecContent?: string,
    baseSpecContent?: string
  ): Promise<{ approved: boolean; notes?: string }> {
    if (!proposedSpecContent && scopeChangeMetadata?.scopeChangeProposedUpdates.length) {
      const prd = await new PrdService().getPrd(projectId);
      baseSpecContent = prdToSpecMarkdown(prd);
      for (const update of scopeChangeMetadata.scopeChangeProposedUpdates) {
        prd.sections[update.section] = {
          content: update.content,
          version: (prd.sections[update.section]?.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
      }
      proposedSpecContent = prdToSpecMarkdown(prd);
    }
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
        const requestId = `hil-${randomUUID()}`;
        if (proposedSpecContent)
          await prdProposalStore.registerDurable(
            projectId,
            requestId,
            proposedSpecContent,
            baseSpecContent ?? ""
          );
        const notification = await notificationService.createHilApproval({
          id: requestId,
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
        const requestId = `hil-${randomUUID()}`;
        if (proposedSpecContent)
          await prdProposalStore.registerDurable(
            projectId,
            requestId,
            proposedSpecContent,
            baseSpecContent ?? ""
          );
        const notification = await notificationService.createHilApproval({
          id: requestId,
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

        // A live caller observes durable state. Application of an approved SPEC
        // belongs to the server worker and survives loss of this promise.
        while (true) {
          const resolved = await notificationService.getById(projectId, notification.id);
          if (!resolved) return { approved: false, notes: "Approval was removed" };
          if (resolved.status === "resolved") {
            const approved =
              resolved.responses?.some(
                (r) => r.questionId === "approval" && r.answer === "approved"
              ) ?? false;
            if (approved && proposedSpecContent) {
              await specPublicationService.applyApprovedProposal(notification.id);
              return { approved: true, notes: "durable_spec_applied" };
            }
            return { approved };
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      default:
        return { approved: defaultApproved };
    }
  }

  /**
   * Called when a hil_approval notification is resolved via PATCH.
   * Resolves the waiting promise for requires_approval.
   */
  async notifyResolved(notificationId: string, approved: boolean): Promise<void> {
    if (approved) await specPublicationService.applyApprovedProposal(notificationId);
    prdProposalStore.remove(notificationId);
  }
}

export const hilService = new HilService();
