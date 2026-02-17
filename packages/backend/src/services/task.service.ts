import path from "path";
import type { Task, AgentSession, KanbanColumn, TaskDependency } from "@opensprint/shared";
import { resolveTestCommand } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { BeadsService } from "./beads.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { SessionManager } from "./session-manager.js";
import { orchestratorService } from "./orchestrator.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { ContextAssembler } from "./context-assembler.js";
import { BranchManager } from "./branch-manager.js";
import type { BeadsIssue } from "./beads.service.js";

export class TaskService {
  private projectService = new ProjectService();
  private beads = new BeadsService();
  private sessionManager = new SessionManager();
  private contextAssembler = new ContextAssembler();
  private branchManager = new BranchManager();

  /** List all tasks for a project with computed kanban columns and test results */
  async listTasks(projectId: string): Promise<Task[]> {
    const project = await this.projectService.getProject(projectId);
    const [allIssues, readyIssues] = await Promise.all([
      this.beads.listAll(project.repoPath),
      this.beads.ready(project.repoPath),
    ]);
    // Exclude epics from ready — they are containers, not work items
    const readyIds = new Set(readyIssues.filter((i) => (i.issue_type ?? i.type) !== "epic").map((i) => i.id));
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));

    const tasks = allIssues.map((issue) => this.beadsIssueToTask(issue, readyIds, idToIssue));
    await this.enrichTasksWithTestResults(project.repoPath, tasks);

    // Override kanban column for current task when orchestrator phase is review (PRD §7.3.2)
    const buildStatus = await orchestratorService.getStatus(projectId);
    if (buildStatus.currentTask && buildStatus.currentPhase === "review") {
      const currentTask = tasks.find((t) => t.id === buildStatus.currentTask);
      if (currentTask && currentTask.kanbanColumn === "in_progress") {
        currentTask.kanbanColumn = "in_review";
      }
    }
    return tasks;
  }

  /** Get ready tasks (wraps bd ready --json). Excludes epics — they are containers, not work items. */
  async getReadyTasks(projectId: string): Promise<Task[]> {
    const project = await this.projectService.getProject(projectId);
    const [readyIssues, allIssues] = await Promise.all([
      this.beads.ready(project.repoPath),
      this.beads.listAll(project.repoPath),
    ]);
    const nonEpicReady = readyIssues.filter((i) => (i.issue_type ?? i.type) !== "epic");
    const readyIds = new Set(nonEpicReady.map((i) => i.id));
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    return nonEpicReady.map((issue) => this.beadsIssueToTask(issue, readyIds, idToIssue));
  }

  /** Get a single task with full details (wraps bd show --json) */
  async getTask(projectId: string, taskId: string): Promise<Task> {
    const project = await this.projectService.getProject(projectId);
    const [issue, allIssues, readyIssues] = await Promise.all([
      this.beads.show(project.repoPath, taskId),
      this.beads.listAll(project.repoPath),
      this.beads.ready(project.repoPath),
    ]);
    const readyIds = new Set(readyIssues.filter((i) => (i.issue_type ?? i.type) !== "epic").map((i) => i.id));
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    return this.beadsIssueToTask(issue, readyIds, idToIssue);
  }

  /**
   * Normalize beads dependency format. bd list uses { depends_on_id, type }; bd show uses { id, dependency_type }.
   */
  private normalizeDependency(d: Record<string, unknown>): { targetId: string; type: string } | null {
    const targetId = (d.depends_on_id ?? d.id) as string | undefined;
    const type = (d.type ?? d.dependency_type) as string | undefined;
    if (!targetId || !type) return null;
    return { targetId, type };
  }

  /** Transform beads issue to Task with computed kanbanColumn */
  private beadsIssueToTask(issue: BeadsIssue, readyIds: Set<string>, idToIssue: Map<string, BeadsIssue>): Task {
    const id = issue.id ?? "";
    const kanbanColumn = this.computeKanbanColumn(issue, readyIds, idToIssue);
    const rawDeps = (issue.dependencies as Array<Record<string, unknown>>) ?? [];
    const dependencies = rawDeps
      .map((d) => this.normalizeDependency(d))
      .filter((x): x is { targetId: string; type: string } => x != null)
      .map(({ targetId, type }) => ({ targetId, type: type as TaskDependency["type"] }));
    const epicId = this.extractEpicId(issue.id);

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
    };
  }

  private computeKanbanColumn(
    issue: BeadsIssue,
    readyIds: Set<string>,
    idToIssue: Map<string, BeadsIssue>,
  ): KanbanColumn {
    const status = (issue.status as string) ?? "open";

    if (status === "closed") return "done";
    if (status === "blocked") return "blocked";
    if (status === "in_progress" && issue.assignee) return "in_progress";

    // status === 'open'
    const rawDeps = (issue.dependencies as Array<Record<string, unknown>>) ?? [];
    const blocksDeps = rawDeps
      .map((d) => this.normalizeDependency(d))
      .filter((x): x is { targetId: string; type: string } => x != null && x.type === "blocks");

    for (const d of blocksDeps) {
      const depIssue = idToIssue.get(d.targetId);
      if (!depIssue || (depIssue.status as string) !== "open") continue;
      // Gate: .0 convention or "Plan approval gate" (beads may use .1 for first child)
      const isGate = /\.0$/.test(d.targetId) || depIssue.title === "Plan approval gate";
      if (isGate) return "planning";
      return "backlog";
    }

    return readyIds.has(issue.id) ? "ready" : "backlog";
  }

  private extractEpicId(id: string | undefined | null): string | null {
    if (id == null || typeof id !== "string") return null;
    const lastDot = id.lastIndexOf(".");
    if (lastDot <= 0) return null;
    return id.slice(0, lastDot);
  }

  private normalizeType(t: string | undefined): Task["type"] {
    const valid: Task["type"][] = ["bug", "feature", "task", "epic", "chore"];
    return (valid.includes(t as Task["type"]) ? t : "task") as Task["type"];
  }

  /** Enrich tasks with latest test results from agent sessions (PRD §8.3) */
  private async enrichTasksWithTestResults(repoPath: string, tasks: Task[]): Promise<void> {
    await Promise.all(
      tasks.map(async (task) => {
        const sessions = await this.sessionManager.listSessions(repoPath, task.id);
        const latest = sessions[sessions.length - 1];
        if (latest?.testResults) {
          task.testResults = latest.testResults;
        }
      }),
    );
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
      throw new AppError(404, ErrorCodes.SESSION_NOT_FOUND, `Session ${taskId}-${attempt} not found`, {
        taskId,
        attempt,
      });
    }
    return session;
  }

  /**
   * Unblock a task (PRD §7.3.2, §9.1).
   * Sets beads status back to open. Optionally resets attempts label.
   */
  async unblock(
    projectId: string,
    taskId: string,
    options?: { resetAttempts?: boolean },
  ): Promise<{ taskUnblocked: boolean }> {
    const project = await this.projectService.getProject(projectId);
    const issue = await this.beads.show(project.repoPath, taskId);
    const status = (issue.status as string) ?? "open";

    if (status !== "blocked") {
      return { taskUnblocked: false };
    }

    await this.beads.update(project.repoPath, taskId, { status: "open" });

    if (options?.resetAttempts) {
      const labels = (issue.labels ?? []) as string[];
      const attemptsLabel = labels.find((l) => /^attempts:\d+$/.test(l));
      if (attemptsLabel) {
        await this.beads.removeLabel(project.repoPath, taskId, attemptsLabel);
      }
    }

    await this.beads.sync(project.repoPath);
    broadcastToProject(projectId, {
      type: "task.updated",
      taskId,
      status: "open",
      assignee: null,
    });

    return { taskUnblocked: true };
  }

  /** Manually mark a task as done. If it was the last task in its epic, closes the epic too. */
  async markDone(projectId: string, taskId: string): Promise<{ taskClosed: boolean; epicClosed?: boolean }> {
    const project = await this.projectService.getProject(projectId);
    const issue = await this.beads.show(project.repoPath, taskId);
    const status = (issue.status as string) ?? "open";

    if (status === "closed") {
      return { taskClosed: false };
    }

    await this.beads.close(project.repoPath, taskId, "Manually marked done", true);
    await this.beads.sync(project.repoPath);
    broadcastToProject(projectId, {
      type: "task.updated",
      taskId,
      status: "closed",
      assignee: null,
    });

    const epicId = this.extractEpicId(taskId);
    let epicClosed = false;

    if (epicId) {
      const allIssues = await this.beads.listAll(project.repoPath);
      const implTasks = allIssues.filter(
        (i) => i.id.startsWith(epicId + ".") && !i.id.endsWith(".0") && (i.issue_type ?? i.type) !== "epic",
      );
      const allClosed = implTasks.every((i) => (i.status as string) === "closed");

      if (allClosed) {
        const epicIssue = allIssues.find((i) => i.id === epicId);
        if (epicIssue && (epicIssue.status as string) !== "closed") {
          await this.beads.close(project.repoPath, epicId, "All tasks done", true);
          await this.beads.sync(project.repoPath);
          broadcastToProject(projectId, {
            type: "task.updated",
            taskId: epicId,
            status: "closed",
            assignee: null,
          });
          epicClosed = true;
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
    options: { phase?: "coding" | "review"; createBranch?: boolean; attempt?: number } = {},
  ): Promise<string> {
    const { phase = "coding", createBranch = true, attempt = 1 } = options;
    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;
    const settings = await this.projectService.getSettings(projectId);

    const issue = await this.beads.show(repoPath, taskId);
    const branchName = `opensprint/${taskId}`;

    if (createBranch) {
      await this.branchManager.createOrCheckoutBranch(repoPath, branchName);
    }

    const prdExcerpt = await this.contextAssembler.extractPrdExcerpt(repoPath);
    const planContent =
      (await this.contextAssembler.getPlanContentForTask(repoPath, issue, this.beads)) ||
      '# Plan\n\nNo plan content available.';
    const blockerIds = await this.beads.getBlockers(repoPath, taskId);
    const dependencyOutputs = await this.contextAssembler.collectDependencyOutputs(repoPath, blockerIds);

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
