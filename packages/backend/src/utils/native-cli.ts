import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "child_process";
import { normalizeSpawnEnvPath } from "./path-env.js";

export type NativeCliProvider = "claude-cli" | "codex";

/** Resolve GUI installs too: Finder's PATH can omit the CLI shipped with ChatGPT. */
export function resolveNativeCliCommand(provider: NativeCliProvider): string {
  const executable = provider === "codex" ? "codex" : "claude";
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executable));
  candidates.push(path.join(os.homedir(), ".local", "bin", executable));
  if (process.platform === "darwin" && provider === "codex") {
    candidates.push(
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/Applications/Codex.app/Contents/Resources/codex"
    );
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* Try the next installed location, including broken PATH symlinks. */
    }
  }
  return executable;
}

/** A subscription CLI must never silently inherit API-key billing or alternate gateways. */
export function buildNativeCliEnv(provider: NativeCliProvider): NodeJS.ProcessEnv {
  const env = normalizeSpawnEnvPath({ ...process.env });
  const keys =
    provider === "codex"
      ? ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"]
      : [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_VERTEX",
          "CLAUDE_CODE_USE_FOUNDRY",
        ];
  for (const key of keys) delete env[key];
  return env;
}

export function buildCodexArgs(model: string | null, coding: boolean): string[] {
  return [
    "-a",
    "never",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'model_provider="openai"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "exec",
    "--sandbox",
    coding ? "workspace-write" : "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    ...(model && model !== "default" ? ["--model", model] : []),
    "-",
  ];
}

/** Check effective auth in the same project: apiKeyHelper settings outrank subscription login. */
export async function assertClaudeSubscription(cwd: string): Promise<void> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      resolveNativeCliCommand("claude-cli"),
      ["auth", "status"],
      {
        cwd,
        env: buildNativeCliEnv("claude-cli"),
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
      (error, output) => {
        if (error)
          reject(
            new Error(
              "Claude Code is not signed in. Run claude auth login with your Claude subscription."
            )
          );
        else resolve(String(output));
      }
    );
  });
  let status: { loggedIn?: boolean; authMethod?: string };
  try {
    status = JSON.parse(stdout);
  } catch {
    throw new Error(
      "Could not verify Claude Code subscription sign-in. Update Claude Code and run claude auth login."
    );
  }
  if (!status.loggedIn || !["claude.ai", "oauth_token"].includes(status.authMethod ?? "")) {
    throw new Error(
      "Claude Code subscription sign-in required. Run claude auth login with your Claude account and remove apiKeyHelper or API-key settings for this project."
    );
  }
}
