import { Router, Request } from "express";
import type { ApiResponse } from "@opensprint/shared";
import {
  maskDatabaseUrl,
  maskApiKeysForResponse,
  validateDatabaseUrl,
  DEFAULT_DATABASE_URL,
  API_KEY_PROVIDERS,
  type GlobalSettingsResponse,
  type ApiKeyProvider,
} from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import type { GlobalSettings } from "@opensprint/shared";
import { getGlobalSettings, updateGlobalSettings } from "../services/global-settings.service.js";
import { clearLimitHit } from "../services/api-key-resolver.service.js";
import { clearExhaustedForProviderAcrossAllProjects } from "../services/api-key-exhausted.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { getProjects } from "../services/project-index.js";
import { runSchema } from "../db/schema.js";
import { createPostgresDbClientFromUrl } from "../db/client.js";
import { databaseRuntime } from "../services/database-runtime.service.js";

export const globalSettingsRouter = Router();

function buildResponse(settings: GlobalSettings) {
  const effectiveUrl = settings.databaseUrl ?? DEFAULT_DATABASE_URL;
  return {
    databaseUrl: maskDatabaseUrl(effectiveUrl),
    ...(settings.apiKeys && { apiKeys: maskApiKeysForResponse(settings.apiKeys) }),
  };
}

// GET /global-settings/reveal-key/:provider/:id — Returns the raw value for a single API key (for reveal-on-click after refresh).
globalSettingsRouter.get("/reveal-key/:provider/:id", async (req, res, next) => {
  try {
    const provider = req.params.provider as ApiKeyProvider;
    const id = req.params.id;
    if (!API_KEY_PROVIDERS.includes(provider) || !id || typeof id !== "string") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Invalid provider or id");
    }
    const settings = await getGlobalSettings();
    const entries = settings.apiKeys?.[provider];
    const entry = entries?.find((e) => e.id === id);
    if (!entry?.value) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, "API key not found");
    }
    res.json({ data: { value: entry.value } } as ApiResponse<{ value: string }>);
  } catch (err) {
    next(err);
  }
});

// POST /global-settings/clear-limit-hit/:provider/:id — Clears limitHitAt for a rate-limited key so it can be retried.
// On success, clears exhausted state for that provider and nudges the orchestrator for all projects
// so work can resume promptly after API access is restored.
globalSettingsRouter.post("/clear-limit-hit/:provider/:id", async (req, res, next) => {
  try {
    const provider = req.params.provider as ApiKeyProvider;
    const id = req.params.id;
    if (!API_KEY_PROVIDERS.includes(provider) || !id || typeof id !== "string") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Invalid provider or id");
    }
    await clearLimitHit("", provider, id, "global");
    clearExhaustedForProviderAcrossAllProjects(provider);
    const projects = await getProjects();
    for (const p of projects) {
      orchestratorService.nudge(p.id);
    }
    const settings = await getGlobalSettings();
    res.json({
      data: buildResponse(settings),
    } as ApiResponse<GlobalSettingsResponse>);
  } catch (err) {
    next(err);
  }
});

// POST /global-settings/setup-tables — Runs schema setup against provided databaseUrl. Session-only; does not persist URL.
globalSettingsRouter.post("/setup-tables", async (req: Request, res, next) => {
  try {
    const body = req.body as { databaseUrl?: string };
    if (body.databaseUrl === undefined || typeof body.databaseUrl !== "string") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "databaseUrl must be a string");
    }
    const trimmed = body.databaseUrl.trim();
    if (!trimmed) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "databaseUrl cannot be empty");
    }
    let databaseUrl: string;
    try {
      databaseUrl = validateDatabaseUrl(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid database URL";
      throw new AppError(400, ErrorCodes.INVALID_INPUT, msg);
    }
    const { client, pool } = await createPostgresDbClientFromUrl(databaseUrl);
    try {
      await runSchema(client);
    } finally {
      await pool.end();
    }
    databaseRuntime.requestReconnect("setup-tables");
    res.json({ data: { ok: true } } as ApiResponse<{ ok: boolean }>);
  } catch (err) {
    next(err);
  }
});

// GET /global-settings — Returns databaseUrl masked (host/port visible, password redacted), apiKeys masked.
globalSettingsRouter.get("/", async (_req, res, next) => {
  try {
    const settings = await getGlobalSettings();
    res.json({
      data: buildResponse(settings),
    } as ApiResponse<GlobalSettingsResponse>);
  } catch (err) {
    next(err);
  }
});

// PUT /global-settings — Accepts databaseUrl, apiKeys. Validates and sanitizes. Merge apiKeys with existing (preserve value when id exists and value omitted).
globalSettingsRouter.put("/", async (req: Request, res, next) => {
  try {
    const body = req.body as { databaseUrl?: string; apiKeys?: unknown };
    const updates: { databaseUrl?: string; apiKeys?: unknown } = {};
    const previous = await getGlobalSettings();

    if (body.databaseUrl !== undefined) {
      if (typeof body.databaseUrl !== "string") {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "databaseUrl must be a string");
      }
      const trimmed = body.databaseUrl.trim();
      if (!trimmed) {
        throw new AppError(400, ErrorCodes.INVALID_INPUT, "databaseUrl cannot be empty");
      }
      try {
        updates.databaseUrl = validateDatabaseUrl(trimmed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid database URL";
        throw new AppError(400, ErrorCodes.INVALID_INPUT, msg);
      }
    }

    if (body.apiKeys !== undefined) {
      updates.apiKeys = body.apiKeys;
    }

    if (Object.keys(updates).length === 0) {
      const current = await getGlobalSettings();
      return res.json({
        data: buildResponse(current),
      } as ApiResponse<GlobalSettingsResponse>);
    }

    const updated = await updateGlobalSettings(updates as Partial<GlobalSettings>);
    if (updates.databaseUrl !== undefined && updates.databaseUrl !== previous.databaseUrl) {
      databaseRuntime.requestReconnect("settings-updated");
    }
    res.json({
      data: buildResponse(updated),
    } as ApiResponse<GlobalSettingsResponse>);
  } catch (err) {
    next(err);
  }
});
