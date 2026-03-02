import { spawn, exec } from "child_process";
import { readFileSync, openSync, closeSync, mkdirSync, appendFileSync } from "fs";
import { open as fsOpen, stat as fsStat, readFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import OpenAI from "openai";
import type { AgentConfig } from "@opensprint/shared";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getErrorMessage, getExecErrorShape, isLimitError } from "../utils/error-utils.js";
import {
  isOpenAIResponsesModel,
  toOpenAIResponsesInputMessage,
  type OpenAIResponsesInputMessage,
} from "../utils/openai-models.js";
import {
  getNextKey,
  recordLimitHit,
  clearLimitHit,
  ENV_FALLBACK_KEY_ID,
  type KeySource,
} from "./api-key-resolver.service.js";
import { markExhausted } from "./api-key-exhausted.service.js";
import { notificationService } from "./notification.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { registerAgentProcess, unregisterAgentProcess } from "./agent-process-registry.js";
import { createLogger } from "../utils/logger.js";

const execAsync = promisify(exec);
const log = createLogger("agent-client");

const OUTPUT_POLL_MS = 150;
/** Poll for result.json so we can treat "wrote result but process still running" as done (e.g. Cursor) */
const RESULT_POLL_MS = 2000;

/** ANSI codes for colorizing agent role in logs (only when stdout is a TTY) */
const ANSI_BOLD_CYAN = "\x1b[1;96m";
const ANSI_RESET = "\x1b[0m";

function colorizeRole(role: string): string {
  if (typeof process.stdout?.isTTY === "boolean" && process.stdout.isTTY) {
    return `${ANSI_BOLD_CYAN}${role}${ANSI_RESET}`;
  }
  return role;
}

/** Build full prompt from system prompt, conversation history, and final user message (Human/Assistant format). */
function buildFullPrompt(options: {
  systemPrompt?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
}): string {
  let full = "";
  if (options.systemPrompt) {
    full += options.systemPrompt + "\n\n";
  }
  if (options.conversationHistory) {
    for (const msg of options.conversationHistory) {
      full += `${msg.role === "user" ? "Human" : "Assistant"}: ${msg.content}\n\n`;
    }
  }
  full += `Human: ${options.prompt}\n\nAssistant:`;
  return full;
}

function buildOpenAIResponsesInput(options: {
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
}): OpenAIResponsesInputMessage[] {
  const input: OpenAIResponsesInputMessage[] = [];
  if (options.conversationHistory) {
    for (const message of options.conversationHistory) {
      input.push(toOpenAIResponsesInputMessage(message.role, message.content));
    }
  }
  input.push({ role: "user", content: options.prompt });
  return input;
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

/** Format raw agent errors into user-friendly messages with remediation hints */
function formatAgentError(
  agentType: "claude" | "claude-cli" | "cursor" | "custom" | "openai",
  raw: string
): string {
  const lower = raw.toLowerCase();

  // Cursor: authentication
  if (
    agentType === "cursor" &&
    (lower.includes("authentication required") || lower.includes("run 'agent login'"))
  ) {
    return "Cursor agent requires authentication. Either run `agent login` in your terminal, or add CURSOR_API_KEY to your project .env file. Get a key from Cursor → Settings → Integrations → User API Keys.";
  }

  // Cursor/Claude: command not found (ENOENT)
  if (
    lower.includes("enoent") ||
    lower.includes("command not found") ||
    lower.includes("not found")
  ) {
    if (agentType === "cursor") {
      return "Cursor agent CLI was not found. Install: curl https://cursor.com/install -fsS | bash. Then restart your terminal.";
    }
    if (agentType === "claude" || agentType === "claude-cli") {
      return "claude CLI was not found. Install it from https://docs.anthropic.com/cli or via npm: npm install -g @anthropic-ai/cli";
    }
  }

  // Model-related errors
  if (
    lower.includes("model") &&
    (lower.includes("invalid") || lower.includes("not found") || lower.includes("unknown"))
  ) {
    return `${raw} If using Cursor, run \`agent models\` in your terminal to list available models, then update the model in Settings.`;
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return `Agent timed out after 5 minutes. ${raw}`;
  }

  // API key / 401
  if (lower.includes("api key") || lower.includes("401") || lower.includes("unauthorized")) {
    if (agentType === "openai") {
      return `${raw} Check that OPENAI_API_KEY is set in .env or Settings. Get a key from https://platform.openai.com/.`;
    }
    return `${raw} Check that your API key is set in .env and valid.`;
  }

  return raw;
}

export interface AgentInvokeOptions {
  /** The agent config to use */
  config: AgentConfig;
  /** The prompt/message to send */
  prompt: string;
  /** System-level instructions */
  systemPrompt?: string;
  /** Conversation history for context */
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Working directory for CLI agents */
  cwd?: string;
  /** Callback for streaming output chunks */
  onChunk?: (chunk: string) => void;
  /** Project ID for API key resolution (Cursor: ApiKeyResolver.getNextKey for CURSOR_API_KEY) */
  projectId?: string;
}

export interface AgentResponse {
  content: string;
  raw?: unknown;
}

/**
 * Unified agent invocation interface.
 * Supports Claude API, Cursor CLI, and Custom CLI agents.
 */
export class AgentClient {
  /**
   * Invoke an agent and get a response.
   */
  async invoke(options: AgentInvokeOptions): Promise<AgentResponse> {
    switch (options.config.type) {
      case "claude":
      case "claude-cli":
        return this.invokeClaudeCli(options);
      case "cursor":
        return this.invokeCursorCli(options);
      case "openai":
        return this.invokeOpenAIApi(options);
      case "custom":
        return this.invokeCustomCli(options);
      default:
        throw new AppError(
          400,
          ErrorCodes.AGENT_UNSUPPORTED_TYPE,
          `Unsupported agent type: ${options.config.type}`,
          {
            agentType: options.config.type,
          }
        );
    }
  }

  /**
   * Invoke agent with a task file (for Build phase).
   * Spawns the agent as a subprocess and streams output.
   * When outputLogPath is provided, stdout/stderr are redirected to a file
   * (allowing the agent to survive backend restarts) and the file is polled
   * to deliver output via onOutput.
   * @param agentRole - Human-readable role for logging (e.g. 'coder', 'code reviewer')
   * @param outputLogPath - If set, redirect agent output to this file instead of pipes
   * @param projectId - For Cursor: use ApiKeyResolver.getNextKey for CURSOR_API_KEY; on limit error retry with next key; on success clearLimitHit
   */
  spawnWithTaskFile(
    config: AgentConfig,
    taskFilePath: string,
    cwd: string,
    onOutput: (chunk: string) => void,
    onExit: (code: number | null) => void | Promise<void>,
    agentRole?: string,
    outputLogPath?: string,
    projectId?: string
  ): { kill: () => void; pid: number | null } {
    if (config.type === "openai") {
      return this.spawnOpenAIWithTaskFile(
        config,
        taskFilePath,
        cwd,
        onOutput,
        onExit,
        agentRole,
        outputLogPath,
        projectId
      );
    }
    if (config.type === "cursor" && projectId) {
      return this.spawnCursorWithTaskFileAsync(
        config,
        taskFilePath,
        cwd,
        onOutput,
        onExit,
        agentRole,
        outputLogPath,
        projectId
      );
    }
    return this.doSpawnWithTaskFile(
      config,
      taskFilePath,
      cwd,
      onOutput,
      onExit,
      agentRole,
      outputLogPath,
      undefined,
      undefined
    );
  }

  /**
   * Cursor with projectId: async key resolution, retry on limit error, clearLimitHit on success.
   */
  private spawnCursorWithTaskFileAsync(
    config: AgentConfig,
    taskFilePath: string,
    cwd: string,
    onOutput: (chunk: string) => void,
    onExit: (code: number | null) => void | Promise<void>,
    agentRole: string | undefined,
    outputLogPath: string | undefined,
    projectId: string
  ): { kill: () => void; pid: number | null } {
    let innerHandle: { kill: () => void; pid: number | null } | null = null;
    const handle: { kill: () => void; pid: number | null } = {
      get pid() {
        return innerHandle?.pid ?? null;
      },
      kill() {
        innerHandle?.kill();
      },
    };

    const trySpawn = async (): Promise<void> => {
      const resolved = await getNextKey(projectId, "CURSOR_API_KEY");
      if (!resolved || !resolved.key.trim()) {
        log.error("No Cursor API key available for spawn");
        markExhausted(projectId, "CURSOR_API_KEY");
        const notification = await notificationService.createApiBlocked({
          projectId,
          source: "execute",
          sourceId: "api-keys-CURSOR_API_KEY",
          message:
            "Your API key(s) for Cursor have hit their limit. Please increase your budget or add another key.",
          errorCode: "rate_limit",
        });
        broadcastToProject(projectId, {
          type: "notification.added",
          notification: {
            id: notification.id,
            projectId: notification.projectId,
            source: notification.source,
            sourceId: notification.sourceId,
            questions: notification.questions,
            status: notification.status,
            createdAt: notification.createdAt,
            resolvedAt: notification.resolvedAt,
            kind: "api_blocked",
            errorCode: notification.errorCode,
          },
        });
        Promise.resolve(onExit(1)).catch((e) => log.error("onExit failed", { err: e }));
        return;
      }
      const { key, keyId, source } = resolved;

      const stderrCollector = { stderr: "" };

      const wrappedOnExit = async (code: number | null) => {
        if (code === 0) {
          if (keyId !== ENV_FALLBACK_KEY_ID) {
            await clearLimitHit(projectId, "CURSOR_API_KEY", keyId, source);
          }
          return Promise.resolve(onExit(0));
        }
        // Read output to check for limit error (file or collected stderr)
        let output = "";
        if (outputLogPath) {
          try {
            output = await readFile(outputLogPath, "utf-8");
          } catch {
            // ignore
          }
        } else {
          output = stderrCollector.stderr;
        }
        if (isLimitError({ stderr: output }) && keyId !== ENV_FALLBACK_KEY_ID) {
          await recordLimitHit(projectId, "CURSOR_API_KEY", keyId, source);
          const next = await getNextKey(projectId, "CURSOR_API_KEY");
          if (next) {
            return trySpawn();
          }
          markExhausted(projectId, "CURSOR_API_KEY");
          const notification = await notificationService.createApiBlocked({
            projectId,
            source: "execute",
            sourceId: "api-keys-CURSOR_API_KEY",
            message:
              "Your API key(s) for Cursor have hit their limit. Please increase your budget or add another key.",
            errorCode: "rate_limit",
          });
          broadcastToProject(projectId, {
            type: "notification.added",
            notification: {
              id: notification.id,
              projectId: notification.projectId,
              source: notification.source,
              sourceId: notification.sourceId,
              questions: notification.questions,
              status: notification.status,
              createdAt: notification.createdAt,
              resolvedAt: notification.resolvedAt,
              kind: "api_blocked",
              errorCode: notification.errorCode,
            },
          });
        }
        return Promise.resolve(onExit(code));
      };

      innerHandle = this.doSpawnWithTaskFile(
        config,
        taskFilePath,
        cwd,
        onOutput,
        wrappedOnExit,
        agentRole,
        outputLogPath,
        { CURSOR_API_KEY: key },
        stderrCollector
      );
    };

    trySpawn().catch((err) => {
      log.error("spawnCursorWithTaskFileAsync failed", { err });
      Promise.resolve(onExit(1)).catch(() => {});
    });

    return handle;
  }

  /**
   * OpenAI with task file: run API call in-process, stream to onOutput, simulate exit code.
   * No subprocess spawn; uses getNextKey/recordLimitHit/clearLimitHit for key rotation.
   */
  private spawnOpenAIWithTaskFile(
    config: AgentConfig,
    taskFilePath: string,
    cwd: string,
    onOutput: (chunk: string) => void,
    onExit: (code: number | null) => void | Promise<void>,
    agentRole?: string,
    outputLogPath?: string,
    projectId?: string
  ): { kill: () => void; pid: number | null } {
    let aborted = false;
    const handle: { kill: () => void; pid: number | null } = {
      pid: null,
      kill() {
        aborted = true;
      },
    };

    if (outputLogPath) {
      mkdirSync(path.dirname(outputLogPath), { recursive: true });
    }

    const emit = (chunk: string) => {
      onOutput(chunk);
      if (outputLogPath) {
        try {
          appendFileSync(outputLogPath, chunk);
        } catch {
          // ignore
        }
      }
    };

    const run = async (): Promise<void> => {
      let taskContent: string;
      try {
        taskContent = await readFile(taskFilePath, "utf-8");
      } catch (readErr) {
        const msg = getErrorMessage(readErr);
        log.error("OpenAI task file read failed", { taskFilePath, err: msg });
        emit(`[Agent error: Could not read task file: ${msg}]\n`);
        return Promise.resolve(onExit(1)).catch((e) => log.error("onExit failed", { err: e }));
      }

      const model = config.model ?? "gpt-4o-mini";
      const systemPrompt = `You are a coding agent. Execute the task described in the user message. Output your work directly.`;
      const useResponsesApi = isOpenAIResponsesModel(model);
      const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = useResponsesApi
        ? []
        : [
            { role: "system", content: systemPrompt },
            { role: "user", content: taskContent },
          ];

      const triedKeyIds = new Set<string>();
      let lastError: unknown;

      const tryCall = async (): Promise<void> => {
        if (aborted) return;

        const resolved = projectId
          ? await getNextKey(projectId, "OPENAI_API_KEY")
          : {
              key: process.env.OPENAI_API_KEY || "",
              keyId: ENV_FALLBACK_KEY_ID,
              source: "env" as KeySource,
            };

        if (!resolved || !resolved.key.trim()) {
          const msg = lastError ? getErrorMessage(lastError) : "No OpenAI API key available";
          emit(`[Agent error: ${msg}]\n`);
          if (projectId) {
            markExhausted(projectId, "OPENAI_API_KEY");
            notificationService
              .createApiBlocked({
                projectId,
                source: "execute",
                sourceId: "api-keys-OPENAI_API_KEY",
                message:
                  "Your API key(s) for OpenAI have hit their limit. Please increase your budget or add another key.",
                errorCode: "rate_limit",
              })
              .then((notification) => {
                broadcastToProject(projectId, {
                  type: "notification.added",
                  notification: {
                    id: notification.id,
                    projectId: notification.projectId,
                    source: notification.source,
                    sourceId: notification.sourceId,
                    questions: notification.questions,
                    status: notification.status,
                    createdAt: notification.createdAt,
                    resolvedAt: notification.resolvedAt,
                    kind: "api_blocked",
                    errorCode: notification.errorCode,
                  },
                });
              })
              .catch((e) => log.error("Failed to create API-blocked notification", { err: e }));
          }
          return Promise.resolve(onExit(1)).catch((e) => log.error("onExit failed", { err: e }));
        }

        const { key, keyId, source } = resolved;
        if (triedKeyIds.has(keyId)) {
          const msg = getErrorMessage(lastError);
          emit(`[Agent error: ${msg}]\n`);
          if (projectId) {
            markExhausted(projectId, "OPENAI_API_KEY");
            notificationService
              .createApiBlocked({
                projectId,
                source: "execute",
                sourceId: "api-keys-OPENAI_API_KEY",
                message:
                  "Your API key(s) for OpenAI have hit their limit. Please increase your budget or add another key.",
                errorCode: "rate_limit",
              })
              .then((notification) => {
                broadcastToProject(projectId, {
                  type: "notification.added",
                  notification: {
                    id: notification.id,
                    projectId: notification.projectId,
                    source: notification.source,
                    sourceId: notification.sourceId,
                    questions: notification.questions,
                    status: notification.status,
                    createdAt: notification.createdAt,
                    resolvedAt: notification.resolvedAt,
                    kind: "api_blocked",
                    errorCode: notification.errorCode,
                  },
                });
              })
              .catch((e) => log.error("Failed to create API-blocked notification", { err: e }));
          }
          return Promise.resolve(onExit(1)).catch((e) => log.error("onExit failed", { err: e }));
        }
        triedKeyIds.add(keyId);

        const client = new OpenAI({ apiKey: key });
        try {
          const fullContent = useResponsesApi
            ? await collectOpenAIResponsesStream(
                (await client.responses.create({
                  model,
                  instructions: systemPrompt,
                  input: [{ role: "user", content: taskContent }],
                  max_output_tokens: 16384,
                  stream: true,
                })) as AsyncIterable<{ type?: string; delta?: string }>,
                (delta) => {
                  if (!aborted) emit(delta);
                }
              )
            : await (async () => {
                const stream = await client.chat.completions.create({
                  model,
                  messages: openaiMessages,
                  max_tokens: 16384,
                  stream: true,
                });

                let streamedContent = "";
                for await (const chunk of stream) {
                  if (aborted) return streamedContent;
                  const delta = chunk.choices[0]?.delta?.content;
                  if (delta) {
                    streamedContent += delta;
                    emit(delta);
                  }
                }
                return streamedContent;
              })();

          if (aborted) return;

          if (projectId && keyId !== ENV_FALLBACK_KEY_ID) {
            await clearLimitHit(projectId, "OPENAI_API_KEY", keyId, source);
          }

          log.info("OpenAI coding agent completed", { outputLen: fullContent.length });
          return Promise.resolve(onExit(0)).catch((e) => log.error("onExit failed", { err: e }));
        } catch (error: unknown) {
          lastError = error;
          if (isLimitError(error) && keyId !== ENV_FALLBACK_KEY_ID) {
            await recordLimitHit(projectId!, "OPENAI_API_KEY", keyId, source);
            return tryCall();
          }
          const msg = getErrorMessage(error);
          emit(`[Agent error: ${msg}]\n`);
          return Promise.resolve(onExit(1)).catch((e) => log.error("onExit failed", { err: e }));
        }
      };

      return tryCall();
    };

    run().catch((err) => {
      log.error("spawnOpenAIWithTaskFile failed", { err });
      Promise.resolve(onExit(1)).catch(() => {});
    });

    return handle;
  }

  /**
   * Internal spawn implementation. cursorEnvOverrides: for Cursor, { CURSOR_API_KEY: key }.
   * stderrCollector: when provided (cursor+projectId pipe mode), stderr is appended for limit-error detection.
   */
  private doSpawnWithTaskFile(
    config: AgentConfig,
    taskFilePath: string,
    cwd: string,
    onOutput: (chunk: string) => void,
    onExit: (code: number | null) => void | Promise<void>,
    agentRole?: string,
    outputLogPath?: string,
    cursorEnvOverrides?: Record<string, string>,
    stderrCollector?: { stderr: string }
  ): { kill: () => void; pid: number | null } {
    let command: string;
    let args: string[];

    switch (config.type) {
      case "claude":
      case "claude-cli":
        command = "claude";
        args = ["--task-file", taskFilePath];
        if (config.model) {
          args.push("--model", config.model);
        }
        break;
      case "cursor": {
        let taskContent: string;
        try {
          taskContent = readFileSync(taskFilePath, "utf-8");
        } catch (readErr) {
          const msg = getErrorMessage(readErr);
          throw new AppError(
            500,
            ErrorCodes.AGENT_TASK_FILE_READ_FAILED,
            `Could not read task file: ${taskFilePath}. ${msg}`,
            {
              taskFilePath,
              cause: msg,
            }
          );
        }
        command = "agent";
        args = [
          "--print",
          "--force",
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--workspace",
          cwd,
          "--trust",
        ];
        if (config.model) {
          args.push("--model", config.model);
        }
        args.push(taskContent);
        break;
      }
      case "custom": {
        if (!config.cliCommand) {
          throw new AppError(
            400,
            ErrorCodes.AGENT_CLI_REQUIRED,
            "Custom agent requires a CLI command"
          );
        }
        const parts = config.cliCommand.split(" ");
        command = parts[0];
        args = [...parts.slice(1), taskFilePath];
        break;
      }
      default:
        throw new AppError(
          400,
          ErrorCodes.AGENT_UNSUPPORTED_TYPE,
          `Unsupported agent type: ${config.type}`,
          {
            agentType: config.type,
          }
        );
    }

    // When outputLogPath is provided, open a file descriptor for stdout/stderr
    // so the agent process survives backend restarts (no broken pipe).
    let outputFd: number | undefined;
    if (outputLogPath) {
      mkdirSync(path.dirname(outputLogPath), { recursive: true });
      outputFd = openSync(outputLogPath, "w");
    }

    const stdio: ["ignore", "pipe" | number, "pipe" | number] =
      outputFd !== undefined ? ["ignore", outputFd, outputFd] : ["ignore", "pipe", "pipe"];

    const role = agentRole ?? "coder";
    log.info(`Spawning agent subprocess — role: ${colorizeRole(role)}`, {
      type: config.type,
      agentRole: role,
      command,
      taskFilePath,
      cwd,
      outputLogPath: outputLogPath ?? "(pipe)",
    });

    const spawnEnv =
      config.type === "cursor" && cursorEnvOverrides
        ? { ...process.env, ...cursorEnvOverrides }
        : { ...process.env };

    const child = spawn(command, args, {
      cwd,
      stdio,
      env: spawnEnv,
      detached: true,
    });

    // Close our copy of the fd; the child process inherits its own.
    if (outputFd !== undefined) {
      closeSync(outputFd);
    }

    if (child.pid) {
      registerAgentProcess(child.pid, { processGroup: true });
    }

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    /** When we SIGTERM from result.json path, follow up with SIGKILL if process doesn't exit within this window (e.g. Cursor ignores SIGTERM). */
    const SIGKILL_AFTER_TERM_MS = 15_000;
    let sigkillAfterTermTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let resultPollTimer: ReturnType<typeof setInterval> | null = null;
    let readOffset = 0;
    /** Set when we invoke onExit from result.json terminal-status path so we don't double-invoke on process exit */
    let exitNotified = false;

    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (resultPollTimer) {
        clearInterval(resultPollTimer);
        resultPollTimer = null;
      }
    };

    const cleanup = () => {
      if (child.pid) {
        unregisterAgentProcess(child.pid, { processGroup: true });
      }
      stopPoll();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (sigkillAfterTermTimer) {
        clearTimeout(sigkillAfterTermTimer);
        sigkillAfterTermTimer = null;
      }
    };

    /** Terminal statuses in result.json: agent has finished and reported outcome. */
    const RESULT_TERMINAL_STATUSES = ["success", "failed", "approved", "rejected"];

    const checkResultAndMaybeExit = async (): Promise<void> => {
      if (!outputLogPath || !cwd) return;
      const taskDir = path.dirname(outputLogPath);
      const taskId = path.basename(taskDir);
      const resultPath = path.join(cwd, OPENSPRINT_PATHS.active, taskId, "result.json");
      try {
        const raw = await readFile(resultPath, "utf-8");
        const parsed = JSON.parse(raw) as { status?: string };
        const status = typeof parsed?.status === "string" ? parsed.status.toLowerCase() : "";
        if (RESULT_TERMINAL_STATUSES.includes(status)) {
          if (resultPollTimer) {
            clearInterval(resultPollTimer);
            resultPollTimer = null;
          }
          log.info("result.json present with terminal status; terminating agent process", {
            taskId,
            status: parsed.status,
          });
          exitNotified = true;
          const code = status === "success" ? 0 : 1;
          stopPoll();
          Promise.resolve(onExit(code)).catch((err) => {
            log.error("onExit callback failed (result.json path)", { err });
          });
          try {
            process.kill(-child.pid!, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
          // If process doesn't exit (e.g. Cursor ignores SIGTERM), force SIGKILL within 10–30s so agent is gone quickly.
          sigkillAfterTermTimer = setTimeout(() => {
            sigkillAfterTermTimer = null;
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              try {
                if (!child.killed) child.kill("SIGKILL");
              } catch {
                // Process may already have exited
              }
            }
          }, SIGKILL_AFTER_TERM_MS);
        }
      } catch {
        // No result yet or invalid JSON / missing status
      }
    };

    /** Read new bytes from the output log file and deliver via onOutput */
    const drainOutputFile = async (): Promise<void> => {
      if (!outputLogPath) return;
      try {
        const s = await fsStat(outputLogPath);
        if (s.size <= readOffset) return;
        const toRead = Math.min(s.size - readOffset, 256 * 1024);
        const fh = await fsOpen(outputLogPath, "r");
        try {
          const buf = Buffer.alloc(toRead);
          const { bytesRead } = await fh.read(buf, 0, toRead, readOffset);
          if (bytesRead > 0) {
            readOffset += bytesRead;
            onOutput(buf.subarray(0, bytesRead).toString());
          }
        } finally {
          await fh.close();
        }
      } catch {
        // File may not exist yet or transient I/O error
      }
    };

    if (outputLogPath) {
      // Poll the output file to stream content to the caller
      pollTimer = setInterval(() => {
        drainOutputFile().catch(() => {});
      }, OUTPUT_POLL_MS);
      // First drain immediately so first chunk is not delayed by a full interval
      setImmediate(() => drainOutputFile().catch(() => {}));
      // When agent writes result.json but does not exit (e.g. Cursor), poll and SIGTERM so onExit runs
      resultPollTimer = setInterval(() => {
        checkResultAndMaybeExit().catch(() => {});
      }, RESULT_POLL_MS);
    } else {
      // Pipe-based streaming (original behavior)
      child.stdout!.on("data", (data: Buffer) => {
        onOutput(data.toString());
      });
      child.stderr!.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (stderrCollector) stderrCollector.stderr += chunk;
        onOutput(chunk);
      });
    }

    child.on("close", (code) => {
      if (sigkillAfterTermTimer) {
        clearTimeout(sigkillAfterTermTimer);
        sigkillAfterTermTimer = null;
      }
      stopPoll();
      drainOutputFile()
        .catch(() => {})
        .finally(() => {
          cleanup();
          if (exitNotified) return;
          Promise.resolve(onExit(code)).catch((err) => {
            log.error("onExit callback failed", { err });
          });
        });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      const friendly =
        err.code === "ENOENT" && config.type === "cursor"
          ? "Cursor agent not found. Install: curl https://cursor.com/install -fsS | bash"
          : err.code === "ENOENT" && (config.type === "claude" || config.type === "claude-cli")
            ? "claude CLI not found. Install from https://docs.anthropic.com/cli"
            : err.message;
      onOutput(`[Agent error: ${friendly}]\n`);
      cleanup();
      Promise.resolve(onExit(1)).catch((exitErr) => {
        log.error("onExit callback failed", { err: exitErr });
      });
    });

    return {
      pid: child.pid ?? null,
      kill: () => {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        killTimer = setTimeout(() => {
          killTimer = null;
          try {
            if (!child.killed) {
              process.kill(-child.pid!, "SIGKILL");
            }
          } catch {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }
        }, 5000);
      },
    };
  }

  // ─── Private Invocation Methods ───

  private async invokeClaudeCli(options: AgentInvokeOptions): Promise<AgentResponse> {
    const { config, prompt, systemPrompt, conversationHistory } = options;
    const fullPrompt = buildFullPrompt({ systemPrompt, conversationHistory, prompt });

    const args = ["--print", fullPrompt];
    if (config.model) {
      args.unshift("--model", config.model);
    }
    const cwd = options.cwd || process.cwd();

    const child = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      detached: true,
    });

    if (child.pid) {
      registerAgentProcess(child.pid, { processGroup: true });
    }

    try {
      const stdout = await this.runClaudeAgentSpawn(child, { processGroup: true });
      const content = stdout.trim();
      if (options.onChunk) {
        options.onChunk(content);
      }
      return { content };
    } catch (error: unknown) {
      const shape = getExecErrorShape(error);
      const raw =
        shape.stderr || shape.message || (error instanceof Error ? error.message : String(error));
      throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, formatAgentError("claude", raw), {
        agentType: "claude",
        raw,
        isLimitError: isLimitError(error),
      });
    } finally {
      if (child.pid) {
        unregisterAgentProcess(child.pid, { processGroup: true });
      }
    }
  }

  /** Run Claude CLI via spawn; pass prompt as argv (no shell) to avoid orphan processes.
   * Uses SIGTERM first (allows cleanup), then SIGKILL after 3s if process ignores SIGTERM. */
  private runClaudeAgentSpawn(
    child: ReturnType<typeof spawn>,
    options?: { processGroup?: boolean }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 300_000;
      let stdout = "";
      let stderr = "";

      const killChild = (signal: "SIGTERM" | "SIGKILL") => {
        if (child.killed) return;
        try {
          if (options?.processGroup && child.pid) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          child.kill(signal);
        }
      };
      const timeout = setTimeout(() => {
        if (child.killed) return;
        killChild("SIGTERM");
        setTimeout(() => killChild("SIGKILL"), 3000);
        if (stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(
            new AppError(
              504,
              ErrorCodes.AGENT_INVOKE_FAILED,
              `Claude CLI timed out after ${TIMEOUT_MS / 1000}s. stderr: ${stderr.slice(0, 500)}`,
              {
                agentType: "claude",
                isTimeout: true,
                stderr: stderr.slice(0, 500),
              }
            )
          );
        }
      }, TIMEOUT_MS);

      // Attach close/error first so we handle early exit (e.g. ENOENT) before data listeners
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0 || stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `claude exited with code ${code}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    });
  }

  private async invokeCursorCli(options: AgentInvokeOptions): Promise<AgentResponse> {
    const { config, prompt, systemPrompt, conversationHistory, projectId } = options;
    const fullPrompt = buildFullPrompt({ systemPrompt, conversationHistory, prompt });

    // Use spawn (not exec) to avoid shell interpretation of PRD content—backticks,
    // $, quotes in the prompt can crash or hang the shell. Spawn passes the prompt
    // as a single argv with no shell. Also enables live streaming to the terminal.
    const cwd = options.cwd || process.cwd();
    const args = ["-p", "--force", "--trust", "--mode", "ask", fullPrompt];
    if (config.model) {
      args.splice(1, 0, "--model", config.model);
    }

    const triedKeyIds = new Set<string>();
    let lastError: unknown;

    for (;;) {
      const resolved = projectId
        ? await getNextKey(projectId, "CURSOR_API_KEY")
        : { key: process.env.CURSOR_API_KEY || "", keyId: ENV_FALLBACK_KEY_ID, source: "env" as KeySource };

      if (!resolved || !resolved.key.trim()) {
        const msg = lastError ? getErrorMessage(lastError) : "No Cursor API key available";
        throw new AppError(
          400,
          ErrorCodes.AGENT_INVOKE_FAILED,
          lastError && isLimitError(lastError)
            ? `All Cursor API keys hit rate limits. ${msg} Add more keys in Settings, or retry after 24h.`
            : "CURSOR_API_KEY is not set. Add it to your .env file or Settings. Get a key from Cursor → Settings → Integrations → User API Keys.",
          lastError ? { agentType: "cursor", raw: msg, isLimitError: isLimitError(lastError) } : undefined
        );
      }

      const { key, keyId, source } = resolved;
      if (triedKeyIds.has(keyId)) {
        const msg = getErrorMessage(lastError);
        throw new AppError(
          502,
          ErrorCodes.AGENT_INVOKE_FAILED,
          `Cursor API error: ${msg}. Check Settings (API key, model).`,
          { agentType: "cursor", raw: msg, isLimitError: true }
        );
      }
      triedKeyIds.add(keyId);

      log.info("Cursor CLI starting", {
        model: config.model ?? "default",
        promptLen: fullPrompt.length,
        cwd,
        CURSOR_API_KEY: key ? "set" : "NOT SET",
      });

      try {
        const content = await this.runCursorAgentSpawn(args, cwd, key);
        log.info("Cursor CLI completed", { outputLen: content.length });
        if (projectId && keyId !== ENV_FALLBACK_KEY_ID) {
          await clearLimitHit(projectId, "CURSOR_API_KEY", keyId, source);
        }
        if (options.onChunk) {
          options.onChunk(content);
        }
        return { content };
      } catch (error: unknown) {
        lastError = error;
        if (isLimitError(error) && keyId !== ENV_FALLBACK_KEY_ID) {
          await recordLimitHit(projectId!, "CURSOR_API_KEY", keyId, source);
          continue;
        }
        // Non-limit error or env fallback with limit: throw
        const isAppErr = error instanceof AppError;
        const appDetails = isAppErr
          ? (error.details as Record<string, unknown> | undefined)
          : undefined;
        const execShape = getExecErrorShape(error);
        const isTimeout = isAppErr
          ? Boolean(appDetails?.isTimeout)
          : Boolean(execShape.killed && execShape.signal === "SIGTERM");

        const raw = isTimeout
          ? `The Cursor agent timed out after 5 minutes. Try a faster model (e.g. sonnet-4.6-thinking) in Settings, or use Claude instead.`
          : isAppErr
            ? error.message
            : execShape.stderr ||
              execShape.message ||
              (error instanceof Error ? error.message : String(error));

        log.error("Cursor CLI failed", { raw, isTimeout });
        throw new AppError(
          isTimeout ? 504 : 502,
          ErrorCodes.AGENT_INVOKE_FAILED,
          formatAgentError("cursor", raw),
          {
            agentType: "cursor",
            raw,
            isTimeout,
            isLimitError: isLimitError(error),
          }
        );
      }
    }
  }

  /** Run Cursor agent via spawn; stream stdout/stderr to terminal and collect output */
  private runCursorAgentSpawn(args: string[], cwd: string, cursorApiKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 300_000;
      let stdout = "";
      let stderr = "";

      const child = spawn("agent", args, {
        cwd,
        env: { ...process.env, CURSOR_API_KEY: cursorApiKey || "" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (child.pid) {
        registerAgentProcess(child.pid);
      }

      const timeout = setTimeout(() => {
        if (child.killed) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 3000);
        if (stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(
            new AppError(
              504,
              ErrorCodes.AGENT_INVOKE_FAILED,
              `Cursor CLI timed out after ${TIMEOUT_MS / 1000}s. stderr: ${stderr.slice(0, 500)}`,
              {
                agentType: "cursor",
                isTimeout: true,
                stderr: stderr.slice(0, 500),
              }
            )
          );
        }
      }, TIMEOUT_MS);

      const safeWrite = (stream: NodeJS.WriteStream, data: string | Buffer) => {
        try {
          stream.write(data, (err) => {
            if (err) process.stderr.write(`[agent] stream write failed: ${err.message}\n`);
          });
        } catch {
          // ignore
        }
      };

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        safeWrite(process.stdout, chunk);
      });

      child.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        safeWrite(process.stderr, chunk);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (child.pid) unregisterAgentProcess(child.pid);
        if (code === 0 || stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(
            new AppError(
              502,
              ErrorCodes.AGENT_INVOKE_FAILED,
              `Cursor CLI failed: code=${code} stderr=${stderr.slice(0, 500)}`,
              {
                agentType: "cursor",
                exitCode: code,
                stderr: stderr.slice(0, 500),
              }
            )
          );
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        if (child.pid) unregisterAgentProcess(child.pid);
        reject(err);
      });
    });
  }

  private async invokeOpenAIApi(options: AgentInvokeOptions): Promise<AgentResponse> {
    const { config, prompt, systemPrompt, conversationHistory, projectId } = options;
    const model = config.model ?? "gpt-4o-mini";
    const useResponsesApi = isOpenAIResponsesModel(model);

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (!useResponsesApi && systemPrompt?.trim()) {
      openaiMessages.push({ role: "system", content: systemPrompt.trim() });
    }
    if (!useResponsesApi && conversationHistory) {
      for (const m of conversationHistory) {
        openaiMessages.push({ role: m.role, content: m.content });
      }
    }
    if (!useResponsesApi) {
      openaiMessages.push({ role: "user", content: prompt });
    }

    const triedKeyIds = new Set<string>();
    let lastError: unknown;

    for (;;) {
      const resolved = projectId
        ? await getNextKey(projectId, "OPENAI_API_KEY")
        : {
            key: process.env.OPENAI_API_KEY || "",
            keyId: ENV_FALLBACK_KEY_ID,
            source: "env" as KeySource,
          };

      if (!resolved || !resolved.key.trim()) {
        const msg = lastError ? getErrorMessage(lastError) : "No OpenAI API key available";
        throw new AppError(
          400,
          ErrorCodes.AGENT_INVOKE_FAILED,
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
        if (useResponsesApi) {
          const responseInput = buildOpenAIResponsesInput({ conversationHistory, prompt });
          if (options.onChunk) {
            content = await collectOpenAIResponsesStream(
              (await client.responses.create({
                model,
                instructions: systemPrompt?.trim() || undefined,
                input: responseInput,
                max_output_tokens: 8192,
                stream: true,
              })) as AsyncIterable<{ type?: string; delta?: string }>,
              options.onChunk
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
        } else if (options.onChunk) {
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
              options.onChunk(delta);
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

        if (projectId && keyId !== ENV_FALLBACK_KEY_ID) {
          await clearLimitHit(projectId, "OPENAI_API_KEY", keyId, source);
        }

        return { content };
      } catch (error: unknown) {
        lastError = error;
        if (isLimitError(error) && keyId !== ENV_FALLBACK_KEY_ID) {
          await recordLimitHit(projectId!, "OPENAI_API_KEY", keyId, source);
          continue;
        }
        const msg = getErrorMessage(error);
        throw new AppError(
          502,
          ErrorCodes.AGENT_INVOKE_FAILED,
          formatAgentError("openai", msg),
          {
            agentType: "openai",
            raw: msg,
            isLimitError: isLimitError(error),
          }
        );
      }
    }
  }

  private async invokeCustomCli(options: AgentInvokeOptions): Promise<AgentResponse> {
    const { config, prompt } = options;

    if (!config.cliCommand) {
      throw new AppError(400, ErrorCodes.AGENT_CLI_REQUIRED, "Custom agent requires a CLI command");
    }

    try {
      const { stdout } = await execAsync(`${config.cliCommand} "${prompt.replace(/"/g, '\\"')}"`, {
        cwd: options.cwd || process.cwd(),
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const content = stdout.trim();
      if (options.onChunk) {
        options.onChunk(content);
      }

      return { content };
    } catch (error: unknown) {
      const err = error as { message: string; stderr?: string };
      const raw = err.stderr || err.message;
      throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, formatAgentError("custom", raw), {
        agentType: "custom",
        raw,
        isLimitError: isLimitError(error),
      });
    }
  }
}
