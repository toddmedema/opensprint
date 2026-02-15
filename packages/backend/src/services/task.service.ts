import path from "path";
import type { Task, AgentSession, KanbanColumn, TaskDependency } from "@opensprint/shared";
import { getTestCommandForFramework } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { BeadsService } from "./beads.service.js";
import { SessionManager } from "./session-manager.js";
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
    const readyIds = new Set(readyIssues.map((i) => i.id));
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));

    const tasks = allIssues.map((issue) => this.beadsIssueToTask(issue, readyIds, idToIssue));
    await this.enrichTasksWithTestResults(project.repoPath, tasks);
    return tasks;
  }

  /** Get ready tasks (wraps bd ready --json) */
  async getReadyTasks(projectId: string): Promise<Task[]> {
    const project = await this.projectService.getProject(projectId);
    const [readyIssues, allIssues] = await Promise.all([
      this.beads.ready(project.repoPath),
      this.beads.listAll(project.repoPath),
    ]);
    const readyIds = new Set(readyIssues.map((i) => i.id));
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    return readyIssues.map((issue) => this.beadsIssueToTask(issue, readyIds, idToIssue));
  }

  /** Get a single task (wraps bd show --json) */
  async getTask(projectId: string, taskId: string): Promise<Task> {
    const project = await this.projectService.getProject(projectId);
    const [issue, allIssues, readyIssues] = await Promise.all([
      this.beads.show(project.repoPath, taskId),
      this.beads.listAll(project.repoPath),
      this.beads.ready(project.repoPath),
    ]);
    const readyIds = new Set(readyIssues.map((i) => i.id));
    const idToIssue = new Map(allIssues.map((i) => [i.id, i]));
    return this.beadsIssueToTask(issue, readyIds, idToIssue);
  }

  /** Transform beads issue to Task with computed kanbanColumn */
  private beadsIssueToTask(issue: BeadsIssue, readyIds: Set<string>, idToIssue: Map<string, BeadsIssue>): Task {
    const kanbanColumn = this.computeKanbanColumn(issue, readyIds, idToIssue);
    const deps = (issue.dependencies as Array<{ depends_on_id: string; type: string }>) ?? [];
    const epicId = this.extractEpicId(issue.id);

    return {
      id: issue.id,
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
      // Gate: .0 convention or "Plan approval gate" (beads may use .1 for first child)
      const isGate = /\.0$/.test(d.depends_on_id) || depIssue.title === "Plan approval gate";
      if (isGate) return "planning";
      return "backlog";
    }

    return readyIds.has(issue.id) ? "ready" : "backlog";
  }

  private extractEpicId(id: string): string | null {
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
    const planContent = await this.getPlanContentForTask(repoPath, issue);
    const blockerIds = await this.beads.getBlockers(repoPath, taskId);
    const dependencyOutputs = await this.contextAssembler.collectDependencyOutputs(repoPath, blockerIds);

    const config = {
      taskId,
      repoPath,
      branch: branchName,
      testCommand: getTestCommandForFramework(settings.testFramework) || 'echo "No test command configured"',
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

  private async getPlanContentForTask(repoPath: string, task: BeadsIssue): Promise<string> {
    const parentId = this.beads.getParentId(task.id);
    if (parentId) {
      try {
        const parent = await this.beads.show(repoPath, parentId);
        const desc = parent.description as string;
        if (desc?.startsWith(".opensprint/plans/")) {
          const planId = path.basename(desc, ".md");
          return this.contextAssembler.readPlanContent(repoPath, planId);
        }
      } catch {
        // Parent might not exist
      }
    }
    return "";
  }
}
