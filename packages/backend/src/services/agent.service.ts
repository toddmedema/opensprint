import fs from "fs/promises";
import os from "os";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AgentConfig, AgentRole } from "@opensprint/shared";
import { AgentClient } from "./agent-client.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getErrorMessage, isLimitError } from "../utils/error-utils.js";
import { activeAgentsService } from "./active-agents.service.js";
import {
  getNextKey,
  recordLimitHit,
  clearLimitHit,
  ENV_FALLBACK_KEY_ID,
  type KeySource,
} from "./api-key-resolver.service.js";

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

/** Create a handle for an existing process by PID (used when re-attaching after backend restart). */
export function createPidHandle(pid: number): CodingAgentHandle {
  return {
    pid,
    kill() {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may already be dead
      }
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

  /**
   * Invoke the planning agent with messages.
   * Returns full response; optionally streams via onChunk.
   * Claude: uses @anthropic-ai/sdk API. Cursor/custom: delegates to AgentClient (CLI).
   */
  async invokePlanningAgent(options: InvokePlanningAgentOptions): Promise<PlanningAgentResponse> {
    const { tracking } = options;
    if (tracking) {
      activeAgentsService.register(
        tracking.id,
        tracking.projectId,
        tracking.phase,
        tracking.role,
        tracking.label,
        new Date().toISOString(),
        tracking.branchName,
        tracking.planId,
        undefined,
        tracking.feedbackId
      );
    }
    try {
      return await this._invokePlanningAgentInner(options);
    } finally {
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

    // Cursor and custom: use AgentClient (CLI-based). Images are written to temp files
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
    if (tracking) {
      activeAgentsService.register(
        tracking.id,
        tracking.projectId,
        tracking.phase,
        tracking.role,
        tracking.label,
        new Date().toISOString(),
        tracking.branchName,
        tracking.planId,
        undefined,
        tracking.feedbackId
      );
    }

    const originalOnExit = options.onExit;
    const wrappedOnExit = tracking
      ? (code: number | null) => {
          activeAgentsService.unregister(tracking.id);
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
   * Default prompt for the merger agent. Instructs the agent to resolve
   * merge/rebase conflict markers in the working directory.
   */
  private static readonly MERGER_PROMPT = `# Merger Agent: Resolve Git Conflicts

You are the Merger agent. Your job is to resolve merge or rebase conflicts in this repository.

## Context

A git merge or rebase has encountered conflicts. The working directory contains files with conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).

## Your Task

1. **Identify conflicted files** — Run \`git diff --name-only --diff-filter=U\` or \`git status\` to find unmerged paths.
2. **Resolve each conflict** — Edit each conflicted file to remove conflict markers and produce a correct merged result. Preserve intended behavior from both sides where appropriate.
3. **Stage resolved files** — Run \`git add <file>\` for each resolved file.
4. **Verify** — Ensure no conflict markers remain. Run \`git diff --check\` to confirm.

## Rules

- Do NOT run \`git rebase --continue\` or \`git commit\` — the orchestrator will do that after you exit.
- Resolve conflicts by editing files; do not delete entire files unless that is clearly correct.
- Prefer keeping both sides' changes when they are compatible; otherwise choose the most correct resolution.
- Exit with code 0 when all conflicts are resolved and staged. Exit non-zero if you cannot resolve.
`;

  /**
   * Run the merger agent and wait for it to complete.
   * Returns true if the agent exited with code 0 (success), false otherwise.
   * Used when merge/rebase fails with conflicts — the agent resolves them;
   * the caller then runs rebase --continue or merge --continue.
   */
  async runMergerAgentAndWait(projectId: string, cwd: string, config: AgentConfig): Promise<boolean> {
    const promptPath = path.join(os.tmpdir(), `opensprint-merger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
    await fs.writeFile(promptPath, AgentService.MERGER_PROMPT);
    try {
      return await new Promise<boolean>((resolve) => {
        this.invokeMergerAgent(promptPath, config, {
          cwd,
          onOutput: () => {},
          onExit: (code) => resolve(code === 0),
          projectId,
        });
      });
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
        throw new AppError(
          400,
          ErrorCodes.ANTHROPIC_API_KEY_MISSING,
          lastError && isLimitError(lastError)
            ? `All Claude API keys hit rate limits. ${msg} Add more keys in Settings, or retry after 24h.`
            : "ANTHROPIC_API_KEY is not set. Add it to your .env file or Settings. Get a key from https://console.anthropic.com/. Alternatively, switch to Claude (CLI) in Agent Config to use the locally-installed claude CLI instead.",
          lastError ? { agentType: "claude", raw: msg, isLimitError: isLimitError(lastError) } : undefined
        );
      }

      const { key, keyId, source } = resolved;
      if (triedKeyIds.has(keyId)) {
        // Already tried this key (env fallback with limit - can't mark, would loop)
        const msg = getErrorMessage(lastError);
        throw new AppError(
          502,
          ErrorCodes.AGENT_INVOKE_FAILED,
          `Claude API error: ${msg}. Check Settings (API key, model).`,
          { agentType: "claude", raw: msg, isLimitError: true }
        );
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
            throw new AppError(
              502,
              ErrorCodes.AGENT_INVOKE_FAILED,
              `Claude API rate limit: ${msg}. Add more keys in Settings for automatic rotation.`,
              { agentType: "claude", raw: msg, isLimitError: true }
            );
          }
          await recordLimitHit(projectId, "ANTHROPIC_API_KEY", keyId, source);
          continue;
        }
        const msg = getErrorMessage(error);
        throw new AppError(
          502,
          ErrorCodes.AGENT_INVOKE_FAILED,
          `Claude API error: ${msg}. Check Settings (API key, model).`,
          { agentType: "claude", raw: msg, isLimitError: false }
        );
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

    // Map PlanningMessage (user/assistant) to OpenAI messages. OpenAI uses system, user, assistant.
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (systemPrompt?.trim()) {
      openaiMessages.push({ role: "system", content: systemPrompt.trim() });
    }
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

    const triedKeyIds = new Set<string>();
    let lastError: unknown;

    for (;;) {
      const resolved = await getNextKey(projectId, "OPENAI_API_KEY");
      if (!resolved) {
        const msg = lastError ? getErrorMessage(lastError) : "No API key available";
        throw new AppError(
          400,
          ErrorCodes.OPENAI_API_ERROR,
          lastError && isLimitError(lastError)
            ? `All OpenAI API keys hit rate limits. ${msg} Add more keys in Settings, or retry after 24h.`
            : "OPENAI_API_KEY is not set. Add it to your .env file or Settings. Get a key from https://platform.openai.com/.",
          lastError ? { agentType: "openai", raw: msg, isLimitError: isLimitError(lastError) } : undefined
        );
      }

      const { key, keyId, source } = resolved;
      if (triedKeyIds.has(keyId)) {
        const msg = getErrorMessage(lastError);
        throw new AppError(
          502,
          ErrorCodes.AGENT_INVOKE_FAILED,
          `OpenAI API error: ${msg}. Check Settings (API key, model).`,
          { agentType: "openai", raw: msg, isLimitError: true }
        );
      }
      triedKeyIds.add(keyId);

      const client = new OpenAI({ apiKey: key });

      try {
        let content: string;
        if (onChunk) {
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
            throw new AppError(
              502,
              ErrorCodes.AGENT_INVOKE_FAILED,
              `OpenAI API rate limit: ${msg}. Add more keys in Settings for automatic rotation.`,
              { agentType: "openai", raw: msg, isLimitError: true }
            );
          }
          await recordLimitHit(projectId, "OPENAI_API_KEY", keyId, source);
          continue;
        }
        const msg = getErrorMessage(error);
        throw new AppError(
          502,
          ErrorCodes.AGENT_INVOKE_FAILED,
          `OpenAI API error: ${msg}. Check Settings (API key, model).`,
          { agentType: "openai", raw: msg, isLimitError: false }
        );
      }
    }
  }
}

export const agentService = new AgentService();
