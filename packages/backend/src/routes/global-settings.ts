import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateParams, validateBody } from "../middleware/validate.js";
import {
  apiKeyProviderParamSchema,
  migrateToPostgresBodySchema,
  setupTablesBodySchema,
  globalSettingsPutBodySchema,
} from "../schemas/request-global-settings.js";
import type { ApiResponse } from "@opensprint/shared";
import {
  maskDatabaseUrl,
  maskApiKeysForResponse,
  maskTodoistOAuthForResponse,
  validateDatabaseUrl,
  getDatabaseDialect,
  parsePreferredEditor,
  parseTodoistOAuthCredentials,
  type GlobalSettingsResponse,
  type ApiKeyProvider,
} from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import type { ApiKeysUpdate, GlobalSettings } from "@opensprint/shared";
import {
  getGlobalSettings,
  updateGlobalSettings,
  getEffectiveDatabaseConfig,
  getDefaultDatabaseUrl,
  type GlobalSettingsPartialUpdate,
} from "../services/global-settings.service.js";
import { migrateSqliteToPostgres } from "../services/migrate-to-postgres.service.js";
import { clearLimitHit } from "../services/api-key-resolver.service.js";
import { clearExhaustedForProviderAcrossAllProjects } from "../services/api-key-exhausted.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { getProjects } from "../services/project-index.js";
import { initAppDb } from "../db/app-db.js";
import { databaseRuntime } from "../services/database-runtime.service.js";
import { parseAgentConfig } from "../schemas/agent-config.js";
import { guardGovernedGlobalSettings } from "../middleware/governance-settings.js";

export const globalSettingsRouter = Router();

function buildResponse(settings: GlobalSettings) {
  const effectiveUrl = settings.databaseUrl ?? getDefaultDatabaseUrl();
  const maskedTodoist = maskTodoistOAuthForResponse(settings.todoistOAuth);
  return {
    databaseUrl: maskDatabaseUrl(effectiveUrl),
    databaseDialect: getDatabaseDialect(effectiveUrl),
    ...(settings.apiKeys && { apiKeys: maskApiKeysForResponse(settings.apiKeys) }),
    showNotificationDotInMenuBar: settings.showNotificationDotInMenuBar !== false,
    showRunningAgentCountInMenuBar: settings.showRunningAgentCountInMenuBar !== false,
    ...(settings.simpleComplexityAgent && {
      simpleComplexityAgent: settings.simpleComplexityAgent,
    }),
    ...(settings.complexComplexityAgent && {
      complexComplexityAgent: settings.complexComplexityAgent,
    }),
    preferredEditor: settings.preferredEditor ?? "auto",
    ...(maskedTodoist && { todoistOAuth: maskedTodoist }),
  };
}

// GET /global-settings/reveal-key/:provider/:id — Returns the raw value for a single API key (for reveal-on-click after refresh).
globalSettingsRouter.get(
  "/reveal-key/:provider/:id",
  validateParams(apiKeyProviderParamSchema),
  wrapAsync(async (req, res) => {
    const provider = req.params.provider as ApiKeyProvider;
    const id = Array.isArray(req.params.id) ? (req.params.id[0] ?? "") : req.params.id;
    const settings = await getGlobalSettings();
    const entries = settings.apiKeys?.[provider];
    const entry = entries?.find((e) => e.id === id);
    if (!entry?.value) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, "API key not found");
    }
    res.json({ data: { value: entry.value } } as ApiResponse<{ value: string }>);
  })
);

// GET /global-settings/reveal-todoist-secret — Returns the raw clientSecret for reveal-on-click.
globalSettingsRouter.get(
  "/reveal-todoist-secret",
  wrapAsync(async (_req, res) => {
    const settings = await getGlobalSettings();
    const secret = settings.todoistOAuth?.clientSecret;
    if (!secret) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, "Todoist client secret not configured");
    }
    res.json({ data: { value: secret } } as ApiResponse<{ value: string }>);
  })
);

// POST /global-settings/clear-limit-hit/:provider/:id — Clears key disable markers so it can be retried.
// On success, clears exhausted state for that provider and nudges the orchestrator for all projects
// so work can resume promptly after API access is restored.
globalSettingsRouter.post(
  "/clear-limit-hit/:provider/:id",
  validateParams(apiKeyProviderParamSchema),
  wrapAsync(async (req, res) => {
    const provider = req.params.provider as ApiKeyProvider;
    const id = Array.isArray(req.params.id) ? (req.params.id[0] ?? "") : req.params.id;
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
  })
);

// POST /global-settings/migrate-to-postgres — Copy data from current DB (SQLite) to target Postgres, then switch.
globalSettingsRouter.post(
  "/migrate-to-postgres",
  validateBody(migrateToPostgresBodySchema),
  guardGovernedGlobalSettings,
  wrapAsync(async (req: Request, res) => {
    const body = req.body as { databaseUrl: string };
    const trimmed = body.databaseUrl.trim();
    if (!trimmed) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "databaseUrl cannot be empty");
    }
    let targetUrl: string;
    try {
      targetUrl = validateDatabaseUrl(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid database URL";
      throw new AppError(400, ErrorCodes.INVALID_INPUT, msg);
    }
    if (getDatabaseDialect(targetUrl) !== "postgres") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Target must be a PostgreSQL URL");
    }

    const { databaseUrl: sourceUrl } = await getEffectiveDatabaseConfig();
    if (getDatabaseDialect(sourceUrl) === "postgres") {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "Already using PostgreSQL. Change database URL in Settings if needed."
      );
    }

    await migrateSqliteToPostgres(sourceUrl, targetUrl);
    await updateGlobalSettings({ databaseUrl: targetUrl });
    databaseRuntime.requestReconnect("migrate-to-postgres");

    res.json({
      data: { ok: true, message: "Migration complete. Reconnecting..." },
    } as ApiResponse<{ ok: boolean; message: string }>);
  })
);

// POST /global-settings/setup-tables — Runs schema setup against provided databaseUrl. Session-only; does not persist URL.
globalSettingsRouter.post(
  "/setup-tables",
  validateBody(setupTablesBodySchema),
  wrapAsync(async (req: Request, res) => {
    const body = req.body as { databaseUrl: string };
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
    const appDb = await initAppDb(databaseUrl);
    try {
      await appDb.getClient();
    } finally {
      await appDb.close();
    }
    databaseRuntime.requestReconnect("setup-tables");
    res.json({ data: { ok: true } } as ApiResponse<{ ok: boolean }>);
  })
);

// GET /global-settings — Returns databaseUrl masked (host/port visible, password redacted), apiKeys masked.
globalSettingsRouter.get(
  "/",
  wrapAsync(async (_req, res) => {
    const settings = await getGlobalSettings();
    res.json({
      data: buildResponse(settings),
    } as ApiResponse<GlobalSettingsResponse>);
  })
);

// PUT /global-settings — Accepts databaseUrl, apiKeys, menu bar toggles, simpleComplexityAgent / complexComplexityAgent (or null to clear). Validates and sanitizes. Merge apiKeys with existing (preserve value when id exists and value omitted).
globalSettingsRouter.put(
  "/",
  validateBody(globalSettingsPutBodySchema),
  guardGovernedGlobalSettings,
  wrapAsync(async (req: Request, res) => {
    const body = req.body as {
      databaseUrl?: string;
      apiKeys?: unknown;
      showNotificationDotInMenuBar?: boolean;
      showRunningAgentCountInMenuBar?: boolean;
      simpleComplexityAgent?: unknown;
      complexComplexityAgent?: unknown;
      preferredEditor?: unknown;
      todoistOAuth?: unknown;
    };
    const updates: GlobalSettingsPartialUpdate = {};
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
      updates.apiKeys = body.apiKeys as ApiKeysUpdate;
    }

    if (body.showNotificationDotInMenuBar !== undefined) {
      updates.showNotificationDotInMenuBar = Boolean(body.showNotificationDotInMenuBar);
    }

    if (body.showRunningAgentCountInMenuBar !== undefined) {
      updates.showRunningAgentCountInMenuBar = Boolean(body.showRunningAgentCountInMenuBar);
    }

    if (Object.prototype.hasOwnProperty.call(body, "simpleComplexityAgent")) {
      if (body.simpleComplexityAgent === null) {
        updates.simpleComplexityAgent = null;
      } else if (body.simpleComplexityAgent !== undefined) {
        updates.simpleComplexityAgent = parseAgentConfig(
          body.simpleComplexityAgent,
          "simpleComplexityAgent"
        );
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "complexComplexityAgent")) {
      if (body.complexComplexityAgent === null) {
        updates.complexComplexityAgent = null;
      } else if (body.complexComplexityAgent !== undefined) {
        updates.complexComplexityAgent = parseAgentConfig(
          body.complexComplexityAgent,
          "complexComplexityAgent"
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "preferredEditor")) {
      if (body.preferredEditor === null) {
        updates.preferredEditor = null;
      } else if (body.preferredEditor !== undefined) {
        const pe = parsePreferredEditor(body.preferredEditor);
        if (!pe) {
          throw new AppError(
            400,
            ErrorCodes.INVALID_INPUT,
            'preferredEditor must be "vscode", "cursor", or "auto"'
          );
        }
        updates.preferredEditor = pe;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "todoistOAuth")) {
      if (body.todoistOAuth === null) {
        updates.todoistOAuth = null;
      } else if (body.todoistOAuth !== undefined) {
        const parsed = parseTodoistOAuthCredentials(body.todoistOAuth);
        if (parsed) {
          // Preserve existing secret when UI submits masked/empty secret while editing other fields.
          const clientSecret = parsed.clientSecret || previous.todoistOAuth?.clientSecret || "";
          if (!parsed.clientId || !clientSecret || !parsed.redirectUri) {
            throw new AppError(
              400,
              ErrorCodes.INVALID_INPUT,
              "todoistOAuth must include clientId, clientSecret, and redirectUri"
            );
          }
          updates.todoistOAuth = {
            clientId: parsed.clientId,
            clientSecret,
            redirectUri: parsed.redirectUri,
          };
        } else {
          throw new AppError(
            400,
            ErrorCodes.INVALID_INPUT,
            "todoistOAuth must include clientId, clientSecret, and redirectUri"
          );
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      const current = await getGlobalSettings();
      return res.json({
        data: buildResponse(current),
      } as ApiResponse<GlobalSettingsResponse>);
    }

    const updated = await updateGlobalSettings(updates);
    if (updates.databaseUrl !== undefined && updates.databaseUrl !== previous.databaseUrl) {
      databaseRuntime.requestReconnect("settings-updated");
    }
    res.json({
      data: buildResponse(updated),
    } as ApiResponse<GlobalSettingsResponse>);
  })
);
