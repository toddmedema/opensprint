import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { modelsRouter } from "../routes/models.js";
import { API_PREFIX } from "@opensprint/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { requireLocalSessionAuth } from "../middleware/require-local-session-auth.js";
import {
  ensureLocalSessionToken,
  setLocalSessionTokenForTesting,
  VITEST_DEFAULT_LOCAL_SESSION_TOKEN,
} from "../services/local-session-auth.service.js";
import * as modelListCache from "../services/model-list-cache.js";
import { clearInFlightFetches, validateApiKey } from "../routes/models.js";
import { authedSupertest } from "./local-auth-test-helpers.js";

const mockModelsList = vi.fn();
const mockGetNextKey = vi.fn();
const mockListCodexModels = vi.fn();

vi.mock("../services/cli-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/cli-models.js")>();
  return {
    ...actual,
    listCodexModels: (...args: unknown[]) => mockListCodexModels(...args),
  };
});

vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: (...args: unknown[]) => mockGetNextKey(...args),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    models: {
      list: mockModelsList,
    },
  })),
}));

const originalFetch = globalThis.fetch;

/** Matches createApp(): `/api/v1` is behind requireLocalSessionAuth before /models is mounted. */
function createMinimalModelsApp() {
  // Other suites call `setLocalSessionTokenForTesting` with a non-default token; `ensureLocalSessionToken`
  // is idempotent and would keep that token. Reset so `authedSupertest` and the gate agree (merge-gate flake).
  setLocalSessionTokenForTesting(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
  ensureLocalSessionToken();
  const app = express();
  app.use(express.json());
  app.use(API_PREFIX, requireLocalSessionAuth);
  app.use(`${API_PREFIX}/models`, modelsRouter);
  app.use(errorHandler);
  return app;
}

type MinimalModelsApp = ReturnType<typeof createMinimalModelsApp>;

/** GET with timeout and one retry on supertest "socket hang up" (merge-gate flake with full test graph). */
async function authedGetWithHangupRetry(app: MinimalModelsApp, url: string) {
  const doRequest = () => authedSupertest(app).get(url).timeout(10_000);
  try {
    return await doRequest();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/socket hang up/i.test(msg)) {
      return await doRequest();
    }
    throw err;
  }
}

describe("Models API", () => {
  let app: ReturnType<typeof createMinimalModelsApp>;
  let originalAnthropicKey: string | undefined;
  let originalCursorKey: string | undefined;
  let originalOpenAIKey: string | undefined;
  let originalGoogleKey: string | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    app = createMinimalModelsApp();
    modelListCache.clear();
    clearInFlightFetches();
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalCursorKey = process.env.CURSOR_API_KEY;
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    originalGoogleKey = process.env.GOOGLE_API_KEY;
    vi.clearAllMocks();
    mockListCodexModels.mockResolvedValue([
      { id: "default", displayName: "Codex default (account's latest)" },
      { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
    ]);
    mockGetNextKey.mockImplementation(async (_projectId: string, provider: string) => {
      const key = process.env[provider];
      return key?.trim() ? { key, keyId: "__env__" } : null;
    });
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    process.env.CURSOR_API_KEY = originalCursorKey;
    process.env.OPENAI_API_KEY = originalOpenAIKey;
    process.env.GOOGLE_API_KEY = originalGoogleKey;
    globalThis.fetch = originalFetch;
    setLocalSessionTokenForTesting(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
    ensureLocalSessionToken();
  });

  describe("GET /models", () => {
    it("returns empty array when provider is claude and no API key", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      mockGetNextKey.mockResolvedValue(null);
      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=claude`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(mockModelsList).not.toHaveBeenCalled();
    });

    it("returns empty array when provider is cursor and no API key", async () => {
      delete process.env.CURSOR_API_KEY;
      mockGetNextKey.mockResolvedValue(null);
      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns empty array when provider is openai and no API key", async () => {
      delete process.env.OPENAI_API_KEY;
      mockGetNextKey.mockResolvedValue(null);
      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns empty array when provider is google and no API key", async () => {
      delete process.env.GOOGLE_API_KEY;
      mockGetNextKey.mockResolvedValue(null);
      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=google`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("requests a key for model listing even when global key cooldown should be ignored", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-openai-test", keyId: "k1", source: "global" });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "gpt-4o", object: "model" }] }),
        text: () => Promise.resolve(""),
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`);

      expect(res.status).toBe(200);
      expect(mockGetNextKey).toHaveBeenCalledWith("", "OPENAI_API_KEY", {
        includeRateLimited: true,
      });
      expect(res.body.data).toEqual([{ id: "gpt-4o", displayName: "gpt-4o" }]);
    });

    it("lists the current Cursor v1 model catalog and preserves display names", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            { id: "composer-2.5", displayName: "Composer 2.5", parameters: [] },
            { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
          ],
        }),
      });

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=cursor`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "composer-2.5", displayName: "Composer 2.5" },
        { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.cursor.com/v1/models",
        expect.objectContaining({
          headers: { Authorization: "Bearer cursor-test-key" },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("paginates Gemini models and only offers text generation models", async () => {
      process.env.GOOGLE_API_KEY = "google-test-key";
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [
              {
                name: "models/gemini-3.8-flash",
                displayName: "Gemini 3.8 Flash",
                supportedGenerationMethods: ["generateContent"],
              },
              { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
              {
                name: "models/gemini-tts",
                supportedGenerationMethods: ["generateContent"],
                description: "Text-to-speech model",
              },
            ],
            nextPageToken: "page/2+token",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [
              { name: "models/gemini-3.1-pro", supportedGenerationMethods: ["generateContent"] },
            ],
          }),
        });

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=google`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
        { id: "gemini-3.1-pro", displayName: "gemini-3.1-pro" },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(globalThis.fetch).mock.calls;
      const first = new URL(String(calls[0][0]));
      const second = new URL(String(calls[1][0]));
      expect(first.searchParams.has("key")).toBe(false);
      expect(second.searchParams.get("pageToken")).toBe("page/2+token");
      expect(calls[0][1]).toEqual(
        expect.objectContaining({
          headers: { "x-goog-api-key": "google-test-key" },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("does not share cached model entitlements between API keys", async () => {
      process.env.OPENAI_API_KEY = "first-account-key";
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "gpt-6-luna" }] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "gpt-6-astra" }] }) });

      const first = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=openai`);
      process.env.OPENAI_API_KEY = "second-account-key";
      const second = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=openai`);

      expect(first.body.data).toEqual([{ id: "gpt-6-luna", displayName: "gpt-6-luna" }]);
      expect(second.body.data).toEqual([{ id: "gpt-6-astra", displayName: "gpt-6-astra" }]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("omits shut down OpenAI models and audio/image-only model families", async () => {
      process.env.OPENAI_API_KEY = "openai-test-key";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: "gpt-6.1-sol", shutdown_date: null },
            { id: "gpt-6.1-terra", shutdown_date: "2999-12-31" },
            { id: "gpt-5.2-codex", shutdown_date: "2000-01-01" },
            { id: "gpt-transcribe" },
            { id: "gpt-live-1" },
            { id: "chatgpt-image-latest" },
            { id: "gpt-3.5-turbo-instruct" },
          ],
        }),
      });

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=openai`);

      expect(res.body.data).toEqual([
        { id: "gpt-6.1-sol", displayName: "gpt-6.1-sol" },
        { id: "gpt-6.1-terra", displayName: "gpt-6.1-terra" },
      ]);
    });

    it("does not loop forever if Gemini repeats a pagination token", async () => {
      process.env.GOOGLE_API_KEY = "google-test-key";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [], nextPageToken: "same-page" }),
      });

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=google`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe("GOOGLE_API_ERROR");
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("excludes retired Claude models while preserving current and accessible deprecated models", async () => {
      process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
      mockModelsList.mockImplementation(async function* () {
        yield { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", lifecycle: "active" };
        yield {
          id: "claude-sonnet-4-6",
          display_name: "Claude Sonnet 4.6",
          lifecycle: "deprecated",
        };
        yield { id: "claude-retired", display_name: "Retired model", lifecycle: "retired" };
      });

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=claude`);

      expect(res.body.data.map((model: { id: string }) => model.id)).toEqual([
        "claude-opus-5-5",
        "claude-sonnet-4-6",
      ]);
    });

    it.each([
      ["openai", "OPENAI_API_KEY", "OPENAI_API_ERROR"],
      ["cursor", "CURSOR_API_KEY", "CURSOR_API_ERROR"],
      ["google", "GOOGLE_API_KEY", "GOOGLE_API_ERROR"],
    ])(
      "returns a bounded provider error for %s connection timeouts",
      async (provider, envKey, code) => {
        process.env[envKey] = "test-key";
        globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));

        const res = await authedGetWithHangupRetry(
          app,
          `${API_PREFIX}/models?provider=${provider}`
        );

        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe(code);
        expect(res.body.error.message).toContain("timed out");
      }
    );

    it("returns empty array for unknown provider", async () => {
      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=unknown`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("GET /models?provider=lmstudio: returns 200 and ModelOption[] when LM Studio returns OpenAI-style list", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "model-1" }] }),
      });

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=lmstudio`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: "model-1", displayName: "model-1" }]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:1234/v1/models",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it("fetches and returns LM Studio models when server is up (default baseUrl)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "local-model-1", object: "model" },
              { id: "local-model-2", object: "model" },
            ],
          }),
      });

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=lmstudio`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "local-model-1", displayName: "local-model-1" },
        { id: "local-model-2", displayName: "local-model-2" },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:1234/v1/models",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it("fetches LM Studio models from custom baseUrl query param", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "custom-model" }] }),
      });

      const res = await authedGetWithHangupRetry(
        app,
        `${API_PREFIX}/models?provider=lmstudio&baseUrl=http://192.168.1.10:1234`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: "custom-model", displayName: "custom-model" }]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://192.168.1.10:1234/v1/models",
        expect.any(Object)
      );
    });

    it("normalizes LM Studio baseUrl trailing slash", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      await authedGetWithHangupRetry(
        app,
        `${API_PREFIX}/models?provider=lmstudio&baseUrl=http://localhost:1234/`
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:1234/v1/models",
        expect.any(Object)
      );
    });

    it("trims LM Studio baseUrl and fetches from normalized URL", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "trimmed-model" }] }),
      });

      const res = await authedGetWithHangupRetry(
        app,
        `${API_PREFIX}/models?provider=lmstudio&baseUrl=%20%20http://localhost:1234%20%20`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: "trimmed-model", displayName: "trimmed-model" }]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:1234/v1/models",
        expect.any(Object)
      );
    });

    it("returns 400 for LM Studio with invalid baseUrl (non-http(s))", async () => {
      const res = await authedGetWithHangupRetry(
        app,
        `${API_PREFIX}/models?provider=lmstudio&baseUrl=ftp://localhost:1234`
      );
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
      expect(res.body.error?.message).toMatch(/http or https/);
    });

    it("returns 502 when LM Studio is unreachable (connection refused)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=lmstudio`);
      expect(res.status).toBe(502);
      expect(res.body.error?.code).toBe("LM_STUDIO_UNREACHABLE");
      expect(res.body.error?.message).toContain("LM Studio is not reachable");
    });

    it("returns 502 when LM Studio returns non-2xx", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });

      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=lmstudio`);
      expect(res.status).toBe(502);
      expect(res.body.error?.code).toBe("LM_STUDIO_UNREACHABLE");
      expect(res.body.error?.message).toContain("LM Studio is not reachable");
    });

    it("fetches Ollama models from the OpenAI-compatible API", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "llama3.2:latest", object: "model" },
              { id: "mistral:7b", object: "model" },
            ],
          }),
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=ollama`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "llama3.2:latest", displayName: "llama3.2:latest" },
        { id: "mistral:7b", displayName: "mistral:7b" },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/v1/models",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("preserves custom Ollama baseUrl path segments and appends /v1 idempotently", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "llama3.2" }] }),
      });

      const res = await authedSupertest(app).get(
        `${API_PREFIX}/models?provider=ollama&baseUrl=${encodeURIComponent(" http://192.168.1.10:11434/proxy/v1/ ")}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: "llama3.2", displayName: "llama3.2" }]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://192.168.1.10:11434/proxy/v1/models",
        expect.any(Object)
      );
    });

    it("falls back to the native Ollama tags endpoint when /v1/models is unavailable", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: () => Promise.resolve("Not Found"),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              models: [{ name: "llama3.2:latest" }, { model: "mistral:7b" }],
            }),
        });

      const res = await authedGetWithHangupRetry(
        app,
        `${API_PREFIX}/models?provider=ollama&baseUrl=${encodeURIComponent("http://127.0.0.1:11434/proxy/v1")}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "llama3.2:latest", displayName: "llama3.2:latest" },
        { id: "mistral:7b", displayName: "mistral:7b" },
      ]);
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        "http://127.0.0.1:11434/proxy/v1/models",
        expect.any(Object)
      );
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        "http://127.0.0.1:11434/proxy/api/tags",
        expect.any(Object)
      );
    });

    it("returns empty array when Ollama has no local models", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=ollama`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns 502 when the Ollama API is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=ollama`);

      expect(res.status).toBe(502);
      expect(res.body.error?.code).toBe("OLLAMA_UNREACHABLE");
      expect(res.body.error?.message).toContain("Ollama is not reachable");
    });

    it("uses cache on second Ollama request (same baseUrl)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "llama3.2" }] }),
      });

      const res1 = await authedSupertest(app).get(`${API_PREFIX}/models?provider=ollama`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toEqual([{ id: "llama3.2", displayName: "llama3.2" }]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const res2 = await authedSupertest(app).get(`${API_PREFIX}/models?provider=ollama`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toEqual([{ id: "llama3.2", displayName: "llama3.2" }]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("uses cache on second LM Studio request (same baseUrl)", async () => {
      const mockJson = vi.fn().mockResolvedValue({
        data: [{ id: "cached-model" }],
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: mockJson,
      });

      const res1 = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=lmstudio`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const res2 = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=lmstudio`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("fetches and returns Claude models when API key is set", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      mockModelsList.mockImplementation(async function* () {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
        yield { id: "claude-opus-4", display_name: "Claude Opus 4" };
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=claude`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
        { id: "claude-opus-4", displayName: "Claude Opus 4" },
      ]);
      expect(mockModelsList).toHaveBeenCalledTimes(1);
    });

    it("uses cache on second Claude request", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      mockModelsList.mockImplementation(async function* () {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      });

      const res1 = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=claude`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toHaveLength(1);
      expect(mockModelsList).toHaveBeenCalledTimes(1);

      const res2 = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=claude`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(1);
      expect(mockModelsList).toHaveBeenCalledTimes(1); // no additional call
    });

    it("fetches and returns Cursor models when API key is set", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: ["gpt-4", "claude-3"] }),
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "gpt-4", displayName: "gpt-4" },
        { id: "claude-3", displayName: "claude-3" },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("uses cache on second Cursor request", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const mockJson = vi.fn().mockResolvedValue({ models: ["gpt-4"] });
      const cursorFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: mockJson,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", cursorFetch);

      const res1 = await authedSupertest(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toHaveLength(1);
      expect(cursorFetch).toHaveBeenCalledTimes(1);

      const res2 = await authedSupertest(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(1);
      expect(cursorFetch).toHaveBeenCalledTimes(1); // no additional call — cache hit
    });

    it("fetches and returns OpenAI models when API key is set", async () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "gpt-4o", object: "model" },
              { id: "gpt-4o-mini", object: "model" },
              { id: "o1-preview", object: "model" },
              { id: "o3-mini", object: "model" },
              { id: "text-embedding-3-small", object: "model" },
            ],
          }),
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "gpt-4o", displayName: "gpt-4o" },
        { id: "gpt-4o-mini", displayName: "gpt-4o-mini" },
        { id: "o1-preview", displayName: "o1-preview" },
        { id: "o3-mini", displayName: "o3-mini" },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/models",
        expect.objectContaining({
          headers: { Authorization: "Bearer sk-openai-test" },
        })
      );
    });

    it("keeps current OpenAI chat and reasoning models while excluding specialized ones", async () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "chatgpt-4o-latest", object: "model" },
              { id: "gpt-5", object: "model" },
              { id: "gpt-5-mini", object: "model" },
              { id: "gpt-5.3-codex", object: "model" },
              { id: "o3", object: "model" },
              { id: "o4-mini", object: "model" },
              { id: "gpt-image-1", object: "model" },
              { id: "gpt-4o-transcribe", object: "model" },
              { id: "text-embedding-3-small", object: "model" },
            ],
          }),
        text: () => Promise.resolve(""),
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "chatgpt-4o-latest", displayName: "chatgpt-4o-latest" },
        { id: "gpt-5", displayName: "gpt-5" },
        { id: "gpt-5-mini", displayName: "gpt-5-mini" },
        { id: "gpt-5.3-codex", displayName: "gpt-5.3-codex" },
        { id: "o3", displayName: "o3" },
        { id: "o4-mini", displayName: "o4-mini" },
      ]);
    }, 60_000);

    it("uses cache on second OpenAI request", async () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      const mockJson = vi.fn().mockResolvedValue({
        data: [{ id: "gpt-4o", object: "model" }],
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: mockJson,
        text: () => Promise.resolve(""),
      });

      const res1 = await authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const res2 = await authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("defaults to claude when provider not specified", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const res = await authedSupertest(app).get(`${API_PREFIX}/models`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns hardcoded defaults for claude-cli when no API key is set", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=claude-cli`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toHaveProperty("id");
      expect(res.body.data[0]).toHaveProperty("displayName");
    });

    it("uses Claude CLI aliases without consulting API keys even when a key exists", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=claude-cli`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((model: { id: string }) => model.id)).toEqual([
        "default",
        "sonnet",
        "opus",
        "haiku",
        "fable",
      ]);
      expect(
        res.body.data.find((model: { id: string }) => model.id === "fable").displayName
      ).toMatch(/usage credits/i);
      expect(mockGetNextKey).not.toHaveBeenCalled();
      expect(mockModelsList).not.toHaveBeenCalled();
    });

    it("returns native effort capabilities without consulting cloud API keys", async () => {
      mockListCodexModels.mockResolvedValueOnce([
        {
          id: "sol",
          displayName: "Sol",
          defaultEffort: "low",
          supportedEfforts: [{ effort: "low" }, { effort: "ultra" }],
        },
      ]);
      const codex = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=codex`);
      expect(codex.body.data[0]).toMatchObject({
        defaultEffort: "low",
        supportedEfforts: [{ effort: "low" }, { effort: "ultra" }],
      });
      const claude = await authedGetWithHangupRetry(
        app,
        `${API_PREFIX}/models?provider=claude-cli`
      );
      expect(claude.body.data.find((model: { id: string }) => model.id === "sonnet")).toMatchObject(
        {
          defaultEffort: "medium",
          supportedEfforts: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })),
        }
      );
      expect(mockGetNextKey).not.toHaveBeenCalled();
    });

    it("lists Codex models using local CLI auth without API keys", async () => {
      const res = await authedGetWithHangupRetry(app, `${API_PREFIX}/models?provider=codex`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "default", displayName: "Codex default (account's latest)" },
        { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
      ]);
      expect(mockListCodexModels).toHaveBeenCalledOnce();
      expect(mockGetNextKey).not.toHaveBeenCalled();
    });

    it("coalesces concurrent Cursor requests to avoid rate limits", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const fetchPromise = new Promise<{ ok: boolean; json: () => Promise<{ models: string[] }> }>(
        (resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: () => Promise.resolve({ models: ["gpt-4", "claude-3"] }),
              }),
            10
          );
        }
      );
      globalThis.fetch = vi.fn().mockReturnValue(fetchPromise);

      const requests = [
        authedSupertest(app).get(`${API_PREFIX}/models?provider=cursor`),
        authedSupertest(app).get(`${API_PREFIX}/models?provider=cursor`),
        authedSupertest(app).get(`${API_PREFIX}/models?provider=cursor`),
      ];

      const results = await Promise.all(requests);
      results.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
          { id: "gpt-4", displayName: "gpt-4" },
          { id: "claude-3", displayName: "claude-3" },
        ]);
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("returns helpful message on Cursor 429 rate limit", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limit exceeded"),
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res.status).toBe(429);
      expect(res.body.error?.message).toContain("rate limit");
      expect(res.body.error?.message).toContain("30 minutes");
    });

    it("returns helpful message on OpenAI 429 rate limit", async () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limit exceeded"),
      });

      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`);
      expect(res.status).toBe(429);
      expect(res.body.error?.message).toContain("rate limit");
      expect(res.body.error?.message).toContain("30 minutes");
    });

    it("uses API key from global store when projectId is provided (projectId passed for API compatibility, key resolution is global-only)", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-ant-global-key", keyId: "k1", source: "global" });
      mockModelsList.mockImplementation(async function* () {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      });

      delete process.env.ANTHROPIC_API_KEY;
      const res = await authedSupertest(app).get(
        `${API_PREFIX}/models?provider=claude&projectId=proj-123`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: "claude-sonnet-4", displayName: "Claude Sonnet 4" }]);
      expect(mockGetNextKey).toHaveBeenCalledWith("proj-123", "ANTHROPIC_API_KEY", {
        includeRateLimited: true,
      });
      expect(mockModelsList).toHaveBeenCalledTimes(1);
    });

    it("resolves API key from global store when projectId is omitted", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-ant-global-key", keyId: "k1", source: "global" });
      mockModelsList.mockImplementation(async function* () {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      });

      delete process.env.ANTHROPIC_API_KEY;
      const res = await authedSupertest(app).get(`${API_PREFIX}/models?provider=claude`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: "claude-sonnet-4", displayName: "Claude Sonnet 4" }]);
      expect(mockGetNextKey).toHaveBeenCalledWith("", "ANTHROPIC_API_KEY", {
        includeRateLimited: true,
      });
      expect(mockModelsList).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent OpenAI requests to avoid rate limits", async () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      const mockJson = vi.fn().mockResolvedValue({
        data: [
          { id: "gpt-4o", object: "model" },
          { id: "gpt-4o-mini", object: "model" },
        ],
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: mockJson,
        text: () => Promise.resolve(""),
      });

      const requests = [
        authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`),
        authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`),
        authedSupertest(app).get(`${API_PREFIX}/models?provider=openai`),
      ];

      const results = await Promise.all(requests);
      results.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
          { id: "gpt-4o", displayName: "gpt-4o" },
          { id: "gpt-4o-mini", displayName: "gpt-4o-mini" },
        ]);
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent Claude requests to avoid rate limits", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      mockModelsList.mockImplementation(async function* () {
        await new Promise((r) => setTimeout(r, 20));
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      });

      const requests = [
        authedSupertest(app).get(`${API_PREFIX}/models?provider=claude`),
        authedSupertest(app).get(`${API_PREFIX}/models?provider=claude`),
      ];

      const results = await Promise.all(requests);
      results.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].id).toBe("claude-sonnet-4");
      });
      expect(mockModelsList).toHaveBeenCalledTimes(1);
    });
  });

  describe("validateApiKey", () => {
    it("validates Google keys in a header with a bounded, non-inference request", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

      expect(await validateApiKey("google", "  google-key  ")).toEqual({ valid: true });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://generativelanguage.googleapis.com/v1beta/models",
        expect.objectContaining({
          headers: { "x-goog-api-key": "google-key" },
          signal: expect.any(AbortSignal),
        })
      );
    });

    it.each(["cursor", "openai", "google"] as const)(
      "does not return %s key material echoed by a failed provider",
      async (provider) => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => "The key secret-test-key was rejected",
        });

        const result = await validateApiKey(provider, "secret-test-key");

        expect(result.valid).toBe(false);
        expect(result.error).not.toContain("secret-test-key");
        expect(result.error).toContain("[redacted]");
      }
    );

    it("returns valid: true for Claude when API succeeds", async () => {
      mockModelsList.mockImplementation(async function* () {
        yield { id: "claude-1", display_name: "Claude 1" };
      });

      const result = await validateApiKey("claude", "sk-ant-test");
      expect(result).toEqual({ valid: true });
      expect(mockModelsList).toHaveBeenCalledWith({ limit: 1 });
    });

    it("returns valid: false with error for Claude when API fails", async () => {
      mockModelsList.mockReturnValue({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error("Invalid API key");
            },
          };
        },
      });

      const result = await validateApiKey("claude", "bad-key");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid API key");
    });

    it("returns valid: true for Cursor when fetch succeeds", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: ["gpt-4"] }),
      });

      const result = await validateApiKey("cursor", "cursor-key");
      expect(result).toEqual({ valid: true });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.cursor.com/v1/models",
        expect.objectContaining({
          headers: { Authorization: "Bearer cursor-key" },
        })
      );
    });

    it("returns valid: false with error for Cursor when fetch fails with 401", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const result = await validateApiKey("cursor", "bad-key");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("401");
      expect(result.error).toContain("API key");
    });

    it("returns valid: false when value is empty", async () => {
      const result = await validateApiKey("claude", "");
      expect(result).toEqual({ valid: false, error: "value is required" });
      expect(mockModelsList).not.toHaveBeenCalled();
    });

    it("returns valid: false for unknown provider", async () => {
      const result = await validateApiKey("unknown" as "claude", "key");
      expect(result).toEqual({ valid: false, error: "Unknown provider: unknown" });
    });

    it("returns valid: true for OpenAI when fetch succeeds", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "gpt-4o" }] }),
      });

      const result = await validateApiKey("openai", "sk-openai-key");
      expect(result).toEqual({ valid: true });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/models",
        expect.objectContaining({
          headers: { Authorization: "Bearer sk-openai-key" },
        })
      );
    });

    it("returns valid: false with error for OpenAI when fetch fails with 401", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Invalid API key"),
      });

      const result = await validateApiKey("openai", "bad-key");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("401");
      expect(result.error).toContain("API key");
    });
  });
});
