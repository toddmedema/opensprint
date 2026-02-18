import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./client";

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
        expect.objectContaining({ headers: expect.any(Object) }),
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

    it("throws with server error message when response not ok", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: vi.fn().mockResolvedValue({
          error: { code: "VALIDATION", message: "Invalid project ID" },
        }),
      } as Response);

      await expect(api.projects.get("invalid")).rejects.toThrow("Invalid project ID");
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
        expect.any(Object),
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
        }),
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
  });
});
