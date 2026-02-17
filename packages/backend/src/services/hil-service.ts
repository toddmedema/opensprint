import { v4 as uuid } from "uuid";
import type { HilConfig } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { broadcastToProject } from "../websocket/index.js";

type HilCategory = keyof HilConfig;

/** Optional metadata for scope-change HIL requests (AI-generated summary) */
export interface ScopeChangeHilMetadata {
  scopeChangeSummary: string;
  scopeChangeProposedUpdates: Array<{ section: string; changeLogEntry?: string }>;
}

interface HilRequest {
  id: string;
  projectId: string;
  category: HilCategory;
  description: string;
  options: Array<{ id: string; label: string; description: string }>;
  resolved: boolean;
  approved: boolean | null;
  notes: string | null;
  createdAt: string;
}

/**
 * Human-in-the-loop service.
 * Evaluates decisions against the project's HIL config and handles
 * approval workflows.
 */
export class HilService {
  private projectService = new ProjectService();
  private pendingRequests = new Map<string, HilRequest>();
  private resolveCallbacks = new Map<string, (approved: boolean, notes?: string) => void>();

  /**
   * Evaluate a decision against the HIL config.
   * Returns immediately for 'automated' and 'notify_and_proceed'.
   * Blocks (via promise) for 'requires_approval' until user responds.
   * @param defaultApproved - When mode is automated/notify_and_proceed, return this value (default: true).
   *   Use false for escalation cases where the default is "don't proceed" (e.g. retry limit reached).
   * @param scopeChangeMetadata - For scopeChanges category: AI-generated summary and proposed updates for the modal.
   */
  async evaluateDecision(
    projectId: string,
    category: HilCategory | 'testFailuresAndRetries',
    description: string,
    options?: Array<{ id: string; label: string; description: string }>,
    defaultApproved = true,
    scopeChangeMetadata?: ScopeChangeHilMetadata,
  ): Promise<{ approved: boolean; notes?: string }> {
    // PRD §6.5.1: Test failures are always automated, not configurable
    if (category === 'testFailuresAndRetries') {
      console.log(`[HIL] Automated decision for testFailuresAndRetries: ${description}`);
      return { approved: defaultApproved };
    }

    const settings = await this.projectService.getSettings(projectId);
    const mode = settings.hilConfig[category];

    const defaultOptions = options || [
      { id: "approve", label: "Approve", description: "Proceed with this decision" },
      { id: "reject", label: "Reject", description: "Do not proceed" },
    ];

    switch (mode) {
      case "automated":
        // Log and proceed automatically with default
        console.log(`[HIL] Automated decision for ${category}: ${description}`);
        return { approved: defaultApproved };

      case "notify_and_proceed": {
        // Notify user but proceed immediately with default (PRD §6.5.2)
        const request = this.createRequest(projectId, category, description, defaultOptions);
        broadcastToProject(projectId, {
          type: "hil.request",
          requestId: request.id,
          category,
          description,
          options: defaultOptions,
          blocking: false,
          ...(scopeChangeMetadata && {
            scopeChangeSummary: scopeChangeMetadata.scopeChangeSummary,
            scopeChangeProposedUpdates: scopeChangeMetadata.scopeChangeProposedUpdates,
          }),
        });
        console.log(`[HIL] Notify-and-proceed for ${category}: ${description}`);
        return { approved: defaultApproved };
      }

      case "requires_approval": {
        // Block until user responds (PRD §6.5.2)
        const request = this.createRequest(projectId, category, description, defaultOptions);
        broadcastToProject(projectId, {
          type: "hil.request",
          requestId: request.id,
          category,
          description,
          options: defaultOptions,
          blocking: true,
          ...(scopeChangeMetadata && {
            scopeChangeSummary: scopeChangeMetadata.scopeChangeSummary,
            scopeChangeProposedUpdates: scopeChangeMetadata.scopeChangeProposedUpdates,
          }),
        });
        console.log(`[HIL] Waiting for approval on ${category}: ${description}`);

        return new Promise<{ approved: boolean; notes?: string }>((resolve) => {
          this.resolveCallbacks.set(request.id, (approved, notes) => {
            resolve({ approved, notes });
          });
        });
      }

      default:
        return { approved: defaultApproved };
    }
  }

  /**
   * Handle a user's response to a HIL request.
   * Called when a 'hil.respond' WebSocket event is received.
   */
  respondToRequest(requestId: string, approved: boolean, notes?: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      console.warn(`[HIL] Unknown request ID: ${requestId}`);
      return;
    }

    request.resolved = true;
    request.approved = approved;
    request.notes = notes ?? null;

    // Resolve the waiting promise
    const callback = this.resolveCallbacks.get(requestId);
    if (callback) {
      callback(approved, notes);
      this.resolveCallbacks.delete(requestId);
    }

    this.pendingRequests.delete(requestId);
    console.log(`[HIL] Request ${requestId} resolved: ${approved ? "approved" : "rejected"}`);
  }

  /**
   * Get all pending requests for a project.
   */
  getPendingRequests(projectId: string): HilRequest[] {
    return Array.from(this.pendingRequests.values()).filter((r) => r.projectId === projectId && !r.resolved);
  }

  private createRequest(
    projectId: string,
    category: HilCategory,
    description: string,
    options: Array<{ id: string; label: string; description: string }>,
  ): HilRequest {
    const request: HilRequest = {
      id: uuid(),
      projectId,
      category,
      description,
      options,
      resolved: false,
      approved: null,
      notes: null,
      createdAt: new Date().toISOString(),
    };
    this.pendingRequests.set(request.id, request);
    return request;
  }
}

export const hilService = new HilService();
