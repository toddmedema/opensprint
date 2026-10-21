import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
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
import { isOpenAIResponsesModel } from "../utils/openai-models.js";
import { acquireGlobalAgentSlot } from "./agent-global-concurrency.service.js";
import { activeAgentsService } from "./active-agents.service.js";
import {
  getNextKey,
  recordLimitHit,
  clearLimitHit,
  ENV_FALLBACK_KEY_ID,
} from "./api-key-resolver.service.js";
import { taskStore } from "./task-store.service.js";
import { createLogger } from "../utils/logger.js";
import { LOG_DIFF_TRUNCATE_AT_CHARS, truncateToThreshold } from "../utils/log-diff-truncation.js";
import { filterAgentOutput } from "../utils/agent-output-filter.js";
import {
  describeStructuredOutputProblem,
  parseMergerAgentResult,
} from "./agent-result-validation.js";
import { buildAgentApiFailureMessages } from "./agent/agent-api-failure-messages.js";
import {
  buildMergerAgentPrompt,
  clearMergerResultFile,
  MERGER_RESULT_EXPECTED_SHAPE,
  readMergerAgentResultWithRaw,
  verifyMergerGitResolution,
} from "./agent/agent-merger-support.js";
import {
  buildOpenAIPlanningResponsesInput,
  collectOpenAIResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./agent/agent-openai-planning-stream.js";
import type {
  AgentTrackingInfo,
  CodingAgentHandle,
  InvokeCodingAgentOptions,
  InvokePlanningAgentOptions,
  MergerPhase,
  PlanningAgentResponse,
  RecordAgentRunOptions,
  RunMergerAgentOptions,
} from "./agent/agent-types.js";
import { parseImageForClaude, writeImagesForCli } from "./agent/agent-image-attachments.js";
import {
  buildOpenAIPromptCacheKey,
  extractAnthropicCacheUsage,
  extractOpenAICacheUsage,
  fingerprintPrompt,
  toAnthropicTextBlock,
  type AgentCacheUsageMetrics,
  type PromptCacheContext,
} from "../utils/prompt-cache.js";
import { summarizeDebugArtifact } from "./agentic-repair.service.js";

const log = createLogger("agent-service");

export type {
  AgentTrackingInfo,
  CodingAgentHandle,
  InvokeCodingAgentOptions,
  InvokePlanningAgentOptions,
  MergerPhase,
  PlanningAgentResponse,
  PlanningMessage,
  RecordAgentRunOptions,
  RunMergerAgentOptions,
} from "./agent/agent-types.js";

export { createProcessGroupHandle } from "./agent/agent-process-handle.js";

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
  flow?: string;
  promptFingerprint?: string | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
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
  debugArtifact?: import("@opensprint/shared").DebugArtifact | null;
};

/**
 * AgentService — unified interface for planning and coding agents.
 * invokePlanningAgent uses Claude API when config.type is 'claude';
 * falls back to AgentClient (CLI) for cursor/custom.
 * invokeCodingAgent spawns the coding agent with a file-based prompt.
 */
export class AgentService {
  private agentClient = new AgentClient();
  private static readonly AGENT_STATS_RETENTION = 500;

  /**
   * Invoke the planning agent with messages.
   * Returns full response; optionally streams via onChunk.
   * Claude: uses @anthropic-ai/sdk API. Cursor/custom: delegates to AgentClient (CLI).
   */
  async invokePlanningAgent(options: InvokePlanningAgentOptions): Promise<PlanningAgentResponse> {
    const releaseGlobalSlot = await acquireGlobalAgentSlot(options.projectId);
    try {
      const { tracking } = options;
      const startedAt = new Date().toISOString();
      let outcome: "success" | "failed" = "failed";
      let cacheMetrics: AgentCacheUsageMetrics | undefined;
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
          tracking.feedbackId,
          tracking.taskId
        );
      }
      try {
        const result = await this._invokePlanningAgentInner(options);
        cacheMetrics = result.cacheMetrics;
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
          flow: cacheMetrics?.flow,
          promptFingerprint: cacheMetrics?.promptFingerprint ?? null,
          cacheReadTokens: cacheMetrics?.cacheReadTokens ?? null,
          cacheWriteTokens: cacheMetrics?.cacheWriteTokens ?? null,
        } satisfies AgentRunStatParams);
        if (tracking) activeAgentsService.unregister(tracking.id);
      }
    } finally {
      releaseGlobalSlot();
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
      const { promptSuffix, cleanup: doCleanup } = await writeImagesForCli(cwd, images);
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
        timeoutMs: config.timeoutMs,
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
    const invocationId = tracking?.attemptId ?? randomUUID();
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
        tracking.feedbackId,
        tracking.taskId,
        invocationId
      );
    }

    const originalOnExit = options.onExit;
    let exited = false;
    const shouldRecordStats =
      tracking != null && tracking.role !== "coder" && tracking.role !== "reviewer";
    const wrappedOnExit =
      tracking || shouldRecordStats
        ? (code: number | null) => {
            if (exited) return;
            exited = true;
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
              activeAgentsService.unregister(tracking.id, invocationId);
            }
            return originalOnExit(code);
          }
        : originalOnExit;

    let handle: CodingAgentHandle;
    try {
      handle = this.agentClient.spawnWithTaskFile(
        config,
        promptPath,
        options.cwd,
        options.onOutput,
        wrappedOnExit,
        options.agentRole,
        options.outputLogPath,
        options.projectId
      );
    } catch (err) {
      if (tracking) activeAgentsService.unregister(tracking.id, invocationId);
      throw err;
    }

    if (tracking && handle.pendingMessages && !exited) {
      activeAgentsService.registerChannel(tracking.id, handle.pendingMessages, config.type, {
        projectId: tracking.projectId,
        attempt: tracking.attempt,
        attemptId: invocationId,
      });
    }

    return handle;
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
      flow,
      promptFingerprint,
      cacheReadTokens,
      cacheWriteTokens,
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
          `INSERT INTO agent_stats (
             project_id,
             task_id,
             agent_id,
             role,
             model,
             attempt,
             started_at,
             completed_at,
             outcome,
             duration_ms,
             flow,
             prompt_fingerprint,
             cache_read_tokens,
             cache_write_tokens
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
            flow ?? null,
            promptFingerprint ?? null,
            cacheReadTokens ?? null,
            cacheWriteTokens ?? null,
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
    const rawLog = params.outputLog.trim().length > 0 ? params.outputLog : fallbackOutput;
    const outputLog = filterAgentOutput(rawLog);
    const truncatedOutput = truncateToThreshold(outputLog, LOG_DIFF_TRUNCATE_AT_CHARS);
    const failureReason =
      params.outcome === "failed" ? "Merger agent could not resolve conflicts cleanly." : null;
    const summary =
      params.outcome === "success"
        ? `Merger resolved ${params.phase} conflicts for ${taskLabel} on ${params.branchName}.`
        : `Merger failed to resolve ${params.phase} conflicts for ${taskLabel} on ${params.branchName}.`;
    const debugArtifactSummary = summarizeDebugArtifact(params.debugArtifact);
    const repairIterations = params.debugArtifact ? 1 : 0;
    const rootCauseCategory = params.debugArtifact?.rootCauseCategory ?? null;

    try {
      await taskStore.runWrite(async (client) => {
        await client.execute(
          `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch, git_diff, test_results, failure_reason, summary, debug_artifact_summary, repair_iterations, root_cause_category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
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
            debugArtifactSummary,
            repairIterations,
            rootCauseCategory,
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

  /**
   * Run the merger agent and wait for it to complete.
   * Returns true if the agent exited with code 0 (success), false otherwise.
   * Used when merge/rebase fails with conflicts — the agent resolves them;
   * the caller then runs rebase --continue or merge --continue.
   */
  async runMergerAgentAndWait(options: RunMergerAgentOptions): Promise<boolean> {
    const runId = `merger-${options.projectId}-${options.taskId || "push"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mergerTaskId = options.taskId.trim() !== "" ? options.taskId : undefined;
    const startedAt = new Date().toISOString();
    const outputChunks: string[] = [];
    try {
      const runAttempt = async (params?: {
        repairContext?: string;
        trackingIdSuffix?: string;
        trackingLabelSuffix?: string;
      }): Promise<{
        exitedCleanly: boolean;
        raw: string | null;
        parsed: ReturnType<typeof parseMergerAgentResult>;
        verified: boolean;
      }> => {
        await clearMergerResultFile(options.cwd);
        const promptPath = path.join(
          os.tmpdir(),
          `opensprint-merger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
        );
        await fs.writeFile(
          promptPath,
          await buildMergerAgentPrompt(options, params?.repairContext)
        );
        const releaseGlobalSlot = await acquireGlobalAgentSlot(options.projectId);
        let slotReleased = false;
        const releaseMergerSlot = () => {
          if (slotReleased) return;
          slotReleased = true;
          releaseGlobalSlot();
        };
        try {
          const exitedCleanly = await new Promise<boolean>((resolve) => {
            this.invokeMergerAgent(promptPath, options.config, {
              cwd: options.cwd,
              onOutput: (chunk) => outputChunks.push(chunk),
              onExit: (code) => {
                releaseMergerSlot();
                resolve(code === 0);
              },
              projectId: options.projectId,
              tracking: {
                id: `${runId}${params?.trackingIdSuffix ?? ""}`,
                projectId: options.projectId,
                phase: "execute",
                role: "merger",
                label: `Merger conflict resolution${params?.trackingLabelSuffix ?? ""}`,
                branchName: options.branchName,
                taskId: mergerTaskId,
              },
            });
          });
          const { raw, parsed } = await readMergerAgentResultWithRaw(options.cwd);
          const verified =
            exitedCleanly && parsed?.status === "success"
              ? await verifyMergerGitResolution(options.cwd)
              : false;
          return { exitedCleanly, raw, parsed, verified };
        } finally {
          releaseMergerSlot();
          await fs.unlink(promptPath).catch((err: unknown) => {
            log.warn("prompt unlink failed", {
              err: err instanceof Error ? err.message : String(err),
            });
          });
        }
      };

      let attemptResult = await runAttempt();
      if (!attemptResult.parsed) {
        const repairContext = describeStructuredOutputProblem({
          fileLabel: ".opensprint/merge-result.json",
          rawContent: attemptResult.raw,
          expectedShape: MERGER_RESULT_EXPECTED_SHAPE,
        });
        log.warn("Retrying merger once to repair structured output", {
          projectId: options.projectId,
          taskId: options.taskId,
          branchName: options.branchName,
        });
        attemptResult = await runAttempt({
          repairContext,
          trackingIdSuffix: "-repair",
          trackingLabelSuffix: " (repair structured output)",
        });
      }

      const verified = attemptResult.verified;
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
        debugArtifact: attemptResult.parsed?.debugArtifact ?? null,
      });
      return verified;
    } finally {
      await clearMergerResultFile(options.cwd).catch((err: unknown) => {
        log.warn("clear merger result failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
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
    const promptFingerprint = fingerprintPrompt(systemPrompt?.trim() || model);
    const anthropicSystem = systemPrompt?.trim()
      ? [toAnthropicTextBlock(systemPrompt.trim(), true)]
      : undefined;

    // Convert to Anthropic message format. When images exist, last user message gets content as array.
    const anthropicMessages = messages.map((m, i) => {
      const isLastUser = m.role === "user" && i === messages.length - 1;
      const hasImages = isLastUser && images && images.length > 0;
      const shouldCacheBlock = i < messages.length - 1;
      if (hasImages) {
        const imageBlocks = images!.map((img) => {
          const { media_type, data } = parseImageForClaude(img);
          return { type: "image" as const, source: { type: "base64" as const, media_type, data } };
        });
        return {
          role: m.role as "user",
          content: [toAnthropicTextBlock(m.content, false), ...imageBlocks],
        };
      }
      return {
        role: m.role as "user" | "assistant",
        content: [toAnthropicTextBlock(m.content, shouldCacheBlock)],
      };
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
        const stream = client.messages.stream({
          model,
          max_tokens: 8192,
          system: anthropicSystem,
          messages: anthropicMessages,
        });

        let fullContent = "";
        if (onChunk) {
          stream.on("text", (text) => {
            fullContent += text;
            onChunk(text);
          });
        }

        const finalMessage = await stream.finalMessage();
        const contentBlocks = finalMessage?.content ?? [];
        const textBlock = Array.isArray(contentBlocks)
          ? contentBlocks.find((b: { type?: string }) => b.type === "text")
          : undefined;
        const content =
          textBlock && typeof textBlock === "object" && "text" in textBlock
            ? String(textBlock.text)
            : fullContent;
        const cacheMetrics = extractAnthropicCacheUsage({
          response: finalMessage,
          flow: "plan",
          promptFingerprint,
        });

        await clearLimitHit(projectId, "ANTHROPIC_API_KEY", keyId, source);
        return { content, cacheMetrics };
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
    const { projectId, config, messages, systemPrompt, images, onChunk, previousResponseId } =
      options;

    const model = config.model ?? "gpt-4o-mini";
    const useResponsesApi = isOpenAIResponsesModel(model);
    const promptFingerprint = fingerprintPrompt(systemPrompt?.trim() || model);
    const promptCacheContext: PromptCacheContext = {
      provider: "openai",
      model,
      flow: "plan",
      projectId,
      role: options.role,
      instructionsFingerprint: promptFingerprint,
      ...(options.promptCacheContext ?? {}),
    };
    const promptCacheKey = buildOpenAIPromptCacheKey(promptCacheContext);

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
        let responseId: string | undefined;
        let cacheMetrics: AgentCacheUsageMetrics | undefined;
        if (useResponsesApi) {
          const responseInput = buildOpenAIPlanningResponsesInput(messages, images);
          if (onChunk) {
            const streamResult = await collectOpenAIResponsesStream(
              (await client.responses.create({
                model,
                instructions: systemPrompt?.trim() || undefined,
                input: responseInput,
                max_output_tokens: 8192,
                previous_response_id: previousResponseId,
                prompt_cache_key: promptCacheKey,
                prompt_cache_retention: "in-memory",
                stream: true,
              })) as AsyncIterable<OpenAIResponsesStreamEvent>,
              onChunk
            );
            content = streamResult.content;
            responseId = streamResult.responseId;
            cacheMetrics = extractOpenAICacheUsage({
              response: {
                id: streamResult.responseId ?? null,
                usage: streamResult.usage ?? null,
              },
              flow: "plan",
              promptFingerprint,
              promptCacheKey,
            });
          } else {
            const response = await client.responses.create({
              model,
              instructions: systemPrompt?.trim() || undefined,
              input: responseInput,
              max_output_tokens: 8192,
              previous_response_id: previousResponseId,
              prompt_cache_key: promptCacheKey,
              prompt_cache_retention: "in-memory",
            });
            content = response.output_text;
            responseId = response.id;
            cacheMetrics = extractOpenAICacheUsage({
              response,
              flow: "plan",
              promptFingerprint,
              promptCacheKey,
            });
          }
        } else if (onChunk) {
          const stream = await client.chat.completions.create({
            model,
            messages: openaiMessages,
            max_tokens: 8192,
            prompt_cache_key: promptCacheKey,
            prompt_cache_retention: "in-memory",
            stream: true,
            stream_options: { include_usage: true },
          });
          let fullContent = "";
          let usage:
            | {
                prompt_tokens_details?: { cached_tokens?: number | null } | null;
              }
            | null
            | undefined;
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              onChunk(delta);
            }
            if (chunk.usage) {
              usage = chunk.usage;
            }
          }
          content = fullContent;
          cacheMetrics = extractOpenAICacheUsage({
            response: { id: null, usage },
            flow: "plan",
            promptFingerprint,
            promptCacheKey,
          });
        } else {
          const response = await client.chat.completions.create({
            model,
            messages: openaiMessages,
            max_tokens: 8192,
            prompt_cache_key: promptCacheKey,
            prompt_cache_retention: "in-memory",
          });
          content = response.choices[0]?.message?.content ?? "";
          responseId = response.id;
          cacheMetrics = extractOpenAICacheUsage({
            response,
            flow: "plan",
            promptFingerprint,
            promptCacheKey,
          });
        }

        await clearLimitHit(projectId, "OPENAI_API_KEY", keyId, source);
        return { content, responseId, cacheMetrics };
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
