import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CollaborationActiveRun,
  CollaborationOverview,
  CollaborationTask,
  CollaborationTaskContext,
} from "@opensprint/shared";
import type { ProjectService } from "./project.service.js";
import type { StoredTask, TaskStoreService } from "./task-store.service.js";
import { AppError } from "../middleware/error-handler.js";
import { CommandRunError, runCommand } from "../utils/command-runner.js";
import { redactSecretsForUserDisplay } from "../utils/secret-redaction.js";
import { compactExecutionText, parseTaskLastExecutionSummary } from "./task-execution-summary.js";

const TEXT_LIMIT = 256 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const DIFF_CACHE_TTL_MS = 3_000;
const MAX_CACHED_DIFFS = 32;
const PATHS = [
  ".",
  ":(exclude).opensprint",
  ":(exclude)**/.opensprint",
  ":(exclude)**/.opensprint/**",
  ":(exclude)**/node_modules",
  ":(exclude)**/node_modules/**",
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)**/.env",
  ":(exclude)**/.env.*",
];

/** One policy for active and historical patches. Metadata never authorizes filesystem access. */
function shareableDiffPath(filename: string): boolean {
  if (
    !filename ||
    /[\s"\\]/.test(filename) ||
    Array.from(filename).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    filename.startsWith("/") ||
    /^[A-Za-z]:/.test(filename)
  )
    return false;
  return !filename
    .split("/")
    // Case-insensitive filesystems can resolve .ENV to .env. Compatibility
    // normalization also closes ambiguous Unicode spellings before policy checks.
    .map((part) => part.normalize("NFKC").toLowerCase())
    .some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part === ".git" ||
        part === ".opensprint" ||
        part === "node_modules" ||
        part === ".env" ||
        part.startsWith(".env.")
    );
}

/**
 * Accept ordinary, unambiguous Git text-patch sections only. Quoted paths, binary/combined
 * patches and unknown metadata are omitted rather than guessed. This is path filtering
 * plus the application's known credential patterns, not arbitrary secret detection.
 */
function sharedDiff(raw: string): { text: string; truncated: boolean } {
  const sections = raw.split(/(?=^diff )/m);
  const kept: string[] = [];
  for (const section of sections) {
    const lines = section.split("\n");
    const header = /^diff --git a\/([^\s"\\]+) b\/([^\s"\\]+)$/.exec(lines[0] ?? "");
    if (!header || !shareableDiffPath(header[1]!) || !shareableDiffPath(header[2]!)) continue;
    const before = header[1]!;
    const after = header[2]!;
    let hunks = false;
    let valid = true;
    for (const line of lines.slice(1)) {
      if (!line) continue;
      if (/^(?:GIT binary patch|Binary files |diff )/.test(line)) {
        valid = false;
        break;
      }
      if (line.startsWith("@@ ")) {
        if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
          valid = false;
          break;
        }
        hunks = true;
        continue;
      }
      if (hunks) {
        if (!/^[- +]/.test(line) && line !== "\\ No newline at end of file") {
          valid = false;
          break;
        }
        continue;
      }
      if (line.startsWith("--- ")) {
        if (line !== `--- a/${before}` && line !== "--- /dev/null") {
          valid = false;
          break;
        }
      } else if (line.startsWith("+++ ")) {
        if (line !== `+++ b/${after}` && line !== "+++ /dev/null") {
          valid = false;
          break;
        }
      } else if (/^(?:rename|copy) (?:from|to) /.test(line)) {
        const rename = /^(?:rename|copy) (from|to) (.+)$/.exec(line)!;
        if (
          !shareableDiffPath(rename[2]!) ||
          rename[2] !== (rename[1] === "from" ? before : after)
        ) {
          valid = false;
          break;
        }
      } else if (
        !/^(?:index [a-f0-9]+\.\.[a-f0-9]+(?: \d{6})?|(?:old|new|deleted file|new file) mode \d{6}|(?:dis)?similarity index \d{1,3}%)$/.test(
          line
        )
      ) {
        valid = false;
        break;
      }
    }
    if (valid) kept.push(section);
  }
  const text = redactSecretsForUserDisplay(kept.join(""));
  const bytes = Buffer.from(text, "utf8");
  return {
    text:
      bytes.length > TEXT_LIMIT
        ? new TextDecoder().decode(bytes.subarray(0, TEXT_LIMIT), { stream: true })
        : text,
    truncated: bytes.length > TEXT_LIMIT,
  };
}

/** Server-owned attempt snapshot. Caller-provided filesystem paths are never accepted. */
export interface CollaborationExecutionSnapshot {
  attemptId: string;
  attempt: number;
  branchName: string;
  worktreePath: string | null;
  output: readonly string[];
  /** The runner evicted an earlier prefix; its first retained line is not independently safe. */
  outputTruncated?: boolean;
  /** Recovered output is tailed from mutable checkout files and is not a trusted sharing source. */
  outputFromFile?: boolean;
  uncertain: boolean;
}

interface ContextDependencies {
  projectService: Pick<ProjectService, "getProject" | "getSettings">;
  taskStore: Pick<TaskStoreService, "show" | "listAll" | "getDb">;
  readExecution: (projectId: string, taskId: string) => CollaborationExecutionSnapshot | null;
  getActiveRun: (projectId: string, taskId: string) => CollaborationActiveRun | null;
}

/** Project only the task catch-up fields shared with authenticated collaborators. */
function taskSummary(task: StoredTask, questions: string[] = []): CollaborationTask {
  const summary = parseTaskLastExecutionSummary(task.last_execution_summary)?.summary;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updated_at,
    completedAt: task.completed_at ?? null,
    ...(summary ? { summary: compactExecutionText(summary, 500) } : {}),
    questions,
  };
}

/**
 * Omit the first unknown record of a bounded tail, including a possible
 * whitespace-separated assignment/header value. Known redactors accept newlines
 * between prefixes, separators and values, so a broken prefix can span lines.
 */
function omitPartialOutputRecord(text: string): string {
  const boundary = text.indexOf("\n");
  if (boundary < 0) return "";
  const leading = text.slice(0, boundary);
  const rest = text.slice(boundary + 1);
  const leadingWord = leading.trim().toLowerCase();
  const mayContinue = !leadingWord || /[=:]\s*$/.test(leading) || "bearer".endsWith(leadingWord);
  if (/^\s*[=:]/.test(rest)) {
    // The missing name may be followed by whitespace before its separator.
    // Consume that separator, blank lines and the first nonblank value line.
    return rest.replace(/^\s*[=:]\s*[^\r\n]*(?:\r?\n|$)/, "");
  }
  return mayContinue ? rest.replace(/^\s*[^\r\n]*(?:\r?\n|$)/, "") : rest;
}

/**
 * Redact the complete available text before limiting its display tail. A bounded
 * database tail can begin in a credential value, so discard its first partial
 * line rather than displaying text whose missing prefix cannot be inspected.
 */
function sharedOutputTail(
  text: string,
  missingPrefix = false
): { text: string; truncated: boolean } {
  // Match complete prefixes even when a credential value follows on another
  // line. Removing that prefix first would defeat whitespace-aware redactors.
  let redacted = redactSecretsForUserDisplay(text);
  if (missingPrefix) redacted = omitPartialOutputRecord(redacted);
  const bytes = Buffer.from(redacted, "utf8");
  let start = Math.max(0, bytes.length - TEXT_LIMIT);
  // Start on a complete UTF-8 code point so replacement characters cannot grow
  // the returned byte count beyond the response budget.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return {
    text: start > 0 ? bytes.subarray(start).toString("utf8") : redacted,
    truncated: missingPrefix || bytes.length > TEXT_LIMIT,
  };
}

/** Bound Git process output/time without changing the checkout or index. */
async function git(cwd: string, args: string[], limit = TEXT_LIMIT) {
  try {
    const result = await runCommand(
      { command: "git", args: ["--no-pager", "-c", "core.fsmonitor=false", ...args] },
      { cwd, timeout: GIT_TIMEOUT_MS, maxStdoutBytes: limit, maxStderrBytes: 8_192 }
    );
    return { text: result.stdout, truncated: false };
  } catch (error) {
    if (
      error instanceof CommandRunError &&
      error.message.startsWith("Command output exceeded limit:")
    ) {
      return { text: error.stdout, truncated: true };
    }
    throw error;
  }
}

/** Reject results when execution ownership or the checkout changed during asynchronous IO. */
function assertSameAttempt(
  before: CollaborationExecutionSnapshot,
  after: CollaborationExecutionSnapshot | null
) {
  if (
    !after ||
    before.attemptId !== after.attemptId ||
    before.attempt !== after.attempt ||
    before.worktreePath !== after.worktreePath ||
    before.branchName !== after.branchName ||
    after.uncertain
  ) {
    throw new AppError(
      409,
      "AGENT_ATTEMPT_CHANGED",
      "The active attempt changed. Refresh before inspecting or guiding this task."
    );
  }
}

/** Read-only project projection; it cannot stage files, launch agents, or mutate execution state. */
export class CollaborationTaskContextService {
  private readonly pendingContexts = new Map<string, Promise<CollaborationTaskContext>>();
  private readonly cachedDiffs = new Map<
    string,
    { expiresAt: number; value: { text: string; truncated: boolean } }
  >();

  constructor(private readonly dependencies: ContextDependencies) {}

  /** Check project and task membership before any task-scoped collaboration action. */
  async assertTaskExists(projectId: string, taskId: string): Promise<void> {
    await this.dependencies.projectService.getProject(projectId);
    await this.dependencies.taskStore.show(projectId, taskId);
  }

  /** Capture the catch-up boundary before reading task summaries and unresolved questions. */
  async getOverview(projectId: string): Promise<CollaborationOverview> {
    const observedAt = new Date().toISOString();
    const project = await this.dependencies.projectService.getProject(projectId);
    const [tasks, questions] = await Promise.all([
      this.dependencies.taskStore.listAll(projectId),
      this.openQuestions(projectId),
    ]);
    return {
      observedAt,
      projectName: project.name,
      tasks: tasks.map((task) => taskSummary(task, questions.get(task.id))),
    };
  }

  /** Coalesce simultaneous reads and give each caller an independent response object. */
  async getTaskContext(projectId: string, taskId: string): Promise<CollaborationTaskContext> {
    const key = JSON.stringify([projectId, taskId]);
    const pending = this.pendingContexts.get(key);
    if (pending) return structuredClone(await pending);
    if (this.pendingContexts.size >= 32) {
      throw new AppError(
        429,
        "COLLABORATION_BUSY",
        "Many tasks are being inspected. Try again shortly."
      );
    }
    const read = this.loadTaskContext(projectId, taskId);
    this.pendingContexts.set(key, read);
    try {
      return structuredClone(await read);
    } finally {
      if (this.pendingContexts.get(key) === read) this.pendingContexts.delete(key);
    }
  }

  /** Read fresh task/output state and verify the exact checkout before projecting a diff. */
  private async loadTaskContext(
    projectId: string,
    taskId: string
  ): Promise<CollaborationTaskContext> {
    const project = await this.dependencies.projectService.getProject(projectId);
    const task = taskSummary(await this.dependencies.taskStore.show(projectId, taskId));
    const execution = this.dependencies.readExecution(projectId, taskId);
    if (!execution) return this.archivedContext(projectId, task);

    const activeRun = this.dependencies.getActiveRun(projectId, taskId);
    if (execution.uncertain) {
      return {
        task,
        activeRun: null,
        output: "",
        diff: "",
        source: "none",
        unavailableReason:
          "Execution ownership is being verified. Live output and changes are unavailable until verification completes.",
      };
    }
    if (activeRun && activeRun.attemptId !== execution.attemptId) {
      assertSameAttempt(execution, null);
    }

    // The runner already bounds its retained chunks. Join before redaction so a
    // credential split across provider events is never cut into an unrecognizable value.
    const output = execution.outputFromFile
      ? { text: "", truncated: false }
      : sharedOutputTail(execution.output.join(""), execution.outputTruncated);
    let diff = { text: "", truncated: false };
    let unavailableReason: string | undefined;
    try {
      const worktree = await fs.realpath(execution.worktreePath ?? project.repoPath);
      const repo = await fs.realpath(project.repoPath);
      const [repoGit, worktreeGit, branch] = await Promise.all([
        git(repo, ["rev-parse", "--git-common-dir"], 8_192),
        git(worktree, ["rev-parse", "--git-common-dir"], 8_192),
        git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"], 8_192),
      ]);
      const [repoCommon, worktreeCommon] = await Promise.all([
        fs.realpath(path.resolve(repo, repoGit.text.trim())),
        fs.realpath(path.resolve(worktree, worktreeGit.text.trim())),
      ]);
      if (repoCommon !== worktreeCommon || branch.text.trim() !== execution.branchName) {
        throw new Error("Execution checkout no longer matches this project and attempt.");
      }
      assertSameAttempt(execution, this.dependencies.readExecution(projectId, taskId));
      // A checkout is agent writable. Never fall back to its log path: even a
      // previously verified directory can be replaced by a symlink before open.
      // Live output comes from the managed runner; completed output comes from SQL.
      diff = await this.cachedCurrentDiff(projectId, taskId, repo, worktree, execution);
    } catch {
      unavailableReason = "The current checkout or diff could not be verified. Try again shortly.";
    }

    assertSameAttempt(execution, this.dependencies.readExecution(projectId, taskId));
    const currentRun = this.dependencies.getActiveRun(projectId, taskId);
    if (currentRun?.attemptId !== activeRun?.attemptId) assertSameAttempt(execution, null);
    const shared = sharedDiff(diff.text);
    return {
      task,
      activeRun,
      output: output.text,
      diff: shared.text,
      outputTruncated: output.truncated,
      diffTruncated: diff.truncated || shared.truncated,
      source: "active",
      sourceAttemptId: execution.attemptId,
      sourceAttempt: execution.attempt,
      diffRevision: createHash("sha256").update(shared.text).digest("hex"),
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  }

  /**
   * Reuse only expensive diff construction after per-request checkout verification.
   * Task/output/attempt state is never cached. Entries expire promptly, are bounded,
   * and include project, canonical checkout and configured comparison identities.
   */
  private async cachedCurrentDiff(
    projectId: string,
    taskId: string,
    repo: string,
    worktree: string,
    execution: CollaborationExecutionSnapshot
  ): Promise<{ text: string; truncated: boolean }> {
    const settings = await this.dependencies.projectService.getSettings(projectId);
    const preferred = settings.worktreeBaseBranch;
    const key = JSON.stringify([
      projectId,
      taskId,
      repo,
      worktree,
      execution.attemptId,
      execution.attempt,
      execution.branchName,
      preferred,
    ]);
    const now = Date.now();
    for (const [cachedKey, entry] of this.cachedDiffs) {
      if (entry.expiresAt <= now) this.cachedDiffs.delete(cachedKey);
    }
    const cached = this.cachedDiffs.get(key);
    if (cached) return { ...cached.value };
    const value = await this.currentDiff(worktree, preferred);
    if (this.cachedDiffs.size >= MAX_CACHED_DIFFS) {
      this.cachedDiffs.delete(this.cachedDiffs.keys().next().value!);
    }
    this.cachedDiffs.set(key, { expiresAt: Date.now() + DIFF_CACHE_TTL_MS, value: { ...value } });
    return value;
  }

  /**
   * Capture committed, staged and tracked working changes without staging.
   * New files appear only after staging or committing: reopening untracked
   * checkout paths for `--no-index` cannot safely confine mutable parent links.
   */
  private async currentDiff(worktree: string, preferred: string | undefined) {
    let base: string | null = null;
    for (const candidate of [...new Set([preferred, "main", "master"].filter(Boolean))]) {
      try {
        const resolved = await git(
          worktree,
          ["rev-parse", "--verify", `${candidate}^{commit}`],
          128
        );
        if (/^[a-f0-9]{40,64}$/.test(resolved.text.trim())) {
          const mergeBase = await git(worktree, ["merge-base", "HEAD", resolved.text.trim()], 128);
          base = mergeBase.text.trim();
          break;
        }
      } catch {
        // A configured branch may not exist yet; the existing local base is a valid fallback.
      }
    }
    if (!base) throw new Error("No verified local comparison base is available.");
    const result = await git(worktree, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      base,
      "--",
      ...PATHS,
    ]);
    return result;
  }

  /** Read the latest bounded, project-scoped SQL archive and omit an unsafe leading partial line. */
  private async archivedContext(
    projectId: string,
    task: CollaborationTask
  ): Promise<CollaborationTaskContext> {
    const db = await this.dependencies.taskStore.getDb();
    const latest = await db.queryOne(
      `SELECT attempt,
        SUBSTR(output_log, CASE WHEN LENGTH(output_log) > $3 THEN LENGTH(output_log) - $3 + 1 ELSE 1 END, $3) AS output,
        SUBSTR(git_diff, 1, $3) AS diff,
        LENGTH(output_log) AS output_length, LENGTH(git_diff) AS diff_length
       FROM agent_sessions WHERE project_id = $1 AND task_id = $2
       ORDER BY attempt DESC, id DESC LIMIT 1`,
      [projectId, task.id, TEXT_LIMIT]
    );
    if (this.dependencies.readExecution(projectId, task.id)) {
      throw new AppError(409, "AGENT_ATTEMPT_CHANGED", "A new attempt started. Refresh this task.");
    }
    const diff = sharedDiff(typeof latest?.diff === "string" ? latest.diff : "");
    const output = sharedOutputTail(
      typeof latest?.output === "string" ? latest.output : "",
      Number(latest?.output_length ?? 0) > TEXT_LIMIT
    );
    return {
      task,
      activeRun: null,
      output: output.text,
      diff: diff.text,
      outputTruncated: output.truncated,
      diffTruncated: Number(latest?.diff_length ?? 0) > TEXT_LIMIT || diff.truncated,
      source: latest ? "archived" : "none",
      ...(latest ? { sourceAttempt: Number(latest.attempt) } : {}),
      diffRevision: createHash("sha256").update(diff.text).digest("hex"),
    };
  }

  /** Read bounded unresolved Execute questions and ignore malformed legacy rows. */
  private async openQuestions(projectId: string): Promise<Map<string, string[]>> {
    const db = await this.dependencies.taskStore.getDb();
    const rows = await db.query(
      `SELECT source_id, questions FROM open_questions
       WHERE project_id = $1 AND source = 'execute' AND status = 'open'
       ORDER BY created_at DESC LIMIT 200`,
      [projectId]
    );
    const result = new Map<string, string[]>();
    for (const row of rows) {
      let questions: unknown;
      try {
        questions = JSON.parse(String(row.questions));
      } catch {
        continue;
      }
      if (!Array.isArray(questions)) continue;
      const strings = questions
        .flatMap((question: unknown) => {
          const text =
            question && typeof question === "object" && "text" in question ? question.text : null;
          return typeof text === "string" && text.trim() ? [compactExecutionText(text, 500)] : [];
        })
        .slice(0, 10);
      const key = String(row.source_id);
      result.set(key, [...(result.get(key) ?? []), ...strings].slice(0, 10));
    }
    return result;
  }
}
