import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateQuery } from "../middleware/validate.js";
import { modelsListQuerySchema } from "../schemas/request-models.js";
import Anthropic from "@anthropic-ai/sdk";
import type { ApiErrorResponse, ApiResponse } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import * as modelListCache from "../services/model-list-cache.js";
import { getNextKey } from "../services/api-key-resolver.service.js";
import { isOpenAITextModel } from "../utils/openai-models.js";

export interface ModelOption {
  id: string;
  displayName: string;
}

export const modelsRouter = Router();

const CURSOR_MODELS_URL = "https://api.cursor.com/v0/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const LM_STUDIO_DEFAULT_BASE_URL = "http://localhost:1234";

/** Validate and normalize LM Studio baseUrl: http/https only, trim, no trailing slash. */
function normalizeLmStudioBaseUrl(
  raw: string | undefined
): { ok: true; normalized: string } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: true, normalized: LM_STUDIO_DEFAULT_BASE_URL };
  }
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
    return { ok: false, error: "baseUrl must use http or https" };
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, error: "baseUrl must use http or https" };
    }
    const normalized = u.origin.replace(/\/$/, "");
    return { ok: true, normalized };
  } catch {
    return { ok: false, error: "baseUrl is not a valid URL" };
  }
}

/** Validate an API key via minimal API call. Reused by POST /env/keys/validate. */
export async function validateApiKey(
  provider: "claude" | "cursor" | "openai" | "google",
  value: string
): Promise<{ valid: boolean; error?: string }> {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { valid: false, error: "value is required" };
  }

  if (provider === "claude") {
    try {
      const client = new Anthropic({ apiKey: trimmed });
      for await (const _ of client.models.list({ limit: 1 })) {
        break; // one iteration is enough to validate
      }
      return { valid: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: msg };
    }
  }

  if (provider === "cursor") {
    try {
      const response = await fetch(CURSOR_MODELS_URL, {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (response.ok) return { valid: true };
      const text = await response.text();
      const hint =
        response.status === 401
          ? " Check that the API key is valid. Get a key from Cursor → Settings → Integrations → User API Keys."
          : response.status === 403
            ? " Your API key may not have access to models."
            : response.status === 429
              ? " Cursor API rate limit hit. Try again shortly."
              : "";
      return { valid: false, error: `Cursor API error ${response.status}: ${text}${hint}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: msg };
    }
  }

  if (provider === "openai") {
    try {
      const response = await fetch(OPENAI_MODELS_URL, {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (response.ok) return { valid: true };
      const text = await response.text();
      const hint =
        response.status === 401
          ? " Check that the API key is valid. Get a key from platform.openai.com."
          : response.status === 403
            ? " Your API key may not have access to models."
            : response.status === 429
              ? " OpenAI API rate limit hit. Try again shortly."
              : "";
      return { valid: false, error: `OpenAI API error ${response.status}: ${text}${hint}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: msg };
    }
  }

  if (provider === "google") {
    try {
      const response = await fetch(`${GOOGLE_MODELS_URL}?key=${encodeURIComponent(trimmed)}`);
      if (response.ok) return { valid: true };
      const text = await response.text();
      const hint =
        response.status === 401
          ? " Check that the API key is valid. Get a key from aistudio.google.com."
          : response.status === 403
            ? " Your API key may not have access to models."
            : response.status === 429
              ? " Google API rate limit hit. Try again shortly."
              : "";
      return { valid: false, error: `Google API error ${response.status}: ${text}${hint}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: msg };
    }
  }

  return { valid: false, error: `Unknown provider: ${provider}` };
}

/** In-flight fetches per provider to coalesce concurrent requests (avoids rate limits). */
const inFlightFetches = new Map<string, Promise<ModelOption[]>>();

/** Clear in-flight fetches (for tests). */
export function clearInFlightFetches(): void {
  inFlightFetches.clear();
}

async function fetchClaudeModels(apiKey: string): Promise<ModelOption[]> {
  const client = new Anthropic({ apiKey });
  const models: ModelOption[] = [];
  for await (const model of client.models.list({ limit: 100 })) {
    models.push({
      id: model.id,
      displayName: model.display_name,
    });
  }
  return models;
}

async function fetchOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  const response = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    const text = await response.text();
    const hint =
      response.status === 401
        ? " Check that OPENAI_API_KEY in .env is valid. Get a key from platform.openai.com."
        : response.status === 403
          ? " Your API key may not have access to models."
          : response.status === 429
            ? " OpenAI API rate limit hit. The app caches model lists for 30 minutes; try again shortly."
            : "";
    throw new AppError(
      response.status >= 500 ? 502 : response.status,
      ErrorCodes.OPENAI_API_ERROR,
      `OpenAI API error ${response.status}: ${text}${hint}`,
      {
        status: response.status,
        responsePreview: text.slice(0, 200),
      }
    );
  }

  const body = (await response.json()) as { data?: { id: string }[] };
  const models = (body.data ?? [])
    .filter((m) => m.id && isOpenAITextModel(m.id))
    .map((m) => ({ id: m.id, displayName: m.id }));
  return models;
}

async function fetchCursorModels(apiKey: string): Promise<ModelOption[]> {
  const response = await fetch(CURSOR_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const hint =
      response.status === 401
        ? " Check that CURSOR_API_KEY in .env is valid. Get a key from Cursor → Settings → Integrations → User API Keys."
        : response.status === 403
          ? " Your API key may not have access to models."
          : response.status === 429
            ? " Cursor API rate limit hit. The app caches model lists for 30 minutes; try again shortly."
            : "";
    throw new AppError(
      response.status >= 500 ? 502 : response.status,
      ErrorCodes.CURSOR_API_ERROR,
      `Cursor API error ${response.status}: ${text}${hint}`,
      {
        status: response.status,
        responsePreview: text.slice(0, 200),
      }
    );
  }

  const body = (await response.json()) as { models?: string[] };
  return (body.models ?? []).map((id) => ({
    id,
    displayName: id,
  }));
}

async function fetchGoogleModels(apiKey: string): Promise<ModelOption[]> {
  const response = await fetch(`${GOOGLE_MODELS_URL}?key=${encodeURIComponent(apiKey)}`);

  if (!response.ok) {
    const text = await response.text();
    const hint =
      response.status === 401
        ? " Check that GOOGLE_API_KEY in .env is valid. Get a key from aistudio.google.com."
        : response.status === 403
          ? " Your API key may not have access to models."
          : response.status === 429
            ? " Google API rate limit hit. The app caches model lists for 30 minutes; try again shortly."
            : "";
    throw new AppError(
      response.status >= 500 ? 502 : response.status,
      ErrorCodes.GOOGLE_API_ERROR,
      `Google API error ${response.status}: ${text}${hint}`,
      {
        status: response.status,
        responsePreview: text.slice(0, 200),
      }
    );
  }

  const body = (await response.json()) as {
    models?: Array<{ name?: string; displayName?: string }>;
  };
  return (body.models ?? [])
    .filter((m) => m.name && m.name.startsWith("models/"))
    .map((m) => {
      const name = m.name!;
      const id = name.replace(/^models\//, "");
      return {
        id,
        displayName: m.displayName ?? id,
      };
    });
}

async function fetchLmStudioModels(baseUrl: string): Promise<ModelOption[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/models`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isConnectionError =
      msg.includes("ECONNREFUSED") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("fetch failed") ||
      msg.includes("Failed to fetch");
    throw new AppError(
      502,
      ErrorCodes.LM_STUDIO_UNREACHABLE,
      isConnectionError
        ? "LM Studio is not reachable. Ensure it is running and the server URL is correct."
        : `LM Studio request failed: ${msg}`,
      { baseUrl: baseUrl.replace(/\/$/, ""), cause: msg }
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new AppError(
      502,
      ErrorCodes.LM_STUDIO_UNREACHABLE,
      "LM Studio is not reachable. Ensure it is running and the server URL is correct.",
      { status: response.status, responsePreview: text.slice(0, 200) }
    );
  }

  const body = (await response.json()) as { data?: { id: string }[] };
  return (body.data ?? []).filter((m) => m.id).map((m) => ({ id: m.id, displayName: m.id }));
}

/**
 * Fetch models for a provider with request coalescing.
 * Concurrent requests for the same provider share a single API call to avoid rate limits.
 */
async function getModelsWithCoalescing(
  provider: "claude" | "cursor" | "openai" | "google",
  fetchFn: () => Promise<ModelOption[]>
): Promise<ModelOption[]> {
  return getModelsWithCoalescingByKey(provider, fetchFn);
}

/**
 * Fetch models with an arbitrary cache key (e.g. "lmstudio:" + baseUrl).
 * Used for LM Studio where the key depends on baseUrl.
 */
async function getModelsWithCoalescingByKey(
  cacheKey: string,
  fetchFn: () => Promise<ModelOption[]>
): Promise<ModelOption[]> {
  const cached = modelListCache.get<ModelOption[]>(cacheKey);
  if (cached !== undefined) return cached;

  let promise = inFlightFetches.get(cacheKey);
  if (!promise) {
    promise = fetchFn().then(
      (models) => {
        modelListCache.set(cacheKey, models);
        inFlightFetches.delete(cacheKey);
        return models;
      },
      (err) => {
        inFlightFetches.delete(cacheKey);
        throw err;
      }
    );
    inFlightFetches.set(cacheKey, promise);
  }
  return promise;
}

const CLAUDE_CLI_DEFAULT_MODELS: ModelOption[] = [
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
];

/**
 * Resolve API key for models fetch: use project-level keys when projectId provided,
 * otherwise fall back to process.env (backward compatibility).
 */
async function resolveApiKey(
  projectId: string | undefined,
  provider: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY"
): Promise<string | null> {
  // Model-list fetches are lightweight capability discovery and should still work
  // even if a key is cooling down after an agent rate-limit event.
  const resolved = await getNextKey(projectId ?? "", provider, { includeRateLimited: true });
  return resolved?.key?.trim() ?? null;
}

// GET /models?provider=claude|claude-cli|cursor&projectId=... — List available models for the given provider
modelsRouter.get(
  "/",
  validateQuery(modelsListQuerySchema),
  wrapAsync(async (req: Request, res) => {
    const provider = ((req.query as { provider?: string }).provider) || "claude";
    const projectId = (req.query as { projectId?: string }).projectId;

    if (provider === "claude") {
      const apiKey = await resolveApiKey(projectId, "ANTHROPIC_API_KEY");
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await getModelsWithCoalescing("claude", () => fetchClaudeModels(apiKey));
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "claude-cli") {
      const apiKey = await resolveApiKey(projectId, "ANTHROPIC_API_KEY");
      if (apiKey) {
        const models = await getModelsWithCoalescing("claude", () => fetchClaudeModels(apiKey));
        res.json({ data: models } as ApiResponse<ModelOption[]>);
      } else {
        res.json({ data: CLAUDE_CLI_DEFAULT_MODELS } as ApiResponse<ModelOption[]>);
      }
      return;
    }

    if (provider === "cursor") {
      const apiKey = await resolveApiKey(projectId, "CURSOR_API_KEY");
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await getModelsWithCoalescing("cursor", () => fetchCursorModels(apiKey));
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "openai") {
      const apiKey = await resolveApiKey(projectId, "OPENAI_API_KEY");
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await getModelsWithCoalescing("openai", () => fetchOpenAIModels(apiKey));
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "google") {
      const apiKey = await resolveApiKey(projectId, "GOOGLE_API_KEY");
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await getModelsWithCoalescing("google", () => fetchGoogleModels(apiKey));
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "lmstudio") {
      const baseUrlRaw = (req.query as { baseUrl?: string }).baseUrl;
      const parsed = normalizeLmStudioBaseUrl(baseUrlRaw);
      if (!parsed.ok) {
        res.status(400).json({
          error: { code: ErrorCodes.INVALID_INPUT, message: parsed.error },
        } as ApiErrorResponse);
        return;
      }
      const cacheKey = `lmstudio:${parsed.normalized}`;
      const models = await getModelsWithCoalescingByKey(cacheKey, () =>
        fetchLmStudioModels(parsed.normalized)
      );
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    res.json({ data: [] } as ApiResponse<ModelOption[]>);
  })
);
