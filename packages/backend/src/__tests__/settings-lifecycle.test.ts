import { setSettingsStorePathForTesting } from "../services/settings-store.service.js";
/**
 * Full integration test: settings lifecycle.
 * Verifies settings read/write round-trip with two-tier format (simpleComplexityAgent/complexComplexityAgent).
 * Settings are stored in global DB at ~/.opensprint/settings.json keyed by project_id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authedSupertest } from "./local-auth-test-helpers.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import {
  ProjectService,
  getNextScheduledSelfImprovementRunAt,
} from "../services/project.service.js";
import { trackProjectRuntimeRefreshes } from "./project-runtime-test-helpers.js";
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
      runRead: vi
        .fn()
        .mockImplementation(async (fn: (c: DbClient) => Promise<unknown>) =>
          fn(testClientRef.current!)
        ),
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

describe("Settings lifecycle — service-level", { retry: 2 }, () => {
  let projectService: ProjectService;
  let tempDir: string;
  let originalHome: string | undefined;
  let drainRuntimeRefreshes: () => Promise<void>;

  beforeEach(async () => {
    drainRuntimeRefreshes = trackProjectRuntimeRefreshes();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-settings-lifecycle-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    setSettingsStorePathForTesting(path.join(tempDir, ".opensprint", "settings.json"));
    await setGlobalSettings({
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "test-ant", value: "sk-ant-test" }],
        CURSOR_API_KEY: [{ id: "test-cur", value: "cursor-test" }],
      },
    });
  });

  afterEach(async () => {
    await drainRuntimeRefreshes();
    setSettingsStorePathForTesting(null);
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

  it("persists maxTotalConcurrentAgents and clears with null", async () => {
    const repoPath = path.join(tempDir, "total-agents");
    const project = await projectService.createProject({
      name: "Total agents",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.updateSettings(project.id, { maxTotalConcurrentAgents: 5 });

    let fetched = await projectService.getSettings(project.id);
    expect(fetched.maxTotalConcurrentAgents).toBe(5);

    let persisted = await readProjectFromGlobalStore(tempDir, project.id);
    expect(persisted.maxTotalConcurrentAgents).toBe(5);

    await projectService.updateSettings(project.id, { maxTotalConcurrentAgents: null });

    fetched = await projectService.getSettings(project.id);
    expect(fetched.maxTotalConcurrentAgents).toBeUndefined();

    persisted = await readProjectFromGlobalStore(tempDir, project.id);
    expect(persisted.maxTotalConcurrentAgents).toBeUndefined();
  });

  it("preserves maxConcurrentCoders when validation timing samples are recorded (no clobber)", async () => {
    const repoPath = path.join(tempDir, "parallelism-keep");
    const project = await projectService.createProject({
      name: "Parallelism Keep",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.updateSettings(project.id, { maxConcurrentCoders: 4 });
    await projectService.recordValidationDuration(project.id, "scoped", 12_000);

    const fetched = await projectService.getSettings(project.id);
    expect(fetched.maxConcurrentCoders).toBe(4);

    const persisted = await readProjectFromGlobalStore(tempDir, project.id);
    expect(persisted.maxConcurrentCoders).toBe(4);
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

  it("deployment mode=expo persists through save → reload → save round-trip", async () => {
    const repoPath = path.join(tempDir, "deploy-mode");
    const project = await projectService.createProject({
      name: "Deploy Mode",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.updateSettings(project.id, {
      deployment: { mode: "expo", expoConfig: { channel: "preview" } },
    });

    const after = await projectService.getSettings(project.id);
    expect(after.deployment.mode).toBe("expo");

    const persisted = await readProjectFromGlobalStore(tempDir, project.id);
    expect((persisted.deployment as Record<string, unknown>).mode).toBe("expo");

    await projectService.updateSettings(project.id, { testFramework: "vitest" });
    const afterUnrelated = await projectService.getSettings(project.id);
    expect(afterUnrelated.deployment.mode).toBe("expo");
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

describe("Settings API lifecycle", { retry: 2 }, () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;
  let drainRuntimeRefreshes: () => Promise<void>;
  let refreshMaxSlotsSpy:
    | ReturnType<typeof vi.spyOn<typeof orchestratorService, "refreshMaxSlotsAndNudge">>
    | undefined;

  beforeEach(async () => {
    drainRuntimeRefreshes = trackProjectRuntimeRefreshes();
    refreshMaxSlotsSpy = vi
      .spyOn(orchestratorService, "refreshMaxSlotsAndNudge")
      .mockResolvedValue(undefined);
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-settings-api-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    setSettingsStorePathForTesting(path.join(tempDir, ".opensprint", "settings.json"));

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
    await drainRuntimeRefreshes();
    refreshMaxSlotsSpy?.mockRestore();
    setSettingsStorePathForTesting(null);
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("GET /api/v1/projects/:id/settings returns two-tier shape, gitWorkingMode, mergeStrategy, and self-improvement fields", async () => {
    const res = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);

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
    expect(res.body.data.runAgentEnhancementExperiments).toBe(false);
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

    const res = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);

    expect(res.status).toBe(200);
    expect(res.body.data.selfImprovementLastRunAt).toBe("2025-02-01T10:00:00Z");
    expect(res.body.data.selfImprovementLastCommitSha).toBe("abc123def");
  });

  it("GET /api/v1/projects/:id/settings returns nextRunAt when selfImprovementFrequency is daily or weekly", async () => {
    // Fixed UTC instant avoids flaky expectations if the test crosses a UTC day boundary.
    const anchor = new Date("2025-06-11T14:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(anchor);
    try {
      await authedSupertest(app)
        .put(`${API_PREFIX}/projects/${projectId}/settings`)
        .send({ selfImprovementFrequency: "daily" });

      const resDaily = await authedSupertest(app).get(
        `${API_PREFIX}/projects/${projectId}/settings`
      );
      expect(resDaily.status).toBe(200);
      expect(resDaily.body.data.nextRunAt).toBe(getNextScheduledSelfImprovementRunAt("daily"));

      await authedSupertest(app)
        .put(`${API_PREFIX}/projects/${projectId}/settings`)
        .send({ selfImprovementFrequency: "weekly" });

      const resWeekly = await authedSupertest(app).get(
        `${API_PREFIX}/projects/${projectId}/settings`
      );
      expect(resWeekly.status).toBe(200);
      expect(resWeekly.body.data.nextRunAt).toBe(getNextScheduledSelfImprovementRunAt("weekly"));

      await authedSupertest(app)
        .put(`${API_PREFIX}/projects/${projectId}/settings`)
        .send({ selfImprovementFrequency: "never" });

      const resNever = await authedSupertest(app).get(
        `${API_PREFIX}/projects/${projectId}/settings`
      );
      expect(resNever.status).toBe(200);
      expect(resNever.body.data.nextRunAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("PUT /api/v1/projects/:id/settings with new field names succeeds", async () => {
    const res = await authedSupertest(app)
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
    await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ maxConcurrentCoders: 3 });

    expect(refreshMaxSlotsSpy).toHaveBeenCalledWith(projectId);
  });

  it("PUT /api/v1/projects/:id/settings accepts and persists teamMembers; GET returns it", async () => {
    const teamMembers = [{ id: "alice", name: "Alice" }];
    const putRes = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ teamMembers });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.teamMembers).toEqual(teamMembers);

    const getRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.teamMembers).toEqual(teamMembers);

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.teamMembers).toEqual(teamMembers);
  });

  it("PUT /api/v1/projects/:id/settings accepts and persists autoExecutePlans; GET returns it", async () => {
    const getRes0 = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes0.status).toBe(200);
    expect(getRes0.body.data.autoExecutePlans).toBe(false);

    const putRes = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ autoExecutePlans: true });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.autoExecutePlans).toBe(true);

    const getRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.autoExecutePlans).toBe(true);

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.autoExecutePlans).toBe(true);

    await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ autoExecutePlans: false });
    const getRes2 = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes2.body.data.autoExecutePlans).toBe(false);
  });

  it("GET /api/v1/projects/:id/settings returns mergeStrategy; PUT accepts and persists mergeStrategy (round-trip)", async () => {
    const getRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.mergeStrategy).toBe("per_task");

    const putRes = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ mergeStrategy: "per_epic" });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.mergeStrategy).toBe("per_epic");

    const getRes2 = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes2.body.data.mergeStrategy).toBe("per_epic");

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.mergeStrategy).toBe("per_epic");
  });

  it("PUT /api/v1/projects/:id/settings rejects invalid mergeStrategy with 400", async () => {
    const res = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ mergeStrategy: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
    expect(res.body.error?.message).toMatch(/not valid|per_task|per_epic|Per task|Per epic/);
  });

  it("PUT /api/v1/projects/:id/settings returns refreshing runtime status when worktreeBaseBranch changes", async () => {
    const res = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ worktreeBaseBranch: "develop" });

    expect(res.status).toBe(200);
    expect(res.body.data.worktreeBaseBranch).toBe("develop");
    expect(res.body.data.gitRuntimeStatus?.refreshing).toBe(true);
    expect(res.body.data.gitRuntimeStatus?.stale).toBe(true);
  });

  it("PUT /api/v1/projects/:id/settings forces maxConcurrentCoders to 1 when gitWorkingMode is branches", async () => {
    const res = await authedSupertest(app)
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
    await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ gitWorkingMode: "branches" });

    // Send invalid value — should keep branches (not persist invalid)
    const res = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ gitWorkingMode: "invalid" });

    expect(res.status).toBe(200);
    expect(res.body.data.gitWorkingMode).toBe("branches");

    const settings = await readProjectFromGlobalStore(tempDir, projectId);
    expect(settings.gitWorkingMode).toBe("branches");
  });

  it("PUT /api/v1/projects/:id/settings returns 400 when agent config requires API keys but global store has none", async () => {
    await setGlobalSettings({ apiKeys: {} });

    const res = await authedSupertest(app)
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

    const res = await authedSupertest(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(201);

    const settings = await readProjectFromGlobalStore(tempDir, res.body.data.id);
    expect(settings.gitWorkingMode).toBe("branches");
  });

  it("keeps per-project settings isolated under concurrent cross-project PUT storms", async () => {
    const projectIds = [projectId];
    for (let i = 0; i < 3; i += 1) {
      const repoPath = path.join(tempDir, `concurrent-${i}`);
      await fs.mkdir(repoPath, { recursive: true });
      const project = await projectService.createProject({
        name: `Concurrent ${i}`,
        repoPath,
        simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      });
      projectIds.push(project.id);
    }

    const finalByProject = new Map<
      string,
      {
        mergeStrategy: "per_task" | "per_epic";
        selfImprovementFrequency: "never" | "daily" | "weekly";
        maxConcurrentCoders: number;
        unknownScopeStrategy: "optimistic" | "conservative";
      }
    >();

    await Promise.all(
      projectIds.flatMap((id, idx) => [
        authedSupertest(app)
          .put(`${API_PREFIX}/projects/${id}/settings`)
          .send({
            maxConcurrentCoders: 2 + idx,
            mergeStrategy: idx % 2 === 0 ? "per_epic" : "per_task",
          })
          .expect(200),
        authedSupertest(app)
          .put(`${API_PREFIX}/projects/${id}/settings`)
          .send({
            selfImprovementFrequency: idx % 2 === 0 ? "daily" : "weekly",
            unknownScopeStrategy: idx % 2 === 0 ? "conservative" : "optimistic",
          })
          .expect(200),
      ])
    );

    await Promise.all(
      projectIds.map((id, idx) => {
        const finalExpected = {
          mergeStrategy: idx % 2 === 0 ? "per_task" : "per_epic",
          selfImprovementFrequency: idx % 2 === 0 ? "weekly" : "daily",
          maxConcurrentCoders: 5 + idx,
          unknownScopeStrategy: idx % 2 === 0 ? "optimistic" : "conservative",
        } as const;
        finalByProject.set(id, finalExpected);
        return authedSupertest(app)
          .put(`${API_PREFIX}/projects/${id}/settings`)
          .send(finalExpected)
          .expect(200);
      })
    );

    for (const id of projectIds) {
      const expected = finalByProject.get(id)!;
      const getRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${id}/settings`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.mergeStrategy).toBe(expected.mergeStrategy);
      expect(getRes.body.data.selfImprovementFrequency).toBe(expected.selfImprovementFrequency);
      expect(getRes.body.data.maxConcurrentCoders).toBe(expected.maxConcurrentCoders);
      expect(getRes.body.data.unknownScopeStrategy).toBe(expected.unknownScopeStrategy);

      const persisted = await readProjectFromGlobalStore(tempDir, id);
      expect(persisted.mergeStrategy).toBe(expected.mergeStrategy);
      expect(persisted.selfImprovementFrequency).toBe(expected.selfImprovementFrequency);
      expect(persisted.maxConcurrentCoders).toBe(expected.maxConcurrentCoders);
      expect(persisted.unknownScopeStrategy).toBe(expected.unknownScopeStrategy);
    }
  });

  it("PUT /api/v1/projects/:id/settings ignores selfImprovementLastRunAt and selfImprovementLastCommitSha from client", async () => {
    const putRes = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({
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
    const res = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ selfImprovementFrequency: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
    expect(res.body.error?.message).toMatch(
      /selfImprovementFrequency|never|after_each_plan|daily|weekly/
    );
  });

  it("PUT /api/v1/projects/:id/settings rejects invalid runAgentEnhancementExperiments with 400", async () => {
    const res = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/settings`)
      .send({ runAgentEnhancementExperiments: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
    expect(res.body.error?.message).toMatch(/runAgentEnhancementExperiments|boolean/);
  });

  it("PUT deliver/settings mode=expo persists and GET project settings returns it unchanged", async () => {
    const putRes = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}/deliver/settings`)
      .send({ mode: "expo" });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.deployment.mode).toBe("expo");

    const getRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${projectId}/settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.deployment.mode).toBe("expo");
  });
});
