/**
 * Sync tasks from plan markdown (## Tasks section) to task store.
 * Used when plan content is updated (e.g. via Planning mode chat or plan edit).
 * Updates title and description of existing child tasks to match parsed plan tasks.
 */
import { parsePlanTasks } from "@opensprint/shared";
import { taskStore } from "./task-store.service.js";
import type { StoredTask } from "./task-store.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("plan-task-sync");

/**
 * Sync tasks from plan markdown content to task store.
 * Uses epic prefix + non-epic only. Matches by position: plan task i -> child task i.
 * Updates title and description when they differ.
 * No-op if plan has no ## Tasks section, no epic, or no child tasks.
 */
export async function syncPlanTasksFromContent(
  projectId: string,
  planId: string,
  content: string
): Promise<void> {
  const parsedTasks = parsePlanTasks(content);
  if (parsedTasks.length === 0) return;

  const row = await taskStore.planGet(projectId, planId);
  if (!row) return;

  const epicId = (row.metadata.epicId as string) ?? "";
  if (!epicId) return;

  const allIssues = await taskStore.listAll(projectId);
  const children = allIssues.filter(
    (issue: StoredTask) => issue.id.startsWith(epicId + ".") && issue.issue_type !== "epic"
  );

  // Sort by child index (epic.1, epic.2, ...) for stable ordering
  children.sort((a: StoredTask, b: StoredTask) => {
    const suffixA = a.id.split(".").pop() ?? "";
    const suffixB = b.id.split(".").pop() ?? "";
    const idxA = parseInt(suffixA, 10);
    const idxB = parseInt(suffixB, 10);
    if (!Number.isNaN(idxA) && !Number.isNaN(idxB)) return idxA - idxB;
    return suffixA.localeCompare(suffixB);
  });

  let updated = 0;
  for (let i = 0; i < parsedTasks.length && i < children.length; i++) {
    const parsed = parsedTasks[i]!;
    const task = children[i]!;
    const taskTitle = (task.title ?? "").trim();
    const taskDesc = (task.description ?? "").trim();
    const needsTitle = parsed.title !== taskTitle;
    const needsDesc = parsed.description !== taskDesc;
    if (!needsTitle && !needsDesc) continue;

    try {
      const updates: { title?: string; description?: string } = {};
      if (needsTitle) updates.title = parsed.title;
      if (needsDesc) updates.description = parsed.description;
      await taskStore.update(projectId, task.id, updates);
      updated++;
    } catch (err) {
      log.warn("syncPlanTasksFromContent: failed to update task", {
        planId,
        taskId: task.id,
        err: getErrorMessage(err),
      });
    }
  }

  if (updated > 0) {
    await taskStore.syncForPush(projectId);
    broadcastToProject(projectId, { type: "plan.updated", planId });
    log.info("Synced plan tasks to task store", { planId, updated });
  }
}
