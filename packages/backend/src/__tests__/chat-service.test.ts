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

vi.mock("../services/hil-service.js", () => ({
  hilService: {
    evaluateDecision: vi.fn().mockResolvedValue({ approved: true }),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
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
        expect.stringMatching(/^plan-ship-prd-.*auth-plan.*-/),
        projectId,
        "plan",
        "Ship-it PRD update",
        expect.any(String),
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
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
});
