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
import {
  getGlobalSettings,
  updateGlobalSettings,
} from "../services/global-settings.service.js";

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

    if (body.databaseUrl !== undefined) {
      if (typeof body.databaseUrl !== "string") {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          "databaseUrl must be a string"
        );
      }
      const trimmed = body.databaseUrl.trim();
      if (!trimmed) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          "databaseUrl cannot be empty"
        );
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

    const updated = await updateGlobalSettings(updates);
    res.json({
      data: buildResponse(updated),
    } as ApiResponse<GlobalSettingsResponse>);
  } catch (err) {
    next(err);
  }
});
