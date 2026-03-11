/**
 * Feedback resolution flow — resolve, cascade to children, auto-resolve on task done.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { triggerDeployForEvent } from "./deploy-trigger.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("feedback-resolve");

export interface FeedbackResolveDeps {
  listFeedback: (projectId: string) => Promise<FeedbackItem[]>;
  getFeedback: (projectId: string, feedbackId: string) => Promise<FeedbackItem>;
  saveFeedback: (projectId: string, item: FeedbackItem) => Promise<void>;
}

/**
 * Check if any mapped feedback items should be auto-resolved after a task is closed.
 */
export async function checkAutoResolveOnTaskDone(
  projectId: string,
  closedTaskId: string,
  deps: FeedbackResolveDeps
): Promise<void> {
  const projectService = new ProjectService();
  const settings = await projectService.getSettings(projectId);
  if (!settings.deployment.autoResolveFeedbackOnTaskCompletion) {
    return;
  }

  const items = await deps.listFeedback(projectId);
  const candidates = items.filter(
    (i) =>
      i.status === "pending" &&
      i.createdTaskIds.length > 0 &&
      i.createdTaskIds.includes(closedTaskId)
  );
  if (candidates.length === 0) return;

  await projectService.getProject(projectId);
  const allIssues = await taskStoreSingleton.listAll(projectId);
  const idToStatus = new Map(allIssues.map((i) => [i.id, (i.status as string) ?? "open"]));

  for (const item of candidates) {
    const allClosed = item.createdTaskIds.every((tid) => idToStatus.get(tid) === "closed");
    if (allClosed) {
      await resolveFeedback(projectId, item.id, deps);
    }
  }
}

async function cascadeResolveChildren(
  projectId: string,
  parentId: string,
  deps: FeedbackResolveDeps
): Promise<void> {
  const items = await deps.listFeedback(projectId);
  const children = items.filter((i) => i.parent_id === parentId);
  for (const child of children) {
    if (child.status !== "resolved") {
      child.status = "resolved";
      await deps.saveFeedback(projectId, child);
      broadcastToProject(projectId, {
        type: "feedback.resolved",
        feedbackId: child.id,
        item: child,
      });
    }
    await cascadeResolveChildren(projectId, child.id, deps);
  }
}

/**
 * Resolve a feedback item and cascade to children.
 */
export async function resolveFeedback(
  projectId: string,
  feedbackId: string,
  deps: FeedbackResolveDeps
): Promise<FeedbackItem> {
  const item = await deps.getFeedback(projectId, feedbackId);
  if (item.status === "resolved") {
    return item;
  }
  item.status = "resolved";
  await deps.saveFeedback(projectId, item);

  broadcastToProject(projectId, {
    type: "feedback.resolved",
    feedbackId: item.id,
    item,
  });

  await cascadeResolveChildren(projectId, item.id, deps);

  const items = await deps.listFeedback(projectId);
  const criticalItems = items.filter((i) => i.category === "bug");
  const allCriticalResolved =
    criticalItems.length > 0 && criticalItems.every((i) => i.status === "resolved");

  if (allCriticalResolved) {
    triggerDeployForEvent(projectId, "eval_resolution").catch((err) => {
      log.warn("Auto-deploy on Evaluate resolution failed", { projectId, err });
    });
  }

  return item;
}
