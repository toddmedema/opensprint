import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, OPENSPRINT_PATHS } from "@opensprint/shared";

// Mock TaskStoreService so tests don't require bd CLI or shell
vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const sharedDb = new SQL.Database();
  sharedDb.run(actual.SCHEMA_SQL);

  class MockTaskStoreService extends actual.TaskStoreService {
    async init(): Promise<void> {
      (this as unknown as { db: unknown }).db = sharedDb;
      (this as unknown as { injectedDb: unknown }).injectedDb = sharedDb;
    }
    protected ensureDb() {
      if (!(this as unknown as { db: unknown }).db) {
        (this as unknown as { db: unknown }).db = sharedDb;
        (this as unknown as { injectedDb: unknown }).injectedDb = sharedDb;
      }
      return super.ensureDb();
    }
  }

  const singletonInstance = new MockTaskStoreService();
  await singletonInstance.init();

  return {
    ...actual,
    TaskStoreService: MockTaskStoreService,
    taskStore: singletonInstance,
    _resetSharedDb: () => {
      sharedDb.run("DELETE FROM task_dependencies");
      sharedDb.run("DELETE FROM tasks");
    },
  };
});

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

const mockInvokePlanningAgent = vi.fn();
vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (...args: unknown[]) => mockInvokePlanningAgent(...args),
  },
}));

describe("PRD REST API", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-prd-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const project = await projectService.createProject({
      name: "Test Project",
      repoPath: path.join(tempDir, "my-project"),
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore ENOTEMPTY and similar on some systems when removing .git
    }
  });

  it("GET /projects/:id/prd should return full PRD", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.version).toBeDefined();
    expect(res.body.data.sections).toBeDefined();
    expect(res.body.data.sections.executive_summary).toBeDefined();
    expect(res.body.data.sections.problem_statement).toBeDefined();
    expect(res.body.data.changeLog).toEqual([]);
  });

  it("GET /projects/:id/prd should return 404 when project not found", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/nonexistent-id/prd`);

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("GET /projects/:id/prd/history should return empty change log when no changes", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/history`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("GET /projects/:id/prd/history should return change log after updates", async () => {
    await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/prd/executive_summary`)
      .send({ content: "Updated summary" });

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/history`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].section).toBe("executive_summary");
    expect(res.body.data[0].version).toBe(1);
    expect(res.body.data[0].source).toBe("sketch");
    expect(res.body.data[0].timestamp).toBeDefined();
    expect(res.body.data[0].diff).toBeDefined();
  });

  it("GET /projects/:id/prd/:section should return specific section", async () => {
    const prdPath = path.join(tempDir, "my-project", OPENSPRINT_PATHS.prd);
    const prd = JSON.parse(await fs.readFile(prdPath, "utf-8"));
    prd.sections.executive_summary = {
      content: "Our product solves X",
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(prdPath, JSON.stringify(prd));

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/executive_summary`);

    expect(res.status).toBe(200);
    expect(res.body.data.content).toBe("Our product solves X");
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.updatedAt).toBeDefined();
  });

  it("GET /projects/:id/prd/:section should return 404 when project not found", async () => {
    const res = await request(app).get(
      `${API_PREFIX}/projects/nonexistent-id/prd/executive_summary`
    );

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("GET /projects/:id/prd/:section should return 400 for invalid section key", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/invalid_section`);

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_SECTION");
  });

  it("PUT /projects/:id/prd/:section should update section and return version info", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/prd/executive_summary`)
      .send({ content: "New executive summary content" });

    expect(res.status).toBe(200);
    expect(res.body.data.section.content).toBe("New executive summary content");
    expect(res.body.data.section.version).toBe(1);
    expect(res.body.data.previousVersion).toBe(0);
    expect(res.body.data.newVersion).toBe(1);

    const getRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/prd/executive_summary`
    );
    expect(getRes.body.data.content).toBe("New executive summary content");
  });

  it("PUT /projects/:id/prd/:section should accept source parameter", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/prd/problem_statement`)
      .send({ content: "Users face challenges", source: "plan" });

    expect(res.status).toBe(200);
    expect(res.body.data.newVersion).toBe(1);

    const historyRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/history`);
    expect(historyRes.body.data[0].source).toBe("plan");
  });

  it("PUT /projects/:id/prd/:section should return 404 when project not found", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/nonexistent-id/prd/executive_summary`)
      .send({ content: "Some content" });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("PUT /projects/:id/prd/:section should return 400 for invalid section key", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/prd/invalid_section`)
      .send({ content: "Some content" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_SECTION");
  });

  it("PUT /projects/:id/prd/:section should return 400 when content is missing", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/prd/executive_summary`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
  });

  it("PUT /projects/:id/prd/:section should allow empty string content", async () => {
    const res = await request(app)
      .put(`${API_PREFIX}/projects/${projectId}/prd/executive_summary`)
      .send({ content: "" });

    expect(res.status).toBe(200);
    expect(res.body.data.section.content).toBe("");
  });

  it("POST /projects/:id/prd/upload should extract text from .md file for empty-state onboarding", async () => {
    const mdContent = "# My Product PRD\n\n## Overview\n\nA task management app.";
    const buffer = Buffer.from(mdContent, "utf-8");

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/prd/upload`)
      .attach("file", buffer, "spec.md");

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.text).toBe(mdContent);
    expect(res.body.data.filename).toBe("spec.md");
  });

  it("POST /projects/:id/prd/upload should return 400 when no file provided", async () => {
    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/prd/upload`);

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toContain("No file");
  });

  it("POST /projects/:id/prd/upload should return 400 for unsupported file type", async () => {
    const buffer = Buffer.from("content", "utf-8");

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/prd/upload`)
      .attach("file", buffer, "document.txt");

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toContain("Unsupported");
  });

  describe("POST /projects/:id/prd/generate-from-codebase", () => {
    beforeEach(() => {
      mockInvokePlanningAgent.mockReset();
    });

    it("returns 204 and updates PRD when agent returns PRD_UPDATE blocks", async () => {
      const repoPath = path.join(tempDir, "my-project");
      await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
      await fs.writeFile(path.join(repoPath, "src", "index.ts"), "export function main() {}");

      const prdUpdateContent = "This app is a small TypeScript module.";
      mockInvokePlanningAgent.mockResolvedValue({
        content: `[PRD_UPDATE:executive_summary]\n${prdUpdateContent}\n[/PRD_UPDATE]`,
      });

      const res = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/prd/generate-from-codebase`
      );

      expect(res.status).toBe(204);
      expect(mockInvokePlanningAgent).toHaveBeenCalled();

      const prdRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd`);
      expect(prdRes.status).toBe(200);
      expect(prdRes.body.data.sections.executive_summary?.content).toBe(prdUpdateContent);
    });

    it("returns 400 when agent returns no PRD_UPDATE blocks", async () => {
      const repoPath = path.join(tempDir, "my-project");
      await fs.writeFile(path.join(repoPath, "main.py"), "print('hi')");

      mockInvokePlanningAgent.mockResolvedValue({ content: "I could not infer a PRD." });

      const res = await request(app).post(
        `${API_PREFIX}/projects/${projectId}/prd/generate-from-codebase`
      );

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_INPUT");
    });
  });
});
