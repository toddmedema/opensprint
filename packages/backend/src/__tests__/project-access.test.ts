import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { setupWebSocket, closeWebSocket } from "../websocket/index.js";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { taskStore } from "../services/task-store.service.js";
import { identityService } from "../services/identity.service.js";
import { createIdentityRouter, createMembershipRouter } from "../routes/identity.js";
import {
  projectAccess,
  permissionForRequest,
  redactNamedResponse,
} from "../middleware/project-access.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getRequestContext } from "../services/request-context.js";
import {
  ensureLocalSessionToken,
  VITEST_DEFAULT_LOCAL_SESSION_TOKEN,
} from "../services/local-session-auth.service.js";
import { consumeScopedWebSocketTicket } from "../services/websocket-upgrade-ticket.service.js";
import { wsUpgradeTicketRouter } from "../routes/ws-upgrade-ticket.js";
import { PresenceService } from "../services/presence.service.js";
import { createRuntimeRouter } from "../routes/runtime-state.js";
import { operationService } from "../services/operation.service.js";
import { executionOwnershipService } from "../services/execution-ownership.service.js";
import type { ProjectPermission } from "@opensprint/shared";

describe("named project access", () => {
  it("requires controller permission across execution entry points and removes credentials from named responses", () => {
    expect(permissionForRequest("DELETE", "/projects/A/tasks/t")).toBe("control");
    for (const path of [
      "/projects/A/plans/execute-batch",
      "/projects/A/plans/p/re-execute",
      "/projects/A/plans/p/execute",
      "/projects/A/plans/p/archive",
      "/projects/A/plans/p/mark-complete",
      "/projects/A/tasks/t/done",
      "/projects/A/agents/a/kill",
    ])
      expect(permissionForRequest("POST", path)).toBe("control");
    expect(
      redactNamedResponse({
        data: {
          deployment: {
            expoToken: "secret",
            envVars: { TOKEN: "secret" },
            targets: [{ envVars: { PASSWORD: "secret" }, name: "prod" }],
          },
          revision: 2,
        },
      })
    ).toEqual({ data: { deployment: { targets: [{ name: "prod" }] }, revision: 2 } });
  });
  let db: AppDb;
  let directory: string;
  let app: express.Express;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "project-access-"));
    db = await initAppDb(`sqlite://${path.join(directory, "test.sqlite").replace(/\\/g, "/")}`);
    vi.spyOn(taskStore, "getDb").mockImplementation(() => db.getClient());
    vi.spyOn(taskStore, "runWrite").mockImplementation((fn) => db.runWrite(fn));
    vi.spyOn(taskStore, "runRead").mockImplementation((fn) => db.runRead!(fn));
    ensureLocalSessionToken();
    app = express();
    app.use(express.json());
    app.use("/api/v1/auth", createIdentityRouter());
    app.use("/api/v1", projectAccess);
    app.use("/api/v1/ws-upgrade-ticket", wsUpgradeTicketRouter);
    app.use("/api/v1/projects/:projectId/members", createMembershipRouter());
    app.use("/api/v1/projects/:projectId/runtime", createRuntimeRouter());
    app.all("/api/v1/projects/:projectId/tasks/:id", (_req, res) => {
      res.json({ data: getRequestContext() });
    });
    app.all("/api/v1/projects/:projectId/execute/start", (_req, res) => {
      res.json({ data: { accepted: true } });
    });
    app.all("/api/v1/projects/:projectId/settings", (_req, res) => {
      res.json({ data: { accepted: true } });
    });
    app.get("/api/v1/projects/:projectId/integrations/github", (_req, res) => {
      res.json({ data: { accepted: true } });
    });
    app.get("/api/v1/global-settings", (_req, res) => {
      res.json({ data: { secret: "host-only" } });
    });
    app.use(errorHandler);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function join(permissions: ProjectPermission[] = ["read", "edit"]) {
    const invite = await identityService.createInvitation("A", {
      displayName: "Alice",
      role: "participant",
      permissions,
    });
    const response = await request(app)
      .post("/api/v1/auth/redeem")
      .send({ token: invite.token })
      .expect(200);
    return {
      invite,
      response,
      cookie: response.headers["set-cookie"][0].split(";")[0],
      csrf: response.body.data.csrfToken,
    };
  }
  it("applies authorization to case-insensitive routes and optional trailing slashes", async () => {
    const editor = await join();
    for (const route of ["settings/", "Settings", "Execute/start", "tasks/t/"]) {
      await request(app)
        [route.startsWith("tasks") ? "delete" : "post"](`/api/v1/projects/A/${route}`)
        .set("Cookie", editor.cookie)
        .set("X-OpenSprint-CSRF", editor.csrf)
        .set("Idempotency-Key", crypto.randomUUID())
        .set("If-Match", "1")
        .send({})
        .expect(403);
    }
    await request(app)
      .get("/api/v1/projects/A/Integrations/github")
      .set("Cookie", editor.cookie)
      .expect(403);
    const manager = await join(["read", "manage"]);
    await request(app)
      .post("/api/v1/projects/A/Settings/")
      .set("Cookie", manager.cookie)
      .set("X-OpenSprint-CSRF", manager.csrf)
      .set("Idempotency-Key", "settings-secret")
      .set("If-Match", "1")
      .send({ deployment: { envVars: { SECRET: "value" } } })
      .expect(403);
    await request(app)
      .post("/api/v1/projects/A/Settings/")
      .set("Cookie", manager.cookie)
      .set("X-OpenSprint-CSRF", manager.csrf)
      .set("Idempotency-Key", "settings-revision")
      .send({})
      .expect(428);
  });
  it("authorizes deployment reconciliation and cancellation independently of editing and execution control", async () => {
    const deployer = await join(["read", "deploy"]);
    const controller = await join(["read", "control"]);
    const operation = await operationService.accept({
      projectId: "A",
      actorId: "host",
      requestId: "deployment",
      kind: "deployment.run",
      target: "staging",
      payload: {},
    });
    const mutate = (actor: typeof deployer, path: string, body = {}) =>
      request(app)
        .post(`/api/v1/projects/A/runtime/${path}`)
        .set("Cookie", actor.cookie)
        .set("X-OpenSprint-CSRF", actor.csrf)
        .set("Idempotency-Key", crypto.randomUUID())
        .send(body);
    await mutate(controller, `operations/${operation.id}/cancel`).expect(403);
    await mutate(deployer, `operations/${operation.id}/cancel`).expect(200);
    const uncertain = await operationService.accept({
      projectId: "A",
      actorId: "host",
      requestId: "uncertain-deployment",
      kind: "deployment.run",
      target: "staging",
      payload: {},
    });
    await db.runWrite((tx) =>
      tx.execute("UPDATE durable_operations SET status='uncertain' WHERE id=$1", [uncertain.id])
    );
    const input = {
      expectedGeneration: 0,
      outcome: "failed",
      reason: "Provider confirmed no release",
    };
    await mutate(controller, `operations/${uncertain.id}/reconcile`, input).expect(403);
    await mutate(deployer, `operations/${uncertain.id}/reconcile`, input).expect(200);
    const stop = vi.spyOn(executionOwnershipService, "requestStop").mockResolvedValue(true);
    await mutate(deployer, "attempts/attempt/stop").expect(403);
    await mutate(controller, "attempts/attempt/stop").expect(202);
    expect(stop).toHaveBeenCalledWith("A", "attempt");
  });
  it("rejects a foreign project ticket and closes a revoked reader before pending output is delivered", async () => {
    const { cookie, csrf, invite } = await join();
    const ticket = async () =>
      (
        await request(app)
          .post("/api/v1/ws-upgrade-ticket")
          .set("Cookie", cookie)
          .set("X-OpenSprint-CSRF", csrf)
          .set("Idempotency-Key", crypto.randomUUID())
          .send({ projectId: "A" })
          .expect(200)
      ).body.data.ticket;
    const server = createServer(app);
    let release!: (text: string) => void;
    let requested!: () => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    setupWebSocket(server, {
      getLiveOutput: async () => {
        requested();
        return pending;
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    let reader: WebSocket | undefined;
    try {
      const foreign = new WebSocket(
        `ws://127.0.0.1:${port}/ws/projects/B?ticket=${await ticket()}`
      );
      await new Promise<void>((resolve, reject) => {
        foreign.once("error", () => resolve());
        foreign.once("open", () => reject(new Error("Foreign project accepted")));
      });
      reader = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/A?ticket=${await ticket()}`);
      await new Promise<void>((resolve, reject) => {
        reader!.once("open", resolve);
        reader!.once("error", reject);
      });
      const received: string[] = [];
      reader.on("message", (message) => received.push(message.toString()));
      const closed = new Promise<void>((resolve) => reader!.once("close", () => resolve()));
      reader.send(JSON.stringify({ type: "agent.subscribe", taskId: "task" }));
      await readStarted;
      await identityService.revokeActor("A", invite.actorId);
      release("revoked project output");
      await closed;
      expect(received).toEqual([]);
    } finally {
      release("");
      reader?.terminate();
      closeWebSocket();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("consumes invitations once, persists hashed credentials and reauthenticates named cookies", async () => {
    const { invite, cookie } = await join();
    await request(app).post("/api/v1/auth/redeem").send({ token: invite.token }).expect(401);
    const actor = await request(app)
      .get("/api/v1/projects/A/tasks/t")
      .set("Cookie", cookie)
      .expect(200);
    expect(actor.body.data.principal).toMatchObject({
      actorId: invite.actorId,
      displayName: "Alice",
      local: false,
    });
    const rows = await (
      await db.getClient()
    ).query("SELECT token_hash FROM collaboration_credentials");
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(cookie.split("=")[1]);
    await request(app).get("/api/v1/projects/B/tasks/t").set("Cookie", cookie).expect(403);
    await request(app).get("/api/v1/global-settings").set("Cookie", cookie).expect(403);
  });
  it("uses database time for invitation and session expiry despite a skewed backend clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const { cookie } = await join(["read"]);
    await request(app).get("/api/v1/projects/A/tasks/t").set("Cookie", cookie).expect(200);
  });
  it("requires CSRF, immutable request identity and displayed revision; edits grant no control or approval", async () => {
    const { cookie, csrf } = await join();
    const url = "/api/v1/projects/A/tasks/t";
    await request(app).patch(url).set("Cookie", cookie).send({}).expect(403);
    await request(app)
      .patch(url)
      .set("Cookie", cookie)
      .set("X-OpenSprint-CSRF", csrf)
      .send({})
      .expect(400);
    await request(app)
      .patch(url)
      .set("Cookie", cookie)
      .set("X-OpenSprint-CSRF", csrf)
      .set("Idempotency-Key", "edit-1")
      .send({})
      .expect(428);
    const accepted = await request(app)
      .patch(url)
      .set("Cookie", cookie)
      .set("X-OpenSprint-CSRF", csrf)
      .set("Idempotency-Key", "edit-1")
      .set("If-Match", "3")
      .send({})
      .expect(200);
    expect(accepted.body.data).toMatchObject({ requestId: "edit-1", expectedRevision: 3 });
    await request(app)
      .post("/api/v1/projects/A/execute/start")
      .set("Cookie", cookie)
      .set("X-OpenSprint-CSRF", csrf)
      .set("Idempotency-Key", "run-1")
      .send({})
      .expect(403);
  });
  it("revokes membership and scopes one-use websocket tickets to a project across DB clients", async () => {
    const { invite, cookie, csrf } = await join();
    const ticket = await request(app)
      .post("/api/v1/ws-upgrade-ticket")
      .set("Cookie", cookie)
      .set("X-OpenSprint-CSRF", csrf)
      .set("Idempotency-Key", "ticket-1")
      .send({ projectId: "A" })
      .expect(200);
    const claims = await consumeScopedWebSocketTicket(ticket.body.data.ticket);
    expect(claims?.projectId).toBe("A");
    expect(await consumeScopedWebSocketTicket(ticket.body.data.ticket)).toBeNull();
    await request(app)
      .delete(`/api/v1/projects/A/members/${invite.actorId}`)
      .set("Authorization", `Bearer ${VITEST_DEFAULT_LOCAL_SESSION_TOKEN}`)
      .expect(204);
    await request(app).get("/api/v1/projects/A/tasks/t").set("Cookie", cookie).expect(403);
    await expect(identityService.resolveHash(claims!.credentialHash, "A")).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("expires presence and typing independently and keeps presenter handoff optimistic", async () => {
    const service = new PresenceService();
    const { invite } = await join(["read", "discuss"]);
    await service.heartbeat("A", invite.actorId, {
      connectionId: crypto.randomUUID(),
      typing: true,
      focus: "plan",
    });
    const presenter = await service.present("A", invite.actorId, {
      expectedRevision: 0,
      focus: "plan",
    });
    expect((await service.snapshot("A")).people[0]).toMatchObject({
      typing: true,
      displayName: "Alice",
    });
    await expect(
      service.present("A", "other", { expectedRevision: presenter.revision, focus: "execute" })
    ).rejects.toMatchObject({ statusCode: 409 });
    await (
      await db.getClient()
    ).execute("UPDATE collaboration_presence SET typing_expires_at=$1", [
      new Date(0).toISOString(),
    ]);
    expect((await service.snapshot("A")).people[0].typing).toBe(false);
    await (
      await db.getClient()
    ).execute("UPDATE collaboration_presence SET expires_at=$1", [new Date(0).toISOString()]);
    expect((await service.snapshot("A")).people).toEqual([]);
  });
});
