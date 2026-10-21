/**
 * Coding agent tools: read_file, write_file, edit_file, run_command, list_files, search_files.
 * Used by the agentic loop to give API-based providers (Claude, OpenAI, Gemini, LM Studio)
 * the same file/shell capabilities that CLI agents have natively.
 */

import { exec } from "child_process";
import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { getDeploymentMode } from "./deployment-mode.js";

const execAsync = promisify(exec);

/** Max size (bytes) to return from read_file; larger files are truncated with a note. */
const READ_FILE_MAX_BYTES = 512 * 1024;
/** Timeout for run_command (ms). */
const RUN_COMMAND_TIMEOUT_MS = 300_000;
/** Max buffer for run_command stdout/stderr (bytes). */
const RUN_COMMAND_MAX_BUFFER = 2 * 1024 * 1024;

export interface AgentToolsContext {
  /** Working directory (worktree path). All paths and commands are relative to this. */
  cwd: string;
}

/** Provider-agnostic tool definition (JSON Schema-like). */
export interface AgentToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; default?: unknown }>;
    required?: string[];
  };
}

/** Resolve a path relative to cwd and ensure it stays inside cwd. */
function resolveSafePath(cwd: string, rawPath: string): { resolved: string; error?: string } {
  const normalized = path.normalize(rawPath).replace(/^\.[/\\]/, "");
  const resolved = path.isAbsolute(normalized)
    ? path.join(cwd, path.relative("/", normalized))
    : path.join(cwd, normalized);
  const realCwd = path.resolve(cwd);
  const realResolved = path.resolve(resolved);
  if (!realResolved.startsWith(realCwd + path.sep) && realResolved !== realCwd) {
    return { resolved: realResolved, error: "Path must be inside the workspace" };
  }
  return { resolved: realResolved };
}

/** read_file(path: string) */
async function executeReadFile(args: { path: string }, ctx: AgentToolsContext): Promise<string> {
  const { resolved, error } = resolveSafePath(ctx.cwd, args.path);
  if (error) return `Error: ${error}`;
  try {
    const buf = await readFile(resolved, { encoding: null });
    const str = buf.toString("utf-8");
    if (buf.length > READ_FILE_MAX_BYTES) {
      return (
        str.slice(0, READ_FILE_MAX_BYTES) +
        `\n\n... [truncated; file is ${buf.length} bytes, showing first ${READ_FILE_MAX_BYTES}]`
      );
    }
    return str;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error reading file: ${msg}`;
  }
}

/** write_file(path: string, content: string) */
async function executeWriteFile(
  args: { path: string; content: string },
  ctx: AgentToolsContext
): Promise<string> {
  const { resolved, error } = resolveSafePath(ctx.cwd, args.path);
  if (error) return `Error: ${error}`;
  try {
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, args.content, "utf-8");
    return `Wrote ${args.path}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error writing file: ${msg}`;
  }
}

/** edit_file(path: string, old_text: string, new_text: string) */
async function executeEditFile(
  args: { path: string; old_text: string; new_text: string },
  ctx: AgentToolsContext
): Promise<string> {
  const { resolved, error } = resolveSafePath(ctx.cwd, args.path);
  if (error) return `Error: ${error}`;
  try {
    const content = await readFile(resolved, "utf-8");
    if (!content.includes(args.old_text)) {
      return `Error: old_text not found in file. Use exact string including newlines.`;
    }
    const newContent = content.replace(args.old_text, args.new_text);
    await writeFile(resolved, newContent, "utf-8");
    return `Updated ${args.path}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error editing file: ${msg}`;
  }
}

/** run_command(command: string, cwd?: string) */
async function executeRunCommand(
  args: { command: string; cwd?: string },
  ctx: AgentToolsContext
): Promise<string> {
  const workDir = args.cwd ? resolveSafePath(ctx.cwd, args.cwd).resolved : ctx.cwd;
  const { error } = resolveSafePath(ctx.cwd, args.cwd ?? ".");
  if (error) return `Error: ${error}`;
  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: workDir,
      timeout: RUN_COMMAND_TIMEOUT_MS,
      maxBuffer: RUN_COMMAND_MAX_BUFFER,
    });
    const out = stdout?.trim() ?? "";
    const err = stderr?.trim() ?? "";
    if (err && out) return `stdout:\n${out}\n\nstderr:\n${err}`;
    if (err) return `stderr:\n${err}`;
    return out || "(no output)";
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    const msg = err.message ?? String(e);
    const parts = [msg];
    if (stdout) parts.push("stdout:", stdout);
    if (stderr) parts.push("stderr:", stderr);
    return `Error: ${parts.join("\n")}`;
  }
}

const LIST_FILES_MAX_ENTRIES = 1000;

async function listFilesRecursive(
  dir: string,
  prefix: string,
  pattern: RegExp | null,
  ctx: AgentToolsContext,
  acc: string[],
  maxEntries: number
): Promise<void> {
  if (acc.length >= maxEntries) return;
  const entries = await readdir(dir, { withFileTypes: true });
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of sorted) {
    if (acc.length >= maxEntries) return;
    const name = e.isDirectory() ? e.name + "/" : e.name;
    const rel = prefix ? `${prefix}${name}` : name;
    if (pattern && !pattern.test(name)) continue;
    acc.push(rel);
    if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git") {
      await listFilesRecursive(path.join(dir, e.name), rel, pattern, ctx, acc, maxEntries);
    }
  }
}

/** list_files(path?: string, pattern?: string) */
async function executeListFiles(
  args: { path?: string; pattern?: string },
  ctx: AgentToolsContext
): Promise<string> {
  const base = args.path ?? ".";
  const { resolved, error } = resolveSafePath(ctx.cwd, base);
  if (error) return `Error: ${error}`;
  const pattern = args.pattern ? new RegExp(args.pattern) : null;
  try {
    const acc: string[] = [];
    await listFilesRecursive(resolved, "", pattern, ctx, acc, LIST_FILES_MAX_ENTRIES);
    return acc.length ? acc.join("\n") : "(empty)";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error listing directory: ${msg}`;
  }
}

/** search_files(pattern: string, path?: string) - simple line-based search, no regex by default */
async function executeSearchFiles(
  args: { pattern: string; path?: string },
  ctx: AgentToolsContext
): Promise<string> {
  const base = args.path ?? ".";
  const { resolved, error } = resolveSafePath(ctx.cwd, base);
  if (error) return `Error: ${error}`;
  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const results: string[] = [];
    const pattern = args.pattern;
    for (const e of entries) {
      const full = path.join(resolved, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const subPath = path.relative(ctx.cwd, full);
        const sub = await executeSearchFiles({ pattern, path: subPath }, ctx);
        if (sub !== "(no matches)") results.push(sub);
      } else {
        try {
          const content = await readFile(full, "utf-8");
          const lines = content.split(/\r?\n/);
          const rel = path.relative(ctx.cwd, full);
          lines.forEach((line, i) => {
            if (line.includes(pattern)) results.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
        } catch {
          // skip binary or unreadable
        }
      }
    }
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error searching: ${msg}`;
  }
}

const TOOL_DEFS: AgentToolDef[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Path is relative to the workspace. Returns file content; large files are truncated.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write or overwrite a file. Creates parent directories if needed. Path is relative to the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace a contiguous substring in a file. Use exact old_text including newlines. Fails if old_text is not found.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        old_text: { type: "string", description: "Exact string to replace" },
        new_text: { type: "string", description: "Replacement string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace (or in a subdirectory if cwd is provided). Returns stdout and stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd: { type: "string", description: "Optional subdirectory relative to workspace" },
      },
      required: ["command"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories recursively (relative to workspace). Optional regex pattern to filter entry names. Skips node_modules and .git.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path, default ." },
        pattern: {
          type: "string",
          description: "Optional JavaScript regex pattern to filter entry names",
        },
      },
    },
  },
  {
    name: "search_files",
    description:
      "Search for a string in files under a path (relative to workspace). Returns matching lines with file:line: content.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "String to search for" },
        path: { type: "string", description: "Directory to search, default ." },
      },
      required: ["pattern"],
    },
  },
];

const EXECUTORS: Record<
  string,
  (args: Record<string, unknown>, ctx: AgentToolsContext) => Promise<string>
> = {
  read_file: (a, ctx) => executeReadFile(a as { path: string }, ctx),
  write_file: (a, ctx) => executeWriteFile(a as { path: string; content: string }, ctx),
  edit_file: (a, ctx) =>
    executeEditFile(a as { path: string; old_text: string; new_text: string }, ctx),
  run_command: (a, ctx) => executeRunCommand(a as { command: string; cwd?: string }, ctx),
  list_files: (a, ctx) => executeListFiles(a as { path?: string; pattern?: string }, ctx),
  search_files: (a, ctx) => executeSearchFiles(a as { pattern: string; path?: string }, ctx),
};

/**
 * Execute a single tool call by name with the given arguments.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: AgentToolsContext
): Promise<string> {
  if (getDeploymentMode() === "isolated-hosted")
    throw new Error("Host file and shell tools are disabled in isolated-hosted mode");
  const fn = EXECUTORS[name];
  if (!fn) return `Error: unknown tool "${name}"`;
  return fn(args, context);
}

/**
 * Get provider-agnostic tool definitions.
 */
export function getAgentToolDefs(): AgentToolDef[] {
  return TOOL_DEFS;
}

/** JSON Schema object type for tool input (Anthropic/OpenAI compatible). */
export type ToolInputSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string; default?: unknown }>;
  required?: string[];
};

/**
 * Convert to Anthropic API tools format (messages.create tools parameter).
 */
export function toAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}> {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as ToolInputSchema,
  }));
}

/**
 * Convert to OpenAI chat completions tools format.
 */
export function toOpenAITools(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: ToolInputSchema };
}> {
  return TOOL_DEFS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as ToolInputSchema,
    },
  }));
}

/**
 * Convert to Google GenAI function declarations format.
 */
export function toGeminiTools(): Array<{
  name: string;
  description: string;
  parameters: object;
}> {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}
