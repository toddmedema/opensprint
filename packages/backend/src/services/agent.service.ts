import fs from "fs/promises";
import os from "os";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AgentConfig, AgentRole } from "@opensprint/shared";
import { AgentClient } from "./agent-client.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import {
  createAgentApiFailureDetails,
  getErrorMessage,
  isLimitError,
} from "../utils/error-utils.js";
import {
  isOpenAIResponsesModel,
  toOpenAIResponsesInputMessage,
  type OpenAIResponsesInputContent,
  type OpenAIResponsesInputMessage,
} from "../utils/openai-models.js";
import { isProcessAlive, signalProcessGroup } from "../utils/process-group.js";
import { shellExec } from "../utils/shell-exec.js";
import { activeAgentsService } from "./active-agents.service.js";
import {
  getNextKey,
  recordLimitHit,
  clearLimitHit,
  ENV_FALLBACK_KEY_ID,
} from "./api-key-resolver.service.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { taskStore } from "./task-store.service.js";
import { createLogger } from "../utils/logger.js";
import { LOG_DIFF_TRUNCATE_AT_CHARS, truncateToThreshold } from "../utils/log-diff-truncation.js";

const log = createLogger("agent-service");

/** Message for planning agent (user or assistant) */
export interface PlanningMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Optional tracking descriptor — when provided, the agent is automatically
 * registered in activeAgentsService on invocation and unregistered on exit.
 */
export interface AgentTrackingInfo {
  id: string;
  projectId: string;
  phase: string;
  role: AgentRole;
  label: string;
  branchName?: string;
  /** Plan ID when agent is working in plan context (e.g. task generation for a plan) */
  planId?: string;
  /** Feedback ID when Analyst is categorizing a specific feedback item */
  feedbackId?: string;
}

/** Options for invokePlanningAgent */
export interface InvokePlanningAgentOptions {
  /** Project ID (required for Claude API key resolution and retry) */
  projectId: string;
  /** Agent role for agent log (required so every planning run is recorded) */
  role: AgentRole;
  /** Agent configuration (model from config) */
  config: AgentConfig;
  /** Conversation messages in order */
  messages: PlanningMessage[];
  /** Optional system prompt */
  systemPrompt?: string;
  /** Optional image attachments (base64 or data URLs). Claude: inline in message. Cursor/custom: written to temp files and paths appended to prompt. */
  images?: string[];
  /** Working directory for CLI agents (cursor/custom) */
  cwd?: string;
  /** Callback for streaming text chunks */
  onChunk?: (chunk: string) => void;
  /** When provided, auto-registers/unregisters with activeAgentsService */
  tracking?: AgentTrackingInfo;
}

/** Response from planning agent */
export interface PlanningAgentResponse {
  content: string;
}

function buildOpenAIPlanningResponsesInput(
  messages: PlanningMessage[],
  images?: string[]
): OpenAIResponsesInputMessage[] {
  return messages.map((message, index) => {
    const isLastUserMessage = message.role === "user" && index === messages.length - 1;
    const hasImages = isLastUserMessage && images && images.length > 0;
    if (!hasImages) {
      return toOpenAIResponsesInputMessage(message.role, message.content);
    }

    const content: OpenAIResponsesInputContent[] = [{ type: "input_text", text: message.content }];
    for (const image of images) {
      content.push({
        type: "input_image",
        image_url: image.startsWith("data:") ? image : `data:image/png;base64,${image}`,
        detail: "auto",
      });
    }
    return { role: "user", content };
  });
}

async function collectOpenAIResponsesStream(
  stream: AsyncIterable<{ type?: string; delta?: string }>,
  onChunk: (chunk: string) => void
): Promise<string> {
  let fullContent = "";
  for await (const event of stream) {
    if (event.type === "response.output_text.delta" && event.delta) {
      fullContent += event.delta;
      onChunk(event.delta);
    }
  }
  return fullContent;
}

function buildAgentApiFailureMessages(
  agentType: "claude" | "openai",
  kind: "rate_limit" | "auth",
  options?: { allKeysExhausted?: boolean }
): { userMessage: string; notificationMessage: string } {
  const label = agentType === "claude" ? "Claude" : "OpenAI";
  if (kind === "rate_limit") {
    if (options?.allKeysExhausted) {
      return {
        userMessage: `All ${label} API keys have hit rate limits. Add another key in Settings or retry after the limit resets.`,
        notificationMessage: `${label} hit a rate limit. Add another API key in Settings or retry after the limit resets.`,
      };
    }
    return {
      userMessage: `${label} hit a rate limit. Add another key in Settings or retry after the limit resets.`,
      notificationMessage: `${label} hit a rate limit. Add another API key in Settings or retry after the limit resets.`,
    };
  }

  return {
    userMessage: `${label} is not configured correctly. Add a valid API key in Settings and try again.`,
    notificationMessage: `${label} needs a valid API key in Settings before work can continue.`,
  };
}

/** Options for invokeCodingAgent (file-based prompt) */
export interface InvokeCodingAgentOptions {
  /** Working directory for the agent (typically repo path) */
  cwd: string;
  /** Callback for streaming output chunks */
  onOutput: (chunk: string) => void;
  /** Callback when agent process exits */
  onExit: (code: number | null) => void;
  /** Human-readable agent role for logging (e.g. 'coder', 'code reviewer') */
  agentRole?: string;
  /** When provided, auto-registers/unregisters with activeAgentsService */
  tracking?: AgentTrackingInfo;
  /** File path to redirect agent stdout/stderr for crash-resilient output */
  outputLogPath?: string;
  /** Project ID for Cursor: ApiKeyResolver for CURSOR_API_KEY, retry on limit error, clearLimitHit on success */
  projectId?: string;
}

/** Return type for invokeCodingAgent — handle with kill() to terminate */
export interface CodingAgentHandle {
  kill: () => void;
  pid: number | null;
}

export type MergerPhase = "rebase_before_merge" | "merge_to_main" | "push_rebase";

export interface RunMergerAgentOptions {
  projectId: string;
  cwd: string;
  config: AgentConfig;
  phase: MergerPhase;
  taskId: string;
  branchName: string;
  conflictedFiles: string[];
  testCommand?: string;
  mergeQualityGates?: string[];
  /** Base branch for merger prompt context (default: "main") */
  baseBranch?: string;
}

export interface RecordAgentRunOptions {
  projectId: string;
  role: AgentRole;
  config: AgentConfig;
  runId: string;
  startedAt: string;
  completedAt: string;
  outcome: "success" | "failed";
}

type AgentRunStatParams = {
  tracking?: AgentTrackingInfo;
  /** Role for agent log (used when tracking is absent) */
  role?: AgentRole;
  /** Run id for agent_stats task_id (used when tracking is absent) */
  runId?: string;
  config: AgentConfig;
  projectId?: string;
  startedAt: string;
  completedAt: string;
  outcome: "success" | "failed";
};

type MergerSessionRecordParams = {
  runId: string;
  projectId: string;
  config: AgentConfig;
  branchName: string;
  phase: MergerPhase;
  taskId: string;
  startedAt: string;
  completedAt: string;
  outputLog: string;
  outcome: "success" | "failed";
};

/** Create a handle for a detached agent process group after backend restart. */
export function createProcessGroupHandle(processGroupLeaderPid: number): CodingAgentHandle {
  return {
    pid: processGroupLeaderPid,
    kill() {
      try {
        signalProcessGroup(processGroupLeaderPid, "SIGTERM");
      } catch {
        // Process may already be dead
        return;
      }

      const killTimer = setTimeout(() => {
        if (!isProcessAlive(processGroupLeaderPid)) return;
        try {
          signalProcessGroup(processGroupLeaderPid, "SIGKILL");
        } catch {
          // Process may already be dead
        }
      }, 5000);
      killTimer.unref?.();
    },
  };
}

/**
 * AgentService — unified interface for planning and coding agents.
 * invokePlanningAgent uses Claude API when config.type is 'claude';
 * falls back to AgentClient (CLI) for cursor/custom.
 * invokeCodingAgent spawns the coding agent with a file-based prompt.
 */
export class AgentService {
  private agentClient = new AgentClient();
  private static readonly MERGER_MAIN_LOG_LIMIT = 5;
  private static readonly AGENT_STATS_RETENTION = 500;

  /**
   * Invoke the planning agent with messages.
   * Returns full response; optionally streams via onChunk.
   * Claude: uses @anthropic-ai/sdk API. Cursor/custom: delegates to AgentClient (CLI).
   */
  async invokePlanningAgent(options: InvokePlanningAgentOptions): Promise<PlanningAgentResponse> {
    const { tracking } = options;
    const startedAt = new Date().toISOString();
    let outcome: "success" | "failed" = "failed";
    if (tracking) {
      activeAgentsService.register(
        tracking.id,
        tracking.projectId,
        tracking.phase,
        tracking.role,
        tracking.label,
        startedAt,
        tracking.branchName,
        tracking.planId,
        undefined,
        tracking.feedbackId
      );
    }
    try {
      const result = await this._invokePlanningAgentInner(options);
      outcome = "success";
      return result;
    } finally {
      const completedAt = new Date().toISOString();
      await this.recordAgentRunStat({
        tracking,
        role: options.role,
        runId: tracking?.id ?? `planning-${options.projectId}-${startedAt}`,
        config: options.config,
        projectId: options.projectId,
        startedAt,
        completedAt,
        outcome,
      } satisfies AgentRunStatParams);
      if (tracking) activeAgentsService.unregister(tracking.id);
    }
  }

  private async _invokePlanningAgentInner(
    options: InvokePlanningAgentOptions
  ): Promise<PlanningAgentResponse> {
    const { config, messages, systemPrompt, cwd, onChunk, images } = options;

    if (config.type === "claude") {
      return this.invokeClaudePlanningAgent(options);
    }

    if (config.type === "openai") {
      return this.invokeOpenAIPlanningAgent(options);
    }

    // Google, Cursor, and custom: use AgentClient (invokeGoogleApi, CLI-based). Images are written to temp files
    // and paths appended to the prompt so the agent can read them via tool calling.
    const lastUser = messages.filter((m) => m.role === "user").pop();
    let prompt = lastUser?.content ?? "";
    let cleanup: (() => Promise<void>) | null = null;
    if (images && images.length > 0) {
      const { promptSuffix, cleanup: doCleanup } = await this.writeImagesForCli(cwd, images);
      cleanup = doCleanup;
      prompt = prompt + promptSuffix;
    }
    try {
      const conversationHistory = messages.slice(0, -1).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const response = await this.agentClient.invoke({
        config,
        prompt,
        systemPrompt,
        cwd,
        conversationHistory,
        onChunk,
        projectId: options.projectId,
      });
      const content = response?.content ?? "";
      return { content };
    } finally {
      if (cleanup) await cleanup();
    }
  }

  /**
   * Invoke the coding or review agent with a file-based prompt (PRD §12.4).
   * Used for both phases: when phase is "coding", prompt.md contains the task spec;
   * when phase is "review", prompt.md contains the review spec per §12.3.
   * Spawns the agent as a subprocess and streams output.
   * Returns a handle with kill() to terminate the process.
   */
  invokeCodingAgent(
    promptPath: string,
    config: AgentConfig,
    options: InvokeCodingAgentOptions
  ): CodingAgentHandle {
    const { tracking } = options;
    const startedAt = new Date().toISOString();
    if (tracking) {
      activeAgentsService.register(
        tracking.id,
        tracking.projectId,
        tracking.phase,
        tracking.role,
        tracking.label,
        startedAt,
        tracking.branchName,
        tracking.planId,
        undefined,
        tracking.feedbackId
      );
    }

    const originalOnExit = options.onExit;
    const shouldRecordStats =
      tracking != null && tracking.role !== "coder" && tracking.role !== "reviewer";
    const wrappedOnExit =
      tracking || shouldRecordStats
        ? (code: number | null) => {
            if (shouldRecordStats) {
              const completedAt = new Date().toISOString();
              void this.recordAgentRunStat({
                tracking,
                config,
                projectId: tracking?.projectId ?? options.projectId,
                startedAt,
                completedAt,
                outcome: code === 0 ? "success" : "failed",
              } satisfies AgentRunStatParams);
            }
            if (tracking) {
              activeAgentsService.unregister(tracking.id);
            }
            return originalOnExit(code);
          }
        : originalOnExit;

    return this.agentClient.spawnWithTaskFile(
      config,
      promptPath,
      options.cwd,
      options.onOutput,
      wrappedOnExit,
      options.agentRole,
      options.outputLogPath,
      options.projectId
    );
  }

  /**
   * Invoke the review agent with a file-based prompt (PRD §12.3, §12.4).
   * The prompt.md must contain the review spec per §12.3 (generated by ContextAssembler
   * when phase is "review"). Spawns the agent as a subprocess and streams output.
   * Returns a handle with kill() to terminate the process.
   */
  invokeReviewAgent(
    promptPath: string,
    config: AgentConfig,
    options: InvokeCodingAgentOptions
  ): CodingAgentHandle {
    return this.invokeCodingAgent(promptPath, config, {
      ...options,
      agentRole: options.agentRole ?? "code reviewer",
    });
  }

  /**
   * Invoke the merger agent to resolve rebase conflicts.
   * Runs in the main repo directory (not a worktree) where the rebase is in progress.
   */
  invokeMergerAgent(
    promptPath: string,
    config: AgentConfig,
    options: InvokeCodingAgentOptions
  ): CodingAgentHandle {
    return this.invokeCodingAgent(promptPath, config, {
      ...options,
      agentRole: "merger",
    });
  }

  /**
   * Record an agent run for flows that do not invoke an external model but should
   * still appear in Help -> Agent Logs (for example, lightweight analyst reply processing).
   */
  async recordAgentRun(options: RecordAgentRunOptions): Promise<void> {
    await this.recordAgentRunStat({
      role: options.role,
      runId: options.runId,
      config: options.config,
      projectId: options.projectId,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
      outcome: options.outcome,
    } satisfies AgentRunStatParams);
  }

  private async recordAgentRunStat(params: AgentRunStatParams): Promise<void> {
    const {
      tracking,
      role: paramRole,
      runId,
      config,
      projectId,
      startedAt,
      completedAt,
      outcome,
    } = params;
    const targetProjectId = tracking?.projectId ?? projectId;
    const role = tracking?.role ?? paramRole;
    const taskId = tracking?.id ?? runId;
    if (!role || !targetProjectId) return;

    const model = config.model?.trim() ? config.model : "unknown";
    const agentId = `${role}-${config.type}-${config.model ?? "default"}`;
    const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());

    try {
      await taskStore.runWrite(async (client) => {
        await client.execute(
          `INSERT INTO agent_stats (project_id, task_id, agent_id, role, model, attempt, started_at, completed_at, outcome, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            targetProjectId,
            taskId,
            agentId,
            role,
            model,
            1,
            startedAt,
            completedAt,
            outcome,
            durationMs,
          ]
        );
        const countRow = await client.queryOne(
          "SELECT COUNT(*)::int as c FROM agent_stats WHERE project_id = $1",
          [targetProjectId]
        );
        const count = (countRow?.c as number) ?? 0;
        if (count > AgentService.AGENT_STATS_RETENTION) {
          await client.execute(
            `DELETE FROM agent_stats WHERE id IN (
               SELECT id FROM agent_stats WHERE project_id = $1 ORDER BY id ASC LIMIT $2
             )`,
            [targetProjectId, count - AgentService.AGENT_STATS_RETENTION]
          );
        }
      });
    } catch (err) {
      log.warn("Failed to record agent run stat", {
        projectId: targetProjectId,
        role,
        err: getErrorMessage(err),
      });
    }
  }

  private async recordMergerSession(params: MergerSessionRecordParams): Promise<void> {
    const taskLabel = params.taskId.trim() || "(no task id)";
    const fallbackOutput = `[Merger ${params.outcome}] phase=${params.phase} task=${taskLabel} branch=${params.branchName}\n`;
    const outputLog = params.outputLog.trim().length > 0 ? params.outputLog : fallbackOutput;
    const truncatedOutput = truncateToThreshold(outputLog, LOG_DIFF_TRUNCATE_AT_CHARS);
    const failureReason =
      params.outcome === "failed" ? "Merger agent could not resolve conflicts cleanly." : null;
    const summary =
      params.outcome === "success"
        ? `Merger resolved ${params.phase} conflicts for ${taskLabel} on ${params.branchName}.`
        : `Merger failed to resolve ${params.phase} conflicts for ${taskLabel} on ${params.branchName}.`;

    try {
      await taskStore.runWrite(async (client) => {
        await client.execute(
          `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch, git_diff, test_results, failure_reason, summary)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            params.projectId,
            params.runId,
            1,
            params.config.type,
            params.config.model ?? "",
            params.startedAt,
            params.completedAt,
            params.outcome,
            truncatedOutput,
            params.branchName,
            null,
            null,
            failureReason,
            summary,
          ]
        );
      });
    } catch (err) {
      log.warn("Failed to record merger session log", {
        projectId: params.projectId,
        runId: params.runId,
        err: getErrorMessage(err),
      });
    }
  }

  private async buildMergerPrompt(options: RunMergerAgentOptions): Promise<string> {
    const baseBranch = options.baseBranch ?? "main";
    const [agentInstructions, statusShort, diffFilterU, mainLog, branchDiffStat] =
      await Promise.all([
        getCombinedInstructions(options.cwd, "merger"),
        this.captureGitOutput(options.cwd, "git status --short"),
        this.captureGitOutput(options.cwd, "git diff --name-only --diff-filter=U"),
        this.captureGitOutput(
          options.cwd,
          `git log --oneline -${AgentService.MERGER_MAIN_LOG_LIMIT} ${baseBranch}`
        ),
        this.captureGitOutput(options.cwd, `git diff --stat ${baseBranch}...${options.branchName}`),
      ]);

    const conflictedFiles =
      options.conflictedFiles.length > 0 ? options.conflictedFiles.join("\n") : "(none reported)";
    const testCommand = options.testCommand?.trim() ? options.testCommand.trim() : "(not provided)";
    const mergeQualityGates =
      options.mergeQualityGates && options.mergeQualityGates.length > 0
        ? options.mergeQualityGates.map((cmd) => `- ${cmd}`).join("\n")
        : "- (not provided)";

    const basePrompt = `# Merger Agent: Resolve Git Conflicts

You are the Merger agent. Your job is to resolve ${options.phase} conflicts for task ${options.taskId} on branch ${options.branchName}.

## Conflict Context

- Stage: ${options.phase}
- Task ID: ${options.taskId}
- Branch: ${options.branchName}
- Base branch: ${baseBranch}
- Test command: ${testCommand}

### Required quality gates before merge
${mergeQualityGates}

### Conflicted files
${conflictedFiles}

### git status --short
${statusShort || "(no output)"}

### git diff --name-only --diff-filter=U
${diffFilterU || "(no output)"}

### Recent ${baseBranch} commits
${mainLog || "(no output)"}

### Branch diff stat vs ${baseBranch}
${branchDiffStat || "(no output)"}

## Your Task

1. Resolve every unmerged file and stage the resolved files.
2. Prefer preserving both sides when they are compatible.
3. Keep the branch compatible with the required quality gates above.
4. Verify there are no remaining conflict markers or unmerged paths.

## Rules

- Do NOT run \`git rebase --continue\`, \`git commit\`, or \`git merge --continue\`.
- Resolve conflicts by editing files; do not delete files unless that is clearly correct.
- Do NOT run destructive cleanup commands such as \`rm -rf\`, \`find ... -delete\`, or \`git clean -fdx\`.
- Run \`git diff --check\` before exiting.
- Exit with code 0 only when all conflicted files are resolved and staged.
- Exit non-zero if you cannot produce a correct resolution.
`;
    if (agentInstructions.trim()) {
      return `${agentInstructions}\n\n${basePrompt}`;
    }
    return basePrompt;
  }

  private async captureGitOutput(cwd: string, command: string): Promise<string> {
    try {
      const { stdout } = await shellExec(command, { cwd, timeout: 10_000 });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  private async verifyMergerResult(cwd: string): Promise<boolean> {
    const unmerged = await this.captureGitOutput(cwd, "git diff --name-only --diff-filter=U");
    if (unmerged.trim().length > 0) {
      return false;
    }
    try {
      await shellExec("git diff --check", { cwd, timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run the merger agent and wait for it to complete.
   * Returns true if the agent exited with code 0 (success), false otherwise.
   * Used when merge/rebase fails with conflicts — the agent resolves them;
   * the caller then runs rebase --continue or merge --continue.
   */
  async runMergerAgentAndWait(options: RunMergerAgentOptions): Promise<boolean> {
    const runId = `merger-${options.projectId}-${options.taskId || "push"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    const outputChunks: string[] = [];
    const promptPath = path.join(
      os.tmpdir(),
      `opensprint-merger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
    );
    await fs.writeFile(promptPath, await this.buildMergerPrompt(options));
    try {
      const exitedCleanly = await new Promise<boolean>((resolve) => {
        this.invokeMergerAgent(promptPath, options.config, {
          cwd: options.cwd,
          onOutput: (chunk) => outputChunks.push(chunk),
          onExit: (code) => resolve(code === 0),
          projectId: options.projectId,
          tracking: {
            id: runId,
            projectId: options.projectId,
            phase: "execute",
            role: "merger",
            label: "Merger conflict resolution",
            branchName: options.branchName,
          },
        });
      });
      const verified = exitedCleanly ? await this.verifyMergerResult(options.cwd) : false;
      const completedAt = new Date().toISOString();
      await this.recordMergerSession({
        runId,
        projectId: options.projectId,
        config: options.config,
        branchName: options.branchName,
        phase: options.phase,
        taskId: options.taskId,
        startedAt,
        completedAt,
        outputLog: outputChunks.join(""),
        outcome: verified ? "success" : "failed",
      });
      return verified;
    } finally {
      await fs.unlink(promptPath).catch(() => {});
    }
  }

  /**
   * Parse data URL or base64 string to { media_type, data } for Anthropic image blocks.
   */
  private parseImageForClaude(img: string): {
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  } {
    const VALID = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
    if (img.startsWith("data:")) {
      const match = img.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const mt = match[1].toLowerCase();
        const media_type = VALID.includes(mt as (typeof VALID)[number])
          ? (mt as (typeof VALID)[number])
          : "image/png";
        return { media_type, data: match[2] };
      }
    }
    return { media_type: "image/png", data: img };
  }

  /** Extension from MIME type for writing CLI image files */
  private static readonly MIME_TO_EXT: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };

  /**
   * Decode image (data URL or base64) to buffer and file extension for CLI temp files.
   */
  private parseImageToBuffer(img: string): { buffer: Buffer; ext: string } {
    const { media_type, data } = this.parseImageForClaude(img);
    const buffer = Buffer.from(data, "base64");
    const ext = AgentService.MIME_TO_EXT[media_type] ?? ".png";
    return { buffer, ext };
  }

  /**
   * Write image attachments to temp files and return prompt suffix + cleanup.
   * Used for Cursor/custom CLI: agent reads images via file paths in the prompt.
   * cwd: when set, files are under cwd/.opensprint/agent-images; otherwise under os.tmpdir().
   */
  private async writeImagesForCli(
    cwd: string | undefined,
    images: string[]
  ): Promise<{ promptSuffix: string; cleanup: () => Promise<void> }> {
    const baseDir = cwd ?? os.tmpdir();
    const imageDirName = `.opensprint/agent-images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const imageDir = path.join(baseDir, imageDirName);
    await fs.mkdir(imageDir, { recursive: true });
    const pathsForPrompt: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const { buffer, ext } = this.parseImageToBuffer(images[i]);
      const name = `${i}${ext}`;
      const filePath = path.join(imageDir, name);
      await fs.writeFile(filePath, buffer);
      // Use paths relative to cwd when available so CLI can read from project; otherwise absolute
      pathsForPrompt.push(cwd ? path.join(imageDirName, name) : filePath);
    }
    const promptSuffix =
      "\n\nAttached images (read these file paths for context):\n" + pathsForPrompt.join("\n");
    const cleanup = async () => {
      await fs.rm(imageDir, { recursive: true }).catch(() => {});
    };
    return { promptSuffix, cleanup };
  }

  /**
   * Claude API integration using @anthropic-ai/sdk.
   * Uses ApiKeyResolver for key rotation: on limit error, recordLimitHit and retry with next key.
   * On success, clearLimitHit. Supports streaming via onChunk and images.
   */
  private async invokeClaudePlanningAgent(
    options: InvokePlanningAgentOptions
  ): Promise<PlanningAgentResponse> {
    const { projectId, config, messages, systemPrompt, images, onChunk } = options;

    const model = config.model ?? "claude-sonnet-4-20250514";

    // Convert to Anthropic message format. When images exist, last user message gets content as array.
    const anthropicMessages = messages.map((m, i) => {
      const isLastUser = m.role === "user" && i === messages.length - 1;
      const hasImages = isLastUser && images && images.length > 0;
      if (hasImages) {
        const imageBlocks = images!.map((img) => {
          const { media_type, data } = this.parseImageForClaude(img);
          return { type: "image" as const, source: { type: "base64" as const, media_type, data } };
        });
        return {
          role: m.role as "user",
          content: [{ type: "text" as const, text: m.content }, ...imageBlocks],
        };
      }
      return { role: m.role as "user" | "assistant", content: m.content };
    });

    const triedKeyIds = new Set<string>();
    let lastError: unknown;

    for (;;) {
      const resolved = await getNextKey(projectId, "ANTHROPIC_API_KEY");
      if (!resolved) {
        const msg = lastError ? getErrorMessage(lastError) : "No API key available";
        const details = createAgentApiFailureDetails({
          kind: lastError && isLimitError(lastError) ? "rate_limit" : "auth",
          agentType: "claude",
          raw: msg,
          ...buildAgentApiFailureMessages(
            "claude",
            lastError && isLimitError(lastError) ? "rate_limit" : "auth",
            { allKeysExhausted: Boolean(lastError && isLimitError(lastError)) }
          ),
          isLimitError: Boolean(lastError && isLimitError(lastError)),
          ...(lastError && isLimitError(lastError) ? { allKeysExhausted: true } : {}),
        });
        throw new AppError(400, ErrorCodes.ANTHROPIC_API_KEY_MISSING, details.userMessage, details);
      }

      const { key, keyId, source } = resolved;
      if (triedKeyIds.has(keyId)) {
        // Already tried this key (env fallback with limit - can't mark, would loop)
        const msg = getErrorMessage(lastError);
        const details = createAgentApiFailureDetails({
          kind: "rate_limit",
          agentType: "claude",
          raw: msg,
          ...buildAgentApiFailureMessages("claude", "rate_limit", { allKeysExhausted: true }),
          isLimitError: true,
          allKeysExhausted: true,
        });
        throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, details.userMessage, details);
      }
      triedKeyIds.add(keyId);

      const client = new Anthropic({ apiKey: key });

      try {
        let content: string;
        if (onChunk) {
          const stream = client.messages.stream({
            model,
            max_tokens: 8192,
            system: systemPrompt ?? undefined,
            messages: anthropicMessages,
          });

          let fullContent = "";
          stream.on("text", (text) => {
            fullContent += text;
            onChunk(text);
          });

          const finalMessage = await stream.finalMessage();
          const contentBlocks = finalMessage?.content ?? [];
          const textBlock = Array.isArray(contentBlocks)
            ? contentBlocks.find((b: { type?: string }) => b.type === "text")
            : undefined;
          content =
            textBlock && typeof textBlock === "object" && "text" in textBlock
              ? String(textBlock.text)
              : fullContent;
        } else {
          const response = await client.messages.create({
            model,
            max_tokens: 8192,
            system: systemPrompt ?? undefined,
            messages: anthropicMessages,
          });

          const contentBlocks = response?.content ?? [];
          const textBlock = Array.isArray(contentBlocks)
            ? contentBlocks.find((b: { type?: string }) => b.type === "text")
            : undefined;
          content =
            textBlock && typeof textBlock === "object" && "text" in textBlock
              ? String(textBlock.text)
              : "";
        }

        await clearLimitHit(projectId, "ANTHROPIC_API_KEY", keyId, source);
        return { content };
      } catch (error: unknown) {
        lastError = error;
        if (isLimitError(error)) {
          if (keyId === ENV_FALLBACK_KEY_ID) {
            const msg = getErrorMessage(error);
            const details = createAgentApiFailureDetails({
              kind: "rate_limit",
              agentType: "claude",
              raw: msg,
              ...buildAgentApiFailureMessages("claude", "rate_limit"),
              isLimitError: true,
            });
            throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, details.userMessage, details);
          }
          await recordLimitHit(projectId, "ANTHROPIC_API_KEY", keyId, source);
          continue;
        }
        const msg = getErrorMessage(error);
        const details = createAgentApiFailureDetails({
          kind: "auth",
          agentType: "claude",
          raw: msg,
          userMessage: "Claude failed. Check the configured API key and model in Settings.",
          notificationMessage: "Claude needs attention in Settings before work can continue.",
          isLimitError: false,
        });
        throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, details.userMessage, details);
      }
    }
  }

  /**
   * OpenAI API integration using openai SDK.
   * Uses ApiKeyResolver for key rotation: on limit error, recordLimitHit and retry with next key.
   * On success, clearLimitHit. Supports streaming via onChunk and images.
   * Maps PlanningMessage (user/assistant) to OpenAI chat format.
   */
  private async invokeOpenAIPlanningAgent(
    options: InvokePlanningAgentOptions
  ): Promise<PlanningAgentResponse> {
    const { projectId, config, messages, systemPrompt, images, onChunk } = options;

    const model = config.model ?? "gpt-4o-mini";
    const useResponsesApi = isOpenAIResponsesModel(model);

    // Map PlanningMessage (user/assistant) to OpenAI messages. OpenAI uses system, user, assistant.
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (!useResponsesApi && systemPrompt?.trim()) {
      openaiMessages.push({ role: "system", content: systemPrompt.trim() });
    }
    if (!useResponsesApi) {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const isLastUser = m.role === "user" && i === messages.length - 1;
        const hasImages = isLastUser && images && images.length > 0;
        if (hasImages) {
          const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
            { type: "text", text: m.content },
          ];
          for (const img of images!) {
            const dataUrl = img.startsWith("data:") ? img : `data:image/png;base64,${img}`;
            content.push({ type: "image_url", image_url: { url: dataUrl } });
          }
          openaiMessages.push({ role: "user", content });
        } else {
          openaiMessages.push({ role: m.role, content: m.content });
        }
      }
    }

    const triedKeyIds = new Set<string>();
    let lastError: unknown;

    for (;;) {
      const resolved = await getNextKey(projectId, "OPENAI_API_KEY");
      if (!resolved) {
        const msg = lastError ? getErrorMessage(lastError) : "No API key available";
        const details = createAgentApiFailureDetails({
          kind: lastError && isLimitError(lastError) ? "rate_limit" : "auth",
          agentType: "openai",
          raw: msg,
          ...buildAgentApiFailureMessages(
            "openai",
            lastError && isLimitError(lastError) ? "rate_limit" : "auth",
            { allKeysExhausted: Boolean(lastError && isLimitError(lastError)) }
          ),
          isLimitError: Boolean(lastError && isLimitError(lastError)),
          ...(lastError && isLimitError(lastError) ? { allKeysExhausted: true } : {}),
        });
        throw new AppError(400, ErrorCodes.OPENAI_API_ERROR, details.userMessage, details);
      }

      const { key, keyId, source } = resolved;
      if (triedKeyIds.has(keyId)) {
        const msg = getErrorMessage(lastError);
        const details = createAgentApiFailureDetails({
          kind: "rate_limit",
          agentType: "openai",
          raw: msg,
          ...buildAgentApiFailureMessages("openai", "rate_limit", { allKeysExhausted: true }),
          isLimitError: true,
          allKeysExhausted: true,
        });
        throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, details.userMessage, details);
      }
      triedKeyIds.add(keyId);

      const client = new OpenAI({ apiKey: key });

      try {
        let content: string;
        if (useResponsesApi) {
          const responseInput = buildOpenAIPlanningResponsesInput(messages, images);
          if (onChunk) {
            content = await collectOpenAIResponsesStream(
              (await client.responses.create({
                model,
                instructions: systemPrompt?.trim() || undefined,
                input: responseInput,
                max_output_tokens: 8192,
                stream: true,
              })) as AsyncIterable<{ type?: string; delta?: string }>,
              onChunk
            );
          } else {
            const response = await client.responses.create({
              model,
              instructions: systemPrompt?.trim() || undefined,
              input: responseInput,
              max_output_tokens: 8192,
            });
            content = response.output_text;
          }
        } else if (onChunk) {
          const stream = await client.chat.completions.create({
            model,
            messages: openaiMessages,
            max_tokens: 8192,
            stream: true,
          });
          let fullContent = "";
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              onChunk(delta);
            }
          }
          content = fullContent;
        } else {
          const response = await client.chat.completions.create({
            model,
            messages: openaiMessages,
            max_tokens: 8192,
          });
          content = response.choices[0]?.message?.content ?? "";
        }

        await clearLimitHit(projectId, "OPENAI_API_KEY", keyId, source);
        return { content };
      } catch (error: unknown) {
        lastError = error;
        if (isLimitError(error)) {
          if (keyId === ENV_FALLBACK_KEY_ID) {
            const msg = getErrorMessage(error);
            const details = createAgentApiFailureDetails({
              kind: "rate_limit",
              agentType: "openai",
              raw: msg,
              ...buildAgentApiFailureMessages("openai", "rate_limit"),
              isLimitError: true,
            });
            throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, details.userMessage, details);
          }
          await recordLimitHit(projectId, "OPENAI_API_KEY", keyId, source);
          continue;
        }
        const msg = getErrorMessage(error);
        const details = createAgentApiFailureDetails({
          kind: "auth",
          agentType: "openai",
          raw: msg,
          userMessage: "OpenAI failed. Check the configured API key and model in Settings.",
          notificationMessage: "OpenAI needs attention in Settings before work can continue.",
          isLimitError: false,
        });
        throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, details.userMessage, details);
      }
    }
  }
}

export const agentService = new AgentService();
