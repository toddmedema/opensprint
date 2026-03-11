/**
 * Task creation from feedback — create tasks, link to existing tasks,
 * deduplication, and category-to-type mapping.
 * Extracted from feedback.service for maintainability.
 */

import type { FeedbackItem, FeedbackCategory, ProposedTask } from "@opensprint/shared";
import { clampTaskComplexity } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { PlanService } from "./plan.service.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { feedbackStore } from "./feedback-store.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("feedback-task-creation");

/**
 * Deduplicate proposed tasks by normalized title. Keeps first occurrence, reindexes and remaps depends_on.
 */
export function deduplicateProposedTasks(tasks: ProposedTask[]): ProposedTask[] {
  if (tasks.length <= 1) return tasks;
  const seen = new Set<string>();
  const kept: ProposedTask[] = [];
  const oldIndexToNewIndex = new Map<number, number>();
  const sorted = [...tasks].sort((a, b) => a.index - b.index);
  for (const t of sorted) {
    const key = t.title.toLowerCase().trim();
    if (seen.has(key)) {
      oldIndexToNewIndex.set(t.index, kept.length - 1);
      continue;
    }
    seen.add(key);
    const newIndex = kept.length;
    oldIndexToNewIndex.set(t.index, newIndex);
    kept.push({ ...t, index: newIndex });
  }
  for (const t of kept) {
    const newDeps = (t.depends_on ?? [])
      .map((d) => oldIndexToNewIndex.get(d))
      .filter((d): d is number => d !== undefined);
    t.depends_on = [...new Set(newDeps)];
  }
  return kept;
}

/**
 * Map feedback category to task type (PRD §14).
 */
export function categoryToTaskType(category: FeedbackCategory): "bug" | "feature" | "task" {
  switch (category) {
    case "bug":
      return "bug";
    case "feature":
      return "feature";
    case "ux":
    case "scope":
    default:
      return "task";
  }
}

export class FeedbackTaskCreationService {
  private projectService = new ProjectService();
  private taskStore = taskStoreSingleton;
  private planService: PlanService | null = null;

  private getPlanService(): PlanService {
    this.planService ??= new PlanService();
    return this.planService;
  }

  /**
   * Link feedback to existing tasks instead of creating new ones.
   */
  async linkFeedbackToExistingTasks(
    projectId: string,
    item: FeedbackItem,
    taskIds: string[],
    updates?: Record<string, { title?: string; description?: string }>
  ): Promise<string[]> {
    const fresh = await feedbackStore.getFeedback(projectId, item.id);
    if (fresh.createdTaskIds && fresh.createdTaskIds.length > 0) {
      return fresh.createdTaskIds;
    }

    const project = await this.projectService.getProject(projectId);

    const sourceTitle = `Feedback: ${item.text.slice(0, 60)}${item.text.length > 60 ? "…" : ""}`;
    const sourceTask = await this.taskStore.create(project.id, sourceTitle, {
      type: "chore",
      priority: 4,
      description: `Feedback ID: ${item.id}`,
    });
    item.feedbackSourceTaskId = sourceTask.id;

    for (const taskId of taskIds) {
      const upd = updates?.[taskId];
      const existing = await Promise.resolve(this.taskStore.show(projectId, taskId));
      const existingIds = ((existing as { sourceFeedbackIds?: string[] }).sourceFeedbackIds ??
        []) as string[];
      const sourceFeedbackIds = existingIds.includes(item.id)
        ? existingIds
        : [...existingIds, item.id];
      if (upd && (upd.title != null || upd.description != null)) {
        await this.taskStore.update(projectId, taskId, {
          ...(upd.title != null && { title: upd.title }),
          ...(upd.description != null && { description: upd.description }),
          extra: { sourceFeedbackIds },
        });
      } else {
        await this.taskStore.update(projectId, taskId, {
          extra: { sourceFeedbackIds },
        });
      }
      await this.taskStore.addDependency(projectId, taskId, sourceTask.id, "discovered-from");
    }

    return taskIds;
  }

  /**
   * Create tasks from feedback (PRD §12.3.4). Idempotent: skips if tasks already created.
   */
  async createTasksFromFeedback(
    projectId: string,
    item: FeedbackItem,
    similar_existing_task_id?: string | null
  ): Promise<string[]> {
    const fresh = await feedbackStore.getFeedback(projectId, item.id);
    if (fresh.createdTaskIds && fresh.createdTaskIds.length > 0) {
      return fresh.createdTaskIds;
    }

    if (similar_existing_task_id) {
      const allTasks = await this.taskStore.listAll(projectId);
      const openLeafTasks = allTasks.filter(
        (t) =>
          (t.status as string) === "open" &&
          (t.issue_type ?? t.type) !== "epic" &&
          (t.issue_type ?? t.type) !== "chore"
      );
      const validIds = new Set(openLeafTasks.map((t) => t.id));
      if (validIds.has(similar_existing_task_id)) {
        try {
          const existing = await Promise.resolve(
            await this.taskStore.show(projectId, similar_existing_task_id)
          );
          const existingIds = ((existing as { sourceFeedbackIds?: string[] }).sourceFeedbackIds ??
            []) as string[];
          const sourceFeedbackIds = existingIds.includes(item.id)
            ? existingIds
            : [...existingIds, item.id];
          const desc = (existing.description as string) ?? "";
          const appendedDesc = desc.trim()
            ? `${desc}\n\n---\nFeedback: ${item.text}`
            : `Feedback: ${item.text}`;
          await this.taskStore.update(projectId, similar_existing_task_id, {
            extra: { sourceFeedbackIds },
            description: appendedDesc,
          });
          item.createdTaskIds = [similar_existing_task_id];
          return [similar_existing_task_id];
        } catch (err) {
          log.warn("Merge into existing task failed, falling through to create", {
            feedbackId: item.id,
            existingTaskId: similar_existing_task_id,
            err,
          });
        }
      } else {
        log.warn("Invalid similar_existing_task_id, falling through to create", {
          feedbackId: item.id,
          similar_existing_task_id,
        });
      }
    }

    const proposedTasks = item.proposedTasks ?? [];
    let taskTitles = item.taskTitles ?? [];
    const hasProposed = proposedTasks.length > 0;
    let hasTitles = taskTitles.length > 0;
    if (!hasProposed && !hasTitles) {
      if (item.text?.trim()) {
        taskTitles = [item.text.slice(0, 80)];
        hasTitles = true;
      } else return [];
    }

    const userPriorityOverride =
      typeof item.userPriority === "number" && item.userPriority >= 0 && item.userPriority <= 4
        ? item.userPriority
        : undefined;

    const project = await this.projectService.getProject(projectId);
    const planService = this.getPlanService();

    let parentEpicId: string | undefined;
    let planVersionNumberForTasks: number | undefined;
    if (item.mappedEpicId) {
      parentEpicId = item.mappedEpicId;
    }
    if (item.mappedPlanId) {
      try {
        const plan = await planService.getPlan(projectId, item.mappedPlanId);
        if (plan.metadata.epicId) {
          parentEpicId = plan.metadata.epicId;
        }
        planVersionNumberForTasks =
          item.planVersionNumber ?? plan.currentVersionNumber ?? undefined;
      } catch {
        // Plan not found or no epic — create tasks without parent
      }
    }

    const singleProposedTask = hasProposed && proposedTasks.length === 1;
    let feedbackSourceTaskId: string | undefined;
    if (!singleProposedTask) {
      try {
        const sourceTitle = `Feedback: ${item.text.slice(0, 60)}${item.text.length > 60 ? "…" : ""}`;
        const sourceTask = await this.taskStore.create(project.id, sourceTitle, {
          type: "chore",
          priority: 4,
          description: `Feedback ID: ${item.id}`,
        });
        feedbackSourceTaskId = sourceTask.id;
        item.feedbackSourceTaskId = sourceTask.id;
      } catch (err) {
        log.error("Failed to create feedback source task", { feedbackId: item.id, err });
      }
    }

    const taskType = categoryToTaskType(item.category);
    const createdIds: string[] = [];
    const taskIdMap = new Map<number, string>();

    if (hasProposed) {
      const sorted = [...proposedTasks].sort((a, b) => a.index - b.index);
      for (const task of sorted) {
        try {
          const priority =
            userPriorityOverride ?? task.priority ?? (item.category === "bug" ? 0 : 2);
          const baseDesc = task.description || undefined;
          const description =
            singleProposedTask && baseDesc
              ? `${baseDesc}\n\nFeedback ID: ${item.id}`
              : singleProposedTask
                ? `Feedback ID: ${item.id}`
                : baseDesc;
          const raw = task.complexity as number | string | undefined;
          const taskComplexity = item.parent_id
            ? 7
            : (clampTaskComplexity(raw) ??
              (raw === "simple" || raw === "low"
                ? 3
                : raw === "complex" || raw === "high"
                  ? 7
                  : undefined));
          const taskExtra: Record<string, unknown> = { sourceFeedbackIds: [item.id] };
          if (item.mappedPlanId && planVersionNumberForTasks != null) {
            taskExtra.sourcePlanId = item.mappedPlanId;
            taskExtra.sourcePlanVersionNumber = planVersionNumberForTasks;
          }
          const issue = await this.taskStore.createWithRetry(
            project.id,
            task.title,
            {
              type: taskType,
              priority,
              description,
              parentId: parentEpicId,
              ...(taskComplexity != null && { complexity: taskComplexity }),
              extra: taskExtra,
            },
            { fallbackToStandalone: true }
          );
          if (issue) {
            createdIds.push(issue.id);
            taskIdMap.set(task.index, issue.id);

            if (feedbackSourceTaskId) {
              try {
                await this.taskStore.addDependency(
                  project.id,
                  issue.id,
                  feedbackSourceTaskId,
                  "discovered-from"
                );
              } catch (depErr) {
                log.error("Failed to add discovered-from", { taskId: issue.id, err: depErr });
              }
            }
          }
        } catch (err) {
          log.error("Failed to create task", { title: task.title, err });
        }
      }

      for (const task of sorted) {
        const childId = taskIdMap.get(task.index);
        const deps = task.depends_on ?? [];
        if (childId) {
          for (const depIdx of deps) {
            const parentId = taskIdMap.get(depIdx);
            if (parentId) {
              try {
                await this.taskStore.addDependency(project.id, childId, parentId);
              } catch (depErr) {
                log.error("Failed to add blocks dep", { childId, parentId, err: depErr });
              }
            }
          }
        }
      }
    } else {
      const seenTitles = new Set<string>();
      const uniqueTitles = taskTitles.filter((t) => {
        const key = t.trim().toLowerCase();
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      });
      for (const title of uniqueTitles) {
        try {
          const priority = userPriorityOverride ?? (item.category === "bug" ? 0 : 2);
          const complexity = item.parent_id ? 7 : undefined;
          const taskExtra: Record<string, unknown> = { sourceFeedbackIds: [item.id] };
          if (item.mappedPlanId && planVersionNumberForTasks != null) {
            taskExtra.sourcePlanId = item.mappedPlanId;
            taskExtra.sourcePlanVersionNumber = planVersionNumberForTasks;
          }
          const issue = await this.taskStore.createWithRetry(
            project.id,
            title,
            {
              type: taskType,
              priority,
              parentId: parentEpicId,
              ...(complexity && { complexity }),
              extra: taskExtra,
            },
            { fallbackToStandalone: true }
          );
          if (issue) {
            createdIds.push(issue.id);
            if (feedbackSourceTaskId) {
              try {
                await this.taskStore.addDependency(
                  project.id,
                  issue.id,
                  feedbackSourceTaskId,
                  "discovered-from"
                );
              } catch (depErr) {
                log.error("Failed to add discovered-from", { taskId: issue.id, err: depErr });
              }
            }
          }
        } catch (err) {
          log.error("Failed to create task", { title, err });
        }
      }
    }

    if (createdIds.length > 0 && parentEpicId) {
      try {
        await this.getPlanService().clearReviewedAtIfNewTasksAdded(projectId, parentEpicId);
      } catch (err) {
        log.warn("Could not clear reviewedAt after feedback task creation", {
          projectId,
          epicId: parentEpicId,
          err,
        });
      }
    }
    return createdIds;
  }
}
