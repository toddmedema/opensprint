import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@opensprint/shared";
import { GitHubAdapter } from "../services/adapters/github-adapter.js";
import { GitHubApiError } from "../services/github-api.js";

const connection = { provider_resource_name: "octocat/hello-world" } as IntegrationConnection;
const adapter = new GitHubAdapter();
const issue = (id: number) => ({
  id,
  number: id,
  title: `Issue ${id}`,
  body: null,
  user: null,
  labels: [],
  created_at: "2025-01-01T00:00:00Z",
  html_url: `https://github.com/octocat/hello-world/issues/${id}`,
});

afterEach(() => vi.unstubAllGlobals());

describe("GitHub adapter", () => {
  it("imports all pages and excludes pull requests on every page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      ...issue(i + 1),
      pull_request: {},
    }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => firstPage })
      .mockResolvedValueOnce({ ok: true, json: async () => [issue(101)] });
    vi.stubGlobal("fetch", fetch);
    const items = await adapter.fetchItems(connection, "token");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain("page=2");
    expect(items).toEqual([
      expect.objectContaining({
        externalId: "101",
        rawPayload: {
          id: "101",
          number: 101,
          repository: "octocat/hello-world",
          url: "https://github.com/octocat/hello-world/issues/101",
        },
      }),
    ]);
  });

  it("uses the immutable global issue id rather than repository-local number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [{ ...issue(9001), number: 1 }] })
    );
    const items = await adapter.fetchItems(connection, "token");
    expect(items[0].externalId).toBe("9001");
    expect(items[0].rawPayload).toMatchObject({ number: 1 });
  });

  it("retains the canonical issue repository after a repository rename", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => [
            { ...issue(9001), html_url: "https://github.com/octocat/renamed/issues/9001" },
          ],
        })
    );
    const items = await adapter.fetchItems(connection, "token");
    expect(items[0].rawPayload).toMatchObject({
      repository: "octocat/renamed",
      url: "https://github.com/octocat/renamed/issues/9001",
    });
  });

  it("rejects invalid repository paths before issuing requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      adapter.fetchItems(
        { ...connection, provider_resource_name: "octocat/repo/../other" },
        "token"
      )
    ).rejects.toThrow("Invalid GitHub repository");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("paginates repository sources", async () => {
    const repos = Array.from({ length: 100 }, (_, i) => ({ id: i, full_name: `owner/repo-${i}` }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => repos })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 101, full_name: "owner/last" }],
      });
    vi.stubGlobal("fetch", fetch);
    expect(await adapter.listSources(connection, "token")).toHaveLength(101);
  });

  it.each([
    { status: 401, remaining: null, reconnect: true },
    { status: 403, remaining: "0", reconnect: false },
    { status: 429, remaining: null, reconnect: false },
    { status: 503, remaining: null, reconnect: false },
  ])(
    "classifies upstream $status without leaking its body",
    async ({ status, remaining, reconnect }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status,
          headers: new Headers(remaining ? { "x-ratelimit-remaining": remaining } : {}),
          text: async () => "secret upstream body",
        })
      );
      try {
        await adapter.fetchItems(connection, "secret token");
        throw new Error("Expected GitHub request failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect((error as GitHubApiError).needsReconnect).toBe(reconnect);
        expect(String(error)).not.toContain("secret");
      }
    }
  );
});
