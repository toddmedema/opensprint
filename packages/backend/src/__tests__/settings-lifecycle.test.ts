/**
 * Full integration test: settings lifecycle.
 * Verifies settings read/write round-trip with two-tier format (simpleComplexityAgent/complexComplexityAgent).
 * Settings are stored in global DB at ~/.opensprint/settings.json keyed by project_id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { orchestratorService } from "../services/orchestrator.service.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { setGlobalSettings } from "../services/global-settings.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, DEFAULT_REVIEW_MODE } from "@opensprint/shared";
import type { DbClient } from "../db/client.js";

const { testClientRef } = vi.hoisted(() => ({ testClientRef: { current: null as DbClient | null } }));
vi.mock("../services/task-store.service.js", async () => {
  const { SCHEMA_SQL, runSchema } = await import("../db/schema.js");
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  testClientRef.current = dbResult?.client ?? null;
  if (dbResult) await runSchema(dbResult.client);
  return {
    taskStore: {
      init: vi.fn().mockImplementation(async () => {}),
      getDb: vi.fn().mockImplementation(async () => testClientRef.current),
      runWrite: vi.fn().mockImplementation(async (fn: (c: DbClient) => Promise<unknown>) => fn(testClientRef.current!)),
      listAll: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
      show: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: "os-0001" }),
      createMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteByProjectId: vi.fn().mockResolvedValue(undefined),
      deleteOpenQuestionsByProjectId: vi.fn().mockResolvedValue(undefined),
      addDependency: vi.fn().mockResolvedValue(undefined),
      ready: vi.fn().mockResolvedValue([]),
      setOnTaskChange: vi.fn(),
      planInsert: vi.fn(),
      planGet: vi.fn().mockResolvedValue(null),
      planListIds: vi.fn().mockResolvedValue([]),
      planDelete: vi.fn().mockResolvedValue(false),
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL,
    _postgresAvailable: !!dbResult,
  };
});

/** Path to project settings store (settings.json keyed by project_id). */
function getProjectSettingsPath(tempDir: string): string {
  return path.join(tempDir, ".opensprint", "settings.json");
}

/** Path to global settings store (global-settings.json for apiKeys). */
function getGlobalSettingsJsonPath(tempDir: string): string {
  return path.join(tempDir, ".opensprint", "global-settings.json");
}

/** Read project settings from project store. */
async function readProjectFromGlobalStore(
  tempDir: string,
  projectId: string
): Promise<Record<string, unknown>> {
  const storePath = getProjectSettingsPath(tempDir);
  const raw = await fs.readFile(storePath, "utf-8");
  const store = JSON.parse(raw) as Record<string, { settings?: Record<string, unknown> }>;
  const entry = store[projectId];
  return (entry?.settings ?? entry ?? {}) as Record<string, unknown>;
}

describe("Settings lifecycle — service-level", () => {
  let projectService: ProjectService;
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-settings-lifecycle-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    await setGlobalSettings({
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "test-ant", value: "sk-ant-test" }],
        CURSOR_API_KEY: [{ id: "test-cur", value: "cursor-test" }],
      },
    });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes two-tier settings → getSettings returns shape → updateSettings persists → global store confirms", async () => {
    const repoPath = path.join(tempDir, "lifecycle");
    const project = await projectService.createProject({
      name: "Lifecycle",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "code-model", cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: "plan-model", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    // getSettings() returns two-tier shape and gitWorkingMode default
    const fetched = await projectService.getSettings(project.id);
    expect(fetched.simpleComplexityAgent.type).toBe("claude");
    expect(fetched.simpleComplexityAgent.model).toBe("code-model");
    expect(fetched.complexComplexityAgent.type).toBe("cursor");
    expect(fetched.complexComplexityAgent.model).toBe("plan-model");
    expect(fetched.gitWorkingMode).toBe("worktree");

    // updateSettings() persists to global store
    await projectService.updateSettings(project.id, { testFramework: "vitest" });

    const persisted = await readProjectFromGlobalStore(tempDir, project.id);
    expect(persisted.simpleComplexityAgent).toBeDefined();
    expect(persisted.complexComplexityAgent).toBeDefined();
    expect(persisted.testFramework).toBe("vitest");
  });

  it("persists maxConcurrentCoders to global store and returns it after getSettings (survives restart)", async () => {
    const repoPath = path.join(tempDir, "parallelism");
    const project = await projectService.createProject({
      name: "Parallelism",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.updateSettings(project.id, { maxConcurrentCoders: 3 });

    const fetched = await projectService.getSettings(project.id);
    expect(fetched.maxConcurrentCoders).toBe(3);

    const persisted = await readProjectFromGlobalStore(tempDir, project.id);
    expect(persisted.maxConcurrentCoders).toBe(3);
  });

  it("getSettings does not return apiKeys (stored in global settings only)", async () => {
    const repoPath = path.join(tempDir, "apikeys");
    const project = await projectService.createProject({
      name: "API Keys",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const fetched = await projectService.getSettings(project.id);
    expect(fetched).not.toHaveProperty("apiKeys");

    const projectPersisted = await readProjectFromGlobalStore(tempDir, project.id);
    expect(projectPersisted).not.toHaveProperty("apiKeys");
  });

  it("round-trip: save new shape → read → save again → output is identical (idempotent)", async () => {
    const repoPath = path.join(tempDir, "round-trip");
    const project = await projectService.createProject({
      name: "Round Trip",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-opus-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    // First save: read current (new shape), then update with same values
    const first = await projectService.getSettings(project.id);
    const firstParsed = await readProjectFromGlobalStore(tempDir, project.id);

    // Save again with minimal/no change (trigger write)
    await projectService.updateSettings(project.id, { testFramework: first.testFramework ?? null });

    const secondParsed = await readProjectFromGlobalStore(tempDir, project.id);

    // Output should be identical (idempotent)
    expect(secondParsed.simpleComplexityAgent).toEqual(firstParsed.simpleComplexityAgent);
    expect(secondParsed.complexComplexityAgent).toEqual(firstParsed.complexComplexityAgent);
    expect(secondParsed.deployment).toEqual(firstParsed.deployment);
    expect(secondParsed.hilConfig).toEqual(firstParsed.hilConfig);
    expect(secondParsed.testFramework).toEqual(firstParsed.testFramework);
    expect(secondParsed.reviewMode).toEqual(firstParsed.reviewMode ?? DEFAULT_REVIEW_MODE);
    expect(secondParsed.gitWorkingMode).toEqual(firstParsed.gitWorkingMode ?? "worktree");
  });
});

describe("Settings API lifecycle", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-settings-api-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    await setGlobalSettings({
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "test-ant", value: "sk-ant-test" }],
        CURSOR_API_KEY: [{ id: "test-cur", value: "cursor-test" }],
      },
    });

    const repoPath = path.join(tempDir, "api-project");
    await fs.mkdir(repoPath, { recursive: true });
    const project = await projectService.createProject({
      name: "API Lifecycle Test",
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

  it("GET /api/v1/projects/:id/settings returns two-tier shape and gitWorkingMode", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.simpleComplexityAgent).toBeDefined();
    expect(res.body.data.simpleComplexityAgent.type).toBe("claude");
    expect(res.body.data.complexComplexityAgent).toBeDefined();
    expect(res.body.data.complexComplexityAgent.type).toBe("claude");
    expect(res.body.data.gitWorkingMode).toBe("worktree");
  });

  it("PUT /api/v1/projects/:id/settings with new field names succeeds", async () => {
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

  it("PUT /api/v1/projects/:id/settings triggers orchestrator nudge so changes take effect immediately", async () => {
    const refreshSpy = vi
      .spyOn(orchestratorService, "refreshMaxSlotsAndNudge")
      .mockResolvedValue(undefined);

    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ maxConcurrentCoders: 3 });

    expect(refreshSpy).toHaveBeenCalledWith(projectId);
    refreshSpy.mockRestore();
  });

  it("PUT /api/v1/projects/:id/settings accepts and persists gitWorkingMode", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ gitWorkingMode: "branches" });

    expect(res.status).toBe(200);
    expect(res.body.data.gitWorkingMode).toBe("branches");

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.body.data.gitWorkingMode).toBe("branches");

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.gitWorkingMode).toBe("branches");
  });

  it("PUT /api/v1/projects/:id/settings forces maxConcurrentCoders to 1 when gitWorkingMode is branches", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ gitWorkingMode: "branches", maxConcurrentCoders: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data.gitWorkingMode).toBe("branches");
    expect(res.body.data.maxConcurrentCoders).toBe(1);

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.maxConcurrentCoders).toBe(1);
  });

  it("PUT /api/v1/projects/:id/settings rejects invalid gitWorkingMode and keeps current", async () => {
    // First set to branches
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ gitWorkingMode: "branches" });

    // Send invalid value — should keep branches (not persist invalid)
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ gitWorkingMode: "invalid" });

    expect(res.status).toBe(200);
    expect(res.body.data.gitWorkingMode).toBe("branches");

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.gitWorkingMode).toBe("branches");
  });

  it("Create project via API with new field names → global store has new shape", async () => {
    const repoPath = path.join(tempDir, "create-via-api");
    await fs.mkdir(repoPath, { recursive: true });

    const body = {
      name: "New Project via API",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-opus-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    };

    const res = await request(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();

    const settings = await readProjectFromGlobalStore(tempDir, res.body.data.id);

    expect(settings.simpleComplexityAgent).toBeDefined();
    expect(settings.simpleComplexityAgent.type).toBe("cursor");
    expect(settings.simpleComplexityAgent.model).toBe("composer-1.5");
    expect(settings.complexComplexityAgent).toBeDefined();
    expect(settings.complexComplexityAgent.type).toBe("claude");
    expect(settings.complexComplexityAgent.model).toBe("claude-opus-4");
  });

  it("GET/PUT /api/v1/projects/:id/settings do not accept or return apiKeys", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
        apiKeys: {
          ANTHROPIC_API_KEY: [{ id: "a1", value: "sk-ant-test" }],
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("apiKeys");

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data).not.toHaveProperty("apiKeys");
  });

  it("PUT /api/v1/projects/:id/settings returns 400 when agent config requires API keys but global store has none", async () => {
    await setGlobalSettings({ apiKeys: {} });

    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
        simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      });

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe("Configure API keys in Settings.");
  });

  it("Create project with gitWorkingMode branches → global store persists it", async () => {
    const repoPath = path.join(tempDir, "branches-mode");
    await fs.mkdir(repoPath, { recursive: true });

    const body = {
      name: "Branches Mode Project",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-opus-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      gitWorkingMode: "branches",
    };

    const res = await request(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(201);

    const settings = await readProjectFromGlobalStore(tempDir, res.body.data.id);
    expect(settings.gitWorkingMode).toBe("branches");
  });
});
