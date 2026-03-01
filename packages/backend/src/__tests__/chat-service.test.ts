import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ChatService } from "../services/chat.service.js";
import { ProjectService } from "../services/project.service.js";
import {
  DEFAULT_HIL_CONFIG,
  OPENSPRINT_PATHS,
  SPEC_MD,
  SPEC_METADATA_PATH,
  specMarkdownToPrd,
  prdToSpecMarkdown,
} from "@opensprint/shared";
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
      planGetByEpicId: vi.fn().mockResolvedValue(null),
      planListIds: vi.fn().mockResolvedValue([]),
      planUpdateContent: vi.fn(),
      planUpdateMetadata: vi.fn(),
      planSetShippedContent: vi.fn(),
      planGetShippedContent: vi.fn().mockResolvedValue(null),
      planDelete: vi.fn().mockResolvedValue(false),
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL,
    _postgresAvailable: !!dbResult,
  };
});

const mockInvokePlanningAgent = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    async invokePlanningAgent(opts: {
      tracking?: {
        id: string;
        projectId: string;
        phase: string;
        role: string;
        label: string;
        branchName?: string;
      };
      [key: string]: unknown;
    }) {
      const { tracking } = opts ?? {};
      if (tracking) {
        mockRegister(
          tracking.id,
          tracking.projectId,
          tracking.phase,
          tracking.role,
          tracking.label,
          new Date().toISOString(),
          tracking.branchName
        );
      }
      try {
        return await mockInvokePlanningAgent(opts);
      } finally {
        if (tracking) mockUnregister(tracking.id);
      }
    },
  },
}));

vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: {
    register: (...args: unknown[]) => mockRegister(...args),
    unregister: (...args: unknown[]) => mockUnregister(...args),
    list: vi.fn().mockReturnValue([]),
  },
}));

const mockHilEvaluate = vi.fn().mockResolvedValue({ approved: true });
vi.mock("../services/hil-service.js", () => ({
  hilService: {
    evaluateDecision: (...args: unknown[]) => mockHilEvaluate(...args),
  },
}));

const mockBroadcast = vi.fn();
vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcast(...args),
}));

describe("ChatService - Plan phase agent registry", () => {
  let chatService: ChatService;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let repoPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockHilEvaluate.mockResolvedValue({ approved: true });
    chatService = new ChatService();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-chat-service-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    repoPath = path.join(tempDir, "my-project");

    const project = await projectService.createProject({
      name: "Test Project",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;

    // Create SPEC.md so syncPrdFromPlanShip can build context
    const prd = {
      version: 1,
      sections: {
        executive_summary: {
          content: "Test app",
          version: 1,
          updatedAt: new Date().toISOString(),
        },
        problem_statement: { content: "", version: 0, updatedAt: new Date().toISOString() },
        user_personas: { content: "", version: 0, updatedAt: new Date().toISOString() },
        goals_and_metrics: { content: "", version: 0, updatedAt: new Date().toISOString() },
        feature_list: { content: "", version: 0, updatedAt: new Date().toISOString() },
        technical_architecture: { content: "", version: 0, updatedAt: new Date().toISOString() },
        data_model: { content: "", version: 0, updatedAt: new Date().toISOString() },
        api_contracts: { content: "", version: 0, updatedAt: new Date().toISOString() },
        non_functional_requirements: {
          content: "",
          version: 0,
          updatedAt: new Date().toISOString(),
        },
        open_questions: { content: "", version: 0, updatedAt: new Date().toISOString() },
      },
      changeLog: [],
    };
    await fs.writeFile(path.join(repoPath, SPEC_MD), prdToSpecMarkdown(prd as never), "utf-8");
    await fs.mkdir(path.join(repoPath, path.dirname(SPEC_METADATA_PATH)), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, SPEC_METADATA_PATH),
      JSON.stringify({ version: 1, changeLog: [] }, null, 2),
      "utf-8"
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("syncPrdFromPlanShip", () => {
    it("should register and unregister Ship-it PRD update agent", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: "No updates needed. The PRD is already aligned.",
      });

      await chatService.syncPrdFromPlanShip(
        projectId,
        "auth-plan",
        "# Auth Plan\n\n## Overview\n\nAuth feature."
      );

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^harmonizer-build-it-.*auth-plan.*-/),
        projectId,
        "plan",
        "harmonizer",
        "Syncing PRD with Plan Execution",
        expect.any(String),
        undefined
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });

    it("should do nothing when agent returns no_changes_needed", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: '{"status":"no_changes_needed"}',
      });

      const specPath = path.join(repoPath, SPEC_MD);
      const specBefore = await fs.readFile(specPath, "utf-8");
      const prdBefore = specMarkdownToPrd(specBefore);

      await chatService.syncPrdFromPlanShip(projectId, "auth-plan", "# Auth Plan\n\nContent.");

      const specAfter = await fs.readFile(specPath, "utf-8");
      const prdAfter = specMarkdownToPrd(specAfter);
      expect(prdAfter).toEqual(prdBefore);
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it("should unregister even when agent invocation throws", async () => {
      mockInvokePlanningAgent.mockRejectedValue(new Error("Agent unavailable"));

      await expect(
        chatService.syncPrdFromPlanShip(projectId, "auth-plan", "# Auth Plan\n\nContent.")
      ).rejects.toThrow("Agent unavailable");

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });
  });

  describe("syncPrdFromScopeChangeFeedback", () => {
    it("should invoke planning agent with scope-change feedback in prompt", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: "No updates needed. The PRD already reflects this scope.",
      });

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Add mobile app support");

      expect(mockInvokePlanningAgent).toHaveBeenCalledTimes(1);
      const call = mockInvokePlanningAgent.mock.calls[0][0];
      expect(call.messages[0].content).toContain("Add mobile app support");
      expect(call.messages[0].content).toContain("## Feedback");
      expect(call.systemPrompt).toContain("scope-change");
      expect(call.systemPrompt).toContain("propose section updates");
    });

    it("should do nothing when agent returns no PRD_UPDATE blocks", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: "No updates needed. The PRD already reflects this scope.",
      });

      const specPath = path.join(repoPath, SPEC_MD);
      const specBefore = await fs.readFile(specPath, "utf-8");
      const prdBefore = specMarkdownToPrd(specBefore);

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Minor feedback");

      const specAfter = await fs.readFile(specPath, "utf-8");
      const prdAfter = specMarkdownToPrd(specAfter);
      expect(prdAfter.sections).toEqual(prdBefore.sections);
    });

    it("should do nothing when agent returns no_changes_needed JSON", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: '{"status":"no_changes_needed"}',
      });

      const specPath = path.join(repoPath, SPEC_MD);
      const specBefore = await fs.readFile(specPath, "utf-8");
      const prdBefore = specMarkdownToPrd(specBefore);

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Minor feedback");

      const specAfter = await fs.readFile(specPath, "utf-8");
      const prdAfter = specMarkdownToPrd(specAfter);
      expect(prdAfter.sections).toEqual(prdBefore.sections);
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it("should apply PRD updates and broadcast when agent returns non-architecture updates", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: JSON.stringify({
          status: "success",
          prd_updates: [
            {
              section: "feature_list",
              action: "update",
              content: "Updated feature list with mobile support.",
            },
          ],
        }),
      });

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Add mobile app");

      const specPath = path.join(repoPath, SPEC_MD);
      const specRaw = await fs.readFile(specPath, "utf-8");
      const prd = specMarkdownToPrd(specRaw);
      expect(prd.sections.feature_list?.content).toContain(
        "Updated feature list with mobile support"
      );
      expect(mockBroadcast).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({ type: "prd.updated", section: "feature_list" })
      );
    });

    it("should evaluate HIL for architecture sections when scope feedback includes them", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: JSON.stringify({
          status: "success",
          prd_updates: [
            {
              section: "technical_architecture",
              action: "update",
              content: "New mobile architecture.",
            },
          ],
        }),
      });

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Add mobile architecture");

      expect(mockHilEvaluate).toHaveBeenCalledWith(
        projectId,
        "architectureDecisions",
        expect.stringContaining("affect architectural sections"),
        expect.any(Array),
        true,
        undefined,
        "prd",
        "architecture"
      );
      const hilDesc = mockHilEvaluate.mock.calls[0][2];
      expect(hilDesc).toContain("Technical Architecture");
      expect(hilDesc).toContain("Scope change feedback");
    });
  });
});
