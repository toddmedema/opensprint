import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError, isApiError, isConnectionError } from "./client";

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("request handling", () => {
    it("returns data from successful JSON response", async () => {
      const mockData = [{ id: "proj-1", name: "Test" }];
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: mockData }),
      } as Response);

      const result = await api.projects.list();
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/projects"),
        expect.objectContaining({ headers: expect.any(Object) })
      );
    });

    it("returns undefined for 204 No Content", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 204,
      } as Response);

      const result = await api.projects.delete("proj-1");
      expect(result).toBeUndefined();
    });

    it("throws ApiError with message and code when response not ok", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: vi.fn().mockResolvedValue({
          error: { code: "VALIDATION", message: "Invalid project ID" },
        }),
      } as Response);

      await expect(api.projects.get("invalid")).rejects.toThrow("Invalid project ID");
      const err = await api.projects.get("invalid").catch((e) => e);
      expect(isApiError(err)).toBe(true);
      expect((err as ApiError).code).toBe("VALIDATION");
      expect((err as ApiError).message).toBe("Invalid project ID");
    });

    it("throws with statusText when error JSON has no message", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: vi.fn().mockResolvedValue({}),
      } as Response);

      await expect(api.projects.list()).rejects.toThrow("Internal Server Error");
    });

    it("uses statusText when JSON parse fails for error response", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Server Error",
        json: vi.fn().mockRejectedValue(new Error("Parse error")),
      } as Response);

      await expect(api.projects.list()).rejects.toThrow("Server Error");
      const err = await api.projects.list().catch((e) => e);
      expect(isApiError(err)).toBe(true);
      expect((err as ApiError).code).toBe("UNKNOWN");
    });
  });

  describe("projects", () => {
    it("get calls correct endpoint", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { id: "proj-1", name: "Test" } }),
      } as Response);

      await api.projects.get("proj-1");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-1"),
        expect.any(Object)
      );
    });

    it("create sends POST with body", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { id: "proj-1", name: "New" } }),
      } as Response);

      await api.projects.create({ name: "New Project" });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/projects"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "New Project" }),
        })
      );
    });
  });

  describe("chat", () => {
    it("send includes context and prdSectionFocus in body", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { message: "Hi" } }),
      } as Response);

      await api.chat.send("proj-1", "Hello", "sketch", "overview");
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.message).toBe("Hello");
      expect(body.context).toBe("sketch");
      expect(body.prdSectionFocus).toBe("overview");
    });

    it("send includes images in body when provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { message: "Hi" } }),
      } as Response);

      const images = ["data:image/png;base64,abc"];
      await api.chat.send("proj-1", "Describe this", "sketch", undefined, images);
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.message).toBe("Describe this");
      expect(body.images).toEqual(images);
    });

    it("history encodes context in URL for plan chat", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { id: "conv-1", context: "plan:auth-plan", messages: [] },
        }),
      } as Response);

      await api.chat.history("proj-1", "plan:auth-plan");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("context=plan%3Aauth-plan"),
        expect.any(Object)
      );
    });
  });

  describe("models", () => {
    it("list calls correct endpoint with provider", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "claude-3-5-sonnet", displayName: "Claude 3.5 Sonnet" }],
        }),
      } as Response);

      const result = await api.models.list("claude");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: "claude-3-5-sonnet", displayName: "Claude 3.5 Sonnet" });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/models?provider=claude"),
        expect.any(Object)
      );
    });
  });

  describe("env", () => {
    it("getKeys returns anthropic, cursor, claudeCli, useCustomCli", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { anthropic: true, cursor: false, claudeCli: true, useCustomCli: false },
        }),
      } as Response);

      const result = await api.env.getKeys();
      expect(result).toEqual({
        anthropic: true,
        cursor: false,
        claudeCli: true,
        useCustomCli: false,
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/keys"),
        expect.any(Object)
      );
    });

    it("validateKey sends POST with provider and value", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { valid: true } }),
      } as Response);

      const result = await api.env.validateKey("claude", "sk-secret");
      expect(result).toEqual({ valid: true });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/keys/validate"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ provider: "claude", value: "sk-secret" }),
        })
      );
    });

    it("validateKey returns valid: false with error on failure", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: { valid: false, error: "Invalid API key" },
        }),
      } as Response);

      const result = await api.env.validateKey("cursor", "bad-key");
      expect(result).toEqual({ valid: false, error: "Invalid API key" });
    });

    it("saveKey sends POST with key and value", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { saved: true } }),
      } as Response);

      await api.env.saveKey("ANTHROPIC_API_KEY", "sk-secret");
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/env/keys"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ key: "ANTHROPIC_API_KEY", value: "sk-secret" }),
        })
      );
    });
  });

  describe("isConnectionError", () => {
    it("returns false for ApiError (server responded)", () => {
      expect(isConnectionError(new ApiError("Not found", "PROJECT_NOT_FOUND"))).toBe(false);
    });

    it("returns true for Failed to fetch", () => {
      expect(isConnectionError(new TypeError("Failed to fetch"))).toBe(true);
      expect(isConnectionError({ message: "Failed to fetch" })).toBe(true);
    });

    it("returns true for NetworkError", () => {
      expect(isConnectionError(new Error("NetworkError"))).toBe(true);
      expect(isConnectionError({ message: "NetworkError" })).toBe(true);
    });

    it("returns true for Network request failed", () => {
      expect(isConnectionError(new Error("Network request failed"))).toBe(true);
    });

    it("returns true for Load failed", () => {
      expect(isConnectionError(new Error("Load failed"))).toBe(true);
      expect(isConnectionError(new Error("Load failed: something"))).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isConnectionError(new Error("Something else"))).toBe(false);
      expect(isConnectionError(new ApiError("Bad request", "VALIDATION"))).toBe(false);
    });
  });

  describe("feedback", () => {
    it("submit includes priority in body when provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 201,
        json: vi.fn().mockResolvedValue({
          data: {
            id: "fb1",
            text: "Critical bug",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        }),
      } as Response);

      await api.feedback.submit("proj-1", "Critical bug", undefined, undefined, 0);
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.text).toBe("Critical bug");
      expect(body.priority).toBe(0);
    });

    it("submit omits priority from body when not provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 201,
        json: vi.fn().mockResolvedValue({
          data: {
            id: "fb2",
            text: "Normal feedback",
            category: "bug",
            mappedPlanId: null,
            createdTaskIds: [],
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        }),
      } as Response);

      await api.feedback.submit("proj-1", "Normal feedback");
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.text).toBe("Normal feedback");
      expect(body).not.toHaveProperty("priority");
    });
  });
});
