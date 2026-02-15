import { exec } from "child_process";
import { promisify } from "util";
import type { TaskType, TaskPriority } from "@opensprint/shared";

const execAsync = promisify(exec);

export interface BeadsIssue {
  id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  priority: number;
  assignee: string | null;
  labels: string[];
  [key: string]: unknown;
}

/**
 * Service for interacting with the beads CLI (`bd`).
 * All commands use --json flags for programmatic integration.
 */
export class BeadsService {
  /**
   * Execute a bd command in the context of a project directory.
   */
  private async exec(repoPath: string, command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`bd ${command}`, {
        cwd: repoPath,
        timeout: 30000,
        env: { ...process.env },
      });
      return stdout;
    } catch (error: unknown) {
      const err = error as { message: string; stderr?: string; code?: number };
      throw new Error(`Beads command failed: bd ${command}\n${err.stderr || err.message}`);
    }
  }

  private parseJson(stdout: string): BeadsIssue {
    try {
      return JSON.parse(stdout.trim());
    } catch {
      const jsonStart = stdout.indexOf("{");
      if (jsonStart >= 0) {
        return JSON.parse(stdout.slice(jsonStart));
      }
      throw new Error(`Failed to parse beads JSON output: ${stdout}`);
    }
  }

  private parseJsonArray(stdout: string): BeadsIssue[] {
    try {
      const parsed = JSON.parse(stdout.trim());
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      const jsonStart = stdout.indexOf("[");
      if (jsonStart >= 0) {
        return JSON.parse(stdout.slice(jsonStart));
      }
      if (stdout.trim() === "" || stdout.trim() === "[]") {
        return [];
      }
      throw new Error(`Failed to parse beads JSON array output: ${stdout}`);
    }
  }

  /** Initialize beads in a project repository */
  async init(repoPath: string): Promise<void> {
    await execAsync("bd init", { cwd: repoPath });
  }

  /** Create a new issue */
  async create(
    repoPath: string,
    title: string,
    options: {
      type?: TaskType | string;
      priority?: TaskPriority | number;
      description?: string;
      parentId?: string;
    } = {},
  ): Promise<BeadsIssue> {
    let cmd = `create "${title}" --json`;
    if (options.type) cmd += ` -t ${options.type}`;
    if (options.priority !== undefined) cmd += ` -p ${options.priority}`;
    if (options.description) cmd += ` -d "${options.description.replace(/"/g, '\\"')}"`;
    if (options.parentId) cmd += ` --parent ${options.parentId}`;
    const stdout = await this.exec(repoPath, cmd);
    return this.parseJson(stdout);
  }

  /** Update an issue */
  async update(
    repoPath: string,
    id: string,
    options: {
      status?: string;
      assignee?: string;
      description?: string;
      priority?: number;
      claim?: boolean;
    } = {},
  ): Promise<BeadsIssue> {
    let cmd = `update ${id} --json`;
    if (options.status) cmd += ` --status ${options.status}`;
    if (options.assignee) cmd += ` --assignee "${options.assignee}"`;
    if (options.description) cmd += ` -d "${options.description.replace(/"/g, '\\"')}"`;
    if (options.priority !== undefined) cmd += ` -p ${options.priority}`;
    if (options.claim) cmd += ` --claim`;
    const stdout = await this.exec(repoPath, cmd);
    return this.parseJson(stdout);
  }

  /** Close an issue */
  async close(repoPath: string, id: string, reason: string): Promise<BeadsIssue> {
    const stdout = await this.exec(repoPath, `close ${id} --reason "${reason.replace(/"/g, '\\"')}" --json`);
    return this.parseJson(stdout);
  }

  /** Get ready tasks (priority-sorted, all deps resolved) */
  async ready(repoPath: string): Promise<BeadsIssue[]> {
    const stdout = await this.exec(repoPath, "ready --json");
    return this.parseJsonArray(stdout);
  }

  /** List all issues (open + in_progress by default) */
  async list(repoPath: string): Promise<BeadsIssue[]> {
    const stdout = await this.exec(repoPath, "list --json");
    return this.parseJsonArray(stdout);
  }

  /** List all issues including closed (for kanban column computation) */
  async listAll(repoPath: string): Promise<BeadsIssue[]> {
    const stdout = await this.exec(repoPath, "list --all --json --limit 0");
    return this.parseJsonArray(stdout);
  }

  /** Show full details of an issue */
  async show(repoPath: string, id: string): Promise<BeadsIssue> {
    const stdout = await this.exec(repoPath, `show ${id} --json`);
    return this.parseJson(stdout);
  }

  /** Get IDs of issues that block this one (this task depends on them) */
  async getBlockers(repoPath: string, id: string): Promise<string[]> {
    try {
      const issue = await this.show(repoPath, id);
      const deps = (issue.dependencies as Array<{ issue_id: string; depends_on_id: string; type: string }>) ?? [];
      return deps.filter((d) => d.type === "blocks").map((d) => d.depends_on_id);
    } catch {
      return [];
    }
  }

  /** Derive parent ID from task ID (e.g. bd-a3f8.1 -> bd-a3f8, opensprint.dev-nl2 -> opensprint.dev) */
  getParentId(taskId: string): string | null {
    const lastDot = taskId.lastIndexOf(".");
    if (lastDot <= 0) return null;
    return taskId.slice(0, lastDot);
  }

  /** Add a dependency between issues */
  async addDependency(repoPath: string, childId: string, parentId: string, type?: string): Promise<void> {
    let cmd = `dep add ${childId} ${parentId} --json`;
    if (type) cmd += ` --type ${type}`;
    await this.exec(repoPath, cmd);
  }

  /** Get the dependency tree */
  async depTree(repoPath: string, id: string): Promise<string> {
    return this.exec(repoPath, `dep tree ${id}`);
  }

  /** Delete an issue */
  async delete(repoPath: string, id: string): Promise<void> {
    await this.exec(repoPath, `delete ${id} --force --json`);
  }

  /** Sync beads with git */
  async sync(repoPath: string): Promise<void> {
    await execAsync("bd sync", { cwd: repoPath });
  }
}
