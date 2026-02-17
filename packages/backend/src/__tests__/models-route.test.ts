import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { API_PREFIX } from "@opensprint/shared";
import * as modelListCache from "../services/model-list-cache.js";

const mockModelsList = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    models: {
      list: mockModelsList,
    },
  })),
}));

const originalFetch = globalThis.fetch;

describe("Models API", () => {
  let app: ReturnType<typeof createApp>;
  let originalAnthropicKey: string | undefined;
  let originalCursorKey: string | undefined;

  beforeEach(() => {
    app = createApp();
    modelListCache.clear();
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalCursorKey = process.env.CURSOR_API_KEY;
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    process.env.CURSOR_API_KEY = originalCursorKey;
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
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: ["gpt-4"] }),
      });

      const res1 = await request(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res1.status).toBe(200);
      expect(res1.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const res2 = await request(app).get(`${API_PREFIX}/models?provider=cursor`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no additional call
    });

    it("defaults to claude when provider not specified", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const res = await request(app).get(`${API_PREFIX}/models`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });
});
