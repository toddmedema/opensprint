import type { UnknownScopeStrategy } from "@opensprint/shared";
import type { TaskStoreService, StoredTask } from "./task-store.service.js";
import type { AgentSlot } from "./orchestrator.service.js";
import { FileScopeAnalyzer, type FileScope } from "./file-scope-analyzer.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("task-scheduler");

export interface SchedulerResult {
  task: StoredTask;
  fileScope: FileScope;
}

/**
 * Selects tasks for parallel execution based on priority and file-overlap detection.
 * When maxConcurrentCoders > 1, uses FileScopeAnalyzer to avoid dispatching
 * tasks that modify overlapping files.
 */
export class TaskScheduler {
  private analyzer = new FileScopeAnalyzer();

  constructor(private taskStore: TaskStoreService) {}

  /**
   * Select up to (maxSlots - activeSlots.size) tasks from readyTasks.
   * Filters out epics, blocked tasks, and tasks already in a slot.
   * Performs blocker pre-flight check and file-overlap detection.
   * When options.allIssues is provided, avoids redundant listAll and per-task show calls.
   */
  async selectTasks(
    projectId: string,
    repoPath: string,
    readyTasks: StoredTask[],
    activeSlots: Map<string, AgentSlot>,
    maxSlots: number,
    options?: {
      allIssues?: StoredTask[];
      unknownScopeStrategy?: UnknownScopeStrategy;
    }
  ): Promise<SchedulerResult[]> {
    const slotsAvailable = maxSlots - activeSlots.size;
    if (slotsAvailable <= 0) return [];
    const unknownScopeStrategy = options?.unknownScopeStrategy ?? "conservative";

    const candidates = readyTasks
      .filter((t) => (t.issue_type ?? t.type) !== "epic")
      .filter((t) => (t.status as string) !== "blocked")
      .filter((t) => !activeSlots.has(t.id));

    const statusMap =
      options?.allIssues !== undefined
        ? new Map(options.allIssues.map((i) => [i.id, i.status]))
        : await this.taskStore.getStatusMap(projectId);
    const idToIssue =
      options?.allIssues !== undefined
        ? new Map(options.allIssues.map((i) => [i.id, i]))
        : undefined;

    // Collect active slot scopes for overlap detection (AgentSlot may carry fileScope from scheduler usage)
    const activeScopes: FileScope[] = [];
    for (const slot of activeSlots.values()) {
      const slotWithScope = slot as AgentSlot & { fileScope?: FileScope };
      if (slotWithScope.fileScope) {
        activeScopes.push(slotWithScope.fileScope);
      }
    }

    const results: SchedulerResult[] = [];
    for (const task of candidates) {
      if (results.length >= slotsAvailable) break;

      const allClosed =
        idToIssue !== undefined
          ? (() => {
              const blockers = this.taskStore.getBlockersFromIssue(task);
              return (
                blockers.length === 0 || blockers.every((bid) => statusMap.get(bid) === "closed")
              );
            })()
          : await this.taskStore.areAllBlockersClosed(projectId, task.id, statusMap);
      if (!allClosed) {
        log.info("Skipping task (blockers not all closed)", {
          taskId: task.id,
          title: task.title,
        });
        continue;
      }

      const predictOptions = idToIssue ? { idToIssue } : undefined;
      const scope = await this.analyzer.predict(
        projectId,
        repoPath,
        task,
        this.taskStore,
        predictOptions
      );

      const existingScopes = [...activeScopes, ...results.map((r) => r.fileScope)];
      if (
        maxSlots > 1 &&
        unknownScopeStrategy === "conservative" &&
        scope.confidence === "heuristic" &&
        existingScopes.length > 0
      ) {
        log.info("Skipping task (heuristic scope serialized by conservative strategy)", {
          taskId: task.id,
        });
        continue;
      }

      // File-overlap detection (only when parallel dispatch is active)
      if (maxSlots > 1 && (activeScopes.length > 0 || results.length > 0)) {
        const overlapping = existingScopes.some((s) => this.analyzer.overlaps(scope, s));

        if (overlapping) {
          log.info("Skipping task (file scope overlaps with active/selected)", {
            taskId: task.id,
            confidence: scope.confidence,
          });
          continue;
        }

        results.push({ task, fileScope: scope });
        continue;
      }

      // Single-dispatch or first task: no overlap check needed
      results.push({ task, fileScope: scope });
    }

    return results;
  }
}
