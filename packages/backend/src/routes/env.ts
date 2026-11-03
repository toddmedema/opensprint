import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateBody } from "../middleware/validate.js";
import {
  envGlobalSettingsBodySchema,
  envKeysValidateBodySchema,
  envKeysPostBodySchema,
} from "../schemas/request-env.js";
import path from "path";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BackendPlatform } from "@opensprint/shared";
import type {
  ApiResponse,
  ApiKeys,
  ApiKeyEntry,
  ApiKeyProvider,
  EnvRuntimeResponse,
} from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { createLogger } from "../utils/logger.js";
import { getBackendRuntimeInfo } from "../utils/runtime-info.js";
import { getFsBrowsePolicyRuntimeInfo } from "../utils/fs-allowed-root.js";
import { validateApiKey } from "./env-keys-validate.js";
import { getGlobalSettings, updateGlobalSettings } from "../services/global-settings.service.js";
import { resolveNativeCliCommand } from "../utils/native-cli.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const log = createLogger("env");

/** Check if Git and Node.js are available on PATH (for installation checklist). */
async function checkPrerequisites(): Promise<{ missing: string[] }> {
  const missing: string[] = [];
  const timeout = 5000;
  const isCommandNotFound = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
    return (
      code === "ENOENT" ||
      /command not found/i.test(msg) ||
      /not recognized/i.test(msg) ||
      /not found/i.test(msg)
    );
  };
  try {
    await execAsync("git --version", { timeout });
  } catch (err) {
    if (isCommandNotFound(err)) missing.push("Git");
    else throw err;
  }
  try {
    await execAsync("node --version", { timeout });
  } catch (err) {
    if (isCommandNotFound(err)) missing.push("Node.js");
    else throw err;
  }
  return { missing };
}

const ALLOWED_KEYS = [
  "ANTHROPIC_API_KEY",
  "CURSOR_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

/** Override for tests when process.chdir is not available (e.g. Vitest workers). Set to null in production. */
let envPathForTesting: string | null = null;
export function setEnvPathForTesting(path: string | null): void {
  envPathForTesting = path;
}

async function getEnvPath(): Promise<string> {
  if (envPathForTesting !== null) return envPathForTesting;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "../.env"),
    path.resolve(cwd, "../../.env"),
  ];
  for (const p of candidates) {
    try {
      await access(p, constants.R_OK);
      return p;
    } catch (_err) {
      log.debug("Env path not readable, skipping", { path: p });
      continue;
    }
  }
  return path.resolve(cwd, "../../.env");
}

function parseEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function serializeEnv(map: Map<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of map) {
    const escaped =
      value.includes(" ") || value.includes("#") ? `"${value.replace(/"/g, '\\"')}"` : value;
    lines.push(`${key}=${escaped}`);
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

export const envRouter = Router();

/** Check whether the `claude` CLI binary is on $PATH */
async function isClaudeCliAvailable(): Promise<boolean> {
  try {
    if (path.isAbsolute(resolveNativeCliCommand("claude-cli"))) return true;
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(cmd, ["claude"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function isCodexCliAvailable(): Promise<boolean> {
  try {
    const command = resolveNativeCliCommand("codex");
    if (path.isAbsolute(command)) return true;
    await execFileAsync(process.platform === "win32" ? "where" : "which", [command], {
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Check whether the Cursor `agent` CLI binary is on $PATH */
async function isCursorCliAvailable(): Promise<boolean> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(cmd, ["agent"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Check whether the Ollama CLI binary is on $PATH */
async function isOllamaCliAvailable(): Promise<boolean> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(cmd, ["ollama"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Check if global store has any API keys configured */
function globalStoreHasKeys(apiKeys: { [key: string]: unknown[] } | undefined): boolean {
  if (!apiKeys || typeof apiKeys !== "object") return false;
  for (const entries of Object.values(apiKeys)) {
    if (Array.isArray(entries) && entries.length > 0) return true;
  }
  return false;
}

/** Check if global store has keys for a given provider */
function globalStoreHasProvider(
  apiKeys: ApiKeys | undefined,
  provider: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY"
): boolean {
  const entries = apiKeys?.[provider];
  return Array.isArray(entries) && entries.length > 0;
}

// GET /env/runtime — Platform / WSL detection for the frontend.
envRouter.get(
  "/runtime",
  wrapAsync(async (_req, res) => {
    res.json({
      data: {
        ...getBackendRuntimeInfo(),
        fsBrowsePolicy: getFsBrowsePolicyRuntimeInfo(),
      },
    } as ApiResponse<EnvRuntimeResponse>);
  })
);

// GET /env/prerequisites — For installation checklist on home: which of Git/Node are missing + platform for install URLs.
envRouter.get(
  "/prerequisites",
  wrapAsync(async (_req, res) => {
    const { missing } = await checkPrerequisites();
    const runtime = getBackendRuntimeInfo();
    res.json({
      data: { missing, platform: runtime.platform },
    } as ApiResponse<{ missing: string[]; platform: BackendPlatform }>);
  })
);

envRouter.get(
  "/global-status",
  wrapAsync(async (_req, res) => {
    const settings = await getGlobalSettings();
    const fromGlobalStore = globalStoreHasKeys(settings.apiKeys);
    const fromEnv =
      Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
      Boolean(process.env.CURSOR_API_KEY?.trim()) ||
      Boolean(process.env.OPENAI_API_KEY?.trim()) ||
      Boolean(process.env.GOOGLE_API_KEY?.trim());
    const hasAnyKey = fromGlobalStore || fromEnv;
    const useCustomCli = settings.useCustomCli ?? false;
    const hasLocalProvider = [settings.simpleComplexityAgent, settings.complexComplexityAgent].some(
      (agent) =>
        agent && ["claude-cli", "codex", "lmstudio", "ollama", "custom"].includes(agent.type)
    );

    res.json({
      data: { hasAnyKey, useCustomCli, hasLocalProvider },
    } as ApiResponse<{ hasAnyKey: boolean; useCustomCli: boolean; hasLocalProvider: boolean }>);
  })
);

// PUT /env/global-settings — Update global settings (e.g. useCustomCli).
envRouter.put(
  "/global-settings",
  validateBody(envGlobalSettingsBodySchema),
  wrapAsync(async (req: Request, res) => {
    const body = req.body as { useCustomCli?: boolean };
    const updates: { useCustomCli?: boolean } = {};
    if (typeof body.useCustomCli === "boolean") {
      updates.useCustomCli = body.useCustomCli;
    }
    if (Object.keys(updates).length === 0) {
      const current = await getGlobalSettings();
      return res.json({
        data: { useCustomCli: current.useCustomCli ?? false },
      } as ApiResponse<{ useCustomCli: boolean }>);
    }
    const updated = await updateGlobalSettings(updates);
    res.json({
      data: { useCustomCli: updated.useCustomCli ?? false },
    } as ApiResponse<{ useCustomCli: boolean }>);
  })
);

// GET /env/keys — Check which API keys / CLIs are configured (never returns key values).
// Keys are read from global store first, then process.env. Return anthropic/cursor/openai true if any source has them.
envRouter.get(
  "/keys",
  wrapAsync(async (_req, res) => {
    const settings = await getGlobalSettings();
    const anthropic =
      Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
      globalStoreHasProvider(settings.apiKeys, "ANTHROPIC_API_KEY");
    const cursor =
      Boolean(process.env.CURSOR_API_KEY?.trim()) ||
      globalStoreHasProvider(settings.apiKeys, "CURSOR_API_KEY");
    const openai =
      Boolean(process.env.OPENAI_API_KEY?.trim()) ||
      globalStoreHasProvider(settings.apiKeys, "OPENAI_API_KEY");
    const google =
      Boolean(process.env.GOOGLE_API_KEY?.trim()) ||
      globalStoreHasProvider(settings.apiKeys, "GOOGLE_API_KEY");
    const [claudeCli, codexCli, cursorCli, ollamaCli] = await Promise.all([
      isClaudeCliAvailable(),
      isCodexCliAvailable(),
      isCursorCliAvailable(),
      isOllamaCliAvailable(),
    ]);
    const useCustomCli = settings.useCustomCli ?? false;
    res.json({
      data: {
        anthropic,
        cursor,
        openai,
        google,
        claudeCli,
        codexCli,
        cursorCli,
        ollamaCli,
        useCustomCli,
      },
    } as ApiResponse<{
      anthropic: boolean;
      cursor: boolean;
      openai: boolean;
      google: boolean;
      claudeCli: boolean;
      codexCli: boolean;
      cursorCli: boolean;
      ollamaCli: boolean;
      useCustomCli: boolean;
    }>);
  })
);

/** Official Cursor install page URLs. */
const CURSOR_CLI_INSTALL_UNIX = "https://cursor.com/install";
const CURSOR_CLI_INSTALL_WIN = "https://cursor.com/install?win32=true";

// POST /env/cursor-cli-install — Return manual install instructions instead of
// piping remote scripts (curl|bash / irm|iex) which is RCE if the CDN is compromised.
envRouter.post(
  "/cursor-cli-install",
  wrapAsync(async (_req, res) => {
    const isWin = process.platform === "win32";
    const installUrl = isWin ? CURSOR_CLI_INSTALL_WIN : CURSOR_CLI_INSTALL_UNIX;
    const manualCommand = isWin
      ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${CURSOR_CLI_INSTALL_WIN}' | iex"`
      : `curl -fsSL "${CURSOR_CLI_INSTALL_UNIX}" | bash`;
    const platform = process.platform;

    res.json({
      data: {
        success: true,
        message:
          "Review and run the install command below in your terminal, or visit the install page directly. Restart your terminal or Open Sprint after installation so the agent command is available.",
        installUrl,
        manualCommand,
        platform,
      },
    } as ApiResponse<{
      success: boolean;
      message: string;
      installUrl: string;
      manualCommand: string;
      platform: string;
    }>);
  })
);

// POST /env/keys/validate — Validate an API key via minimal API call (Claude: list models limit 1; Cursor: GET /v0/models).
envRouter.post(
  "/keys/validate",
  validateBody(envKeysValidateBodySchema),
  wrapAsync(async (req: Request, res) => {
    const { provider, value } = req.body as { provider: string; value: string };

    const result = await validateApiKey(
      provider as "claude" | "cursor" | "openai" | "google",
      value
    );
    res.json({
      data: result.valid ? { valid: true } : { valid: false, error: result.error },
    } as ApiResponse<{ valid: boolean; error?: string }>);
  })
);

// POST /env/keys — Save an API key to global store and .env (backward compat).
// Writes to ~/.opensprint/global-settings.json (merge with existing apiKeys) and .env.
envRouter.post(
  "/keys",
  validateBody(envKeysPostBodySchema),
  wrapAsync(async (req: Request, res) => {
    const { key, value } = req.body as { key: string; value: string };
    if (!ALLOWED_KEYS.includes(key as (typeof ALLOWED_KEYS)[number])) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_KEY,
        `Only ${ALLOWED_KEYS.join(", ")} can be set via this endpoint`
      );
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "value cannot be empty");
    }

    const provider = key as ApiKeyProvider;
    const newEntry: ApiKeyEntry = {
      id: randomUUID(),
      value: trimmed,
    };

    // Persist to global store (merge with existing apiKeys)
    const settings = await getGlobalSettings();
    const existingEntries = settings.apiKeys?.[provider] ?? [];
    const mergedApiKeys: ApiKeys = {
      ...settings.apiKeys,
      [provider]: [...existingEntries, newEntry],
    };
    await updateGlobalSettings({ apiKeys: mergedApiKeys });

    // Keep .env write for backward compat
    const envPath = await getEnvPath();
    let content = "";
    try {
      content = await readFile(envPath, "utf-8");
    } catch {
      log.debug("No existing .env, will create or overwrite", { envPath });
      content = "";
    }

    const map = parseEnv(content);
    map.set(key, trimmed);
    const output = serializeEnv(map);

    try {
      await writeFile(envPath, output, "utf-8");
    } catch (writeErr) {
      const msg = getErrorMessage(writeErr);
      const code = (writeErr as NodeJS.ErrnoException)?.code;
      const hint =
        code === "EACCES"
          ? " Permission denied. Ensure the .env file is writable."
          : code === "EROFS"
            ? " Read-only filesystem. Cannot write .env."
            : "";
      throw new AppError(
        500,
        ErrorCodes.ENV_WRITE_FAILED,
        `Failed to save API key to .env: ${msg}${hint}`,
        { cause: msg }
      );
    }

    process.env[key] = trimmed;

    res.json({ data: { saved: true } } as ApiResponse<{ saved: boolean }>);
  })
);
