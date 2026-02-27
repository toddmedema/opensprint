import fs from "fs/promises";
import path from "path";
import type { Task, AgentSession, KanbanColumn, TaskDependency, TaskComplexity } from "@opensprint/shared";
import { resolveTestCommand } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { SessionManager } from "./session-manager.js";
import { orchestratorService } from "./orchestrator.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { triggerDeploy } from "./deploy-trigger.service.js";
import { ContextAssembler } from "./context-assembler.js";
import { BranchManager } from "./branch-manager.js";
import { FeedbackService } from "./feedback.service.js";
import type { StoredTask } from "./task-store.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("task");

export class TaskService {
  private projectService = new ProjectService();
  private taskStore = taskStoreSingleton;
  private feedbackService = new FeedbackService();
  private sessionManager = new SessionManager();
  private contextAssembler = new ContextAssembler();
  private branchManager = new BranchManager();

  /** List all tasks for a project with computed kanban columns and test results.
   * Uses task store for listAll.
   * When limit/offset provided, returns paginated slice (items + total).
   */
  async listTasks(
    projectId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<Task[] | { items: Task[]; total: number }> {
    const project = await this.projectService.getProject(projectId);

    const allIssues = await this.taskStore.listAll(projectId);
    const readyIds = this.computeReadyIdsFromListAll(allIssues);
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));

    const tasks = allIssues
      .map((issue) => this.storedTaskToTask(issue, readyIds, idToIssue))
      .filter((t) => t.type !== "chore");
    await this.enrichTasksWithTestResults(project.repoPath, tasks);

    // Override kanban column for active review tasks (PRD §7.3.2)
    const buildStatus = await orchestratorService.getStatus(projectId);
    for (const active of buildStatus.activeTasks) {
      if (active.phase === "review") {
        const reviewTask = tasks.find((t) => t.id === active.taskId);
        if (reviewTask && reviewTask.kanbanColumn === "in_progress") {
          reviewTask.kanbanColumn = "in_review";
        }
      }
    }

    if (options?.limit != null && options?.offset != null) {
      const offset = Math.max(0, options.offset);
      const limit = Math.max(1, Math.min(500, options.limit));
      const items = tasks.slice(offset, offset + limit);
      return { items, total: tasks.length };
    }

    return tasks;
  }

  /** Get ready tasks. Computes ready from listAll (excludes epics — they are containers, not work items). */
  async getReadyTasks(projectId: string): Promise<Task[]> {
    await this.projectService.getProject(projectId);
    const allIssues = await this.taskStore.listAll(projectId);
    const readyIds = this.computeReadyIdsFromListAll(allIssues);
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    const readyIssues = allIssues.filter((i) => readyIds.has(i.id ?? ""));
    return readyIssues.map((issue) => this.storedTaskToTask(issue, readyIds, idToIssue));
  }

  /** Add a dependency from childTaskId to parentTaskId (child depends on parent). */
  async addDependency(
    projectId: string,
    childTaskId: string,
    parentTaskId: string,
    type: "blocks" | "related" | "parent-child" = "blocks"
  ): Promise<void> {
    await this.projectService.getProject(projectId);
    await this.taskStore.addDependency(projectId, childTaskId, parentTaskId, type);
  }

  /** Get a single task with full details. */
  async getTask(projectId: string, taskId: string): Promise<Task> {
    await this.projectService.getProject(projectId);

    const allIssues = await this.taskStore.listAll(projectId);
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    let issue = idToIssue.get(taskId);

    if (!issue) {
      try {
        issue = await this.taskStore.show(projectId, taskId);
        idToIssue.set(taskId, issue);
      } catch {
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Issue ${taskId} not found`, {
          issueId: taskId,
        });
      }
    }

    const readyIds = this.computeReadyForSingleTask(issue, idToIssue);
    return this.storedTaskToTask(issue, readyIds, idToIssue);
  }

  /**
   * Compute ready IDs for all tasks from listAll data.
   * Avoids ready() overhead when only checking a single task.
   * A task is ready iff: status=open, not epic, all blocks dependencies closed.
   */
  private computeReadyIdsFromListAll(allIssues: StoredTask[]): Set<string> {
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    const readyIds = new Set<string>();
    for (const issue of allIssues) {
      const single = this.computeReadyForSingleTask(issue, idToIssue);
      if (single.size > 0) readyIds.add(issue.id ?? "");
    }
    return readyIds;
  }

  /** Compute whether this task is ready. */
  private computeReadyForSingleTask(
    issue: StoredTask,
    idToIssue: Map<string, StoredTask>
  ): Set<string> {
    const status = (issue.status as string) ?? "open";
    if (status !== "open") return new Set();
    if ((issue.issue_type ?? issue.type) === "epic") return new Set();

    // Tasks in blocked epic are not ready
    const epicId = this.extractEpicId(issue.id, idToIssue);
    if (epicId) {
      const epic = idToIssue.get(epicId);
      if (epic && (epic.status as string) === "blocked") return new Set();
    }

    const rawDeps = (issue.dependencies as Array<Record<string, unknown>>) ?? [];
    const blocksDeps = rawDeps
      .map((d) => this.normalizeDependency(d))
      .filter((x): x is { targetId: string; type: string } => x != null && x.type === "blocks");

    const allBlockersClosed = blocksDeps.every((d) => {
      const dep = idToIssue.get(d.targetId);
      return dep && (dep.status as string) === "closed";
    });
    return allBlockersClosed ? new Set([issue.id ?? ""]) : new Set();
  }

  /**
   * Normalize dependency format from stored task to TaskDependency.
   */
  private normalizeDependency(
    d: Record<string, unknown>
  ): { targetId: string; type: string } | null {
    const targetId = (d.depends_on_id ?? d.id) as string | undefined;
    const type = (d.type ?? d.dependency_type) as string | undefined;
    if (!targetId || !type) return null;
    return { targetId, type };
  }

  /** Extract feedback ID from "Feedback ID: xxx" pattern (feedback source task description) */
  private extractFeedbackIdFromDescription(desc: string | undefined | null): string | null {
    if (!desc || typeof desc !== "string") return null;
    const m = desc.trim().match(/^Feedback ID:\s*(.+)$/);
    return m ? m[1].trim() : null;
  }

  /** Transform stored task to Task with computed kanbanColumn */
  private storedTaskToTask(
    issue: StoredTask,
    readyIds: Set<string>,
    idToIssue: Map<string, StoredTask>
  ): Task {
    const id = issue.id ?? "";
    const kanbanColumn = this.computeKanbanColumn(issue, readyIds, idToIssue);
    const rawDeps = (issue.dependencies as Array<Record<string, unknown>>) ?? [];
    const dependencies = rawDeps
      .map((d) => this.normalizeDependency(d))
      .filter((x): x is { targetId: string; type: string } => x != null)
      .map(({ targetId, type }) => ({ targetId, type: type as TaskDependency["type"] }));
    const epicId = this.extractEpicId(issue.id, idToIssue);

    // Resolve sourceFeedbackIds: prefer extra.sourceFeedbackIds when present (hydrateTask spreads extra);
    // else derive from description ("Feedback ID: xxx") or discovered-from dependencies; return as array.
    let sourceFeedbackIds: string[] | undefined;
    const storedIds = (issue as { sourceFeedbackIds?: string[] }).sourceFeedbackIds;
    if (Array.isArray(storedIds) && storedIds.length > 0) {
      sourceFeedbackIds = storedIds;
    } else {
      const derived: string[] = [];
      const ownDesc = this.extractFeedbackIdFromDescription(issue.description as string);
      if (ownDesc) {
        derived.push(ownDesc);
      } else {
        const discoveredFromDeps = dependencies.filter((d) => d.type === "discovered-from");
        for (const dep of discoveredFromDeps) {
          const targetIssue = idToIssue.get(dep.targetId);
          const targetDesc = this.extractFeedbackIdFromDescription(
            targetIssue?.description as string
          );
          if (targetDesc && !derived.includes(targetDesc)) derived.push(targetDesc);
        }
      }
      if (derived.length > 0) sourceFeedbackIds = derived;
    }

    const raw = (issue as { complexity?: string }).complexity;
    const taskComplexity: TaskComplexity | undefined =
      raw === "simple" || raw === "complex"
        ? raw
        : raw === "low"
          ? "simple"
          : raw === "high"
            ? "complex"
            : undefined;

    const blockReason =
      (issue as { block_reason?: string | null }).block_reason ?? null;

    return {
      id,
      title: issue.title ?? "",
      description: (issue.description as string) ?? "",
      type: this.normalizeType((issue.issue_type ?? issue.type) as string | undefined),
      status: (issue.status as "open" | "in_progress" | "closed") ?? "open",
      priority: Math.min(4, Math.max(0, (issue.priority as number) ?? 1)) as 0 | 1 | 2 | 3 | 4,
      assignee: (issue.assignee as string) ?? null,
      labels: (issue.labels as string[]) ?? [],
      dependencies,
      epicId,
      kanbanColumn,
      createdAt: (issue.created_at as string) ?? "",
      updatedAt: (issue.updated_at as string) ?? "",
      startedAt: (issue.started_at as string) ?? null,
      completedAt: (issue.completed_at as string) ?? null,
      ...(sourceFeedbackIds ? { sourceFeedbackIds } : {}),
      ...(sourceFeedbackIds?.[0] ? { sourceFeedbackId: sourceFeedbackIds[0] } : {}),
      ...(taskComplexity ? { complexity: taskComplexity } : {}),
      ...(blockReason ? { blockReason } : {}),
    };
  }

  private computeKanbanColumn(
    issue: StoredTask,
    readyIds: Set<string>,
    idToIssue: Map<string, StoredTask>
  ): KanbanColumn {
    const status = (issue.status as string) ?? "open";

    if (status === "closed") return "done";
    if (status === "blocked") return "blocked";
    if (status === "in_progress" && issue.assignee) return "in_progress";

    // Tasks in blocked epic show "planning"
    const epicId = this.extractEpicId(issue.id, idToIssue);
    if (epicId) {
      const epic = idToIssue.get(epicId);
      if (epic && (epic.status as string) === "blocked") return "planning";
    }

    const rawDeps = (issue.dependencies as Array<Record<string, unknown>>) ?? [];
    const blocksDeps = rawDeps
      .map((d) => this.normalizeDependency(d))
      .filter((x): x is { targetId: string; type: string } => x != null && x.type === "blocks");

    for (const d of blocksDeps) {
      const depIssue = idToIssue.get(d.targetId);
      if (!depIssue || (depIssue.status as string) !== "open") continue;
      return "backlog";
    }

    return readyIds.has(issue.id) ? "ready" : "backlog";
  }

  /** Walk up parent chain to find epic (epic-blocked model: no gate). */
  private extractEpicId(id: string | undefined | null, idToIssue?: Map<string, StoredTask>): string | null {
    if (id == null || typeof id !== "string") return null;
    const lastDot = id.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const parentId = id.slice(0, lastDot);
    if (!idToIssue) return parentId;
    const parent = idToIssue.get(parentId);
    if (parent && (parent.issue_type ?? parent.type) === "epic") return parentId;
    return this.extractEpicId(parentId, idToIssue);
  }

  private normalizeType(t: string | undefined): Task["type"] {
    const valid: Task["type"][] = ["bug", "feature", "task", "epic", "chore"];
    return (valid.includes(t as Task["type"]) ? t : "task") as Task["type"];
  }

  /** Enrich tasks with latest test results from agent sessions (PRD §8.3). Uses single readdir. */
  private async enrichTasksWithTestResults(repoPath: string, tasks: Task[]): Promise<void> {
    const sessionsByTask = await this.sessionManager.loadSessionsGroupedByTaskId(repoPath);
    for (const task of tasks) {
      const sessions = sessionsByTask.get(task.id);
      const latest = sessions?.[sessions.length - 1];
      if (latest?.testResults) {
        task.testResults = latest.testResults;
      }
    }
  }

  /** Get all agent sessions for a task */
  async getTaskSessions(projectId: string, taskId: string): Promise<AgentSession[]> {
    const project = await this.projectService.getProject(projectId);
    return this.sessionManager.listSessions(project.repoPath, taskId);
  }

  /** Get a specific agent session for a task */
  async getTaskSession(projectId: string, taskId: string, attempt: number): Promise<AgentSession> {
    const project = await this.projectService.getProject(projectId);
    const session = await this.sessionManager.readSession(project.repoPath, taskId, attempt);
    if (!session) {
      throw new AppError(
        404,
        ErrorCodes.SESSION_NOT_FOUND,
        `Session ${taskId}-${attempt} not found`,
        {
          taskId,
          attempt,
        }
      );
    }
    return session;
  }

  /**
   * Unblock a task (PRD §7.3.2, §9.1).
   * Sets task status back to open. Optionally resets attempts label.
   * Performs full cleanup so the next agent starts from a fresh copy of main:
   * - Stops any running agent and frees slot
   * - Removes worktree (worktree mode) or branch (branches mode)
   * - Deletes task branch so agent gets clean main checkout
   * - Deletes .opensprint/active/<task-id>/ (assignment, prompt, config, etc.)
   */
  async unblock(
    projectId: string,
    taskId: string,
    options?: { resetAttempts?: boolean }
  ): Promise<{ taskUnblocked: boolean }> {
    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;
    const issue = await this.taskStore.show(projectId, taskId);
    const status = (issue.status as string) ?? "open";

    if (status !== "blocked") {
      return { taskUnblocked: false };
    }

    // 1. Stop any running agent and free slot (removes worktree in worktree mode)
    try {
      await orchestratorService.stopTaskAndFreeSlot(projectId, taskId);
    } catch (err) {
      log.warn("Stop-agent-on-unblock failed, continuing cleanup", {
        projectId,
        taskId,
        err,
      });
    }

    // 2. Remove worktree if task was not in slot (e.g. blocked from prior run)
    const settings = await this.projectService.getSettings(projectId);
    const gitWorkingMode = settings.gitWorkingMode ?? "worktree";
    if (gitWorkingMode !== "branches") {
      const worktrees = await this.branchManager.listTaskWorktrees(repoPath);
      const found = worktrees.find((w) => w.taskId === taskId);
      if (found) {
        try {
          await this.branchManager.removeTaskWorktree(repoPath, taskId, found.worktreePath);
        } catch (err) {
          log.warn("Remove-worktree-on-unblock failed", { taskId, err });
        }
      }
    }

    // 3. Delete task branch so next agent starts from fresh main
    const branchName = `opensprint/${taskId}`;
    try {
      await this.branchManager.revertAndReturnToMain(repoPath, branchName);
    } catch (err) {
      log.warn("Revert-branch-on-unblock failed (branch may not exist)", {
        taskId,
        branchName,
        err,
      });
    }

    // 4. Delete .opensprint/active/<task-id>/ (assignment, prompt, config, result, etc.)
    const activeDir = this.sessionManager.getActiveDir(repoPath, taskId);
    try {
      await fs.rm(activeDir, { recursive: true, force: true });
    } catch (err) {
      log.warn("Delete-active-dir-on-unblock failed", { taskId, activeDir, err });
    }

    await this.taskStore.update(projectId, taskId, { status: "open", block_reason: null });

    if (options?.resetAttempts) {
      const labels = (issue.labels ?? []) as string[];
      const attemptsLabel = labels.find((l) => /^attempts:\d+$/.test(l));
      if (attemptsLabel) {
        await this.taskStore.removeLabel(projectId, taskId, attemptsLabel);
      }
    }

    broadcastToProject(projectId, {
      type: "task.updated",
      taskId,
      status: "open",
      assignee: null,
      blockReason: null,
    });

    return { taskUnblocked: true };
  }

  /** Update a task's priority (0–4). */
  async updatePriority(projectId: string, taskId: string, priority: number): Promise<Task> {
    if (priority < 0 || priority > 4) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Priority must be 0–4");
    }
    await this.projectService.getProject(projectId);
    await this.taskStore.update(projectId, taskId, { priority });
    const task = await this.getTask(projectId, taskId);
    broadcastToProject(projectId, {
      type: "task.updated",
      taskId,
      status: task.status,
      assignee: task.assignee,
      priority: task.priority,
    });
    return task;
  }

  /** Manually mark a task as done. If it was the last task in its epic, closes the epic too. */
  async markDone(
    projectId: string,
    taskId: string
  ): Promise<{ taskClosed: boolean; epicClosed?: boolean }> {
    await this.projectService.getProject(projectId);
    const issue = await this.taskStore.show(projectId, taskId);
    const status = (issue.status as string) ?? "open";

    if (status === "closed") {
      return { taskClosed: false };
    }

    // If an agent is actively working on this task, kill it and nudge the orchestrator to pick new work.
    // Best-effort: if this throws (e.g. cleanup), we still close the task below.
    try {
      await orchestratorService.stopTaskAndFreeSlot(projectId, taskId);
    } catch (err) {
      log.warn("Stop-agent-on-mark-done failed, continuing to close task", {
        projectId,
        taskId,
        err,
      });
    }

    await this.taskStore.close(projectId, taskId, "Manually marked done", true);
    broadcastToProject(projectId, {
      type: "task.updated",
      taskId,
      status: "closed",
      assignee: null,
    });

    // PRD §10.2: Auto-resolve feedback when all its created tasks are Done
    this.feedbackService.checkAutoResolveOnTaskDone(projectId, taskId).catch((err) => {
      log.warn("Auto-resolve feedback on task done failed", { taskId, err });
    });

    const allIssues = await this.taskStore.listAll(projectId);
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    const epicId = this.extractEpicId(taskId, idToIssue);
    let epicClosed = false;

    if (epicId) {
      const implTasks = allIssues.filter(
        (i) =>
          i.id.startsWith(epicId + ".") &&
          (i.issue_type ?? i.type) !== "epic"
      );
      const allClosed = implTasks.every((i) => (i.status as string) === "closed");

      if (allClosed) {
        const epicIssue = allIssues.find((i) => i.id === epicId);
        if (epicIssue && (epicIssue.status as string) !== "closed") {
          await this.taskStore.close(projectId, epicId, "All tasks done", true);
          broadcastToProject(projectId, {
            type: "task.updated",
            taskId: epicId,
            status: "closed",
            assignee: null,
          });
          epicClosed = true;

          // PRD §7.5.3: Auto-deploy on epic completion when user manually marks last task done
          const settings = await this.projectService.getSettings(projectId);
          if (settings.deployment.autoDeployOnEpicCompletion) {
            triggerDeploy(projectId).catch((err) => {
              log.warn("Auto-deploy on epic completion failed", { projectId, err });
            });
          }
        }
      }
    }

    return { taskClosed: true, epicClosed };
  }

  /**
   * Prepare the task directory at .opensprint/active/<task-id>/ with prompt.md, config.json,
   * and context/ (prd_excerpt.md, plan.md, deps/). Creates the task branch if createBranch is true.
   * Returns the absolute path to the task directory.
   */
  async prepareTaskDirectory(
    projectId: string,
    taskId: string,
    options: { phase?: "coding" | "review"; createBranch?: boolean; attempt?: number } = {}
  ): Promise<string> {
    const { phase = "coding", createBranch = true, attempt = 1 } = options;
    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;
    const settings = await this.projectService.getSettings(projectId);

    const issue = await this.taskStore.show(projectId, taskId);
    const branchName = `opensprint/${taskId}`;

    if (createBranch) {
      await this.branchManager.createOrCheckoutBranch(repoPath, branchName);
    }

    const prdExcerpt = await this.contextAssembler.extractPrdExcerpt(repoPath);
    const planContent =
      (await this.contextAssembler.getPlanContentForTask(
        projectId,
        repoPath,
        issue,
        this.taskStore
      )) || "# Plan\n\nNo plan content available.";
    const blockerIds = this.taskStore.getBlockersFromIssue(issue);
    const dependencyOutputs = await this.contextAssembler.collectDependencyOutputs(
      repoPath,
      blockerIds
    );

    const config = {
      invocation_id: taskId,
      agent_role: (phase === "review" ? "reviewer" : "coder") as "reviewer" | "coder",
      taskId,
      repoPath,
      branch: branchName,
      testCommand: resolveTestCommand(settings) || 'echo "No test command configured"',
      attempt,
      phase,
      previousFailure: null as string | null,
      reviewFeedback: null as string | null,
    };

    const taskDir = await this.contextAssembler.assembleTaskDirectory(repoPath, taskId, config, {
      taskId,
      title: issue.title ?? "",
      description: (issue.description as string) ?? "",
      planContent,
      prdExcerpt,
      dependencyOutputs,
    });

    return path.resolve(taskDir);
  }
}
