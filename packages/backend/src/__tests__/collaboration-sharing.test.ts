import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import request from "supertest";
import express from "express";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { CollaborationService } from "../services/collaboration.service.js";
import { createCollaborationRouter } from "../routes/collaboration.js";
import { VITEST_DEFAULT_LOCAL_SESSION_TOKEN } from "../services/local-session-auth.service.js";
import { AppError } from "../middleware/error-handler.js";
import { getApiPort } from "../utils/api-port.js";
import {
  createCollaborationSharingApp,
  getCollaborationSharingConfig,
} from "../collaboration-app.js";

vi.mock("../middleware/require-database.js", () => ({
  requireDatabase: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const origin = "https://collaborate.example.test";
const endpoint = "/api/v1/projects/sample/collaboration";
const host = { actorId: "local-user", displayName: "Local user", role: "controller" as const };

describe("collaboration-only serving boundary", () => {
  let directory: string;
  let db: AppDb;
  let app: express.Express;
  let service: CollaborationService;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-guest-boundary-"));
    const frontendDist = path.join(directory, "frontend");
    await fs.mkdir(frontendDist);
    await fs.writeFile(
      path.join(frontendDist, "index.html"),
      '<main id="root"></main><script src="/assets/app.js"></script>'
    );
    // Even a bundled file with the bootstrap name must never be exposed.
    await fs.writeFile(
      path.join(frontendDist, "__opensprint_local_session.js"),
      VITEST_DEFAULT_LOCAL_SESSION_TOKEN
    );
    db = await initAppDb(`sqlite://${path.join(directory, "test.sqlite")}`);
    service = new CollaborationService({
      runWrite: (fn) => db.runWrite(fn),
      runRead: (fn) => db.runRead!(fn),
    });
    app = createCollaborationSharingApp(
      { port: 3199, origin, frontendDist },
      createCollaborationRouter({
        service,
        assertProjectExists: async () => {},
      })
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("serves guest HTML without host credentials or privileged routes", async () => {
    const html = await request(app).get("/collaborate/sample").expect(200);
    expect(html.text).toContain('id="root"');
    expect(html.text).not.toContain(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
    expect(html.text).not.toContain("__OPENSPRINT_LOCAL_SESSION__");
    expect(html.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(html.headers["content-security-policy"]).not.toContain("'unsafe-inline'");
    expect(html.headers["referrer-policy"]).toBe("no-referrer");
    for (const route of [
      "/",
      "/__opensprint_local_session.js",
      "/%5f%5fopensprint_local_session.js",
      "/__open%C5%BFprint_local_session.js",
      "/__OPENSPRINT_LOCAL_SESSION.JS",
      "/assets/../__opensprint_local_session.js",
      "/assets/%2e%2e/%5f%5fopensprint_local_session.js",
      "/api/v1/env/global-status",
      "/api/v1/global-settings",
      "/api/v1/projects/sample/governance",
    ]) {
      await request(app)
        .get(route)
        .set("Authorization", `Bearer ${VITEST_DEFAULT_LOCAL_SESSION_TOKEN}`)
        .expect(404);
    }
    const index = await request(app).get("/index.html").expect(200);
    expect(index.text).not.toContain(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);
  });

  it("bootstraps same-origin guest routing before the app bundle on every index entry point", async () => {
    for (const route of ["/collaborate/sample", "/index.html", "/INDEX.HTML", "/%69ndex.html"]) {
      const response = await request(app).get(route).expect(200);
      const marker = '<script src="/__opensprint_collaboration_guest.js"></script>';
      expect(response.text).toContain(marker);
      expect(response.text.indexOf(marker)).toBeLessThan(
        response.text.indexOf('<script src="/assets/app.js">')
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    }

    const bootstrap = await request(app).get("/__opensprint_collaboration_guest.js").expect(200);
    expect(bootstrap.headers["content-type"]).toContain("application/javascript");
    const window = {};
    runInNewContext(bootstrap.text, { window });
    expect(window).toEqual({ __OPENSPRINT_COLLABORATION_GUEST__: true });
    expect(bootstrap.headers["cache-control"]).toBe("no-store");
    expect(bootstrap.text).not.toContain(VITEST_DEFAULT_LOCAL_SESSION_TOKEN);

    await fs.writeFile(
      path.join(directory, "frontend", "index.html"),
      '<!doctype html><html><head lang="en"><script type="module" src="/assets/app.js"></script></head><body><main id="root"></main></body></html>'
    );
    const document = await request(app).get("/collaborate/sample").expect(200);
    expect(document.text).toContain(
      '<head lang="en"><script src="/__opensprint_collaboration_guest.js"></script><script type="module"'
    );

    await fs.mkdir(path.join(directory, "frontend", "assets"));
    await fs.writeFile(path.join(directory, "frontend", "assets", "app.js"), "export default 1;");
    const asset = await request(app).get("/assets/app.js").expect(200);
    expect(asset.text).toBe("export default 1;");
    expect(asset.headers["content-security-policy"]).toContain("script-src 'self'");
  });

  it("accepts configured public-origin writes while enforcing named roles and revocation", async () => {
    const invitation = await service.createInvite("sample", host, {
      displayName: "Maya",
      role: "participant",
      expiresInHours: 1,
    });
    const bearer = `Bearer ${invitation.token}`;
    await request(app)
      .options(`${endpoint}/commands`)
      .set("Origin", origin)
      .set("Access-Control-Request-Headers", "authorization,content-type")
      .expect(204);
    const result = await request(app)
      .post(`${endpoint}/commands`)
      .set("Origin", origin)
      .set("Authorization", bearer)
      .send({
        commandId: "public-discussion",
        type: "append_message",
        content: "A project-scoped message",
      })
      .expect(200);
    expect(result.headers["access-control-allow-origin"]).toBe(origin);
    expect(result.body.data.message.actorId).toBe(invitation.invite.actorId);
    await request(app)
      .post(`${endpoint}/invites`)
      .set("Origin", origin)
      .set("Authorization", bearer)
      .send({ displayName: "Outsider", role: "controller", expiresInHours: 1 })
      .expect(403);
    await request(app)
      .get(`${endpoint}/snapshot`)
      .set("Origin", "https://untrusted.example.test")
      .set("Authorization", bearer)
      .expect(403);
    await request(app).get(`${endpoint}/snapshot`).set("Origin", origin).expect(401);
    await service.revokeInvite("sample", host, invitation.invite.id);
    await request(app)
      .get(`${endpoint}/snapshot`)
      .set("Origin", origin)
      .set("Authorization", bearer)
      .expect(401);
  });

  it.each(["development", undefined])(
    "keeps unauthenticated malformed JSON opaque when NODE_ENV is %s",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const body = '{"credential":"private-request-sentinel"';
      const response = await request(app)
        .post(`${endpoint}/commands`)
        .set("Content-Type", "application/json")
        .send(body)
        .expect(400);

      expect(response.body).toEqual({
        error: { code: "INVALID_JSON", message: "Invalid JSON request body." },
      });
      expect(response.text).not.toContain("private-request-sentinel");
      expect(response.text).not.toContain("stack");
      expect(logged).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      label: "oversized JSON",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "private-request-sentinel".repeat(4096) }),
      status: 413,
      code: "REQUEST_TOO_LARGE",
      message: "The request body is too large.",
    },
    {
      label: "unsupported charset",
      headers: { "Content-Type": "application/json; charset=private-request-sentinel" },
      body: '{"credential":"private-request-sentinel"}',
      status: 415,
      code: "UNSUPPORTED_CHARSET",
      message: "Unsupported request charset.",
    },
    {
      label: "unsupported content encoding",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "private-request-sentinel",
      },
      body: '{"credential":"private-request-sentinel"}',
      status: 415,
      code: "UNSUPPORTED_CONTENT_ENCODING",
      message: "Unsupported request content encoding.",
    },
  ])("retains a safe client status for $label without logging the payload", async (input) => {
    vi.stubEnv("NODE_ENV", "development");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request(app)
      .post(`${endpoint}/commands`)
      .set(input.headers)
      .send(input.body)
      .expect(input.status);

    expect(response.body).toEqual({ error: { code: input.code, message: input.message } });
    expect(response.text).not.toContain("private-request-sentinel");
    expect(response.text).not.toContain("stack");
    expect(logged).not.toHaveBeenCalled();
  });

  it.each(["development", undefined])(
    "logs unexpected failures without returning diagnostics when NODE_ENV is %s",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const router = express.Router();
      router.get("/unexpected", () => {
        throw new Error("Cannot read /private/host-path with credential private-error-sentinel");
      });
      const failingApp = createCollaborationSharingApp(
        { port: 3199, origin, frontendDist: path.join(directory, "frontend") },
        router
      );
      const response = await request(failingApp).get(`${endpoint}/unexpected`).expect(500);

      expect(response.body).toEqual({
        error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
      });
      expect(response.text).not.toContain("private-error-sentinel");
      expect(response.text).not.toContain("/private/host-path");
      expect(response.text).not.toContain("stack");
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("private-error-sentinel"));
    }
  );

  it("preserves intended application errors and database retry headers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const router = express.Router();
    router.get("/expected", () => {
      throw new AppError(409, "AGENT_ATTEMPT_CHANGED", "Refresh this task.", {
        taskId: "os-task",
      });
    });
    router.get("/database", () => {
      throw new AppError(503, "DATABASE_UNAVAILABLE", "Database is unavailable.");
    });
    const failingApp = createCollaborationSharingApp(
      { port: 3199, origin, frontendDist: path.join(directory, "frontend") },
      router
    );

    const expected = await request(failingApp).get(`${endpoint}/expected`).expect(409);
    expect(expected.body).toEqual({
      error: {
        code: "AGENT_ATTEMPT_CHANGED",
        message: "Refresh this task.",
        details: { taskId: "os-task" },
      },
    });
    const database = await request(failingApp).get(`${endpoint}/database`).expect(503);
    expect(database.headers["retry-after"]).toBe("5");
    expect(database.body.error).toEqual({
      code: "DATABASE_UNAVAILABLE",
      message: "Database is unavailable.",
    });
  });
});

describe("sharing configuration", () => {
  it.each([undefined, ""])(
    "matches the host listener's default collision checks when PORT is %s",
    (port) => {
      expect(getApiPort({ PORT: port })).toBe(3100);
      for (const configuration of [
        { OPENSPRINT_COLLABORATION_PORT: "3100", OPENSPRINT_COLLABORATION_ORIGIN: origin },
        {
          OPENSPRINT_COLLABORATION_PORT: "3199",
          OPENSPRINT_COLLABORATION_ORIGIN: "http://127.0.0.1:3100",
        },
      ])
        expect(() => getCollaborationSharingConfig({ PORT: port, ...configuration })).toThrow();
      expect(
        getCollaborationSharingConfig({
          PORT: port,
          OPENSPRINT_COLLABORATION_PORT: "3199",
          OPENSPRINT_COLLABORATION_ORIGIN: "http://127.0.0.1:3199",
        })
      ).toMatchObject({ port: 3199, origin: "http://127.0.0.1:3199" });
    }
  );

  it.each(["4100", "4100suffix"])(
    "uses the configured host port consistently for PORT=%s",
    (port) => {
      expect(getApiPort({ PORT: port })).toBe(4100);
      for (const configuration of [
        { OPENSPRINT_COLLABORATION_PORT: "4100", OPENSPRINT_COLLABORATION_ORIGIN: origin },
        {
          OPENSPRINT_COLLABORATION_PORT: "3199",
          OPENSPRINT_COLLABORATION_ORIGIN: "http://127.0.0.1:4100",
        },
      ])
        expect(() => getCollaborationSharingConfig({ PORT: port, ...configuration })).toThrow();
      expect(
        getCollaborationSharingConfig({
          PORT: port,
          OPENSPRINT_COLLABORATION_PORT: "3100",
          OPENSPRINT_COLLABORATION_ORIGIN: "http://127.0.0.1:3100",
        })
      ).toMatchObject({ port: 3100, origin: "http://127.0.0.1:3100" });
    }
  );

  it("stays disabled by default and requires a separate explicit port and origin", () => {
    expect(getCollaborationSharingConfig({})).toBeNull();
    expect(
      getCollaborationSharingConfig({
        OPENSPRINT_COLLABORATION_PORT: "3199",
        OPENSPRINT_COLLABORATION_ORIGIN: origin,
      })
    ).toMatchObject({ port: 3199, origin });
    for (const environment of [
      { OPENSPRINT_COLLABORATION_PORT: "3199" },
      { OPENSPRINT_COLLABORATION_ORIGIN: origin },
      { OPENSPRINT_COLLABORATION_PORT: "3100", OPENSPRINT_COLLABORATION_ORIGIN: origin },
      { OPENSPRINT_COLLABORATION_PORT: "0", OPENSPRINT_COLLABORATION_ORIGIN: origin },
      { OPENSPRINT_COLLABORATION_PORT: "65536", OPENSPRINT_COLLABORATION_ORIGIN: origin },
      {
        OPENSPRINT_COLLABORATION_PORT: "3199",
        OPENSPRINT_COLLABORATION_ORIGIN: "http://127.0.0.1:3100",
      },
      ...[
        "http://remote.example.test",
        `${origin}/nested`,
        `${origin}?secret=bad`,
        "https://user:password@example.test",
        `${origin}#invite=bad`,
      ].map((value) => ({
        OPENSPRINT_COLLABORATION_PORT: "3199",
        OPENSPRINT_COLLABORATION_ORIGIN: value,
      })),
    ])
      expect(() => getCollaborationSharingConfig(environment)).toThrow();
    expect(
      getCollaborationSharingConfig({
        OPENSPRINT_COLLABORATION_PORT: "3199",
        OPENSPRINT_COLLABORATION_ORIGIN: "http://127.0.0.1:3199",
      })?.origin
    ).toBe("http://127.0.0.1:3199");
  });
});
