import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, OPENSPRINT_DIR } from "@opensprint/shared";

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  if (!dbResult) {
    return { ...actual, TaskStoreService: class { constructor() { throw new Error("Postgres required"); } }, taskStore: null, _postgresAvailable: false };
  }
  const store = new actual.TaskStoreService(dbResult.client);
  await store.init();
  return { ...actual, TaskStoreService: class extends actual.TaskStoreService { constructor() { super(dbResult.client); } }, taskStore: store, _postgresAvailable: true };
});

const projectsTaskStoreMod = await import("../services/task-store.service.js");
const projectsPostgresOk = (projectsTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

const validCreateBody = {
  name: "New Project",
  repoPath: "", // set in each test
  simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
  complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
  deployment: { mode: "custom" },
  hilConfig: DEFAULT_HIL_CONFIG,
};

describe.skipIf(!projectsPostgresOk)("Projects REST API — spec/sketch phase routes", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-projects-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const repoPath = path.join(tempDir, "my-project");
    await fs.mkdir(repoPath, { recursive: true });
    const project = await projectService.createProject({
      name: "Sketch Test Project",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("GET /projects/:id/sketch should return project (Sketch phase canonical endpoint)", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/sketch`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBe(projectId);
    expect(res.body.data.name).toBe("Sketch Test Project");
    expect(res.body.data.currentPhase).toBe("sketch");
  });

  it("GET /projects/:id/sketch-context returns hasExistingCode false when repo has no source files", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/sketch-context`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.hasExistingCode).toBe(false);
  });

  it("GET /projects/:id/sketch-context returns hasExistingCode true when repo has source files", async () => {
    const repoPath = path.join(tempDir, "my-project");
    await fs.writeFile(path.join(repoPath, "index.ts"), "console.log('hello');");

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/sketch-context`);

    expect(res.status).toBe(200);
    expect(res.body.data.hasExistingCode).toBe(true);
  });

  it("POST /projects/:id/archive removes project from list, keeps .opensprint", async () => {
    const repoPath = path.join(tempDir, "my-project");
    const opensprintPath = path.join(repoPath, OPENSPRINT_DIR);

    const listBefore = await request(app).get(`${API_PREFIX}/projects`);
    expect(listBefore.body.data).toHaveLength(1);

    const archiveRes = await request(app).post(`${API_PREFIX}/projects/${projectId}/archive`);
    expect(archiveRes.status).toBe(204);

    const listAfter = await request(app).get(`${API_PREFIX}/projects`);
    expect(listAfter.body.data).toHaveLength(0);

    const stat = await fs.stat(opensprintPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("DELETE /projects/:id removes project from list and deletes .opensprint", async () => {
    const repoPath = path.join(tempDir, "my-project");
    const opensprintPath = path.join(repoPath, OPENSPRINT_DIR);

    const deleteRes = await request(app).delete(`${API_PREFIX}/projects/${projectId}`);
    expect(deleteRes.status).toBe(204);

    const listAfter = await request(app).get(`${API_PREFIX}/projects`);
    expect(listAfter.body.data).toHaveLength(0);

    await expect(fs.stat(opensprintPath)).rejects.toThrow();
  });
});

describe("Projects REST API — create and settings", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-projects-create-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const repoPath = path.join(tempDir, "my-project");
    await fs.mkdir(repoPath, { recursive: true });
    const project = await projectService.createProject({
      name: "Settings Test Project",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("POST /projects creates project with simpleComplexityAgent and complexComplexityAgent", async () => {
    const repoPath = path.join(tempDir, "create-via-api");
    await fs.mkdir(repoPath, { recursive: true });

    const body = { ...validCreateBody, repoPath };
    const res = await request(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.name).toBe("New Project");
    expect(res.body.data.repoPath).toBe(repoPath);

    const settingsRes = await request(app).get(
      `${API_PREFIX}/projects/${res.body.data.id}/settings`
    );
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.data.simpleComplexityAgent).toBeDefined();
    expect(settingsRes.body.data.simpleComplexityAgent.type).toBe("claude");
    expect(settingsRes.body.data.complexComplexityAgent).toBeDefined();
    expect(settingsRes.body.data.complexComplexityAgent.type).toBe("claude");
  });

  it("PUT /projects/:id/settings updates simpleComplexityAgent and complexComplexityAgent", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
        simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
        complexComplexityAgent: { type: "claude", model: "claude-opus-4", cliCommand: null },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.simpleComplexityAgent.type).toBe("cursor");
    expect(res.body.data.simpleComplexityAgent.model).toBe("composer-1.5");
    expect(res.body.data.complexComplexityAgent.type).toBe("claude");
    expect(res.body.data.complexComplexityAgent.model).toBe("claude-opus-4");
  });

  it("POST /projects without simpleComplexityAgent/complexComplexityAgent returns 400", async () => {
    const repoPath = path.join(tempDir, "missing-agents");
    await fs.mkdir(repoPath, { recursive: true });

    const body = {
      name: "Missing Agents",
      repoPath,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    };

    const res = await request(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("INVALID_AGENT_CONFIG");
  });

  it("POST /projects creates project; GET settings does not return apiKeys", async () => {
    const repoPath = path.join(tempDir, "create-basic");
    await fs.mkdir(repoPath, { recursive: true });

    const body = { ...validCreateBody, repoPath };
    const res = await request(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(201);
    const projectId = res.body.data.id;

    const settingsRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/settings`
    );
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.data).not.toHaveProperty("apiKeys");
  });
});
