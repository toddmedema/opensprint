/**
 * Full integration test: settings lifecycle.
 * Verifies settings read/write round-trip with two-tier format (simpleComplexityAgent/complexComplexityAgent).
 * Settings are stored in global DB at ~/.opensprint/settings.json keyed by project_id.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { getNextKey } from "../services/api-key-resolver.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, DEFAULT_REVIEW_MODE } from "@opensprint/shared";

/** Path to global settings store (when HOME is tempDir in tests). */
function getGlobalSettingsPath(tempDir: string): string {
  return path.join(tempDir, ".opensprint", "settings.json");
}

/** Read project settings from global store. */
async function readProjectFromGlobalStore(
  tempDir: string,
  projectId: string
): Promise<Record<string, unknown>> {
  const storePath = getGlobalSettingsPath(tempDir);
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

  it("persists apiKeys to global store and returns them after getSettings", async () => {
    const repoPath = path.join(tempDir, "apikeys");
    const project = await projectService.createProject({
      name: "API Keys",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const apiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx" }],
      CURSOR_API_KEY: [
        { id: "k2", value: "cursor-key-1" },
        { id: "k3", value: "cursor-key-2", limitHitAt: "2025-02-25T12:00:00Z" },
      ],
    };
    await projectService.updateSettings(project.id, { apiKeys });

    const fetched = await projectService.getSettings(project.id);
    expect(fetched.apiKeys).toEqual(apiKeys);

    const persisted = await readProjectFromGlobalStore(tempDir, project.id);
    expect(persisted.apiKeys).toEqual(apiKeys);
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

  it("PUT /api/v1/projects/:id/settings accepts and persists apiKeys (response masked)", async () => {
    const apiKeys = {
      ANTHROPIC_API_KEY: [{ id: "a1", value: "sk-ant-test" }],
      CURSOR_API_KEY: [{ id: "c1", value: "cursor-test-key" }],
    };
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ apiKeys });

    expect(res.status).toBe(200);
    expect(res.body.data.apiKeys).toEqual({
      ANTHROPIC_API_KEY: [{ id: "a1", masked: "••••••••" }],
      CURSOR_API_KEY: [{ id: "c1", masked: "••••••••" }],
    });

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.body.data.apiKeys).toEqual({
      ANTHROPIC_API_KEY: [{ id: "a1", masked: "••••••••" }],
      CURSOR_API_KEY: [{ id: "c1", masked: "••••••••" }],
    });

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.apiKeys).toEqual(apiKeys);
  });

  it("GET /api/v1/projects/:id/settings returns masked apiKeys with limitHitAt", async () => {
    const apiKeys = {
      ANTHROPIC_API_KEY: [
        { id: "k1", value: "sk-ant-secret" },
        { id: "k2", value: "sk-ant-other", limitHitAt: "2025-02-25T12:00:00Z" },
      ],
    };
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ apiKeys });

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.apiKeys).not.toBeUndefined();
    expect(getRes.body.data.apiKeys.ANTHROPIC_API_KEY).toHaveLength(2);
    expect(getRes.body.data.apiKeys.ANTHROPIC_API_KEY[0]).toEqual({
      id: "k1",
      masked: "••••••••",
    });
    expect(getRes.body.data.apiKeys.ANTHROPIC_API_KEY[1]).toEqual({
      id: "k2",
      masked: "••••••••",
      limitHitAt: "2025-02-25T12:00:00Z",
    });
    expect(getRes.body.data.apiKeys.ANTHROPIC_API_KEY[0].value).toBeUndefined();
    expect(getRes.body.data.apiKeys.ANTHROPIC_API_KEY[1].value).toBeUndefined();
  });

  it("PUT apiKeys then ApiKeyResolver.getNextKey returns the key (integration)", async () => {
    const apiKeys = {
      ANTHROPIC_API_KEY: [
        { id: "a1", value: "sk-ant-from-api" },
        { id: "a2", value: "sk-ant-second" },
      ],
    };
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ apiKeys });

    const resolved = await getNextKey(projectId, "ANTHROPIC_API_KEY");
    expect(resolved).toEqual({ key: "sk-ant-from-api", keyId: "a1", source: "project" });
  });

  it("PUT /api/v1/projects/:id/settings rejects empty apiKeys when provider in use", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
        apiKeys: {
          ANTHROPIC_API_KEY: [],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
    expect(res.body.error?.message).toContain("ANTHROPIC_API_KEY");
    expect(res.body.error?.message).toContain("cannot be empty");
  });

  it("PUT /api/v1/projects/:id/settings merges apiKeys when value omitted (keeps existing)", async () => {
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", value: "sk-ant-original" },
            { id: "k2", value: "sk-ant-second" },
          ],
        },
      });

    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
        apiKeys: {
          ANTHROPIC_API_KEY: [
            { id: "k1", limitHitAt: "2025-02-25T14:00:00Z" },
            { id: "k2" },
          ],
        },
      });

    expect(res.status).toBe(200);
    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.apiKeys?.ANTHROPIC_API_KEY).toHaveLength(2);
    expect(settings.apiKeys?.ANTHROPIC_API_KEY?.[0]).toEqual({
      id: "k1",
      value: "sk-ant-original",
      limitHitAt: "2025-02-25T14:00:00Z",
    });
    expect(settings.apiKeys?.ANTHROPIC_API_KEY?.[1]).toEqual({
      id: "k2",
      value: "sk-ant-second",
    });
  });

  it("PUT /api/v1/projects/:id/settings allows apiKeys without provider when that provider not in use", async () => {
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      });

    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
        apiKeys: {
          CURSOR_API_KEY: [{ id: "c1", value: "cursor-key" }],
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.apiKeys?.CURSOR_API_KEY).toHaveLength(1);
    expect(res.body.data.apiKeys?.CURSOR_API_KEY?.[0]).toMatchObject({ id: "c1", masked: "••••••••" });
    expect(res.body.data.apiKeys?.ANTHROPIC_API_KEY).toBeUndefined();
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
