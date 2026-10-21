import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import type { CollaborationPrincipal } from "@opensprint/shared";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { runCollaborationSchema } from "../db/collaboration-schema.js";
import { CollaborationService } from "../services/collaboration.service.js";
import { createCollaborationAccess } from "../services/collaboration-access.service.js";
import { createCollaborationRouter } from "../routes/collaboration.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { AppError, errorHandler } from "../middleware/error-handler.js";
import { VITEST_DEFAULT_LOCAL_SESSION_TOKEN } from "../services/local-session-auth.service.js";
import { appendProjectEvent } from "../services/project-event.service.js";

const alice: CollaborationPrincipal = {
  actorId: "alice",
  displayName: "Alice",
  role: "controller",
};
const bob: CollaborationPrincipal = { actorId: "bob", displayName: "Bob", role: "controller" };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

describe("durable project collaboration", () => {
  let db: AppDb;
  let directory: string;
  let url: string;
  let service: CollaborationService;
  const open = async () => {
    db = await initAppDb(url);
    await runCollaborationSchema(await db.getClient());
    service = new CollaborationService({
      runWrite: (fn) => db.runWrite(fn),
      runRead: (fn) => db.runRead!(fn),
    });
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-collaboration-"));
    url = `sqlite://${path.join(directory, "test.sqlite").replace(/\\/g, "/")}`;
    await open();
  });
  afterEach(async () => {
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("retains attributed concurrent appends and replays commit-ordered pages after restart", async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        service.command("A", i % 2 ? alice : bob, {
          commandId: `message-${i}`,
          type: "append_message",
          content: `Message ${i}`,
        })
      )
    );
    await service.command("B", bob, {
      commandId: "message-0",
      type: "append_message",
      content: "Private B",
    });
    await db.close();
    await open();
    const snapshot = await service.snapshot("A", alice);
    expect(snapshot.cursor).toBe(30);
    expect(snapshot.messages).toHaveLength(30);
    expect(new Set(snapshot.messages.map((m) => m.actorId))).toEqual(new Set(["alice", "bob"]));
    expect(snapshot.messages.map((m) => m.cursor)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1)
    );
    const first = await service.replay("A", 0, 7);
    const remaining = await service.replay("A", first.nextCursor, 100);
    expect(first.hasMore).toBe(true);
    expect(remaining.hasMore).toBe(false);
    expect([...first.events, ...remaining.events].map((e) => e.cursor)).toEqual(
      snapshot.messages.map((m) => m.cursor)
    );
    expect((await service.snapshot("B", bob)).messages.map((m) => m.content)).toEqual([
      "Private B",
    ]);
  });

  it("deduplicates concurrent retries and rejects command ID reuse for another payload or actor", async () => {
    const command = { commandId: "same", type: "append_message" as const, content: "Once" };
    const [one, two] = await Promise.all([
      service.command("A", alice, command),
      service.command("A", alice, command),
    ]);
    expect(two).toEqual(one);
    await expect(
      service.command("A", alice, { ...command, content: "Changed" })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.command("A", bob, command)).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.snapshot("A", alice)).cursor).toBe(1);
    await service.command("B", bob, command);
    expect((await service.snapshot("B", bob)).cursor).toBe(1);
    await expect(service.replay("A", 99)).rejects.toMatchObject({
      statusCode: 409,
      details: { resetRequired: true, cursor: 1 },
    });
  });

  it("lets an independently granted controller claim a run without discussion permission", async () => {
    const controller = {
      ...alice,
      role: "viewer" as const,
      permissions: ["read", "control"] as const,
    };
    const principal = { ...controller, permissions: [...controller.permissions] };
    await service.command("A", principal, {
      commandId: "control-only",
      type: "claim_control",
      runId: "run",
      expectedRevision: 0,
    });
    await expect(service.assertControl("A", principal, "run")).resolves.toBe(1);
    await expect(
      service.command("A", principal, {
        commandId: "discussion",
        type: "append_message",
        content: "Forbidden",
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("redacts secrets in historical replay for named members while preserving cursors", async () => {
    await db.runWrite((tx) =>
      appendProjectEvent(tx, {
        projectId: "A",
        type: "settings_changed",
        payload: {
          revision: 1,
          state: {
            deployment: {
              expoToken: "secret-token",
              targets: [{ name: "prod", envVars: { SECRET: "secret-env" } }],
            },
          },
        },
      })
    );
    const app = express();
    app.use(
      "/projects/:projectId/collaboration",
      createCollaborationRouter({
        service,
        access: createCollaborationAccess(
          JSON.stringify([
            {
              actorId: "reader",
              displayName: "Reader",
              tokenHash: hash("reader-secret"),
              projects: { A: "viewer" },
            },
          ])
        ),
        assertProjectExists: async () => undefined,
      })
    );
    app.use(errorHandler);
    const replay = await request(app)
      .get("/projects/A/collaboration/events?after=0")
      .auth("reader-secret", { type: "bearer" })
      .expect(200);
    expect(replay.body.data.nextCursor).toBe(1);
    expect(replay.body.data.events[0].payload).toEqual({
      revision: 1,
      state: { deployment: { targets: [{ name: "prod" }] } },
    });
    const host = await request(app)
      .get("/projects/A/collaboration/events?after=0")
      .auth(VITEST_DEFAULT_LOCAL_SESSION_TOKEN, { type: "bearer" })
      .expect(200);
    expect(host.body.data.events[0].payload.state.deployment.expoToken).toBe("secret-token");
  });

  it("elects one run controller with CAS and authorizes handoff against current ownership and membership", async () => {
    const results = await Promise.allSettled(
      [alice, bob].map((actor) =>
        service.command("A", actor, {
          commandId: `claim-${actor.actorId}`,
          type: "claim_control",
          runId: "run-1",
          expectedRevision: 0,
        })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const run = (await service.snapshot("A", alice)).runs[0];
    const owner = run.controllerId === "alice" ? alice : bob;
    const next = owner === alice ? bob : alice;
    await expect(
      service.command("A", next, {
        commandId: "steal",
        type: "handoff_control",
        runId: "run-1",
        expectedRevision: 1,
        targetActorId: next.actorId,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.command(
        "A",
        owner,
        {
          commandId: "bad-target",
          type: "handoff_control",
          runId: "run-1",
          expectedRevision: 1,
          targetActorId: "outsider",
        },
        () => false
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    const handed = await service.command(
      "A",
      owner,
      {
        commandId: "handoff",
        type: "handoff_control",
        runId: "run-1",
        expectedRevision: 1,
        targetActorId: next.actorId,
      },
      (actorId) => actorId === next.actorId
    );
    expect(handed.run).toEqual({ runId: "run-1", controllerId: next.actorId, revision: 2 });
    await expect(
      service.command("A", owner, {
        commandId: "stale",
        type: "claim_control",
        runId: "run-1",
        expectedRevision: 1,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.snapshot("B", alice)).runs).toEqual([]);
    expect((await service.replay("A")).events.map((e) => e.type)).toEqual([
      "control_claimed",
      "control_handed_off",
    ]);
  });

  it("gates guidance by authoritative ownership and keeps handoff behind accepted guidance", async () => {
    const local: CollaborationPrincipal = {
      actorId: "local-user",
      displayName: "Local user",
      role: "controller",
    };
    expect(await service.assertControl("A", local, "run-1")).toBe(0);
    await expect(service.assertControl("A", alice, "run-1")).rejects.toMatchObject({
      statusCode: 403,
    });
    await service.command("A", alice, {
      commandId: "claim",
      type: "claim_control",
      runId: "run-1",
      expectedRevision: 0,
    });
    await expect(service.assertControl("A", local, "run-1")).rejects.toMatchObject({
      statusCode: 403,
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const guidance = service.withControl("A", alice, "run-1", async (revision) => {
      expect(revision).toBe(1);
      entered();
      await gate;
      return "accepted";
    });
    await started;
    let handedOff = false;
    const handoff = service
      .command(
        "A",
        alice,
        {
          commandId: "handoff",
          type: "handoff_control",
          runId: "run-1",
          expectedRevision: 1,
          targetActorId: "bob",
        },
        () => true
      )
      .then(() => {
        handedOff = true;
      });
    await new Promise<void>((r) => setImmediate(r));
    expect(handedOff).toBe(false);
    release();
    expect(await guidance).toBe("accepted");
    await handoff;
    await expect(
      service.withControl("A", alice, "run-1", async () => "forbidden")
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await service.withControl("A", bob, "run-1", async () => "accepted")).toBe("accepted");
    await service.command("A", bob, {
      type: "handoff_control",
      commandId: "release",
      runId: "run-1",
      expectedRevision: 2,
      targetActorId: null,
    });
    await expect(service.assertControl("A", local, "run-1")).rejects.toMatchObject({
      statusCode: 403,
    });
    await service.command("A", local, {
      type: "claim_control",
      commandId: "local-claim",
      runId: "run-1",
      expectedRevision: 3,
    });
    expect(await service.assertControl("A", local, "run-1")).toBe(4);
  });

  it("serializes TaskStore, repository writes, and reads on the shared SQLite connection without nesting deadlocks", async () => {
    const store = new TaskStoreService();
    await store.init(url, db);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.create("A", `Task ${i}`)),
      ...Array.from({ length: 10 }, (_, i) =>
        service.command("A", alice, {
          commandId: `parallel-${i}`,
          type: "append_message",
          content: `Discussion ${i}`,
        })
      ),
    ]);
    expect(await store.listAll("A")).toHaveLength(10);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const failed = db.runWrite(async (tx) => {
      await tx.execute("UPDATE collaboration_projects SET cursor = 999 WHERE project_id = $1", [
        "A",
      ]);
      entered();
      await gate;
      throw new Error("rollback");
    });
    // Attach rejection handling before releasing the transaction.
    const failure = expect(failed).rejects.toThrow("rollback");
    await started;
    let observed = false;
    const read = (await db.getClient())
      .queryOne("SELECT cursor FROM collaboration_projects WHERE project_id = $1", ["A"])
      .then((row) => {
        observed = true;
        return row;
      });
    await new Promise<void>((r) => setImmediate(r));
    expect(observed).toBe(false);
    release();
    await failure;
    expect((await read)?.cursor).toBe(20);
    const committed = await service.replay("A");
    expect(committed.events.filter((event) => event.type === "task_changed")).toHaveLength(10);
    expect(committed.events.filter((event) => event.type === "message_appended")).toHaveLength(10);
    await store.runWrite(async () =>
      db.runWrite(async (tx) => {
        expect((await tx.queryOne("SELECT 1 as n"))?.n).toBe(1);
      })
    );
    await db.runExclusive!(async () => {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          db.runWrite(async (tx) => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect((await tx.queryOne("SELECT 1 as n"))?.n).toBe(1);
          })
        )
      );
    });
  });

  it("enforces project-scoped bearer roles, ignores self-asserted actors, and bounds commands and replay", async () => {
    const access = createCollaborationAccess(
      JSON.stringify([
        {
          actorId: "alice",
          displayName: "Alice",
          tokenHash: hash("alice-secret"),
          projects: { A: "participant" },
        },
        {
          actorId: "viewer",
          displayName: "Viewer",
          tokenHash: hash("viewer-secret"),
          projects: { A: "viewer" },
        },
        {
          actorId: "bob",
          displayName: "Bob",
          tokenHash: hash("bob-secret"),
          projects: { A: "controller" },
        },
      ])
    );
    const app = express();
    const acceptedActors: string[] = [];
    app.use(express.json());
    app.use(
      "/projects/:projectId/collaboration",
      createCollaborationRouter({
        service,
        access,
        assertProjectExists: async (projectId) => {
          if (projectId !== "A") throw new AppError(404, "NOT_FOUND", "Project not found");
        },
        getActiveRun: async (_projectId, taskId) => ({ taskId, attemptId: "run-one" }),
        handleGuidance: async (input) => {
          acceptedActors.push(input.actorId);
          return { accepted: true };
        },
      })
    );
    app.use(errorHandler);
    const endpoint = "/projects/A/collaboration";
    expect((await request(app).get(`${endpoint}/snapshot`)).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/projects/B/collaboration/snapshot")
          .auth("alice-secret", { type: "bearer" })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/projects/missing/collaboration/snapshot")
          .auth(VITEST_DEFAULT_LOCAL_SESSION_TOKEN, { type: "bearer" })
      ).status
    ).toBe(404);
    const command = { type: "append_message", commandId: "route-message", content: "Hello" };
    expect(
      (
        await request(app)
          .post(`${endpoint}/commands`)
          .auth("viewer-secret", { type: "bearer" })
          .send(command)
      ).status
    ).toBe(403);
    const appended = await request(app)
      .post(`${endpoint}/commands`)
      .auth("alice-secret", { type: "bearer" })
      .set("X-Actor-Id", "admin")
      .send(command);
    expect(appended.status).toBe(200);
    expect(appended.body.data.message.actorId).toBe("alice");
    expect(
      (
        await request(app)
          .post(`${endpoint}/commands`)
          .auth("alice-secret", { type: "bearer" })
          .send({ commandId: "claim", type: "claim_control", runId: "one", expectedRevision: 0 })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${endpoint}/commands`)
          .auth("alice-secret", { type: "bearer" })
          .send({ ...command, content: "x".repeat(10_001) })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .get(`${endpoint}/events?limit=201`)
          .auth("viewer-secret", { type: "bearer" })
      ).status
    ).toBe(400);
    const snapshot = await request(app)
      .get(`${endpoint}/snapshot`)
      .auth("viewer-secret", { type: "bearer" });
    expect(snapshot.body.data.principal.role).toBe("viewer");
    expect(snapshot.body.data.messages).toHaveLength(1);
    const guidance = {
      taskId: "os-one",
      attemptId: "run-one",
      clientMessageId: "guidance-one",
      content: "Please check the boundary",
    };
    for (const token of ["viewer-secret", "alice-secret", "bob-secret"]) {
      expect(
        (
          await request(app)
            .post(`${endpoint}/guidance`)
            .auth(token, { type: "bearer" })
            .send(guidance)
        ).status
      ).toBe(403);
    }
    expect(
      (await request(app).get(`${endpoint}/runs/os-one`).auth("viewer-secret", { type: "bearer" }))
        .body.data.attemptId
    ).toBe("run-one");
    await service.command("A", bob, {
      commandId: "bob-claim",
      type: "claim_control",
      runId: "run-one",
      expectedRevision: 0,
    });
    const activeControl = await request(app)
      .get(`${endpoint}/runs/os-one`)
      .auth("viewer-secret", { type: "bearer" });
    expect(activeControl.body.data.control).toEqual({
      runId: "run-one",
      controllerId: "bob",
      revision: 1,
    });
    expect(
      (
        await request(app)
          .post(`${endpoint}/guidance`)
          .auth(VITEST_DEFAULT_LOCAL_SESSION_TOKEN, { type: "bearer" })
          .send(guidance)
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${endpoint}/guidance`)
          .auth("bob-secret", { type: "bearer" })
          .set("X-Actor-Id", "admin")
          .send(guidance)
      ).status
    ).toBe(200);
    expect(acceptedActors).toEqual(["bob"]);
    await service.command(
      "A",
      bob,
      {
        commandId: "bob-handoff",
        type: "handoff_control",
        runId: "run-one",
        expectedRevision: 1,
        targetActorId: "local-user",
      },
      (actorId) => access.canControlActor("A", actorId)
    );
    expect(
      (
        await request(app)
          .post(`${endpoint}/guidance`)
          .auth("bob-secret", { type: "bearer" })
          .send(guidance)
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${endpoint}/guidance`)
          .auth(VITEST_DEFAULT_LOCAL_SESSION_TOKEN, { type: "bearer" })
          .send({ ...guidance, clientMessageId: "guidance-two" })
      ).status
    ).toBe(200);
    expect(acceptedActors).toEqual(["bob", "local-user"]);
    expect(() => createCollaborationAccess('[{"actorId":"spoof"}]')).toThrow(
      "hashed actor credentials"
    );
  });
});
