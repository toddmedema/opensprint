import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBackendRuntimeInfo, type BackendRuntimeInfo } from "./runtime-info.js";

const execFileAsync = promisify(execFile);

interface BrowserOpenAttempt {
  command: string;
  args: string[];
}

interface BrowserOpenOptions {
  runtime?: BackendRuntimeInfo;
  hasCommand?: (command: string) => Promise<boolean>;
  runCommand?: (command: string, args: string[]) => Promise<void>;
}

export interface BrowserOpenResult {
  status: "opened" | "logged" | "failed";
  command?: string;
  error?: string;
}

async function defaultHasCommand(command: string, runtime: BackendRuntimeInfo): Promise<boolean> {
  const lookupCommand = runtime.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(lookupCommand, [command], { timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function defaultRunCommand(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { windowsHide: true });
}

async function buildOpenAttempts(
  url: string,
  runtime: BackendRuntimeInfo,
  hasCommand: (command: string) => Promise<boolean>
): Promise<BrowserOpenAttempt[]> {
  if (runtime.isWsl) {
    const attempts: BrowserOpenAttempt[] = [];
    if (await hasCommand("wslview")) {
      attempts.push({ command: "wslview", args: [url] });
    }
    attempts.push({ command: "cmd.exe", args: ["/c", "start", "", url] });
    return attempts;
  }

  if (runtime.platform === "darwin") {
    return [{ command: "open", args: [url] }];
  }

  if (runtime.platform === "win32") {
    return [{ command: "cmd.exe", args: ["/c", "start", "", url] }];
  }

  return [{ command: "xdg-open", args: [url] }];
}

export async function openBrowser(
  url: string,
  options: BrowserOpenOptions = {}
): Promise<BrowserOpenResult> {
  const runtime = options.runtime ?? getBackendRuntimeInfo();
  const hasCommand = options.hasCommand ?? ((command) => defaultHasCommand(command, runtime));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const attempts = await buildOpenAttempts(url, runtime, hasCommand);
  let lastError: string | undefined;

  for (const attempt of attempts) {
    try {
      await runCommand(attempt.command, attempt.args);
      return { status: "opened", command: attempt.command };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return runtime.isWsl
    ? { status: "logged", error: lastError }
    : { status: "failed", error: lastError };
}
