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
import { projectGitRuntimeCache } from "../services/project-git-runtime-cache.js";
import { setGlobalSettings } from "../services/global-settings.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, DEFAULT_REVIEW_MODE } from "@opensprint/shared";
import type { DbClient } from "../db/client.js";

const { testClientRef } = vi.hoisted(() => ({
  testClientRef: { current: null as DbClient | null },
}));
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
      runWrite: vi
        .fn()
        .mockImplementation(async (fn: (c: DbClient) => Promise<unknown>) =>
          fn(testClientRef.current!)
        ),
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

/** Write project settings into the global store (for tests that seed lastRunAt/lastSha). */
async function writeProjectToGlobalStore(
  tempDir: string,
  projectId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const storePath = getProjectSettingsPath(tempDir);
  const raw = await fs.readFile(storePath, "utf-8");
  const store = JSON.parse(raw) as Record<
    string,
    { settings: Record<string, unknown>; updatedAt: string }
  >;
  const entry = store[projectId];
  if (entry?.settings) {
    Object.assign(entry.settings, patch);
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
  }
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
    expect(secondParsed.mergeStrategy).toEqual(firstParsed.mergeStrategy ?? "per_task");
  });
});

describe("Settings API lifecycle", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;
  let refreshMaxSlotsSpy:
    | ReturnType<typeof vi.spyOn<typeof orchestratorService, "refreshMaxSlotsAndNudge">>
    | undefined;

  beforeEach(async () => {
    refreshMaxSlotsSpy = vi
      .spyOn(orchestratorService, "refreshMaxSlotsAndNudge")
      .mockResolvedValue(undefined);
    projectGitRuntimeCache.clear();
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
    refreshMaxSlotsSpy?.mockRestore();
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("GET /api/v1/projects/:id/settings returns two-tier shape, gitWorkingMode, mergeStrategy, and self-improvement fields", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.simpleComplexityAgent).toBeDefined();
    expect(res.body.data.simpleComplexityAgent.type).toBe("claude");
    expect(res.body.data.complexComplexityAgent).toBeDefined();
    expect(res.body.data.complexComplexityAgent.type).toBe("claude");
    expect(res.body.data.gitWorkingMode).toBe("worktree");
    expect(res.body.data.mergeStrategy).toBe("per_task");
    expect(res.body.data.selfImprovementFrequency).toBeDefined();
    expect(res.body.data.selfImprovementFrequency).toBe("never");
    expect(res.body.data.autoExecutePlans).toBe(false);
    // selfImprovementLastRunAt and selfImprovementLastCommitSha are optional; present only when set by internal runs
    expect(res.body.data.gitRuntimeStatus).toEqual({
      lastCheckedAt: null,
      stale: true,
      refreshing: true,
    });
  });

  it("GET /api/v1/projects/:id/settings returns selfImprovementLastRunAt and selfImprovementLastCommitSha when set in store", async () => {
    await writeProjectToGlobalStore(tempDir, projectId, {
      selfImprovementLastRunAt: "2025-02-01T10:00:00Z",
      selfImprovementLastCommitSha: "abc123def",
    });

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.data.selfImprovementLastRunAt).toBe("2025-02-01T10:00:00Z");
    expect(res.body.data.selfImprovementLastCommitSha).toBe("abc123def");
  });

  it("GET /api/v1/projects/:id/settings returns nextRunAt when selfImprovementFrequency is daily or weekly", async () => {
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ selfImprovementFrequency: "daily" });

    const resDaily = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(resDaily.status).toBe(200);
    expect(resDaily.body.data.nextRunAt).toBeDefined();
    expect(resDaily.body.data.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);

    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ selfImprovementFrequency: "weekly" });

    const resWeekly = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(resWeekly.status).toBe(200);
    expect(resWeekly.body.data.nextRunAt).toBeDefined();
    expect(resWeekly.body.data.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);

    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ selfImprovementFrequency: "never" });

    const resNever = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(resNever.status).toBe(200);
    expect(resNever.body.data.nextRunAt).toBeUndefined();
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
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ maxConcurrentCoders: 3 });

    expect(refreshMaxSlotsSpy).toHaveBeenCalledWith(projectId);
  });

  it("PUT /api/v1/projects/:id/settings accepts and persists teamMembers; GET returns it", async () => {
    const teamMembers = [{ id: "alice", name: "Alice" }];
    const putRes = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ teamMembers });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.teamMembers).toEqual(teamMembers);

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.teamMembers).toEqual(teamMembers);

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.teamMembers).toEqual(teamMembers);
  });

  it("PUT /api/v1/projects/:id/settings accepts teamMembers with empty name (add-then-edit flow)", async () => {
    const teamMembers = [{ id: "uuid-new-member", name: "" }];
    const putRes = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ teamMembers });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.teamMembers).toEqual(teamMembers);

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.teamMembers).toEqual(teamMembers);

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.teamMembers).toEqual(teamMembers);
  });

  it("PUT /api/v1/projects/:id/settings accepts and persists autoExecutePlans; GET returns it", async () => {
    const getRes0 = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes0.status).toBe(200);
    expect(getRes0.body.data.autoExecutePlans).toBe(false);

    const putRes = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ autoExecutePlans: true });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.autoExecutePlans).toBe(true);

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.autoExecutePlans).toBe(true);

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.autoExecutePlans).toBe(true);

    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ autoExecutePlans: false });
    const getRes2 = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes2.body.data.autoExecutePlans).toBe(false);
  });

  it("PUT /api/v1/projects/:id/settings accepts and persists enableHumanTeammates; GET returns it", async () => {
    const getRes0 = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes0.body.data.enableHumanTeammates).toBe(false);

    const putRes = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ enableHumanTeammates: true });
    expect(putRes.status).toBe(200);
    expect(putRes.body.data.enableHumanTeammates).toBe(true);

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.body.data.enableHumanTeammates).toBe(true);

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.enableHumanTeammates).toBe(true);
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

  it("GET /api/v1/projects/:id/settings returns mergeStrategy; PUT accepts and persists mergeStrategy (round-trip)", async () => {
    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.mergeStrategy).toBe("per_task");

    const putRes = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ mergeStrategy: "per_epic" });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.mergeStrategy).toBe("per_epic");

    const getRes2 = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes2.body.data.mergeStrategy).toBe("per_epic");

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.mergeStrategy).toBe("per_epic");
  });

  it("PUT /api/v1/projects/:id/settings rejects invalid mergeStrategy with 400", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ mergeStrategy: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
    expect(res.body.error?.message).toMatch(/not valid|per_task|per_epic|Per task|Per epic/);
  });

  it("PUT /api/v1/projects/:id/settings returns refreshing runtime status when worktreeBaseBranch changes", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ worktreeBaseBranch: "develop" });

    expect(res.status).toBe(200);
    expect(res.body.data.worktreeBaseBranch).toBe("develop");
    expect(res.body.data.gitRuntimeStatus?.refreshing).toBe(true);
    expect(res.body.data.gitRuntimeStatus?.stale).toBe(true);
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

  it("GET/PUT /api/v1/projects/:id/settings do not accept or return apiKeys (global-only)", async () => {
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

    const persisted = await readProjectFromGlobalStore(tempDir, projectId);
    expect(persisted).not.toHaveProperty("apiKeys");
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

  it("PUT /api/v1/projects/:id/settings accepts and persists selfImprovementFrequency; GET returns it", async () => {
    const getRes0 = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes0.body.data.selfImprovementFrequency).toBe("never");

    const putRes = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ selfImprovementFrequency: "daily" });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.selfImprovementFrequency).toBe("daily");

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.selfImprovementFrequency).toBe("daily");

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.selfImprovementFrequency).toBe("daily");
  });

  it("PUT /api/v1/projects/:id/settings ignores selfImprovementLastRunAt and selfImprovementLastCommitSha from client", async () => {
    const putRes = await request(app).put(`${API_PREFIX}/projects/${projectId}/settings`).send({
      selfImprovementFrequency: "weekly",
      selfImprovementLastRunAt: "2025-01-15T12:00:00Z",
      selfImprovementLastCommitSha: "client-set-sha",
    });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.selfImprovementFrequency).toBe("weekly");
    expect(putRes.body.data.selfImprovementLastRunAt).toBeUndefined();
    expect(putRes.body.data.selfImprovementLastCommitSha).toBeUndefined();

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.selfImprovementFrequency).toBe("weekly");
    expect(settings.selfImprovementLastRunAt).toBeUndefined();
    expect(settings.selfImprovementLastCommitSha).toBeUndefined();
  });

  it("PUT /api/v1/projects/:id/settings rejects invalid selfImprovementFrequency with 400", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ selfImprovementFrequency: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
    expect(res.body.error?.message).toMatch(
      /selfImprovementFrequency|never|after_each_plan|daily|weekly/
    );
  });
});
