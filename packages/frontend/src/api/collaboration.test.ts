import { describe, it, expect } from "vitest";
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
  it("advances across task, approval and operation events without interpreting them as run control", () => {
    const events = ["task_changed", "approval_changed", "operation_changed"].map((type, index) => ({
      projectId: "p",
      cursor: index + 2,
      type,
      actorId: "system",
      createdAt: "now",
      payload: { id: "resource", revision: index + 1 },
    }));
    const next = applyCollaborationReplay(snapshot, { events, nextCursor: 4, hasMore: false });
    expect(next.cursor).toBe(4);
    expect(next.runs).toEqual([]);
    expect(next.messages).toEqual([]);
  });
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
