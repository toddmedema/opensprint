import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EvidenceItem } from "../domain.js";
import { ForgeError } from "../errors.js";
import { redactText, sanitizedEnv } from "../redact.js";
import { assertCommand } from "../runbook/runbook.js";

export interface CommandResult extends EvidenceItem {
  timedOut: boolean;
}

export function runArgv(options: {
  argv: string[];
  cwd: string;
  timeoutSec: number;
  checkoutRoot: string;
  env?: NodeJS.ProcessEnv;
  secrets?: string[];
  extraEnv?: Record<string, string>;
  stdin?: string;
}): Promise<CommandResult> {
  const relativeCwd = path.relative(options.checkoutRoot, options.cwd) || ".";
  const resolved = assertCommand(
    { argv: options.argv, cwd: relativeCwd, timeoutSec: options.timeoutSec },
    { allowEnv: false, checkoutRoot: options.checkoutRoot }
  );
  const spawnCwd = path.resolve(options.checkoutRoot, resolved.cwd);
  assertRealpathInside(options.checkoutRoot, spawnCwd);
  const command = options.argv
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
  const env = sanitizedEnv(options.env ?? process.env, options.secrets ?? [], options.extraEnv);
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(options.argv[0] ?? "", options.argv.slice(1), {
      cwd: spawnCwd,
      env,
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (options.stdin) child.stdin?.end(options.stdin);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutSec * 1000);
    const take = (chunk: Buffer) => {
      if (output.length < 8000) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const finish = (exitCode: number, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        excerpt: redactText(output, options.secrets ?? []),
        timedOut,
      });
    };
    child.once("error", (error) => {
      output += error.message;
      finish(127, false);
    });
    child.once("exit", (code, signal) => {
      finish(code ?? (signal ? 124 : 1), signal === "SIGKILL");
    });
  });
}

function assertRealpathInside(checkoutRoot: string, cwd: string): void {
  if (!fs.existsSync(checkoutRoot) || !fs.existsSync(cwd)) return;
  const root = fs.realpathSync(checkoutRoot);
  const dir = fs.realpathSync(cwd);
  const relative = path.relative(root, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ForgeError(400, "invalid_cwd", "cwd must stay inside the checkout.");
  }
}

export function resolveTool(name: string): string | null {
  if (name.includes("/") || name.includes("\\")) return null;
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

export function commandFailure(result: CommandResult): ForgeError | null {
  if (result.exitCode === 0) return null;
  return new ForgeError(400, "command_failed", `${result.command} exited ${result.exitCode}`);
}
