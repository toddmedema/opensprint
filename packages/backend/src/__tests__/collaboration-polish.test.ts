import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { CollaborationPrincipal } from "@opensprint/shared";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { CollaborationService } from "../services/collaboration.service.js";
import { createCollaborationRouter } from "../routes/collaboration.js";
import { createCollaborationAccess } from "../services/collaboration-access.service.js";
import { AppError, errorHandler } from "../middleware/error-handler.js";
import { VITEST_DEFAULT_LOCAL_SESSION_TOKEN } from "../services/local-session-auth.service.js";
import { getTestDatabaseUrl } from "./test-db-helper.js";

const host: CollaborationPrincipal = {
  actorId: "local-user",
  displayName: "Local user",
  role: "controller",
};
const alice: CollaborationPrincipal = {
  actorId: "alice",
  displayName: "Alice",
  role: "controller",
};
const bob: CollaborationPrincipal = { actorId: "bob", displayName: "Bob", role: "controller" };

// Exercise the same portable schema, membership and CAS behavior on both supported dialects.
describe.each(["sqlite", "postgres"] as const)("polished collaboration (%s)", (dialect) => {
  let db: AppDb;
  let service: CollaborationService;
  let project: string;
  beforeEach(async () => {
    db = await initAppDb(dialect === "sqlite" ? "sqlite://:memory:" : await getTestDatabaseUrl());
    service = new CollaborationService({
      runWrite: (fn) => db.runWrite(fn),
      runRead: (fn) => db.runRead!(fn),
    });
    project = `collab-${randomUUID()}`;
  });
  afterEach(async () => {
    // Every project is unique; remove only this fixture's collaboration rows on PostgreSQL.
    if (dialect === "postgres")
      await db.runWrite(async (tx) => {
        for (const table of [
          "collaboration_projects",
          "collaboration_messages",
          "collaboration_message_context",
          "collaboration_runs",
          "collaboration_control_requests",
          "collaboration_control_request_events",
          "collaboration_run_context",
          "collaboration_commands",
          "collaboration_events",
          "collaboration_invites",
          "collaboration_presence",
          "collaboration_preferences",
        ])
          await tx.execute(`DELETE FROM ${table} WHERE project_id = $1`, [project]);
      });
    await db.close();
  });

  it("stores only invitation hashes, isolates projects, and immediately enforces expiry and revocation", async () => {
    await expect(
      service.createInvite(project, alice, {
        displayName: "Guest",
        role: "controller",
        expiresInHours: 24,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    const created = await service.createInvite(project, host, {
      displayName: "Guest",
      role: "controller",
      expiresInHours: 24,
    });
    const principal = await service.resolveInvite(project, created.token);
    expect(principal).toEqual({
      actorId: created.invite.actorId,
      displayName: "Guest",
      role: "controller",
    });
    expect(await service.resolveInvite("foreign", created.token)).toBeNull();
    const stored = await db.runRead!((tx) =>
      tx.queryOne("SELECT * FROM collaboration_invites WHERE project_id = $1", [project])
    );
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(await service.listInvites(project, host))).not.toContain("token_hash");
    await service.heartbeat(project, principal!, "browser-one", "os-task");
    await service.revokeInvite(project, host, created.invite.id);
    expect(await service.resolveInvite(project, created.token)).toBeNull();
    expect(await service.presence(project)).toEqual([]);
    const expired = await service.createInvite(project, host, {
      displayName: "Expired",
      role: "viewer",
      expiresInHours: 1,
    });
    await db.runWrite((tx) =>
      tx.execute("UPDATE collaboration_invites SET expires_at = $2 WHERE project_id = $1", [
        project,
        "2000-01-01T00:00:00.000Z",
      ])
    );
    expect(await service.resolveInvite(project, expired.token)).toBeNull();
  });

  it("retains control until correct recipient accepts and rejects stale, spoofed and revoked-party transfers", async () => {
    await service.command(project, alice, {
      type: "claim_control",
      commandId: "claim",
      runId: "attempt-1",
      expectedRevision: 0,
      taskId: "os-task",
    });
    const requests = await Promise.allSettled(
      ["ask-one", "ask-two"].map((commandId) =>
        service.command(
          project,
          bob,
          {
            type: "request_control",
            commandId,
            runId: "attempt-1",
            expectedRevision: 1,
            targetActorId: "bob",
            taskId: "os-task",
          },
          () => true
        )
      )
    );
    expect(requests.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await service.getRunControl(project, "attempt-1")).controllerId).toBe("alice");
    await expect(
      service.command(
        project,
        bob,
        {
          type: "respond_control",
          commandId: "self-accept",
          runId: "attempt-1",
          expectedRevision: 2,
          accept: true,
        },
        () => true
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await service.command(
      project,
      alice,
      {
        type: "respond_control",
        commandId: "accept-bob",
        runId: "attempt-1",
        expectedRevision: 2,
        accept: true,
      },
      () => true
    );
    expect((await service.getRunControl(project, "attempt-1")).controllerId).toBe("bob");
    const invitation = await service.createInvite(project, host, {
      displayName: "Next",
      role: "controller",
      expiresInHours: 1,
    });
    const guest = (await service.resolveInvite(project, invitation.token))!;
    await service.command(
      project,
      bob,
      {
        type: "handoff_control",
        commandId: "offer",
        runId: "attempt-1",
        expectedRevision: 3,
        targetActorId: guest.actorId,
      },
      (actor) => actor === "bob"
    );
    expect((await service.getRunControl(project, "attempt-1")).controllerId).toBe("bob");
    await service.revokeInvite(project, host, invitation.invite.id);
    await expect(
      service.command(
        project,
        guest,
        {
          type: "respond_control",
          commandId: "accept-revoked",
          runId: "attempt-1",
          expectedRevision: 4,
          accept: true,
        },
        (actor) => actor === "bob"
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await service.command(project, bob, {
      type: "cancel_control_request",
      commandId: "cancel",
      runId: "attempt-1",
      expectedRevision: 4,
    });
    expect((await service.getRunControl(project, "attempt-1")).request).toBeUndefined();
    await expect(
      service.command(project, alice, {
        type: "claim_control",
        commandId: "stale",
        runId: "attempt-1",
        expectedRevision: 1,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("preserves contextual discussions and decisions and derives targeted unread notifications", async () => {
    await service.updatePreferences(project, bob, { seenCursor: 0, subscribedTaskIds: ["os-one"] });
    await service.command(project, alice, {
      type: "append_message",
      commandId: "one",
      content: "Use the URL",
      taskId: "os-one",
      context: {
        kind: "diff",
        label: "Filters",
        path: "src/filter.ts",
        line: 12,
        attemptId: "attempt-1",
      },
      mentionActorIds: ["bob"],
      decision: true,
    });
    await service.command(project, alice, {
      type: "append_message",
      commandId: "two",
      content: "Other task",
      taskId: "os-two",
    });
    await service.command(project, alice, {
      type: "append_message",
      commandId: "three",
      content: "Subscribed update",
      taskId: "os-one",
    });
    const snapshot = await service.snapshot(project, bob);
    expect(snapshot.messages[0]).toMatchObject({
      taskId: "os-one",
      decision: true,
      context: { path: "src/filter.ts", attemptId: "attempt-1" },
      mentionActorIds: ["bob"],
    });
    expect((await service.notifications(project, bob)).map((n) => n.kind)).toEqual([
      "task_discussion",
      "mention",
    ]);
    await service.updatePreferences(project, bob, {
      seenCursor: 3,
      subscribedTaskIds: ["os-one"],
      markSeen: true,
    });
    expect(await service.notifications(project, bob)).toEqual([]);
    expect((await service.preferences(project, bob)).seenAt).toMatch(/^\d{4}-/);
    await service.updatePreferences(project, bob, { seenCursor: 0, subscribedTaskIds: [] });
    expect((await service.preferences(project, bob)).seenCursor).toBe(3);
    await expect(
      service.updatePreferences(project, bob, { seenCursor: 9, subscribedTaskIds: [] })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("tracks each browser independently, expires stale presence, and never transfers control on leave", async () => {
    await service.command(project, alice, {
      type: "claim_control",
      commandId: "claim",
      runId: "attempt-1",
      expectedRevision: 0,
    });
    await service.heartbeat(project, alice, "browser-one", "os-one");
    await service.heartbeat(project, alice, "browser-two", "os-two");
    await service.heartbeat(project, bob, "browser-one", null);
    expect(await service.presence(project)).toHaveLength(3);
    await service.leave(project, bob, "browser-two");
    expect(await service.presence(project)).toHaveLength(3);
    await service.leave(project, alice, "browser-one");
    expect(await service.presence(project)).toHaveLength(2);
    expect((await service.getRunControl(project, "attempt-1")).controllerId).toBe("alice");
    await db.runWrite((tx) =>
      tx.execute("UPDATE collaboration_presence SET last_seen_at = $2 WHERE project_id = $1", [
        project,
        "2000-01-01T00:00:00.000Z",
      ])
    );
    expect(await service.presence(project)).toEqual([]);
  });

  it("keeps old unread mentions through more than a thousand unrelated events", async () => {
    const underscored = { ...bob, actorId: "reader_one" };
    await service.command(project, alice, {
      type: "append_message",
      commandId: "mention",
      content: "Please review this boundary",
      mentionActorIds: [underscored.actorId],
    });
    for (let index = 0; index < 1001; index++)
      await service.command(project, alice, {
        type: "append_message",
        commandId: `unrelated-${index}`,
        content: "Unrelated project discussion",
      });
    // An underscore in actor identity must be literal, never SQL LIKE's wildcard.
    await service.command(project, alice, {
      type: "append_message",
      commandId: "other-reader",
      content: "For someone else",
      mentionActorIds: ["readerXone"],
    });
    expect(await service.notifications(project, underscored)).toEqual([
      expect.objectContaining({
        kind: "mention",
        cursor: 1,
        content: "Please review this boundary",
      }),
    ]);
  });

  it.each(["accept", "decline", "cancel", "reclaim"] as const)(
    "removes a %s-resolved control action while retaining its activity",
    async (resolution) => {
      await service.command(project, alice, {
        type: "claim_control",
        commandId: "claim",
        runId: "attempt-one",
        expectedRevision: 0,
        taskId: "os-one",
      });
      await service.command(
        project,
        bob,
        {
          type: "request_control",
          commandId: "request",
          runId: "attempt-one",
          expectedRevision: 1,
          targetActorId: bob.actorId,
          taskId: "os-one",
        },
        () => true
      );
      expect(await service.notifications(project, alice)).toEqual([
        expect.objectContaining({ kind: "control_request", cursor: 2 }),
      ]);
      expect(await service.notifications(project, alice, () => false)).toEqual([]);
      expect(await service.notifications(project, bob)).toEqual([]);
      if (resolution === "accept" || resolution === "decline")
        await service.command(
          project,
          alice,
          {
            type: "respond_control",
            commandId: "resolve",
            runId: "attempt-one",
            expectedRevision: 2,
            accept: resolution === "accept",
          },
          () => true
        );
      else if (resolution === "cancel")
        await service.command(project, bob, {
          type: "cancel_control_request",
          commandId: "resolve",
          runId: "attempt-one",
          expectedRevision: 2,
        });
      else
        await service.command(project, host, {
          type: "reclaim_control",
          commandId: "resolve",
          runId: "attempt-one",
          expectedRevision: 2,
        });
      expect(await service.notifications(project, alice)).toEqual([]);
      expect((await service.replay(project)).events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "control_requested" })])
      );
    }
  );

  it("requires explicit host reclaim to recover revoked ownership without transferring on disconnect", async () => {
    const invitation = await service.createInvite(project, host, {
      displayName: "Controller",
      role: "controller",
      expiresInHours: 1,
    });
    const guest = (await service.resolveInvite(project, invitation.token))!;
    await service.command(project, guest, {
      type: "claim_control",
      commandId: "claim",
      runId: "attempt-1",
      expectedRevision: 0,
    });
    await service.revokeInvite(project, host, invitation.invite.id);
    expect((await service.getRunControl(project, "attempt-1")).controllerId).toBe(guest.actorId);
    await expect(
      service.command(project, bob, {
        type: "reclaim_control",
        commandId: "reclaim-bob",
        runId: "attempt-1",
        expectedRevision: 1,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await service.command(project, host, {
      type: "reclaim_control",
      commandId: "reclaim-host",
      runId: "attempt-1",
      expectedRevision: 1,
    });
    expect((await service.getRunControl(project, "attempt-1")).controllerId).toBe(host.actorId);
    await expect(
      service.command(project, guest, {
        type: "append_message",
        commandId: "stale-guest",
        content: "Queued before revocation",
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("acknowledges the displayed snapshot and keeps read state on subscription changes", async () => {
    await service.updatePreferences(project, bob, { seenCursor: 0, subscribedTaskIds: ["os-one"] });
    expect((await service.preferences(project, bob)).seenAt).toBeNull();
    const observedAt = "2026-01-01T00:00:00.000Z";
    await service.updatePreferences(project, bob, {
      seenCursor: 0,
      subscribedTaskIds: ["os-one"],
      markSeen: true,
      markSeenAt: observedAt,
    });
    expect((await service.preferences(project, bob)).seenAt).toBe(observedAt);
    await service.updatePreferences(project, bob, { seenCursor: 0, subscribedTaskIds: [] });
    expect((await service.preferences(project, bob)).seenAt).toBe(observedAt);
    await service.updatePreferences(project, bob, {
      seenCursor: 0,
      subscribedTaskIds: [],
      markSeen: true,
      markSeenAt: "2025-01-01T00:00:00.000Z",
    });
    expect((await service.preferences(project, bob)).seenAt).toBe(observedAt);
    await expect(
      service.updatePreferences(project, bob, {
        seenCursor: 0,
        subscribedTaskIds: [],
        markSeen: true,
        markSeenAt: "2099-01-01T00:00:00.000Z",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("requires a verified task and current attempt for every invitation-facing control command", async () => {
    let activeAttempt: string | null = "attempt-current";
    const app = express();
    app.use(express.json());
    app.use(
      "/projects/:projectId/collaboration",
      createCollaborationRouter({
        service,
        access: createCollaborationAccess("[]"),
        assertProjectExists: async () => undefined,
        assertTaskExists: async (_projectId, taskId) => {
          if (taskId !== "os-task") throw new AppError(404, "NOT_FOUND", "Unknown task");
        },
        getActiveRun: async () => activeAttempt && { attemptId: activeAttempt },
      })
    );
    app.use(errorHandler);
    const { token } = await service.createInvite(project, host, {
      displayName: "Controller",
      role: "controller",
      expiresInHours: 1,
    });
    const endpoint = `/projects/${project}/collaboration/commands`;
    const controls = [
      { type: "claim_control" },
      { type: "handoff_control", targetActorId: null },
      { type: "request_control", targetActorId: "local-user" },
      { type: "respond_control", accept: true },
      { type: "cancel_control_request" },
      { type: "reclaim_control" },
    ];
    for (const [index, control] of controls.entries()) {
      const input = {
        ...control,
        commandId: `missing-task-${index}`,
        runId: "attempt-current",
        expectedRevision: 0,
      };
      const missingTask = await request(app)
        .post(endpoint)
        .auth(token, { type: "bearer" })
        .send(input);
      expect(missingTask.status).toBe(400);
      expect(missingTask.body.error.code).toBe("INVALID_TASK_ID");
      const stale = await request(app)
        .post(endpoint)
        .auth(token, { type: "bearer" })
        .send({ ...input, commandId: `stale-${index}`, taskId: "os-task", runId: "old-attempt" });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("AGENT_ATTEMPT_CHANGED");
    }
    expect((await service.snapshot(project, host)).runs).toEqual([]);
    expect((await service.snapshot(project, host)).cursor).toBe(0);
    const claim = {
      type: "claim_control",
      commandId: "valid-claim",
      runId: "attempt-current",
      taskId: "os-task",
      expectedRevision: 0,
    };
    expect(
      (
        await request(app)
          .post(endpoint)
          .auth(token, { type: "bearer" })
          .send({ ...claim, taskId: "foreign" })
      ).status
    ).toBe(404);
    const valid = await request(app).post(endpoint).auth(token, { type: "bearer" }).send(claim);
    expect(valid.status).toBe(200);
    expect(valid.body.data.run).toMatchObject({
      runId: "attempt-current",
      taskId: "os-task",
      revision: 1,
    });
    activeAttempt = null;
    const ended = await request(app)
      .post(endpoint)
      .auth(token, { type: "bearer" })
      .send({
        ...claim,
        type: "handoff_control",
        targetActorId: null,
        commandId: "ended-release",
        expectedRevision: 1,
      });
    expect(ended.status).toBe(409);
    expect((await service.getRunControl(project, "attempt-current")).revision).toBe(1);
  });

  it("fails closed when a control endpoint cannot resolve active attempts", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/projects/:projectId/collaboration",
      createCollaborationRouter({
        service,
        access: createCollaborationAccess("[]"),
        assertProjectExists: async () => undefined,
      })
    );
    app.use(errorHandler);
    const response = await request(app)
      .post(`/projects/${project}/collaboration/commands`)
      .auth(VITEST_DEFAULT_LOCAL_SESSION_TOKEN, { type: "bearer" })
      .send({
        type: "claim_control",
        commandId: "unverified-claim",
        runId: "arbitrary",
        taskId: "os-task",
        expectedRevision: 0,
      });
    expect(response.status).toBe(503);
    expect((await service.snapshot(project, host)).runs).toEqual([]);
  });

  it("authenticates dynamic credentials on every route and rejects stale task control and host-only access", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/projects/:projectId/collaboration",
      createCollaborationRouter({
        service,
        access: createCollaborationAccess("[]"),
        assertProjectExists: async (p) => {
          if (p !== project) throw new AppError(404, "NOT_FOUND", "Unknown project");
        },
        assertTaskExists: async (_p, t) => {
          if (t !== "os-task") throw new AppError(404, "NOT_FOUND", "Unknown task");
        },
        getActiveRun: async () => ({ taskId: "os-task", attemptId: "attempt-new" }),
        getOverview: async () => ({ projectName: "Safe fixture", tasks: [] }),
      })
    );
    app.use(errorHandler);
    const endpoint = `/projects/${project}/collaboration`;
    const created = await request(app)
      .post(`${endpoint}/invites`)
      .auth(VITEST_DEFAULT_LOCAL_SESSION_TOKEN, { type: "bearer" })
      .send({ displayName: "Reviewer", role: "controller", expiresInHours: 24 });
    expect(created.status).toBe(201);
    const token = created.body.data.token;
    expect(
      (await request(app).get(`${endpoint}/overview`).auth(token, { type: "bearer" })).status
    ).toBe(200);
    expect(
      (await request(app).get(`${endpoint}/invites`).auth(token, { type: "bearer" })).status
    ).toBe(403);
    expect(
      (
        await request(app).post(`${endpoint}/commands`).auth(token, { type: "bearer" }).send({
          type: "claim_control",
          commandId: "claim-old",
          runId: "attempt-old",
          taskId: "os-task",
          expectedRevision: 0,
        })
      ).status
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(`${endpoint}/presence`)
          .auth(token, { type: "bearer" })
          .send({ clientId: "tab", taskId: "foreign" })
      ).status
    ).toBe(404);
    await request(app)
      .delete(`${endpoint}/invites/${created.body.data.invite.id}`)
      .auth(VITEST_DEFAULT_LOCAL_SESSION_TOKEN, { type: "bearer" });
    for (const route of [
      "snapshot",
      "overview",
      "presence",
      "preferences",
      "notifications",
      "events",
    ])
      expect(
        (await request(app).get(`${endpoint}/${route}`).auth(token, { type: "bearer" })).status
      ).toBe(401);
  });
});
