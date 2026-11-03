import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateQuery } from "../middleware/validate.js";
import { modelsListQuerySchema } from "../schemas/request-models.js";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import type { ApiErrorResponse, ApiResponse } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import * as modelListCache from "../services/model-list-cache.js";
import { getNextKey } from "../services/api-key-resolver.service.js";
import { isOpenAITextModel } from "../utils/openai-models.js";
import { CLAUDE_CLI_MODELS, listCodexModels } from "../services/cli-models.js";
import {
  ensureOpenAICompatibleV1BaseUrl,
  ensureOllamaNativeApiBaseUrl,
  normalizeLocalOpenAIProviderBaseUrl,
} from "../utils/local-openai-provider.js";

export interface ModelOption {
  id: string;
  displayName: string;
}

export const modelsRouter = Router();

const CURSOR_MODELS_URL = "https://api.cursor.com/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const LM_STUDIO_DEFAULT_BASE_URL = "http://localhost:1234";
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
const MODEL_REQUEST_TIMEOUT_MS = 30_000;

function redactKey(message: string, key: string): string {
  return key ? message.split(key).join("[redacted]") : message;
}

function uniqueModels(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

async function requestModelCatalog(
  url: string,
  provider: "cursor" | "openai" | "google",
  key: string,
  headers: Record<string, string>
): Promise<Response> {
  const label = { cursor: "Cursor", openai: "OpenAI", google: "Google" }[provider];
  const errorCode = {
    cursor: ErrorCodes.CURSOR_API_ERROR,
    openai: ErrorCodes.OPENAI_API_ERROR,
    google: ErrorCodes.GOOGLE_API_ERROR,
  }[provider];
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const message = redactKey(err instanceof Error ? err.message : String(err), key);
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || /aborted|timeout/i.test(message));
    throw new AppError(
      502,
      errorCode,
      isTimeout
        ? `${label} API request timed out. Check your network connection.`
        : `${label} API request failed: ${message}`,
      { cause: message }
    );
  }
}

/** Validate and normalize LM Studio baseUrl: http/https only, trim, no trailing slash. */
function normalizeLmStudioBaseUrl(
  raw: string | undefined
): { ok: true; normalized: string } | { ok: false; error: string } {
  return normalizeLocalOpenAIProviderBaseUrl(raw, LM_STUDIO_DEFAULT_BASE_URL);
}

/** Validate and normalize Ollama baseUrl: http/https only, trim, no trailing slash. */
function normalizeOllamaBaseUrl(
  raw: string | undefined
): { ok: true; normalized: string } | { ok: false; error: string } {
  return normalizeLocalOpenAIProviderBaseUrl(raw, OLLAMA_DEFAULT_BASE_URL);
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
      const client = new Anthropic({ apiKey: trimmed, timeout: MODEL_REQUEST_TIMEOUT_MS });
      for await (const _ of client.models.list({ limit: 1 })) {
        break; // one iteration is enough to validate
      }
      return { valid: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: redactKey(msg, trimmed) };
    }
  }

  if (provider === "cursor") {
    try {
      const response = await requestModelCatalog(CURSOR_MODELS_URL, "cursor", trimmed, {
        Authorization: `Bearer ${trimmed}`,
      });
      if (response.ok) return { valid: true };
      const text = redactKey(await response.text(), trimmed);
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
      return { valid: false, error: redactKey(msg, trimmed) };
    }
  }

  if (provider === "openai") {
    try {
      const response = await requestModelCatalog(OPENAI_MODELS_URL, "openai", trimmed, {
        Authorization: `Bearer ${trimmed}`,
      });
      if (response.ok) return { valid: true };
      const text = redactKey(await response.text(), trimmed);
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
      return { valid: false, error: redactKey(msg, trimmed) };
    }
  }

  if (provider === "google") {
    try {
      const response = await requestModelCatalog(GOOGLE_MODELS_URL, "google", trimmed, {
        "x-goog-api-key": trimmed,
      });
      if (response.ok) return { valid: true };
      const text = redactKey(await response.text(), trimmed);
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
      return { valid: false, error: redactKey(msg, trimmed) };
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
  const client = new Anthropic({ apiKey, timeout: MODEL_REQUEST_TIMEOUT_MS });
  const models: ModelOption[] = [];
  for await (const model of client.models.list({ limit: 100 })) {
    if ((model as { lifecycle?: string }).lifecycle === "retired") continue;
    models.push({
      id: model.id,
      displayName: model.display_name || model.id,
    });
  }
  return uniqueModels(models);
}

async function fetchOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  const response = await requestModelCatalog(OPENAI_MODELS_URL, "openai", apiKey, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (!response.ok) {
    const text = redactKey(await response.text(), apiKey);
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

  const body = (await response.json()) as {
    data?: { id: string; shutdown_date?: string | null }[];
  };
  const models = (body.data ?? [])
    .filter(
      (m) =>
        m.id &&
        isOpenAITextModel(m.id) &&
        (!m.shutdown_date || !(Date.parse(m.shutdown_date) <= Date.now()))
    )
    .map((m) => ({ id: m.id, displayName: m.id }));
  return uniqueModels(models);
}

async function fetchCursorModels(apiKey: string): Promise<ModelOption[]> {
  const response = await requestModelCatalog(CURSOR_MODELS_URL, "cursor", apiKey, {
    Authorization: `Bearer ${apiKey}`,
  });

  if (!response.ok) {
    const text = redactKey(await response.text(), apiKey);
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

  const body = (await response.json()) as {
    items?: Array<{ id: string; displayName?: string }>;
    models?: string[];
  };
  return uniqueModels(
    body.items
      ? body.items
          .filter((model) => typeof model.id === "string")
          .map((model) => ({
            id: model.id,
            displayName: model.displayName || model.id,
          }))
      : (body.models ?? [])
          .filter((id) => typeof id === "string")
          .map((id) => ({
            id,
            displayName: id,
          }))
  );
}

async function fetchGoogleModels(apiKey: string): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(GOOGLE_MODELS_URL);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await requestModelCatalog(url.toString(), "google", apiKey, {
      "x-goog-api-key": apiKey,
    });

    if (!response.ok) {
      const text = redactKey(await response.text(), apiKey);
      const hint =
        response.status === 401
          ? " Check that GOOGLE_API_KEY is valid. Get a key from aistudio.google.com."
          : response.status === 403
            ? " Your API key may not have access to models."
            : response.status === 429
              ? " Google API rate limit hit. The app caches model lists for 30 minutes; try again shortly."
              : "";
      throw new AppError(
        response.status >= 500 ? 502 : response.status,
        ErrorCodes.GOOGLE_API_ERROR,
        `Google API error ${response.status}: ${text}${hint}`,
        { status: response.status, responsePreview: text.slice(0, 200) }
      );
    }

    const body = (await response.json()) as {
      models?: Array<{
        name?: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
      }>;
      nextPageToken?: string;
    };
    for (const model of body.models ?? []) {
      if (
        !model.name?.startsWith("models/") ||
        !model.supportedGenerationMethods?.includes("generateContent")
      )
        continue;
      const id = model.name.slice("models/".length);
      // These generateContent variants require media output/configuration rather than agent text.
      if (/(?:^|-)(?:tts|image|imagen|veo|audio|live|robotics)(?:-|$)/i.test(id)) continue;
      models.push({ id, displayName: model.displayName || id });
    }
    pageToken = body.nextPageToken;
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new AppError(
          502,
          ErrorCodes.GOOGLE_API_ERROR,
          "Google model listing returned a repeated page token."
        );
      }
      seenPageTokens.add(pageToken);
    }
  } while (pageToken);
  return uniqueModels(models);
}

async function fetchLocalOpenAICompatibleModels(options: {
  baseUrl: string;
  providerLabel: "LM Studio" | "Ollama";
  errorCode: typeof ErrorCodes.LM_STUDIO_UNREACHABLE | typeof ErrorCodes.OLLAMA_UNREACHABLE;
  unreachableMessage: string;
}): Promise<ModelOption[]> {
  const url = `${ensureOpenAICompatibleV1BaseUrl(options.baseUrl)}/models`;
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
      options.errorCode,
      isConnectionError
        ? options.unreachableMessage
        : `${options.providerLabel} request failed: ${msg}`,
      { baseUrl: options.baseUrl, cause: msg }
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new AppError(502, options.errorCode, options.unreachableMessage, {
      status: response.status,
      responsePreview: text.slice(0, 200),
    });
  }

  const body = (await response.json()) as { data?: { id: string }[] };
  return (body.data ?? []).filter((m) => m.id).map((m) => ({ id: m.id, displayName: m.id }));
}

async function fetchOllamaNativeModels(baseUrl: string): Promise<ModelOption[]> {
  const url = `${ensureOllamaNativeApiBaseUrl(baseUrl)}/api/tags`;
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
      ErrorCodes.OLLAMA_UNREACHABLE,
      isConnectionError
        ? "Ollama is not reachable. Ensure Ollama is running and the endpoint is correct."
        : `Ollama request failed: ${msg}`,
      { baseUrl, cause: msg }
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new AppError(
      502,
      ErrorCodes.OLLAMA_UNREACHABLE,
      "Ollama is not reachable. Ensure Ollama is running and the endpoint is correct.",
      { status: response.status, responsePreview: text.slice(0, 200) }
    );
  }

  const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
  return (body.models ?? [])
    .map((m) => m.name ?? m.model ?? "")
    .filter((id) => id.length > 0)
    .map((id) => ({ id, displayName: id }));
}

function shouldFallbackToOllamaNativeModels(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== ErrorCodes.OLLAMA_UNREACHABLE) {
    return false;
  }
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as { status?: unknown })
      : undefined;
  const status = typeof details?.status === "number" ? details.status : null;
  return status === 404 || status === 405 || status === 501;
}

async function fetchLmStudioModels(baseUrl: string): Promise<ModelOption[]> {
  return fetchLocalOpenAICompatibleModels({
    baseUrl,
    providerLabel: "LM Studio",
    errorCode: ErrorCodes.LM_STUDIO_UNREACHABLE,
    unreachableMessage:
      "LM Studio is not reachable. Ensure it is running and the server URL is correct.",
  });
}

async function fetchOllamaModels(baseUrl: string): Promise<ModelOption[]> {
  try {
    return await fetchLocalOpenAICompatibleModels({
      baseUrl,
      providerLabel: "Ollama",
      errorCode: ErrorCodes.OLLAMA_UNREACHABLE,
      unreachableMessage:
        "Ollama is not reachable. Ensure Ollama is running and the endpoint is correct.",
    });
  } catch (error) {
    if (!shouldFallbackToOllamaNativeModels(error)) {
      throw error;
    }
    return fetchOllamaNativeModels(baseUrl);
  }
}

/**
 * Fetch models for a provider with request coalescing.
 * Concurrent requests for the same provider share a single API call to avoid rate limits.
 */
async function getModelsWithCoalescing(
  provider: "claude" | "cursor" | "openai" | "google",
  apiKey: string,
  fetchFn: () => Promise<ModelOption[]>
): Promise<ModelOption[]> {
  // Model availability is account-specific. Never reuse one key's catalog after key rotation.
  const credentialHash = createHash("sha256").update(apiKey).digest("hex");
  return getModelsWithCoalescingByKey(`${provider}:${credentialHash}`, fetchFn);
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

// GET /models?provider=...&projectId=... — List available models for the given provider
modelsRouter.get(
  "/",
  validateQuery(modelsListQuerySchema),
  wrapAsync(async (req: Request, res) => {
    const provider = (req.query as { provider?: string }).provider || "claude";
    const projectId = (req.query as { projectId?: string }).projectId;

    if (provider === "claude") {
      const apiKey = await resolveApiKey(projectId, "ANTHROPIC_API_KEY");
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await getModelsWithCoalescing("claude", apiKey, () =>
        fetchClaudeModels(apiKey)
      );
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "claude-cli") {
      res.json({ data: CLAUDE_CLI_MODELS } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "codex") {
      // The CLI refreshes its catalog using the selected local ChatGPT account.
      // Do not share an API-key catalog or cache across local account switches.
      res.json({ data: await listCodexModels() } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "cursor") {
      const apiKey = await resolveApiKey(projectId, "CURSOR_API_KEY");
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await getModelsWithCoalescing("cursor", apiKey, () =>
        fetchCursorModels(apiKey)
      );
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "openai") {
      const apiKey = await resolveApiKey(projectId, "OPENAI_API_KEY");
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await getModelsWithCoalescing("openai", apiKey, () =>
        fetchOpenAIModels(apiKey)
      );
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "google") {
      const apiKey = await resolveApiKey(projectId, "GOOGLE_API_KEY");
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await getModelsWithCoalescing("google", apiKey, () =>
        fetchGoogleModels(apiKey)
      );
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

    if (provider === "ollama") {
      const baseUrlRaw = (req.query as { baseUrl?: string }).baseUrl;
      const parsed = normalizeOllamaBaseUrl(baseUrlRaw);
      if (!parsed.ok) {
        res.status(400).json({
          error: { code: ErrorCodes.INVALID_INPUT, message: parsed.error },
        } as ApiErrorResponse);
        return;
      }
      const cacheKey = `ollama:${parsed.normalized}`;
      const models = await getModelsWithCoalescingByKey(cacheKey, () =>
        fetchOllamaModels(parsed.normalized)
      );
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    res.json({ data: [] } as ApiResponse<ModelOption[]>);
  })
);
