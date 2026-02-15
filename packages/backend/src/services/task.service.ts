import type { Task, AgentSession, KanbanColumn, TaskDependency } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { BeadsService } from "./beads.service.js";
import { SessionManager } from "./session-manager.js";
import { orchestratorService } from "./orchestrator.service.js";
import { broadcastToProject } from "../websocket/index.js";
import type { BeadsIssue } from "./beads.service.js";

export class TaskService {
  private projectService = new ProjectService();
  private beads = new BeadsService();
  private sessionManager = new SessionManager();

  /** List all tasks for a project with computed kanban columns and test results */
  async listTasks(projectId: string): Promise<Task[]> {
    const project = await this.projectService.getProject(projectId);
    const [allIssues, readyIssues] = await Promise.all([
      this.beads.listAll(project.repoPath),
      this.beads.ready(project.repoPath),
    ]);
    // Exclude epics from ready — they are containers, not work items
    const readyIds = new Set(
      readyIssues.filter((i) => (i.issue_type ?? i.type) !== 'epic').map((i) => i.id),
    );
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
    const nonEpicReady = readyIssues.filter((i) => (i.issue_type ?? i.type) !== 'epic');
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
    const readyIds = new Set(
      readyIssues.filter((i) => (i.issue_type ?? i.type) !== 'epic').map((i) => i.id),
    );
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    return this.beadsIssueToTask(issue, readyIds, idToIssue);
  }

  /** Transform beads issue to Task with computed kanbanColumn */
  private beadsIssueToTask(issue: BeadsIssue, readyIds: Set<string>, idToIssue: Map<string, BeadsIssue>): Task {
    const id = issue.id ?? "";
    const kanbanColumn = this.computeKanbanColumn(issue, readyIds, idToIssue);
    const deps = (issue.dependencies as Array<{ depends_on_id: string; type: string }>) ?? [];
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
      dependencies: deps.map((d) => ({ targetId: d.depends_on_id, type: d.type as TaskDependency["type"] })),
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
    if (status === "in_progress" && issue.assignee) return "in_progress";

    // status === 'open'
    const deps = (issue.dependencies as Array<{ depends_on_id: string; type: string }>) ?? [];
    const blocksDeps = deps.filter((d) => d.type === "blocks");

    for (const d of blocksDeps) {
      const depIssue = idToIssue.get(d.depends_on_id);
      if (!depIssue || (depIssue.status as string) !== "open") continue;
      const isGate = /\.0$/.test(d.depends_on_id);
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
      throw new Error(`Session ${taskId}-${attempt} not found`);
    }
    return session;
  }

  /** Manually mark a task as complete. If it was the last task in its epic, closes the epic too. */
  async markComplete(projectId: string, taskId: string): Promise<{ taskClosed: boolean; epicClosed?: boolean }> {
    const project = await this.projectService.getProject(projectId);
    const issue = await this.beads.show(project.repoPath, taskId);
    const status = (issue.status as string) ?? "open";

    if (status === "closed") {
      return { taskClosed: false };
    }

    await this.beads.close(project.repoPath, taskId, "Manually marked complete");
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
        (i) =>
          i.id.startsWith(epicId + ".") &&
          !i.id.endsWith(".0") &&
          (i.issue_type ?? i.type) !== "epic",
      );
      const allClosed = implTasks.every((i) => (i.status as string) === "closed");

      if (allClosed) {
        const epicIssue = allIssues.find((i) => i.id === epicId);
        if (epicIssue && (epicIssue.status as string) !== "closed") {
          await this.beads.close(project.repoPath, epicId, "All tasks completed");
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
}
