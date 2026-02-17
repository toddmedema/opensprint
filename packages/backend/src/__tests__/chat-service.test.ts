import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ChatService } from "../services/chat.service.js";
import { ProjectService } from "../services/project.service.js";
import { DEFAULT_HIL_CONFIG, OPENSPRINT_PATHS } from "@opensprint/shared";

const mockInvokePlanningAgent = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (...args: unknown[]) => mockInvokePlanningAgent(...args),
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
      description: "A test project",
      repoPath,
      planningAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;

    // Create PRD so syncPrdFromPlanShip can build context
    const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.writeFile(
      prdPath,
      JSON.stringify({
        version: 1,
        sections: {
          executive_summary: { content: "Test app", version: 1, updated_at: new Date().toISOString() },
        },
      }),
      "utf-8",
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

      await chatService.syncPrdFromPlanShip(projectId, "auth-plan", "# Auth Plan\n\n## Overview\n\nAuth feature.");

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^harmonizer-build-it-.*auth-plan.*-/),
        projectId,
        "plan",
        "harmonizer",
        "Execute! PRD sync",
        expect.any(String),
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });

    it("should do nothing when agent returns no_changes_needed", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: '{"status":"no_changes_needed"}',
      });

      const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
      const prdBefore = JSON.parse(await fs.readFile(prdPath, "utf-8"));

      await chatService.syncPrdFromPlanShip(projectId, "auth-plan", "# Auth Plan\n\nContent.");

      const prdAfter = JSON.parse(await fs.readFile(prdPath, "utf-8"));
      expect(prdAfter).toEqual(prdBefore);
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it("should unregister even when agent invocation throws", async () => {
      mockInvokePlanningAgent.mockRejectedValue(new Error("Agent unavailable"));

      await expect(
        chatService.syncPrdFromPlanShip(projectId, "auth-plan", "# Auth Plan\n\nContent."),
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
      expect(call.systemPrompt).toContain("scope change");
      expect(call.systemPrompt).toContain("approved for PRD updates");
    });

    it("should do nothing when agent returns no PRD_UPDATE blocks", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: "No updates needed. The PRD already reflects this scope.",
      });

      const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
      const prdBefore = JSON.parse(await fs.readFile(prdPath, "utf-8"));

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Minor feedback");

      const prdAfter = JSON.parse(await fs.readFile(prdPath, "utf-8"));
      expect(prdAfter).toEqual(prdBefore);
    });

    it("should do nothing when agent returns no_changes_needed JSON", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: '{"status":"no_changes_needed"}',
      });

      const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
      const prdBefore = JSON.parse(await fs.readFile(prdPath, "utf-8"));

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Minor feedback");

      const prdAfter = JSON.parse(await fs.readFile(prdPath, "utf-8"));
      expect(prdAfter).toEqual(prdBefore);
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it("should apply PRD updates and broadcast when agent returns non-architecture updates", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: `[PRD_UPDATE:feature_list]
Updated feature list with mobile support.
[/PRD_UPDATE]`,
      });

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Add mobile app");

      const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
      const prd = JSON.parse(await fs.readFile(prdPath, "utf-8"));
      expect(prd.sections.feature_list.content).toContain("Updated feature list with mobile support");
      expect(mockBroadcast).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({ type: "prd.updated", section: "feature_list" }),
      );
    });

    it("should evaluate HIL for architecture sections when scope feedback includes them", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: `[PRD_UPDATE:technical_architecture]
New mobile architecture.
[/PRD_UPDATE]`,
      });

      await chatService.syncPrdFromScopeChangeFeedback(projectId, "Add mobile architecture");

      expect(mockHilEvaluate).toHaveBeenCalledWith(
        projectId,
        "architectureDecisions",
        expect.stringContaining("Scope change feedback"),
        expect.any(Array),
        true,
      );
    });
  });
});
