import { spawn, exec } from 'child_process';
import { readFileSync } from 'fs';
import { promisify } from 'util';
import type { AgentType, AgentConfig } from '@opensprint/shared';

const execAsync = promisify(exec);

/** Format raw agent errors into user-friendly messages with remediation hints */
function formatAgentError(agentType: 'claude' | 'cursor' | 'custom', raw: string): string {
  const lower = raw.toLowerCase();

  // Cursor: authentication
  if (agentType === 'cursor' && (lower.includes('authentication required') || lower.includes("run 'agent login'"))) {
    return (
      'Cursor agent requires authentication. Either run `agent login` in your terminal, or add CURSOR_API_KEY to your project .env file. Get a key from Cursor → Settings → Integrations → User API Keys.'
    );
  }

  // Cursor/Claude: command not found (ENOENT)
  if (lower.includes('enoent') || lower.includes('command not found') || lower.includes('not found')) {
    if (agentType === 'cursor') {
      return (
        'Cursor agent CLI was not found. Install: curl https://cursor.com/install -fsS | bash. Then restart your terminal.'
      );
    }
    if (agentType === 'claude') {
      return (
        'claude CLI was not found. Install it from https://docs.anthropic.com/cli or via npm: npm install -g @anthropic-ai/cli'
      );
    }
  }

  // Model-related errors
  if (lower.includes('model') && (lower.includes('invalid') || lower.includes('not found') || lower.includes('unknown'))) {
    return (
      `${raw} If using Cursor, run \`agent models\` in your terminal to list available models, then update the model in Project Settings → Agent Config.`
    );
  }

  // Timeout
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return `Agent timed out after 2 minutes. ${raw}`;
  }

  // API key / 401
  if (lower.includes('api key') || lower.includes('401') || lower.includes('unauthorized')) {
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
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
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
      case 'claude':
        return this.invokeClaudeCli(options);
      case 'cursor':
        return this.invokeCursorCli(options);
      case 'custom':
        return this.invokeCustomCli(options);
      default:
        throw new Error(`Unsupported agent type: ${options.config.type}`);
    }
  }

  /**
   * Invoke agent with a task file (for Build phase).
   * Spawns the agent as a subprocess and streams output.
   */
  spawnWithTaskFile(
    config: AgentConfig,
    taskFilePath: string,
    cwd: string,
    onOutput: (chunk: string) => void,
    onExit: (code: number | null) => void,
  ): { kill: () => void } {
    let command: string;
    let args: string[];

    switch (config.type) {
      case 'claude':
        command = 'claude';
        args = ['--task-file', taskFilePath];
        if (config.model) {
          args.push('--model', config.model);
        }
        break;
      case 'cursor': {
        // Cursor agent uses --print with prompt as positional arg (no --input)
        let taskContent: string;
        try {
          taskContent = readFileSync(taskFilePath, 'utf-8');
        } catch (readErr) {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          throw new Error(`Could not read task file: ${taskFilePath}. ${msg}`);
        }
        command = 'agent';
        args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--workspace', cwd, '--trust'];
        if (config.model) {
          args.push('--model', config.model);
        }
        args.push(taskContent);
        break;
      }
      case 'custom':
        if (!config.cliCommand) {
          throw new Error('Custom agent requires a CLI command');
        }
        const parts = config.cliCommand.split(' ');
        command = parts[0];
        args = [...parts.slice(1), taskFilePath];
        break;
      default:
        throw new Error(`Unsupported agent type: ${config.type}`);
    }

    console.log('[agent] Spawning agent subprocess', {
      type: config.type,
      command,
      taskFilePath,
      cwd,
    });

    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: true,
    });

    child.stdout.on('data', (data: Buffer) => {
      onOutput(data.toString());
    });

    child.stderr.on('data', (data: Buffer) => {
      onOutput(data.toString());
    });

    child.on('close', (code) => {
      onExit(code);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const friendly =
        err.code === 'ENOENT' && config.type === 'cursor'
          ? 'Cursor agent not found. Install: curl https://cursor.com/install -fsS | bash'
          : err.code === 'ENOENT' && config.type === 'claude'
            ? 'claude CLI not found. Install from https://docs.anthropic.com/cli'
            : err.message;
      onOutput(`[Agent error: ${friendly}]\n`);
      onExit(1);
    });

    return {
      kill: () => {
        try {
          // Kill the entire process group (negative PID) since agent is detached
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          try {
            if (!child.killed) {
              process.kill(-child.pid!, 'SIGKILL');
            }
          } catch {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }
        }, 5000);
      },
    };
  }

  // ─── Private Invocation Methods ───

  private async invokeClaudeCli(options: AgentInvokeOptions): Promise<AgentResponse> {
    const { config, prompt, systemPrompt, conversationHistory } = options;

    // Build conversation context for Claude CLI
    let fullPrompt = '';
    if (systemPrompt) {
      fullPrompt += systemPrompt + '\n\n';
    }
    if (conversationHistory) {
      for (const msg of conversationHistory) {
        fullPrompt += `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}\n\n`;
      }
    }
    fullPrompt += `Human: ${prompt}\n\nAssistant:`;

    try {
      const modelArg = config.model ? `--model ${config.model}` : '';
      const { stdout } = await execAsync(
        `claude ${modelArg} --print "${fullPrompt.replace(/"/g, '\\"')}"`,
        {
          cwd: options.cwd || process.cwd(),
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const content = stdout.trim();
      if (options.onChunk) {
        options.onChunk(content);
      }

      return { content };
    } catch (error: unknown) {
      const err = error as { message: string; stderr?: string };
      const raw = err.stderr || err.message;
      throw new Error(formatAgentError('claude', raw));
    }
  }

  private async invokeCursorCli(options: AgentInvokeOptions): Promise<AgentResponse> {
    const { config, prompt, systemPrompt, conversationHistory } = options;

    // Build full prompt (Cursor agent uses --print with positional prompt, not --input)
    let fullPrompt = '';
    if (systemPrompt) {
      fullPrompt += systemPrompt + '\n\n';
    }
    if (conversationHistory) {
      for (const msg of conversationHistory) {
        fullPrompt += `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}\n\n`;
      }
    }
    fullPrompt += `Human: ${prompt}\n\nAssistant:`;

    // Use spawn (not exec) to avoid shell interpretation of PRD content—backticks,
    // $, quotes in the prompt can crash or hang the shell. Spawn passes the prompt
    // as a single argv with no shell. Also enables live streaming to the terminal.
    const cwd = options.cwd || process.cwd();
    const args = ['-p', '--force', '--trust', '--mode', 'ask', fullPrompt];
    if (config.model) {
      args.splice(1, 0, '--model', config.model);
    }

    const hasCursorKey = Boolean(process.env.CURSOR_API_KEY);
    console.log('[agent] Cursor CLI starting', { model: config.model ?? 'default', promptLen: fullPrompt.length, cwd, CURSOR_API_KEY: hasCursorKey ? 'set' : 'NOT SET' });

    try {
      const content = await this.runCursorAgentSpawn(args, cwd);
      console.log('[agent] Cursor CLI completed', { outputLen: content.length });
      if (options.onChunk) {
        options.onChunk(content);
      }
      return { content };
    } catch (error: unknown) {
      const err = error as { message: string; stderr?: string; killed?: boolean; signal?: string };
      console.error('[agent] Cursor CLI failed:', err.message, err.stderr ? `stderr: ${String(err.stderr).slice(0, 300)}` : '');
      const isTimeout = err.killed && err.signal === 'SIGTERM';
      const raw = isTimeout
        ? `The Cursor agent (Composer 1.5) may hang on some prompts. Try a different model in Project Settings, or use Claude instead.`
        : (err.stderr || err.message);
      throw new Error(formatAgentError('cursor', raw));
    }
  }

  /** Run Cursor agent via spawn; stream stdout/stderr to terminal and collect output */
  private runCursorAgentSpawn(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 120_000;
      let stdout = '';
      let stderr = '';

      const child = spawn('agent', args, {
        cwd,
        env: { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY || '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        if (child.killed) return;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
        if (stdout.trim()) {
          resolve(stdout.trim());
        } else {
          const err = new Error(`Cursor CLI timed out. stderr: ${stderr.slice(0, 500)}`) as Error & { killed?: boolean; signal?: string };
          err.killed = true;
          err.signal = 'SIGTERM';
          reject(err);
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

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        safeWrite(process.stdout, chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        safeWrite(process.stderr, chunk);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (code === 0 || stdout.trim()) {
          resolve(stdout.trim());
        } else {
          const err = new Error(`Cursor CLI failed: code=${code} stderr=${stderr.slice(0, 500)}`) as Error & { stderr?: string };
          err.stderr = stderr;
          reject(err);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async invokeCustomCli(options: AgentInvokeOptions): Promise<AgentResponse> {
    const { config, prompt } = options;

    if (!config.cliCommand) {
      throw new Error('Custom agent requires a CLI command');
    }

    try {
      const { stdout } = await execAsync(
        `${config.cliCommand} "${prompt.replace(/"/g, '\\"')}"`,
        {
          cwd: options.cwd || process.cwd(),
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const content = stdout.trim();
      if (options.onChunk) {
        options.onChunk(content);
      }

      return { content };
    } catch (error: unknown) {
      const err = error as { message: string; stderr?: string };
      const raw = err.stderr || err.message;
      throw new Error(formatAgentError('custom', raw));
    }
  }
}
