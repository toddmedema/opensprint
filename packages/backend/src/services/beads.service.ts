import { exec } from "child_process";
import { promisify } from "util";
import type { TaskType, TaskPriority } from "@opensprint/shared";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // 2MB for large list output

/**
 * Raw shape returned by `bd list --json` / `bd show --json`.
 * Field names use snake_case to match the beads CLI output.
 */
export interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  issue_type: string;
  status: string;
  priority: number;
  assignee?: string | null;
  owner?: string | null;
  labels?: string[];
  created_at: string;
  updated_at: string;
  created_by?: string;
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  [key: string]: unknown;
}

/**
 * Service for interacting with the beads CLI (`bd`).
 * All commands use --json flags for programmatic integration.
 */
export class BeadsService {
  /**
   * Execute a bd command in the context of a project directory.
   * Handles exec errors, timeouts, and surfaces stderr to caller.
   */
  private async exec(
    repoPath: string,
    command: string,
    options?: { timeout?: number },
  ): Promise<string> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    try {
      const { stdout } = await execAsync(`bd ${command}`, {
        cwd: repoPath,
        timeout,
        maxBuffer: MAX_BUFFER_BYTES,
        env: { ...process.env },
      });
      return stdout;
    } catch (error: unknown) {
      const err = error as {
        message: string;
        stderr?: string;
        stdout?: string;
        code?: number;
        killed?: boolean;
        signal?: string;
      };
      if (err.killed && err.signal === 'SIGTERM') {
        throw new Error(
          `Beads command timed out after ${timeout}ms: bd ${command}\n${err.stderr || err.message}`,
        );
      }
      const stderr = err.stderr || err.stdout || err.message;
      throw new Error(`Beads command failed: bd ${command}\n${stderr}`);
    }
  }

  /**
   * Run bd with command and args, return parsed JSON.
   * Use for commands that output JSON (--json flag).
   */
  async runBd(
    repoPath: string,
    command: string,
    args: string[] = [],
    options?: { timeout?: number },
  ): Promise<unknown> {
    const fullCmd = [command, ...args].filter(Boolean).join(' ');
    const stdout = await this.exec(repoPath, fullCmd, options);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    try {
      const jsonStart = trimmed.indexOf('{');
      const arrStart = trimmed.indexOf('[');
      const start =
        jsonStart >= 0 && (arrStart < 0 || jsonStart < arrStart)
          ? jsonStart
          : arrStart;
      if (start >= 0) {
        return JSON.parse(trimmed.slice(start));
      }
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`Failed to parse beads JSON output: ${trimmed.slice(0, 200)}`);
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
    await this.exec(repoPath, "init");
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

  /** Close an issue (bd close returns a JSON array of closed issues, or sometimes empty output) */
  async close(repoPath: string, id: string, reason: string): Promise<BeadsIssue> {
    const stdout = await this.exec(repoPath, `close ${id} --reason "${reason.replace(/"/g, '\\"')}" --json`);
    const arr = this.parseJsonArray(stdout);
    let result = arr[0];
    if (!result) {
      result = await this.show(repoPath, id);
    }
    if ((result.status as string) !== "closed") {
      throw new Error(`Beads close did not persist: issue ${id} still has status "${result.status ?? "undefined"}"`);
    }
    return result;
  }

  /**
   * Get ready tasks (priority-sorted, all blocks deps resolved).
   * bd ready may return tasks whose blockers are in_progress; we only consider
   * a blocks dependency resolved when the blocker status is closed.
   */
  async ready(repoPath: string): Promise<BeadsIssue[]> {
    const stdout = await this.exec(repoPath, "ready --json");
    const rawTasks = this.parseJsonArray(stdout);
    if (rawTasks.length === 0) return [];

    const allIssues = await this.listAll(repoPath);
    const idToStatus = new Map(allIssues.map((i) => [i.id, i.status]));

    const filtered: BeadsIssue[] = [];
    for (const task of rawTasks) {
      const blockers = await this.getBlockers(repoPath, task.id);
      const allBlockersClosed =
        blockers.length === 0 ||
        blockers.every((bid) => idToStatus.get(bid) === "closed");
      if (allBlockersClosed) {
        filtered.push(task);
      }
    }
    return filtered;
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

  /** Show full details of an issue (bd show returns a JSON array) */
  async show(repoPath: string, id: string): Promise<BeadsIssue> {
    const stdout = await this.exec(repoPath, `show ${id} --json`);
    const arr = this.parseJsonArray(stdout);
    const first = arr[0];
    if (first) return first;
    throw new Error(`Issue ${id} not found`);
  }

  /**
   * Check whether all blocks dependencies for a task are closed.
   * Used as a pre-flight guard before claiming a task.
   */
  async areAllBlockersClosed(repoPath: string, taskId: string): Promise<boolean> {
    const blockers = await this.getBlockers(repoPath, taskId);
    if (blockers.length === 0) return true;
    const allIssues = await this.listAll(repoPath);
    const idToStatus = new Map(allIssues.map((i) => [i.id, i.status]));
    return blockers.every((bid) => idToStatus.get(bid) === "closed");
  }

  /** Get IDs of issues that block this one (this task depends on them) */
  async getBlockers(repoPath: string, id: string): Promise<string[]> {
    try {
      const issue = await this.show(repoPath, id);
      const deps = (issue.dependencies as Array<{ id?: string; issue_id?: string; depends_on_id?: string; type?: string; dependency_type?: string }>) ?? [];
      return deps
        .filter((d) => (d.type ?? d.dependency_type) === "blocks")
        .map((d) => d.depends_on_id ?? d.issue_id ?? d.id ?? "")
        .filter((x): x is string => !!x);
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
    await this.exec(repoPath, "sync");
  }
}
