import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { CollaborationSnapshot, CollaborationReplay } from "@opensprint/shared";
import { applyCollaborationReplay } from "./collaboration";
const snapshot: CollaborationSnapshot = {
  projectId: "p",
  sessionId: "default",
  cursor: 1,
  messages: [],
  runs: [],
  messagesHasMore: false,
  runsHasMore: false,
  principal: { actorId: "alice", displayName: "Alice", role: "controller" },
};
const replay: CollaborationReplay = {
  events: [
    {
      projectId: "p",
      cursor: 2,
      type: "message_appended",
      actorId: "bob",
      createdAt: "now",
      payload: {
        id: "m",
        actorId: "bob",
        displayName: "Bob",
        createdAt: "now",
        content: "Hello",
        cursor: 2,
      },
    },
  ],
  nextCursor: 2,
  hasMore: false,
};
describe("shared session replay", () => {
  it("recovers a committed message once without changing the original snapshot", () => {
    const next = applyCollaborationReplay(snapshot, replay);
    expect(next.messages.map((m) => m.id)).toEqual(["m"]);
    expect(applyCollaborationReplay(next, replay).messages).toHaveLength(1);
    expect(snapshot.messages).toEqual([]);
  });
  it("requires a fresh snapshot for missing or foreign events", () => {
    expect(() =>
      applyCollaborationReplay(snapshot, {
        ...replay,
        events: [{ ...replay.events[0], cursor: 3 }],
        nextCursor: 3,
      })
    ).toThrow();
    expect(() =>
      applyCollaborationReplay(snapshot, {
        ...replay,
        events: [{ ...replay.events[0], projectId: "foreign" }],
      })
    ).toThrow();
  });
  it("preserves CAS revisions and replaces control for the exact attempt", () => {
    const result = applyCollaborationReplay(snapshot, {
      events: [
        {
          projectId: "p",
          cursor: 2,
          type: "control_handed_off",
          actorId: "alice",
          createdAt: "now",
          payload: { runId: "attempt-2", controllerId: "bob", revision: 3 },
        },
      ],
      nextCursor: 2,
      hasMore: false,
    });
    expect(result.runs).toEqual([{ runId: "attempt-2", controllerId: "bob", revision: 3 }]);
  });
});

describe("collaboration request routing", () => {
  const hostApi = "https://private-host.example.test";
  const initialPath = window.location.pathname;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE", hostApi);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
      } as Response)
    );
  });

  afterEach(() => {
    delete window.__OPENSPRINT_COLLABORATION_GUEST__;
    delete window.__OPENSPRINT_LOCAL_SESSION__;
    window.history.replaceState(null, "", initialPath);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the guest listener for reads, writes and deletes despite a built host API base", async () => {
    window.__OPENSPRINT_COLLABORATION_GUEST__ = true;
    window.history.replaceState(null, "", "/collaborate/shared");
    const { collaborationApi } = await import("./collaboration");
    const client = collaborationApi("shared", "invite-credential");
    await client.snapshot();
    await client.heartbeat("browser-one", "task-one");
    await client.leave("browser-one");
    await client.revokeInvite("invite-one");

    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/projects/shared/collaboration/snapshot",
      "/api/v1/projects/shared/collaboration/presence",
      "/api/v1/projects/shared/collaboration/presence/browser-one",
      "/api/v1/projects/shared/collaboration/invites/invite-one",
    ]);
    for (const [, options] of vi.mocked(fetch).mock.calls) {
      expect(options?.headers).toMatchObject({ Authorization: "Bearer invite-credential" });
      expect(options).not.toHaveProperty("apiBaseUrl");
    }
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ clientId: "browser-one", taskId: "task-one" }),
    });
    expect(vi.mocked(fetch).mock.calls[2]?.[1]).toMatchObject({
      method: "DELETE",
      keepalive: true,
    });
  });

  it("preserves the configured host API and local-session authorization on host pages", async () => {
    window.__OPENSPRINT_LOCAL_SESSION__ = "host-session";
    window.history.replaceState(null, "", "/projects/shared/execute");
    const { collaborationApi } = await import("./collaboration");
    await collaborationApi("shared").snapshot();

    expect(fetch).toHaveBeenCalledWith(
      `${hostApi}/api/v1/projects/shared/collaboration/snapshot`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer host-session" }),
      })
    );
  });

  it("preserves the configured API for a separately hosted invite page without a guest marker", async () => {
    window.history.replaceState(null, "", "/collaborate/shared");
    const { collaborationApi } = await import("./collaboration");
    await collaborationApi("shared", "invite-credential").snapshot();

    expect(fetch).toHaveBeenCalledWith(
      `${hostApi}/api/v1/projects/shared/collaboration/snapshot`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer invite-credential" }),
      })
    );
  });

  it("limits the guest bootstrap routing override to collaboration APIs", async () => {
    window.__OPENSPRINT_COLLABORATION_GUEST__ = true;
    const { api } = await import("./client");
    await api.projects.list();

    expect(fetch).toHaveBeenCalledWith(`${hostApi}/api/v1/projects`, expect.any(Object));
  });
});
