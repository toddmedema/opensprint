import path from "path";
import type { TaskStoreService, StoredTask } from "./task-store.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("file-scope-analyzer");

export interface FileScope {
  taskId: string;
  files: Set<string>;
  directories: Set<string>;
  confidence: "explicit" | "inferred" | "heuristic";
}

/**
 * Predicts and records the file scope of tasks for conflict-aware scheduling.
 * Uses a layered approach:
 * 1. Conflict labels from prior failed merge attempts
 * 2. Current task actual_files from prior attempts
 * 3. Explicit: `files:` label from Planner output
 * 4. Inferred: `actual_files:` labels from completed dependency tasks
 * 5. Heuristic: directory guesses from task title/description
 */
export class FileScopeAnalyzer {
  /**
   * Predict file scope for a task using available metadata.
   * Returns a FileScope with confidence level indicating the source.
   * When idToIssue is provided (e.g. from listAll), avoids extra show() calls for blockers.
   */
  async predict(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    taskStore: TaskStoreService,
    options?: { idToIssue?: Map<string, StoredTask> }
  ): Promise<FileScope> {
    const scope: FileScope = {
      taskId: task.id,
      files: new Set(),
      directories: new Set(),
      confidence: "heuristic",
    };

    // Layer 1: conflict files from prior failed merge attempts
    const conflictFiles = this.getArrayLabel(task, "conflict_files:");
    if (conflictFiles.length > 0) {
      for (const f of conflictFiles) {
        scope.files.add(f);
        scope.directories.add(path.dirname(f));
      }
      scope.confidence = "explicit";
      return scope;
    }

    // Layer 2: current task actual files from prior attempts
    const actualFiles = this.getArrayLabel(task, "actual_files:");
    if (actualFiles.length > 0) {
      for (const f of actualFiles) {
        scope.files.add(f);
        scope.directories.add(path.dirname(f));
      }
      scope.confidence = "explicit";
      return scope;
    }

    // Layer 3: Explicit file scope from Planner annotations
    const filesLabel = this.getFileScopeLabel(task);
    if (filesLabel) {
      try {
        const parsed = JSON.parse(filesLabel) as {
          modify?: string[];
          create?: string[];
          test?: string[];
        };
        const allFiles = [
          ...(parsed.modify ?? []),
          ...(parsed.create ?? []),
          ...(parsed.test ?? []),
        ];
        for (const f of allFiles) {
          scope.files.add(f);
          scope.directories.add(path.dirname(f));
        }
        if (scope.files.size > 0) {
          scope.confidence = "explicit";
          return scope;
        }
      } catch {
        log.warn("Failed to parse files label", { taskId: task.id });
      }
    }

    // Layer 4: Inferred from dependency tasks' actual files
    const depFiles = await this.inferFromDependencies(
      projectId,
      repoPath,
      task,
      taskStore,
      options?.idToIssue
    );
    if (depFiles.size > 0) {
      scope.files = depFiles;
      for (const f of depFiles) {
        scope.directories.add(path.dirname(f));
      }
      scope.confidence = "inferred";
      return scope;
    }

    // Layer 5: Heuristic from task title/description
    const heuristicDirs = this.extractDirectoriesFromText(
      `${task.title ?? ""} ${task.description ?? ""}`
    );
    scope.directories = heuristicDirs;
    scope.confidence = "heuristic";
    return scope;
  }

  /**
   * Record actual files changed by a task after completion.
   * Stores as `actual_files:<json>` label for future inference.
   */
  async recordActual(
    projectId: string,
    repoPath: string,
    taskId: string,
    changedFiles: string[],
    taskStore: TaskStoreService
  ): Promise<void> {
    if (changedFiles.length === 0) return;
    try {
      await taskStore.setActualFiles(projectId, taskId, changedFiles);
    } catch (err) {
      log.warn("Failed to record actual files", { taskId, err });
    }
  }

  /**
   * Check whether two file scopes overlap.
   * For explicit/inferred scopes: file-set intersection.
   * For heuristic scopes: directory containment.
   */
  overlaps(a: FileScope, b: FileScope): boolean {
    // File-level overlap
    for (const f of a.files) {
      if (b.files.has(f)) return true;
    }

    // Directory-level overlap (at least one scope is heuristic)
    if (a.confidence === "heuristic" || b.confidence === "heuristic") {
      for (const dirA of a.directories) {
        for (const dirB of b.directories) {
          if (dirA === dirB || dirA.startsWith(dirB + "/") || dirB.startsWith(dirA + "/")) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /** Extract `files:` label value from a task */
  private getFileScopeLabel(task: StoredTask): string | null {
    const labels = (task.labels ?? []) as string[];
    const prefix = "files:";
    const label = labels.find((l) => l.startsWith(prefix));
    return label ? label.slice(prefix.length) : null;
  }

  private getArrayLabel(task: StoredTask, prefix: string): string[] {
    const labels = (task.labels ?? []) as string[];
    const label = labels.find((l) => l.startsWith(prefix));
    if (!label) return [];
    try {
      const parsed = JSON.parse(label.slice(prefix.length));
      return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
    } catch {
      return [];
    }
  }

  /** Look at completed dependency tasks for actual_files labels. When idToIssue is provided, avoids show() calls. */
  private async inferFromDependencies(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    taskStore: TaskStoreService,
    idToIssue?: Map<string, StoredTask>
  ): Promise<Set<string>> {
    const files = new Set<string>();

    try {
      const blockers = idToIssue
        ? taskStore.getBlockersFromIssue(task)
        : await taskStore.getBlockers(projectId, task.id);
      for (const blockerId of blockers) {
        try {
          const blocker = idToIssue?.get(blockerId) ?? (await taskStore.show(projectId, blockerId));
          const actualLabel = ((blocker.labels ?? []) as string[]).find((l: string) =>
            l.startsWith("actual_files:")
          );
          if (actualLabel) {
            const parsed = JSON.parse(actualLabel.slice("actual_files:".length)) as string[];
            for (const f of parsed) files.add(f);
          }
        } catch {
          // Blocker might not exist or have invalid labels
        }
      }
    } catch {
      // No blockers or getBlockers not available
    }

    return files;
  }

  /**
   * Extract likely directory paths from text using common patterns.
   * Looks for paths like "src/components", "packages/backend/src", etc.
   */
  private extractDirectoriesFromText(text: string): Set<string> {
    const dirs = new Set<string>();
    const pathPattern =
      /(?:^|\s)((?:src|lib|packages|app|components|services|utils|pages|routes|api|test|__tests__)(?:\/[a-zA-Z0-9_.-]+)*)/g;
    let match;
    while ((match = pathPattern.exec(text)) !== null) {
      dirs.add(match[1]);
    }
    return dirs;
  }
}
