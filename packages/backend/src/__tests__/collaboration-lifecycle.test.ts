import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CollaborationPrincipal } from "@opensprint/shared";
import { initAppDb, type AppDb } from "../db/app-db.js";
import {
  CollaborationService,
  type CollaborationStore,
} from "../services/collaboration.service.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { getTestDatabaseUrl } from "./test-db-helper.js";

const host: CollaborationPrincipal = {
  actorId: "local-user",
  displayName: "Local user",
  role: "controller",
};
const dataTables = [
  "collaboration_projects",
  "collaboration_messages",
  "collaboration_runs",
  "collaboration_commands",
  "collaboration_events",
  "collaboration_message_context",
  "collaboration_control_requests",
  "collaboration_control_request_events",
  "collaboration_run_context",
  "collaboration_invites",
  "collaboration_presence",
  "collaboration_preferences",
];
const writerKinds = [
  "invite",
  "revoke",
  "heartbeat",
  "leave",
  "preferences",
  "discussion",
  "control",
  "guidance",
] as const;

describe.each(["sqlite", "postgres"] as const)(
  "collaboration project lifecycle (%s)",
  (dialect) => {
    let directory: string;
    let url: string;
    let db: AppDb;
    let requestDb: AppDb;
    let store: TaskStoreService;
    let project: string;
    let otherProject: string;
    beforeEach(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-collaboration-lifecycle-"));
      url =
        dialect === "sqlite"
          ? `sqlite://${path.join(directory, "test.sqlite")}`
          : await getTestDatabaseUrl();
      db = await initAppDb(url);
      requestDb = await initAppDb(url);
      store = new TaskStoreService();
      await store.init(undefined, db);
      project = `deleted-${randomUUID()}`;
      otherProject = `retained-${randomUUID()}`;
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      const client = await db.getClient();
      for (const projectId of [project, otherProject]) {
        for (const table of dataTables)
          await client.execute(`DELETE FROM ${table} WHERE project_id=$1`, [projectId]);
        await client.execute("DELETE FROM collaboration_project_lifecycle WHERE project_id=$1", [
          projectId,
        ]);
      }
      await requestDb.close();
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    });

    it.each(writerKinds)(
      "rejects a delayed %s write after deletion across independent service/database instances",
      async (kind) => {
        const service = new CollaborationService(store);
        const invitation = await service.createInvite(project, host, {
          displayName: "Reviewer",
          role: "controller",
          expiresInHours: 1,
        });
        await service.command(project, host, {
          commandId: "claim",
          type: "claim_control",
          runId: "attempt-one",
          expectedRevision: 0,
        });
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const delayedStore: CollaborationStore = {
          runWrite: async (action) => {
            entered();
            await gate;
            return requestDb.runWrite(action);
          },
          runRead: (action) => requestDb.runRead!(action),
        };
        const delayed = new CollaborationService(delayedStore);
        const acceptedGuidance = vi.fn(async () => "accepted");
        const actions = {
          invite: () =>
            delayed.createInvite(project, host, {
              displayName: "Late reviewer",
              role: "viewer",
              expiresInHours: 1,
            }),
          revoke: () => delayed.revokeInvite(project, host, invitation.invite.id),
          heartbeat: () => delayed.heartbeat(project, host, "late-browser", null),
          leave: () => delayed.leave(project, host, "late-browser"),
          preferences: () =>
            delayed.updatePreferences(project, host, {
              seenCursor: 0,
              subscribedTaskIds: ["os-task"],
            }),
          discussion: () =>
            delayed.command(project, host, {
              commandId: "late-discussion",
              type: "append_message",
              content: "Must not return after project removal",
            }),
          control: () =>
            delayed.command(project, host, {
              commandId: "late-control",
              type: "claim_control",
              runId: "attempt-two",
              expectedRevision: 0,
            }),
          guidance: () => delayed.withControl(project, host, "attempt-one", acceptedGuidance),
        };
        const pending = actions[kind]();
        const rejected = expect(pending).rejects.toMatchObject({
          statusCode: 404,
          code: "PROJECT_NOT_FOUND",
        });
        try {
          await waiting;
          await store.deleteByProjectId(project);
        } finally {
          release();
        }
        await rejected;
        expect(acceptedGuidance).not.toHaveBeenCalled();
        const client = await db.getClient();
        for (const table of dataTables) {
          const row = await client.queryOne(
            `SELECT COUNT(*) AS count FROM ${table} WHERE project_id=$1`,
            [project]
          );
          expect(Number(row?.count), table).toBe(0);
        }
        // A new service with a fresh connection must observe durable retirement, not a process-local gate.
        await requestDb.close();
        requestDb = await initAppDb(url);
        const reopened = new CollaborationService({
          runWrite: (action) => requestDb.runWrite(action),
          runRead: (action) => requestDb.runRead!(action),
        });
        await expect(reopened.heartbeat(project, host, "after-reopen", null)).rejects.toMatchObject(
          { code: "PROJECT_NOT_FOUND" }
        );
        await reopened.command(otherProject, host, {
          commandId: "unrelated",
          type: "append_message",
          content: "Other projects remain writable",
        });
        expect((await reopened.snapshot(otherProject, host)).messages).toHaveLength(1);
      }
    );

    it("keeps retirement durable when later project cleanup fails and permits a deletion retry", async () => {
      const service = new CollaborationService(store);
      await service.heartbeat(project, host, "before-delete", null);
      const client = await db.getClient();
      const query = vi
        .spyOn(client, "query")
        .mockRejectedValueOnce(new Error("later cleanup failed"));
      await expect(store.deleteByProjectId(project)).rejects.toThrow("later cleanup failed");
      query.mockRestore();

      const independent = new CollaborationService({
        runWrite: (action) => requestDb.runWrite(action),
        runRead: (action) => requestDb.runRead!(action),
      });
      await expect(
        independent.heartbeat(project, host, "after-delete", null)
      ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      expect(await independent.presence(project)).toEqual([]);
      await store.deleteByProjectId(project);
      await store.deleteByProjectId(project);
      await expect(
        independent.createInvite(project, host, {
          displayName: "After retry",
          role: "viewer",
          expiresInHours: 1,
        })
      ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    });

    if (dialect === "postgres") {
      it("waits for an active writer on another connection, then removes its committed state", async () => {
        const service = new CollaborationService(store);
        await service.command(project, host, {
          commandId: "claim",
          type: "claim_control",
          runId: "attempt-one",
          expectedRevision: 0,
        });
        let release!: () => void;
        let entered!: () => void;
        let writerPid = 0;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const independent = new CollaborationService({
          runWrite: (action) =>
            requestDb.runWrite(async (tx) => {
              writerPid = Number((await tx.queryOne("SELECT pg_backend_pid() AS pid"))?.pid);
              return action(tx);
            }),
          runRead: (action) => requestDb.runRead!(action),
        });
        const writer = independent.withControl(project, host, "attempt-one", async () => {
          entered();
          await gate;
          return "accepted before deletion";
        });
        await started;
        let finishedDeleting = false;
        const deletion = store.deleteByProjectId(project).finally(() => {
          finishedDeleting = true;
        });
        try {
          const client = await db.getClient();
          const deadline = Date.now() + 5_000;
          let observedBlockedDeletion = false;
          while (Date.now() < deadline && !finishedDeleting) {
            const blocked = await client.queryOne(
              "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid)) LIMIT 1",
              [writerPid]
            );
            if (blocked) {
              observedBlockedDeletion = true;
              break;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          expect(observedBlockedDeletion).toBe(true);
          expect(finishedDeleting).toBe(false);
        } finally {
          release();
          await Promise.allSettled([writer, deletion]);
        }
        expect(await writer).toBe("accepted before deletion");
        await deletion;
        expect((await independent.snapshot(project, host)).runs).toEqual([]);
        await expect(
          independent.heartbeat(project, host, "after-active-writer", null)
        ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      });
    }
  }
);
