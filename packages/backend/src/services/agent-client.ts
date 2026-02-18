import { spawn, exec } from "child_process";
import { readFileSync } from "fs";
import { promisify } from "util";
import type { AgentConfig } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";

const execAsync = promisify(exec);

/** Format raw agent errors into user-friendly messages with remediation hints */
function formatAgentError(agentType: "claude" | "cursor" | "custom", raw: string): string {
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
    if (agentType === "claude") {
      return "claude CLI was not found. Install it from https://docs.anthropic.com/cli or via npm: npm install -g @anthropic-ai/cli";
    }
  }

  // Model-related errors
  if (
    lower.includes("model") &&
    (lower.includes("invalid") || lower.includes("not found") || lower.includes("unknown"))
  ) {
    return `${raw} If using Cursor, run \`agent models\` in your terminal to list available models, then update the model in Project Settings → Agent Config.`;
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return `Agent timed out after 5 minutes. ${raw}`;
  }

  // API key / 401
  if (lower.includes("api key") || lower.includes("401") || lower.includes("unauthorized")) {
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
        return this.invokeClaudeCli(options);
      case "cursor":
        return this.invokeCursorCli(options);
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
   * @param agentRole - Human-readable role for logging (e.g. 'coder', 'code reviewer')
   */
  spawnWithTaskFile(
    config: AgentConfig,
    taskFilePath: string,
    cwd: string,
    onOutput: (chunk: string) => void,
    onExit: (code: number | null) => void | Promise<void>,
    agentRole?: string
  ): { kill: () => void; pid: number | null } {
    let command: string;
    let args: string[];

    switch (config.type) {
      case "claude":
        command = "claude";
        args = ["--task-file", taskFilePath];
        if (config.model) {
          args.push("--model", config.model);
        }
        break;
      case "cursor": {
        // Cursor agent uses --print with prompt as positional arg (no --input)
        let taskContent: string;
        try {
          taskContent = readFileSync(taskFilePath, "utf-8");
        } catch (readErr) {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          throw new AppError(
            500,
            ErrorCodes.AGENT_TASK_FILE_READ_FAILED,
            `Could not read task file: ${taskFilePath}. ${msg}`,
            {
              taskFilePath,
              cause: readErr instanceof Error ? readErr.message : String(readErr),
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

    console.log("[agent] Spawning agent subprocess", {
      type: config.type,
      agentRole: agentRole ?? "coder",
      command,
      taskFilePath,
      cwd,
    });

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      detached: true,
    });

    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    child.stdout.on("data", (data: Buffer) => {
      onOutput(data.toString());
    });

    child.stderr.on("data", (data: Buffer) => {
      onOutput(data.toString());
    });

    child.on("close", (code) => {
      cleanup();
      Promise.resolve(onExit(code)).catch((err) => {
        console.error("[agent-client] onExit callback failed:", err);
      });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      const friendly =
        err.code === "ENOENT" && config.type === "cursor"
          ? "Cursor agent not found. Install: curl https://cursor.com/install -fsS | bash"
          : err.code === "ENOENT" && config.type === "claude"
            ? "claude CLI not found. Install from https://docs.anthropic.com/cli"
            : err.message;
      onOutput(`[Agent error: ${friendly}]\n`);
      cleanup();
      Promise.resolve(onExit(1)).catch((exitErr) => {
        console.error("[agent-client] onExit callback failed:", exitErr);
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

    let fullPrompt = "";
    if (systemPrompt) {
      fullPrompt += systemPrompt + "\n\n";
    }
    if (conversationHistory) {
      for (const msg of conversationHistory) {
        fullPrompt += `${msg.role === "user" ? "Human" : "Assistant"}: ${msg.content}\n\n`;
      }
    }
    fullPrompt += `Human: ${prompt}\n\nAssistant:`;

    const modelArg = config.model ? `--model ${config.model}` : "";
    const child = exec(`claude ${modelArg} --print "${fullPrompt.replace(/"/g, '\\"')}"`, {
      cwd: options.cwd || process.cwd(),
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: "SIGTERM",
    });

    try {
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>(
        (resolve, reject) => {
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (d: Buffer) => {
            stdout += d.toString();
          });
          child.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString();
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(stderr || `claude exited with code ${code}`));
          });
        }
      );

      const content = stdout.trim();
      if (options.onChunk) {
        options.onChunk(content);
      }

      return { content };
    } catch (error: unknown) {
      if (child.pid && !child.killed) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          /* already dead */
        }
        // Escalate to SIGKILL if SIGTERM doesn't take effect
        setTimeout(() => {
          if (child.pid && !child.killed) {
            try {
              process.kill(child.pid, "SIGKILL");
            } catch {
              /* already dead */
            }
          }
        }, 3000);
      }
      const err = error as { message: string; stderr?: string };
      const raw = err.stderr || err.message;
      throw new AppError(502, ErrorCodes.AGENT_INVOKE_FAILED, formatAgentError("claude", raw), {
        agentType: "claude",
        raw,
      });
    }
  }

  private async invokeCursorCli(options: AgentInvokeOptions): Promise<AgentResponse> {
    const { config, prompt, systemPrompt, conversationHistory } = options;

    // Build full prompt (Cursor agent uses --print with positional prompt, not --input)
    let fullPrompt = "";
    if (systemPrompt) {
      fullPrompt += systemPrompt + "\n\n";
    }
    if (conversationHistory) {
      for (const msg of conversationHistory) {
        fullPrompt += `${msg.role === "user" ? "Human" : "Assistant"}: ${msg.content}\n\n`;
      }
    }
    fullPrompt += `Human: ${prompt}\n\nAssistant:`;

    // Use spawn (not exec) to avoid shell interpretation of PRD content—backticks,
    // $, quotes in the prompt can crash or hang the shell. Spawn passes the prompt
    // as a single argv with no shell. Also enables live streaming to the terminal.
    const cwd = options.cwd || process.cwd();
    const args = ["-p", "--force", "--trust", "--mode", "ask", fullPrompt];
    if (config.model) {
      args.splice(1, 0, "--model", config.model);
    }

    const hasCursorKey = Boolean(process.env.CURSOR_API_KEY);
    console.log("[agent] Cursor CLI starting", {
      model: config.model ?? "default",
      promptLen: fullPrompt.length,
      cwd,
      CURSOR_API_KEY: hasCursorKey ? "set" : "NOT SET",
    });

    try {
      const content = await this.runCursorAgentSpawn(args, cwd);
      console.log("[agent] Cursor CLI completed", { outputLen: content.length });
      if (options.onChunk) {
        options.onChunk(content);
      }
      return { content };
    } catch (error: unknown) {
      // Detect timeout: either an AppError from runCursorAgentSpawn with isTimeout in details,
      // or a raw ChildProcess error with killed+SIGTERM (from spawn 'error' event).
      const isAppErr = error instanceof AppError;
      const appDetails = isAppErr
        ? (error.details as Record<string, unknown> | undefined)
        : undefined;
      const isTimeout = isAppErr
        ? Boolean(appDetails?.isTimeout)
        : Boolean(
            (error as { killed?: boolean }).killed &&
            (error as { signal?: string }).signal === "SIGTERM"
          );

      const raw = isTimeout
        ? `The Cursor agent timed out after 5 minutes. Try a faster model (e.g. sonnet-4.6-thinking) in Project Settings, or use Claude instead.`
        : isAppErr
          ? error.message
          : (error as { stderr?: string }).stderr || (error as Error).message;

      console.error("[agent] Cursor CLI failed:", raw, isTimeout ? "(timeout)" : "");
      throw new AppError(
        isTimeout ? 504 : 502,
        ErrorCodes.AGENT_INVOKE_FAILED,
        formatAgentError("cursor", raw),
        {
          agentType: "cursor",
          raw,
          isTimeout,
        }
      );
    }
  }

  /** Run Cursor agent via spawn; stream stdout/stderr to terminal and collect output */
  private runCursorAgentSpawn(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 300_000;
      let stdout = "";
      let stderr = "";

      const child = spawn("agent", args, {
        cwd,
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY || "" },
        stdio: ["ignore", "pipe", "pipe"],
      });

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
        reject(err);
      });
    });
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
      });
    }
  }
}
