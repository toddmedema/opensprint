import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { integrationStore } from "../services/integration-store.service.js";
import { tokenEncryption } from "../services/token-encryption.service.js";
import { taskStore } from "../services/task-store.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import { authedSupertest } from "./local-auth-test-helpers.js";
import { cleanupTestProject } from "./test-project-cleanup.js";
import {
  pinOpenSprintPathsForTesting,
  resetOpenSprintPathsForTesting,
} from "./opensprint-path-test-helper.js";

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

const ghRouteTaskStoreMod = await import("../services/task-store.service.js");
const postgresOk =
  (ghRouteTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mappedPlanId: null,
        task_titles: ["Mock task"],
      }),
    }),
  })),
}));

vi.mock("../services/hil-service.js", () => ({
  hilService: { evaluateDecision: vi.fn().mockResolvedValue({ approved: false }) },
}));

vi.mock("../services/websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

vi.mock("../services/deploy-trigger.service.js", () => ({
  triggerDeploy: vi.fn().mockResolvedValue("deploy-123"),
  triggerDeployForEvent: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/todoist-api-client.service.js", async () => {
  const { createTodoistApiClientVitestMock } = await import(
    "./mocks/todoist-api-client.service.vitest-mock.js"
  );
  return createTodoistApiClientVitestMock();
});

// Mock global fetch for GitHub API calls
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const BASE = `${API_PREFIX}/projects`;
function ghUrl(projectId: string, route = "") {
  return `${BASE}/${projectId}/integrations/github${route}`;
}

async function seedGitHubConnection(
  projectId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const realEncryptedToken = tokenEncryption.encryptToken("ghp_test-pat-token");
  const defaults = {
    project_id: projectId,
    provider: "github" as const,
    provider_user_id: "octocat",
    access_token_enc: realEncryptedToken,
    scopes: "repo",
    status: "active" as const,
  };
  await integrationStore.upsertConnection({ ...defaults, ...overrides });
}

async function cleanGitHubData(projectId: string): Promise<void> {
  try {
    await integrationStore.deleteConnection(projectId, "github");
  } catch {
    // ignore if not present
  }
}

describe.skipIf(!postgresOk)("GitHub Integration Routes (createApp)", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-github-route-test-"));
    pinOpenSprintPathsForTesting(tempDir);

    const project = await projectService.createProject({
      name: "GitHub Test Project",
      repoPath: path.join(tempDir, "my-project"),
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
    await taskStore.init();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanGitHubData(projectId);
    await cleanupTestProject({ projectService, projectId });
    projectService.clearListCacheForTesting();
    resetOpenSprintPathsForTesting();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ─── POST /connect ───

  describe("POST /connect", () => {
    it("stores connection when token is valid", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: "octocat" }),
      });

      const res = await authedSupertest(app)
        .post(ghUrl(projectId, "/connect"))
        .send({ token: "ghp_valid-token-123" })
        .expect(200);

      expect(res.body.data.success).toBe(true);
      expect(res.body.data.user).toBe("octocat");

      const conn = await integrationStore.getConnection(projectId, "github");
      expect(conn).not.toBeNull();
      expect(conn!.status).toBe("active");
      expect(conn!.provider_user_id).toBe("octocat");
    });

    it("returns 401 when token is invalid", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Bad credentials" });

      const res = await authedSupertest(app)
        .post(ghUrl(projectId, "/connect"))
        .send({ token: "ghp_invalid" })
        .expect(401);

      expect(res.body.error.code).toBe("INVALID_TOKEN");
    });

    it("returns 400 when token is missing", async () => {
      await authedSupertest(app)
        .post(ghUrl(projectId, "/connect"))
        .send({})
        .expect(400);
    });
  });

  // ─── GET /status ───

  describe("GET /status", () => {
    it("returns disconnected when no connection exists", async () => {
      const res = await authedSupertest(app)
        .get(ghUrl(projectId, "/status"))
        .expect(200);

      expect(res.body.data.connected).toBe(false);
      expect(res.body.data.provider).toBe("github");
    });

    it("returns full status when connected", async () => {
      await seedGitHubConnection(projectId, {
        provider_resource_id: "12345",
        provider_resource_name: "octocat/hello-world",
      });

      const res = await authedSupertest(app)
        .get(ghUrl(projectId, "/status"))
        .expect(200);

      expect(res.body.data.connected).toBe(true);
      expect(res.body.data.user.id).toBe("octocat");
      expect(res.body.data.selectedSource.name).toBe("octocat/hello-world");
    });

    it("does not expose token in status response", async () => {
      await seedGitHubConnection(projectId);

      const res = await authedSupertest(app)
        .get(ghUrl(projectId, "/status"))
        .expect(200);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain("ghp_test-pat-token");
      expect(body).not.toContain("access_token");
    });
  });

  // ─── GET /repos ───

  describe("GET /repos", () => {
    it("returns 404 when not connected", async () => {
      const res = await authedSupertest(app)
        .get(ghUrl(projectId, "/repos"))
        .expect(404);

      expect(res.body.error.code).toBe("NOT_CONNECTED");
    });

    it("lists repos when connected", async () => {
      await seedGitHubConnection(projectId);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 1, full_name: "octocat/hello-world", open_issues_count: 5 },
          { id: 2, full_name: "octocat/spoon-knife", open_issues_count: 0 },
        ],
      });

      const res = await authedSupertest(app)
        .get(ghUrl(projectId, "/repos"))
        .expect(200);

      expect(res.body.data.repos).toHaveLength(2);
      expect(res.body.data.repos[0].name).toBe("octocat/hello-world");
      expect(res.body.data.repos[0].itemCount).toBe(5);
    });
  });

  // ─── PUT /repo ───

  describe("PUT /repo", () => {
    it("saves selected repo", async () => {
      await seedGitHubConnection(projectId);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 12345, full_name: "octocat/hello-world", has_issues: true }),
      });
      const res = await authedSupertest(app)
        .put(ghUrl(projectId, "/repo"))
        .send({ repoId: "12345", repoFullName: "octocat/hello-world" })
        .expect(200);

      expect(res.body.data.success).toBe(true);
      expect(res.body.data.selectedSource.name).toBe("octocat/hello-world");

      const conn = await integrationStore.getConnection(projectId, "github");
      expect(conn!.provider_resource_id).toBe("12345");
      expect(conn!.provider_resource_name).toBe("octocat/hello-world");
    });

    it("returns 404 when not connected", async () => {
      const res = await authedSupertest(app)
        .put(ghUrl(projectId, "/repo"))
        .send({ repoId: "12345", repoFullName: "octocat/hello-world" })
        .expect(404);

      expect(res.body.error.code).toBe("NOT_CONNECTED");
    });
  });

  // ─── POST /sync ───

  describe("POST /sync", () => {
    it("returns 404 when not connected", async () => {
      const res = await authedSupertest(app)
        .post(ghUrl(projectId, "/sync"))
        .expect(404);

      expect(res.body.error.code).toBe("NOT_CONNECTED");
    });

    it("returns 400 when no repo is selected", async () => {
      await seedGitHubConnection(projectId);

      const res = await authedSupertest(app)
        .post(ghUrl(projectId, "/sync"))
        .expect(400);

      expect(res.body.error.code).toBe("NO_REPO_SELECTED");
    });
  });

  describe("issue plan sync", () => {
    const issue = {
      id: 9001,
      number: 1,
      title: "Improve search",
      body: "Support labels.",
      user: { login: "octocat" },
      labels: [],
      created_at: "2025-01-01T00:00:00Z",
      html_url: "https://github.com/octocat/hello-world/issues/1",
    };

    async function seedSelectedRepo() {
      await seedGitHubConnection(projectId, {
        provider_resource_id: "12345",
        provider_resource_name: "octocat/hello-world",
      });
    }

    it("creates a planning plan and blocked epic, and preserves edits on repeated sync", async () => {
      await seedSelectedRepo();
      fetchMock.mockResolvedValue({ ok: true, json: async () => [issue] });
      const response = await authedSupertest(app).post(ghUrl(projectId, "/sync")).expect(200);
      expect(response.body.data).toEqual({ imported: 1, errors: 0 });
      const plan = await taskStore.planGet(projectId, "github-issue-9001");
      expect(plan?.content).toContain("# Improve search\n\nSupport labels.");
      expect(plan?.metadata.githubIssue).toEqual({
        id: "9001",
        number: 1,
        repository: "octocat/hello-world",
        url: issue.html_url,
      });
      const epic = await taskStore.show(projectId, plan!.metadata.epicId as string);
      expect(epic).toMatchObject({ issue_type: "epic", status: "blocked" });
      await taskStore.planUpdateContent(projectId, "github-issue-9001", "# Local plan edits");
      const connection = (await integrationStore.getConnection(projectId, "github"))!;
      await integrationStore.updateLastSync(connection.id, "2020-01-01T00:00:00Z", null);
      const repeat = await authedSupertest(app).post(ghUrl(projectId, "/sync")).expect(200);
      expect(repeat.body.data).toEqual({ imported: 0, errors: 0 });
      expect((await taskStore.planGet(projectId, "github-issue-9001"))?.content).toBe(
        "# Local plan edits"
      );
      const plans = await authedSupertest(app).get(`${BASE}/${projectId}/plans`).expect(200);
      expect(plans.body.data.plans[0].metadata.githubIssue).toEqual(plan?.metadata.githubIssue);
    });

    it("reports upstream failure instead of a successful zero import and keeps the connection active", async () => {
      await seedSelectedRepo();
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "upstream sensitive text",
      });
      const response = await authedSupertest(app).post(ghUrl(projectId, "/sync")).expect(502);
      expect(response.body.error.code).toBe("GITHUB_SYNC_FAILED");
      expect(JSON.stringify(response.body)).not.toContain("sensitive text");
      expect((await integrationStore.getConnection(projectId, "github"))?.status).toBe("active");
    });

    it("marks revoked tokens as needing reconnect", async () => {
      await seedSelectedRepo();
      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      await authedSupertest(app).post(ghUrl(projectId, "/sync")).expect(502);
      expect((await integrationStore.getConnection(projectId, "github"))?.status).toBe(
        "needs_reconnect"
      );
    });

    it("rejects mismatched repository identifiers before saving selection", async () => {
      await seedGitHubConnection(projectId);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 999, full_name: "octocat/hello-world" }),
      });
      await authedSupertest(app)
        .put(ghUrl(projectId, "/repo"))
        .send({ repoId: "12345", repoFullName: "octocat/hello-world" })
        .expect(400);
      expect(
        (await integrationStore.getConnection(projectId, "github"))?.provider_resource_id
      ).toBeNull();
    });

    it("keeps the selected repository when refreshing the same user's token", async () => {
      await seedSelectedRepo();
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ login: "octocat" }) });
      await authedSupertest(app)
        .post(ghUrl(projectId, "/connect"))
        .send({ token: "replacement-token" })
        .expect(200);
      expect(
        (await integrationStore.getConnection(projectId, "github"))?.provider_resource_name
      ).toBe("octocat/hello-world");
    });
  });

  // ─── DELETE / ───

  describe("DELETE /", () => {
    it("disconnects and deletes stored connection", async () => {
      await seedGitHubConnection(projectId);

      const res = await authedSupertest(app)
        .delete(ghUrl(projectId, ""))
        .expect(200);

      expect(res.body.data.disconnected).toBe(true);

      const conn = await integrationStore.getConnection(projectId, "github");
      expect(conn).toBeNull();
    });

    it("returns 404 when not connected", async () => {
      const res = await authedSupertest(app)
        .delete(ghUrl(projectId, ""))
        .expect(404);

      expect(res.body.error.code).toBe("NOT_CONNECTED");
    });
  });
});
