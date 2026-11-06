import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CollaborationActiveRun,
  CollaborationOverview,
  CollaborationTask,
  CollaborationTaskContext,
} from "@opensprint/shared";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import type { ProjectService } from "./project.service.js";
import type { StoredTask, TaskStoreService } from "./task-store.service.js";
import { AppError } from "../middleware/error-handler.js";
import { CommandRunError, runCommand } from "../utils/command-runner.js";
import { filterAgentOutput } from "../utils/agent-output-filter.js";
import { redactSecretsForUserDisplay } from "../utils/secret-redaction.js";
import { compactExecutionText, parseTaskLastExecutionSummary } from "./task-execution-summary.js";

const TEXT_LIMIT = 256 * 1024;
const GIT_TIMEOUT_MS = 5_000;
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
  uncertain: boolean;
}

interface ContextDependencies {
  projectService: Pick<ProjectService, "getProject" | "getSettings">;
  taskStore: Pick<TaskStoreService, "show" | "listAll" | "getDb">;
  readExecution: (projectId: string, taskId: string) => CollaborationExecutionSnapshot | null;
  getActiveRun: (projectId: string, taskId: string) => CollaborationActiveRun | null;
}

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

function tailChunks(chunks: readonly string[]): { text: string; truncated: boolean } {
  const kept: string[] = [];
  let remaining = TEXT_LIMIT;
  let truncated = false;
  for (let index = chunks.length - 1; index >= 0; index--) {
    const chunk = chunks[index]!;
    if (chunk.length > remaining) {
      kept.push(chunk.slice(-remaining));
      truncated = true;
      break;
    }
    kept.push(chunk);
    remaining -= chunk.length;
    if (remaining === 0) {
      truncated = index > 0;
      break;
    }
  }
  return { text: kept.reverse().join(""), truncated };
}

async function readOutputTail(filePath: string) {
  const file = await fs.open(filePath, "r");
  try {
    const stat = await file.stat();
    const bytes = Math.min(stat.size, TEXT_LIMIT);
    const buffer = Buffer.alloc(bytes);
    const result = await file.read(buffer, 0, bytes, Math.max(0, stat.size - bytes));
    return {
      text: filterAgentOutput(buffer.subarray(0, result.bytesRead).toString("utf8")),
      truncated: stat.size > bytes,
    };
  } finally {
    await file.close();
  }
}

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
    // `git diff --no-index` returns 1 for an ordinary difference.
    if (
      args.includes("--no-index") &&
      error instanceof CommandRunError &&
      error.exitCode === 1 &&
      !error.timedOut
    ) {
      return { text: error.stdout, truncated: false };
    }
    throw error;
  }
}

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

  constructor(private readonly dependencies: ContextDependencies) {}

  async assertTaskExists(projectId: string, taskId: string): Promise<void> {
    await this.dependencies.projectService.getProject(projectId);
    await this.dependencies.taskStore.show(projectId, taskId);
  }

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

  async getTaskContext(projectId: string, taskId: string): Promise<CollaborationTaskContext> {
    const key = JSON.stringify([projectId, taskId]);
    const pending = this.pendingContexts.get(key);
    if (pending) return pending;
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
      return await read;
    } finally {
      if (this.pendingContexts.get(key) === read) this.pendingContexts.delete(key);
    }
  }

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

    let output = tailChunks(execution.output);
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
      if (!output.text) {
        output = await readOutputTail(
          path.join(worktree, OPENSPRINT_PATHS.active, taskId, OPENSPRINT_PATHS.agentOutputLog)
        ).catch(() => output);
      }
      diff = await this.currentDiff(projectId, worktree);
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
      output: redactSecretsForUserDisplay(output.text),
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

  private async currentDiff(projectId: string, worktree: string) {
    const settings = await this.dependencies.projectService.getSettings(projectId);
    const preferred = settings.worktreeBaseBranch;
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
    if (result.truncated) return result;

    // New source files matter too. Do not use captureUncommittedDiff: that stages and resets files.
    const untracked = await git(
      worktree,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", ...PATHS],
      16_384
    );
    const files = untracked.text.split("\0").filter(Boolean);
    for (const filename of files.slice(0, 32)) {
      if (!shareableDiffPath(filename)) continue;
      const fullPath = path.resolve(worktree, filename);
      const relative = path.relative(worktree, fullPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const stat = await fs.lstat(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const remaining = TEXT_LIMIT - Buffer.byteLength(result.text, "utf8");
      if (remaining <= 0) return { text: result.text, truncated: true };
      const next = await git(
        worktree,
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          process.platform === "win32" ? "NUL" : "/dev/null",
          filename,
        ],
        remaining
      );
      result.text += next.text;
      if (next.truncated) return { text: result.text, truncated: true };
    }
    return { text: result.text, truncated: untracked.truncated || files.length > 32 };
  }

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
    return {
      task,
      activeRun: null,
      output: typeof latest?.output === "string" ? redactSecretsForUserDisplay(latest.output) : "",
      diff: diff.text,
      outputTruncated: Number(latest?.output_length ?? 0) > TEXT_LIMIT,
      diffTruncated: Number(latest?.diff_length ?? 0) > TEXT_LIMIT || diff.truncated,
      source: latest ? "archived" : "none",
      ...(latest ? { sourceAttempt: Number(latest.attempt) } : {}),
      diffRevision: createHash("sha256").update(diff.text).digest("hex"),
    };
  }

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
