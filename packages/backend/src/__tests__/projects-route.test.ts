import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import {
  setGlobalSettings,
  setGlobalSettingsPathForTesting,
} from "../services/global-settings.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, OPENSPRINT_DIR } from "@opensprint/shared";
import { setBackendRuntimeInfoForTesting } from "../utils/runtime-info.js";
import { cleanupTestProject } from "./test-project-cleanup.js";
import { notificationService } from "../services/notification.service.js";
import { setSelfImprovementRunInProgressForTest } from "../services/self-improvement-runner.service.js";
import { setProjectIndexPathForTesting } from "../services/project-index.js";
import { setSettingsStorePathForTesting } from "../services/settings-store.service.js";
import { authedSupertest } from "./local-auth-test-helpers.js";
import { trackProjectRuntimeRefreshes } from "./project-runtime-test-helpers.js";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  if (!dbResult) {
    return {
      ...actual,
      TaskStoreService: class {
        constructor() {
          throw new Error("Postgres required");
        }
      },
      taskStore: null,
      _postgresAvailable: false,
    };
  }
  const store = new actual.TaskStoreService(dbResult.client);
  await store.init();
  return {
    ...actual,
    TaskStoreService: class extends actual.TaskStoreService {
      constructor() {
        super(dbResult.client);
      }
    },
    taskStore: store,
    _postgresAvailable: true,
  };
});

const projectsTaskStoreMod = await import("../services/task-store.service.js");
const projectsPostgresOk =
  (projectsTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

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
  let drainRuntimeRefreshes: () => Promise<void>;

  beforeEach(async () => {
    drainRuntimeRefreshes = trackProjectRuntimeRefreshes();
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-projects-route-test-"));
    setGlobalSettingsPathForTesting(path.join(tempDir, ".opensprint", "global-settings.json"));
    setProjectIndexPathForTesting(path.join(tempDir, ".opensprint", "projects.json"));
    setSettingsStorePathForTesting(path.join(tempDir, ".opensprint", "settings.json"));

    await setGlobalSettings({
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "test-ant", value: "sk-ant-test" }],
        CURSOR_API_KEY: [{ id: "test-cur", value: "cursor-test" }],
      },
    });

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
    await drainRuntimeRefreshes();
    await cleanupTestProject({ projectService, projectId });
    projectService.clearListCacheForTesting();
    setGlobalSettingsPathForTesting(null);
    setProjectIndexPathForTesting(null);
    setSettingsStorePathForTesting(null);
    setBackendRuntimeInfoForTesting(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("GET /projects/:id/sketch-context returns hasExistingCode false when repo has no source files", async () => {
    const res = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${projectId}/sketch-context`
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.hasExistingCode).toBe(false);
  });

  it("GET /projects/:id/sketch-context returns hasExistingCode true when repo has source files", async () => {
    const repoPath = path.join(tempDir, "my-project");
    await fs.writeFile(path.join(repoPath, "index.ts"), "console.log('hello');");

    const res = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${projectId}/sketch-context`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.hasExistingCode).toBe(true);
  });

  it("GET /projects/:id/self-improvement/history returns empty list when no runs", async () => {
    const res = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${projectId}/self-improvement/history`
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });

  it("GET /projects/:id/self-improvement/history returns runs with timestamp, status, tasksCreatedCount", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const completedAt = "2025-03-10T12:00:00.000Z";
    await taskStore.insertSelfImprovementRunHistory({
      projectId,
      runId: "si-test-1",
      completedAt,
      status: "success",
      tasksCreatedCount: 3,
      mode: "audit_only",
      outcome: "tasks_created",
      summary: "Created 3 self-improvement task(s).",
      promotedVersionId: "bv-promo",
    });

    const res = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${projectId}/self-improvement/history`
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      timestamp: completedAt,
      status: "success",
      tasksCreatedCount: 3,
      mode: "audit_only",
      outcome: "tasks_created",
      summary: "Created 3 self-improvement task(s).",
      promotedVersionId: "bv-promo",
    });
    expect(res.body.data[0].runId).toBe("si-test-1");
  });

  it("POST /projects/:id/self-improvement/run returns run result (tasksCreated or skipped)", async () => {
    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/self-improvement/run`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(typeof res.body.data.tasksCreated).toBe("number");
    if (res.body.data.tasksCreated > 0) {
      expect(res.body.data.runId).toBeDefined();
    } else if (res.body.data.skipped) {
      expect(["no_changes", "run_in_progress"]).toContain(res.body.data.skipped);
    }
  });

  it("POST /projects/:id/self-improvement/approve promotes pending candidate, clears pending, resolves notification, and appends history", async () => {
    await projectService.updateSettings(projectId, {
      selfImprovementPendingCandidateId: "bv-candidate-1",
    });
    await notificationService.createSelfImprovementApproval({
      projectId,
      candidateId: "bv-candidate-1",
      deepLinkPath: `/projects/${projectId}/settings`,
    });

    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/self-improvement/approve`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.pendingCandidateId).toBeUndefined();
    expect(res.body.data.activeBehaviorVersionId).toBe("bv-candidate-1");
    expect(res.body.data.behaviorVersions).toContainEqual(
      expect.objectContaining({ id: "bv-candidate-1" })
    );
    expect(res.body.data.history.at(-1)).toMatchObject({
      action: "approved",
      behaviorVersionId: "bv-candidate-1",
      candidateId: "bv-candidate-1",
    });

    const notifications = await notificationService.listByProject(projectId);
    const stillOpen = notifications.find(
      (n) => n.kind === "self_improvement_approval" && n.sourceId === "bv-candidate-1"
    );
    expect(stillOpen).toBeUndefined();
  });

  it("POST /projects/:id/self-improvement/reject clears pending, resolves notification, and appends history", async () => {
    await projectService.updateSettings(projectId, {
      selfImprovementPendingCandidateId: "bv-candidate-2",
    });
    await notificationService.createSelfImprovementApproval({
      projectId,
      candidateId: "bv-candidate-2",
    });

    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/self-improvement/reject`)
      .send({ candidateId: "bv-candidate-2" });

    expect(res.status).toBe(200);
    expect(res.body.data.pendingCandidateId).toBeUndefined();
    expect(res.body.data.activeBehaviorVersionId).toBeUndefined();
    expect(res.body.data.history.at(-1)).toMatchObject({
      action: "rejected",
      candidateId: "bv-candidate-2",
    });

    const notifications = await notificationService.listByProject(projectId);
    const stillOpen = notifications.find(
      (n) => n.kind === "self_improvement_approval" && n.sourceId === "bv-candidate-2"
    );
    expect(stillOpen).toBeUndefined();
  });

  it("POST /projects/:id/self-improvement/rollback switches active behavior version", async () => {
    await projectService.updateSettings(projectId, {
      selfImprovementActiveBehaviorVersionId: "bv-current",
      selfImprovementBehaviorVersions: [
        { id: "bv-current", promotedAt: "2025-03-10T00:00:00.000Z" },
        { id: "bv-previous", promotedAt: "2025-03-09T00:00:00.000Z" },
      ],
    });

    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/self-improvement/rollback`)
      .send({ behaviorVersionId: "bv-previous" });

    expect(res.status).toBe(200);
    expect(res.body.data.activeBehaviorVersionId).toBe("bv-previous");
    expect(res.body.data.history.at(-1)).toMatchObject({
      action: "rollback",
      behaviorVersionId: "bv-previous",
    });
  });

  it("POST /projects/:id/self-improvement/approve returns 404 when no pending candidate", async () => {
    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/self-improvement/approve`)
      .send();

    expect(res.status).toBe(404);
  });

  it("POST /projects/:id/self-improvement/reject returns 400 when candidateId does not match pending", async () => {
    await projectService.updateSettings(projectId, {
      selfImprovementPendingCandidateId: "bv-candidate-3",
    });
    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/self-improvement/reject`)
      .send({ candidateId: "wrong-id" });

    expect(res.status).toBe(400);
  });

  it("POST /projects/:id/self-improvement/rollback returns 400 for non-promoted behavior version", async () => {
    await projectService.updateSettings(projectId, {
      selfImprovementBehaviorVersions: [{ id: "bv-a", promotedAt: "2025-03-10T00:00:00.000Z" }],
    });

    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects/${projectId}/self-improvement/rollback`)
      .send({ behaviorVersionId: "bv-missing" });

    expect(res.status).toBe(400);
  });

  it("GET /projects/:id/self-improvement/status returns idle when no run in progress", async () => {
    const res = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${projectId}/self-improvement/status`
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.status).toBe("idle");
    expect(res.body.data.stage).toBeUndefined();
    expect(res.body.data.pendingCandidateId).toBeUndefined();
  });

  it("GET /projects/:id/self-improvement/status returns running_audit when run in progress", async () => {
    setSelfImprovementRunInProgressForTest(projectId, { status: "running_audit" });
    try {
      const res = await authedSupertest(app).get(
        `${API_PREFIX}/projects/${projectId}/self-improvement/status`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("running_audit");
    } finally {
      setSelfImprovementRunInProgressForTest(projectId, false);
    }
  });

  it("GET /projects/:id/self-improvement/status returns running_experiments with stage", async () => {
    setSelfImprovementRunInProgressForTest(projectId, {
      status: "running_experiments",
      stage: "scoring",
    });
    try {
      const res = await authedSupertest(app).get(
        `${API_PREFIX}/projects/${projectId}/self-improvement/status`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("running_experiments");
      expect(res.body.data.stage).toBe("scoring");
    } finally {
      setSelfImprovementRunInProgressForTest(projectId, false);
    }
  });

  it("GET /projects/:id/self-improvement/status returns awaiting_approval when candidate pending", async () => {
    await projectService.updateSettings(projectId, {
      selfImprovementPendingCandidateId: "bv-candidate-status",
    });

    const res = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${projectId}/self-improvement/status`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("awaiting_approval");
    expect(res.body.data.pendingCandidateId).toBe("bv-candidate-status");
    expect(res.body.data.summary).toBeDefined();
  });

  it("POST /projects/:id/archive removes project from list, keeps .opensprint", async () => {
    const repoPath = path.join(tempDir, "my-project");
    const opensprintPath = path.join(repoPath, OPENSPRINT_DIR);

    const listBefore = await authedSupertest(app).get(`${API_PREFIX}/projects`);
    expect(listBefore.body.data).toHaveLength(1);

    const archiveRes = await authedSupertest(app).post(
      `${API_PREFIX}/projects/${projectId}/archive`
    );
    expect(archiveRes.status).toBe(204);

    const listAfter = await authedSupertest(app).get(`${API_PREFIX}/projects`);
    expect(listAfter.body.data).toHaveLength(0);

    const stat = await fs.stat(opensprintPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("DELETE /projects/:id removes project from list and deletes .opensprint", async () => {
    const repoPath = path.join(tempDir, "my-project");
    const opensprintPath = path.join(repoPath, OPENSPRINT_DIR);

    const deleteRes = await authedSupertest(app).delete(`${API_PREFIX}/projects/${projectId}`);
    expect(deleteRes.status).toBe(204);

    const listAfter = await authedSupertest(app).get(`${API_PREFIX}/projects`);
    expect(listAfter.body.data).toHaveLength(0);

    await expect(fs.stat(opensprintPath)).rejects.toThrow();
  });
});

describe("Projects REST API — create and settings", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let drainRuntimeRefreshes: () => Promise<void>;

  beforeEach(async () => {
    drainRuntimeRefreshes = trackProjectRuntimeRefreshes();
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-projects-create-test-"));
    setGlobalSettingsPathForTesting(path.join(tempDir, ".opensprint", "global-settings.json"));
    setProjectIndexPathForTesting(path.join(tempDir, ".opensprint", "projects.json"));
    setSettingsStorePathForTesting(path.join(tempDir, ".opensprint", "settings.json"));

    await setGlobalSettings({
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "test-ant", value: "sk-ant-test" }],
        CURSOR_API_KEY: [{ id: "test-cur", value: "cursor-test" }],
      },
    });

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
    await drainRuntimeRefreshes();
    setBackendRuntimeInfoForTesting(null);
    projectService.clearListCacheForTesting();
    setGlobalSettingsPathForTesting(null);
    setProjectIndexPathForTesting(null);
    setSettingsStorePathForTesting(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("POST /projects creates project with simpleComplexityAgent and complexComplexityAgent", async () => {
    const repoPath = path.join(tempDir, "create-via-api");
    await fs.mkdir(repoPath, { recursive: true });

    const body = { ...validCreateBody, repoPath };
    const res = await authedSupertest(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.name).toBe("New Project");
    expect(res.body.data.repoPath).toBe(repoPath);

    const settingsRes = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${res.body.data.id}/settings`
    );
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.data.simpleComplexityAgent).toBeDefined();
    expect(settingsRes.body.data.simpleComplexityAgent.type).toBe("claude");
    expect(settingsRes.body.data.complexComplexityAgent).toBeDefined();
    expect(settingsRes.body.data.complexComplexityAgent.type).toBe("claude");
  });

  it("POST /projects rejects /mnt paths when runtime is WSL", async () => {
    setBackendRuntimeInfoForTesting({
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu",
      repoPathPolicy: "linux_fs_only",
    });

    const res = await authedSupertest(app)
      .post(`${API_PREFIX}/projects`)
      .send({ ...validCreateBody, repoPath: "/mnt/c/Users/Todd/my-project" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNSUPPORTED_REPO_PATH");
    expect(res.body.error.message).toContain("WSL filesystem");
  });

  it("PUT /projects/:id/settings updates simpleComplexityAgent and complexComplexityAgent", async () => {
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

  it("POST /projects without agent tiers inherits global defaults and flags inheritance on GET settings", async () => {
    await setGlobalSettings({
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "test-ant", value: "sk-ant-test" }],
        CURSOR_API_KEY: [{ id: "test-cur", value: "cursor-test" }],
      },
      simpleComplexityAgent: { type: "openai", model: "route-omit-simple", cliCommand: null },
      complexComplexityAgent: { type: "openai", model: "route-omit-complex", cliCommand: null },
    });

    const repoPath = path.join(tempDir, "missing-agents");
    await fs.mkdir(repoPath, { recursive: true });

    const body = {
      name: "Missing Agents",
      repoPath,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    };

    const res = await authedSupertest(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(201);
    const newId = res.body.data.id;

    const settingsRes = await authedSupertest(app).get(`${API_PREFIX}/projects/${newId}/settings`);
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.data.simpleComplexityAgentInherited).toBe(true);
    expect(settingsRes.body.data.complexComplexityAgentInherited).toBe(true);
    expect(settingsRes.body.data.simpleComplexityAgent.model).toBe("route-omit-simple");
    expect(settingsRes.body.data.complexComplexityAgent.model).toBe("route-omit-complex");

    await cleanupTestProject({ projectService, projectId: newId });
  });

  it("POST /projects creates project; GET settings does not return apiKeys", async () => {
    const repoPath = path.join(tempDir, "create-basic");
    await fs.mkdir(repoPath, { recursive: true });

    const body = { ...validCreateBody, repoPath };
    const res = await authedSupertest(app).post(`${API_PREFIX}/projects`).send(body);

    expect(res.status).toBe(201);
    const projectId = res.body.data.id;

    const settingsRes = await authedSupertest(app).get(
      `${API_PREFIX}/projects/${projectId}/settings`
    );
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.data).not.toHaveProperty("apiKeys");
  });

  it("PUT /projects/:id rejects /mnt repoPath updates when runtime is WSL", async () => {
    setBackendRuntimeInfoForTesting({
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu",
      repoPathPolicy: "linux_fs_only",
    });

    const res = await authedSupertest(app)
      .put(`${API_PREFIX}/projects/${projectId}`)
      .send({ repoPath: "/mnt/d/Users/Todd/updated-project" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNSUPPORTED_REPO_PATH");
    expect(res.body.error.message).toContain("WSL filesystem");
  });
});
