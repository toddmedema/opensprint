import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { modelsRouter } from "../routes/models.js";
import { API_PREFIX } from "@opensprint/shared";
import { errorHandler } from "../middleware/error-handler.js";
import * as modelListCache from "../services/model-list-cache.js";
import { clearInFlightFetches, validateApiKey } from "../routes/models.js";

const mockModelsList = vi.fn();
const mockGetNextKey = vi.fn();

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

function createMinimalModelsApp() {
  const app = express();
  app.use(express.json());
  app.use(`${API_PREFIX}/models`, modelsRouter);
  app.use(errorHandler);
  return app;
}

describe("Models API", () => {
  let app: ReturnType<typeof createMinimalModelsApp>;
  let originalAnthropicKey: string | undefined;
  let originalCursorKey: string | undefined;
  let originalOpenAIKey: string | undefined;

  beforeEach(() => {
    app = createMinimalModelsApp();
    modelListCache.clear();
    clearInFlightFetches();
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalCursorKey = process.env.CURSOR_API_KEY;
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    vi.clearAllMocks();
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
    globalThis.fetch = originalFetch;
  });

  describe("GET /models", () => {
    it("returns empty array when provider is claude and no API key", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const res = await request(app).get(`${API_PREFIX}/models?provider=claude`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(mockModelsList).not.toHaveBeenCalled();
    });

    it("returns empty array when provider is cursor and no API key", async () => {
      delete process.env.CURSOR_API_KEY;
      const res = await request(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns empty array when provider is openai and no API key", async () => {
      delete process.env.OPENAI_API_KEY;
      mockGetNextKey.mockResolvedValue(null);
      const res = await request(app).get(`${API_PREFIX}/models?provider=openai`);
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

      const res = await request(app).get(`${API_PREFIX}/models?provider=openai`);

      expect(res.status).toBe(200);
      expect(mockGetNextKey).toHaveBeenCalledWith("", "OPENAI_API_KEY", {
        includeRateLimited: true,
      });
      expect(res.body.data).toEqual([{ id: "gpt-4o", displayName: "gpt-4o" }]);
    });

    it("returns empty array for unknown provider", async () => {
      const res = await request(app).get(`${API_PREFIX}/models?provider=unknown`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("fetches and returns Claude models when API key is set", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      async function* gen() {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
        yield { id: "claude-opus-4", display_name: "Claude Opus 4" };
      }
      mockModelsList.mockReturnValue(gen());

      const res = await request(app).get(`${API_PREFIX}/models?provider=claude`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
        { id: "claude-opus-4", displayName: "Claude Opus 4" },
      ]);
      expect(mockModelsList).toHaveBeenCalledTimes(1);
    });

    it("uses cache on second Claude request", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      async function* gen() {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      }
      mockModelsList.mockReturnValue(gen());

      const res1 = await request(app).get(`${API_PREFIX}/models?provider=claude`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toHaveLength(1);
      expect(mockModelsList).toHaveBeenCalledTimes(1);

      const res2 = await request(app).get(`${API_PREFIX}/models?provider=claude`);
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

      const res = await request(app).get(`${API_PREFIX}/models?provider=cursor`);
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
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: mockJson,
        text: () => Promise.resolve(""),
      });

      const res1 = await request(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const res2 = await request(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no additional call
    }, 10_000);

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

      const res = await request(app).get(`${API_PREFIX}/models?provider=openai`);
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
      });

      const res = await request(app).get(`${API_PREFIX}/models?provider=openai`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: "chatgpt-4o-latest", displayName: "chatgpt-4o-latest" },
        { id: "gpt-5", displayName: "gpt-5" },
        { id: "gpt-5-mini", displayName: "gpt-5-mini" },
        { id: "gpt-5.3-codex", displayName: "gpt-5.3-codex" },
        { id: "o3", displayName: "o3" },
        { id: "o4-mini", displayName: "o4-mini" },
      ]);
    });

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

      const res1 = await request(app).get(`${API_PREFIX}/models?provider=openai`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const res2 = await request(app).get(`${API_PREFIX}/models?provider=openai`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("defaults to claude when provider not specified", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const res = await request(app).get(`${API_PREFIX}/models`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns hardcoded defaults for claude-cli when no API key is set", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const res = await request(app).get(`${API_PREFIX}/models?provider=claude-cli`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toHaveProperty("id");
      expect(res.body.data[0]).toHaveProperty("displayName");
    });

    it("returns API model list for claude-cli when API key is available", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      async function* gen() {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      }
      mockModelsList.mockReturnValue(gen());

      const res = await request(app).get(`${API_PREFIX}/models?provider=claude-cli`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ id: "claude-sonnet-4", displayName: "Claude Sonnet 4" }]);
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
        request(app).get(`${API_PREFIX}/models?provider=cursor`),
        request(app).get(`${API_PREFIX}/models?provider=cursor`),
        request(app).get(`${API_PREFIX}/models?provider=cursor`),
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

      const res = await request(app).get(`${API_PREFIX}/models?provider=cursor`);
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

      const res = await request(app).get(`${API_PREFIX}/models?provider=openai`);
      expect(res.status).toBe(429);
      expect(res.body.error?.message).toContain("rate limit");
      expect(res.body.error?.message).toContain("30 minutes");
    });

    it("uses API key from global store when projectId is provided (projectId passed for API compatibility, key resolution is global-only)", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-ant-global-key", keyId: "k1", source: "global" });
      async function* gen() {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      }
      mockModelsList.mockReturnValue(gen());

      delete process.env.ANTHROPIC_API_KEY;
      const res = await request(app).get(
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
      async function* gen() {
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      }
      mockModelsList.mockReturnValue(gen());

      delete process.env.ANTHROPIC_API_KEY;
      const res = await request(app).get(`${API_PREFIX}/models?provider=claude`);

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
        request(app).get(`${API_PREFIX}/models?provider=openai`),
        request(app).get(`${API_PREFIX}/models?provider=openai`),
        request(app).get(`${API_PREFIX}/models?provider=openai`),
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
      let resolveGen: () => void;
      const genReady = new Promise<void>((r) => {
        resolveGen = r;
      });
      async function* gen() {
        await genReady;
        yield { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" };
      }
      mockModelsList.mockReturnValue(gen());

      const requests = [
        request(app).get(`${API_PREFIX}/models?provider=claude`),
        request(app).get(`${API_PREFIX}/models?provider=claude`),
      ];

      resolveGen!();
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
    it("returns valid: true for Claude when API succeeds", async () => {
      async function* gen() {
        yield { id: "claude-1", display_name: "Claude 1" };
      }
      mockModelsList.mockReturnValue(gen());

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
        "https://api.cursor.com/v0/models",
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
