import { exec } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { promisify } from "util";
import type { TaskType, TaskPriority } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // 2MB for large list output

const daemonReady = new Map<string, { promise: Promise<void>; checkedAt: number }>();
const DAEMON_CHECK_INTERVAL_MS = 60_000;
const DAEMON_STALE_THRESHOLD_MS = 5 * 60_000;

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
   * Ensure exactly one bd daemon is running for the given repo.
   * Uses a per-path singleton promise so concurrent callers coalesce
   * rather than each spawning their own daemon.
   */
  async ensureDaemon(repoPath: string): Promise<void> {
    const now = Date.now();

    // Prune entries that haven't been refreshed recently
    for (const [path, entry] of daemonReady) {
      if (now - entry.checkedAt > DAEMON_STALE_THRESHOLD_MS) {
        daemonReady.delete(path);
      }
    }

    const existing = daemonReady.get(repoPath);
    if (existing && now - existing.checkedAt < DAEMON_CHECK_INTERVAL_MS) {
      return existing.promise;
    }

    const promise = this.startDaemonIfNeeded(repoPath).catch((err) => {
      daemonReady.delete(repoPath);
      console.warn("[beads] Daemon startup failed, will retry next call:", (err as Error).message);
    });
    daemonReady.set(repoPath, { promise, checkedAt: now });

    return promise;
  }

  private isDaemonPidAlive(repoPath: string): boolean {
    try {
      const pidFile = path.join(repoPath, ".beads", "daemon.pid");
      if (!existsSync(pidFile)) return false;
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (!pid || isNaN(pid)) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async startDaemonIfNeeded(repoPath: string): Promise<void> {
    if (this.isDaemonPidAlive(repoPath)) return;

    try {
      const { stdout } = await execAsync("bd daemon status --json", {
        cwd: repoPath,
        timeout: 5_000,
        env: { ...process.env },
      });
      const status = JSON.parse(stdout.trim());
      if (status.status === "running") return;
    } catch {
      // status check failed or timed out
    }

    if (this.isDaemonPidAlive(repoPath)) return;

    try {
      await execAsync("bd daemon start", {
        cwd: repoPath,
        timeout: 10_000,
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string; killed?: boolean };
      if (e.killed || this.isDaemonPidAlive(repoPath)) return;
      const msg = e.stderr ?? e.message ?? "";
      if (msg.includes("already running")) return;
      throw new Error(`Failed to start daemon for ${repoPath}: ${msg}`);
    }
  }

  private async syncImport(repoPath: string): Promise<void> {
    try {
      await execAsync("bd sync --import-only", {
        cwd: repoPath,
        timeout: 15_000,
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      console.warn(`[beads] sync --import-only failed for ${repoPath}: ${e.stderr ?? e.message}`);
    }
  }

  private isStaleDbError(stderr: string): boolean {
    return stderr.includes("Database out of sync") || stderr.includes("bd sync --import-only");
  }

  /**
   * Execute a bd command in the context of a project directory.
   * Handles exec errors, timeouts, and surfaces stderr to caller.
   * Ensures a daemon is running before executing.
   * Auto-recovers from stale-database errors by running sync --import-only and retrying once.
   */
  private async exec(
    repoPath: string,
    command: string,
    options?: { timeout?: number }
  ): Promise<string> {
    await this.ensureDaemon(repoPath);

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
      if (err.killed && err.signal === "SIGTERM") {
        throw new AppError(
          504,
          ErrorCodes.BEADS_TIMEOUT,
          `Beads command timed out after ${timeout}ms: bd ${command}\n${err.stderr || err.message}`,
          {
            command: `bd ${command}`,
            timeout,
          }
        );
      }

      const stderr = err.stderr || err.stdout || err.message;
      if (this.isStaleDbError(stderr)) {
        console.warn(`[beads] Stale DB detected for bd ${command}, running sync --import-only`);
        await this.syncImport(repoPath);
        try {
          const { stdout } = await execAsync(`bd ${command}`, {
            cwd: repoPath,
            timeout,
            maxBuffer: MAX_BUFFER_BYTES,
            env: { ...process.env },
          });
          return stdout;
        } catch (retryError: unknown) {
          const retryErr = retryError as { stderr?: string; stdout?: string; message: string };
          const retryStderr = retryErr.stderr || retryErr.stdout || retryErr.message;
          throw new AppError(
            502,
            ErrorCodes.BEADS_COMMAND_FAILED,
            `Beads command failed after sync retry: bd ${command}\n${retryStderr}`,
            {
              command: `bd ${command}`,
              stderr: retryStderr,
            }
          );
        }
      }

      throw new AppError(
        502,
        ErrorCodes.BEADS_COMMAND_FAILED,
        `Beads command failed: bd ${command}\n${stderr}`,
        {
          command: `bd ${command}`,
          stderr,
        }
      );
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
    options?: { timeout?: number }
  ): Promise<unknown> {
    const fullCmd = [command, ...args].filter(Boolean).join(" ");
    const stdout = await this.exec(repoPath, fullCmd, options);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    try {
      const jsonStart = trimmed.indexOf("{");
      const arrStart = trimmed.indexOf("[");
      const start = jsonStart >= 0 && (arrStart < 0 || jsonStart < arrStart) ? jsonStart : arrStart;
      if (start >= 0) {
        return JSON.parse(trimmed.slice(start));
      }
      return JSON.parse(trimmed);
    } catch {
      throw new AppError(
        502,
        ErrorCodes.BEADS_PARSE_FAILED,
        `Failed to parse beads JSON output: ${trimmed.slice(0, 200)}`,
        {
          outputPreview: trimmed.slice(0, 200),
        }
      );
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
      throw new AppError(
        502,
        ErrorCodes.BEADS_PARSE_FAILED,
        `Failed to parse beads JSON output: ${stdout}`,
        {
          outputPreview: stdout.slice(0, 200),
        }
      );
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
      throw new AppError(
        502,
        ErrorCodes.BEADS_PARSE_FAILED,
        `Failed to parse beads JSON array output: ${stdout}`,
        {
          outputPreview: stdout.slice(0, 200),
        }
      );
    }
  }

  /** Initialize beads in a project repository */
  async init(repoPath: string): Promise<void> {
    try {
      await execAsync("bd init", {
        cwd: repoPath,
        timeout: DEFAULT_TIMEOUT_MS,
        env: { ...process.env },
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string; stdout?: string; message: string };
      const msg = err.stderr || err.stdout || err.message;
      if (msg.includes("already initialized")) return;
      throw new AppError(502, ErrorCodes.BEADS_COMMAND_FAILED, `Beads init failed: ${msg}`, {
        command: "bd init",
        stderr: msg,
      });
    }
  }

  /**
   * Configure beads (e.g. auto-flush, auto-commit).
   * Used during project setup to disable auto-commit (PRD §5.9).
   */
  async configSet(repoPath: string, key: string, value: string | boolean): Promise<void> {
    const val = typeof value === "boolean" ? (value ? "true" : "false") : value;
    await this.exec(repoPath, `config set ${key} ${val}`);
  }

  /**
   * Export beads state to JSONL file (PRD §5.9).
   * Orchestrator manages persistence explicitly when auto-commit is disabled.
   */
  async export(repoPath: string, outputPath: string): Promise<void> {
    await this.exec(repoPath, `export -o ${outputPath}`);
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
    } = {}
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
    } = {}
  ): Promise<BeadsIssue> {
    let cmd = `update ${id} --json`;
    if (options.status) cmd += ` --status ${options.status}`;
    if (options.assignee !== undefined) cmd += ` --assignee "${options.assignee}"`;
    if (options.description) cmd += ` -d "${options.description.replace(/"/g, '\\"')}"`;
    if (options.priority !== undefined) cmd += ` -p ${options.priority}`;
    if (options.claim) cmd += ` --claim`;
    const stdout = await this.exec(repoPath, cmd);
    return this.parseJson(stdout);
  }

  /** Close an issue (bd close returns a JSON array of closed issues, or sometimes empty output).
   * @param force - If true, use --force to close even when blocked by open issues (e.g. manual mark done).
   */
  async close(repoPath: string, id: string, reason: string, force = false): Promise<BeadsIssue> {
    let cmd = `close ${id} --reason "${reason.replace(/"/g, '\\"')}" --json`;
    if (force) cmd += " --force";
    const stdout = await this.exec(repoPath, cmd);
    const arr = this.parseJsonArray(stdout);
    let result = arr[0];
    if (!result) {
      result = await this.show(repoPath, id);
    }
    // Beads daemon may have eventual consistency: close persists but verification read can be stale.
    // Retry verification with short delays before failing.
    const maxRetries = 3;
    const delayMs = 150;
    for (
      let attempt = 0;
      attempt < maxRetries && (result.status as string) !== "closed";
      attempt++
    ) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
        result = await this.show(repoPath, id);
      }
    }
    if ((result.status as string) !== "closed") {
      throw new AppError(
        502,
        ErrorCodes.BEADS_CLOSE_FAILED,
        `Beads close did not persist: issue ${id} still has status "${result.status ?? "undefined"}"`,
        {
          issueId: id,
          status: result.status,
        }
      );
    }
    return result;
  }

  /**
   * Get ready tasks (priority-sorted, all blocks deps resolved).
   * bd ready may return tasks whose blockers are in_progress; we only consider
   * a blocks dependency resolved when the blocker status is closed.
   */
  async ready(repoPath: string): Promise<BeadsIssue[]> {
    const stdout = await this.exec(repoPath, "ready --json -n 0");
    const rawTasks = this.parseJsonArray(stdout);
    if (rawTasks.length === 0) return [];

    const allIssues = await this.listAll(repoPath);
    const idToStatus = new Map(allIssues.map((i) => [i.id, i.status]));

    const filtered: BeadsIssue[] = [];
    for (const task of rawTasks) {
      const blockers = await this.getBlockers(repoPath, task.id);
      const allBlockersClosed =
        blockers.length === 0 || blockers.every((bid) => idToStatus.get(bid) === "closed");
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

  /**
   * List in_progress tasks that have an agent assignee (agent-N).
   * Used by orphan recovery to find tasks abandoned when an agent process died.
   */
  async listInProgressWithAgentAssignee(repoPath: string): Promise<BeadsIssue[]> {
    const all = await this.list(repoPath);
    return all.filter(
      (t) =>
        t.status === "in_progress" &&
        typeof t.assignee === "string" &&
        /^agent-\d+$/.test(t.assignee)
    );
  }

  /** Show full details of an issue (bd show returns a JSON array) */
  async show(repoPath: string, id: string): Promise<BeadsIssue> {
    const stdout = await this.exec(repoPath, `show ${id} --json`);
    const arr = this.parseJsonArray(stdout);
    const first = arr[0];
    if (first) return first;
    throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Issue ${id} not found`, { issueId: id });
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
      const deps =
        (issue.dependencies as Array<{
          id?: string;
          issue_id?: string;
          depends_on_id?: string;
          type?: string;
          dependency_type?: string;
        }>) ?? [];
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
  async addDependency(
    repoPath: string,
    childId: string,
    parentId: string,
    type?: string
  ): Promise<void> {
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

  /** Add a comment to an issue */
  async comment(repoPath: string, id: string, message: string): Promise<void> {
    const escaped = message.replace(/"/g, '\\"');
    await this.exec(repoPath, `comment ${id} "${escaped}"`);
  }

  /** Add a label to an issue */
  async addLabel(repoPath: string, id: string, label: string): Promise<void> {
    await this.exec(repoPath, `update ${id} --add-label ${label}`);
  }

  /** Remove a label from an issue */
  async removeLabel(repoPath: string, id: string, label: string): Promise<void> {
    await this.exec(repoPath, `update ${id} --remove-label ${label}`);
  }

  /**
   * Get cumulative attempt count from beads labels (PRDv2 §9.1).
   * Looks for label "attempts:N"; returns 0 if none found.
   */
  async getCumulativeAttempts(repoPath: string, id: string): Promise<number> {
    const issue = await this.show(repoPath, id);
    const labels = (issue.labels ?? []) as string[];
    const attemptsLabel = labels.find((l) => /^attempts:\d+$/.test(l));
    if (!attemptsLabel) return 0;
    const n = parseInt(attemptsLabel.split(":")[1]!, 10);
    return Number.isNaN(n) ? 0 : n;
  }

  /**
   * Set cumulative attempt count via beads labels (PRDv2 §9.1).
   * Removes any existing attempts:X label, adds attempts:count.
   */
  async setCumulativeAttempts(repoPath: string, id: string, count: number): Promise<void> {
    const issue = await this.show(repoPath, id);
    const labels = (issue.labels ?? []) as string[];
    const existingAttempts = labels.find((l) => /^attempts:\d+$/.test(l));
    if (existingAttempts) {
      await this.removeLabel(repoPath, id, existingAttempts);
    }
    await this.addLabel(repoPath, id, `attempts:${count}`);
  }

  /** Check whether an issue has a specific label */
  hasLabel(issue: BeadsIssue, label: string): boolean {
    return Array.isArray(issue.labels) && issue.labels.includes(label);
  }

  /** Sync beads with git */
  async sync(repoPath: string): Promise<void> {
    await this.exec(repoPath, "sync");
  }
}
