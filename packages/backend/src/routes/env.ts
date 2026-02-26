import { Router, Request } from "express";
import path from "path";
import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApiResponse, ApiKeys } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { createLogger } from "../utils/logger.js";
import { validateApiKey } from "./models.js";
import {
  getGlobalSettings,
  updateGlobalSettings,
} from "../services/global-settings.service.js";

const execFileAsync = promisify(execFile);
const log = createLogger("env");

const ALLOWED_KEYS = ["ANTHROPIC_API_KEY", "CURSOR_API_KEY"] as const;

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
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(cmd, ["claude"], { timeout: 3000 });
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

/** Check if global store has keys for a given provider (ANTHROPIC_API_KEY or CURSOR_API_KEY) */
function globalStoreHasProvider(
  apiKeys: ApiKeys | undefined,
  provider: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY"
): boolean {
  const entries = apiKeys?.[provider];
  return Array.isArray(entries) && entries.length > 0;
}

// GET /env/global-status — Returns { hasAnyKey, useCustomCli } for modal flow.
// hasAnyKey = global store has keys OR process.env has ANTHROPIC/CURSOR OR claudeCli available.
envRouter.get("/global-status", async (_req, res, next) => {
  try {
    const settings = await getGlobalSettings();
    const fromGlobalStore = globalStoreHasKeys(settings.apiKeys);
    const fromEnv =
      Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
      Boolean(process.env.CURSOR_API_KEY?.trim());
    const claudeCli = await isClaudeCliAvailable();
    const hasAnyKey = fromGlobalStore || fromEnv || claudeCli;
    const useCustomCli = settings.useCustomCli ?? false;

    res.json({
      data: { hasAnyKey, useCustomCli },
    } as ApiResponse<{ hasAnyKey: boolean; useCustomCli: boolean }>);
  } catch (err) {
    next(err);
  }
});

// PUT /env/global-settings — Update global settings (e.g. useCustomCli).
envRouter.put("/global-settings", async (req: Request, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// GET /env/keys — Check which API keys / CLIs are configured (never returns key values).
// Keys are read from global store first, then process.env. Return anthropic/cursor true if any source has them.
envRouter.get("/keys", async (_req, res, next) => {
  try {
    const settings = await getGlobalSettings();
    const anthropic =
      Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
      globalStoreHasProvider(settings.apiKeys, "ANTHROPIC_API_KEY");
    const cursor =
      Boolean(process.env.CURSOR_API_KEY?.trim()) ||
      globalStoreHasProvider(settings.apiKeys, "CURSOR_API_KEY");
    const claudeCli = await isClaudeCliAvailable();
    const useCustomCli = settings.useCustomCli ?? false;
    res.json({
      data: { anthropic, cursor, claudeCli, useCustomCli },
    } as ApiResponse<{
      anthropic: boolean;
      cursor: boolean;
      claudeCli: boolean;
      useCustomCli: boolean;
    }>);
  } catch (err) {
    next(err);
  }
});

// POST /env/keys/validate — Validate an API key via minimal API call (Claude: list models limit 1; Cursor: GET /v0/models).
envRouter.post("/keys/validate", async (req: Request, res, next) => {
  try {
    const { provider, value } = req.body as { provider?: string; value?: string };
    if (!provider || typeof value !== "string") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "provider and value are required");
    }
    if (provider !== "claude" && provider !== "cursor") {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "provider must be 'claude' or 'cursor'"
      );
    }

    const result = await validateApiKey(provider, value);
    res.json({
      data: result.valid ? { valid: true } : { valid: false, error: result.error },
    } as ApiResponse<{ valid: boolean; error?: string }>);
  } catch (err) {
    next(err);
  }
});

// POST /env/keys — Save an API key to .env (creates file if missing).
// Used as global fallback when no project-level keys are configured. Project keys take precedence.
envRouter.post("/keys", async (req: Request, res, next) => {
  try {
    const { key, value } = req.body as { key?: string; value?: string };
    if (!key || typeof value !== "string") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "key and value are required");
    }
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
  } catch (err) {
    next(err);
  }
});
