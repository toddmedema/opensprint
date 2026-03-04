import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../middleware/error-handler.js";
import { PrdFromCodebaseService } from "../services/prd-from-codebase.service.js";

type PrdFromCodebaseServiceTestDouble = PrdFromCodebaseService & {
  planService: {
    getCodebaseContext: ReturnType<typeof vi.fn>;
  };
  projectService: {
    getSettings: ReturnType<typeof vi.fn>;
    getRepoPath: ReturnType<typeof vi.fn>;
  };
  chatService: {
    parsePrdUpdatesFromContent: ReturnType<typeof vi.fn>;
    addSketchAssistantMessage?: ReturnType<typeof vi.fn>;
  };
  prdService: {
    updateSections: ReturnType<typeof vi.fn>;
  };
};

const mockInvokePlanningAgent = vi.fn();
const mockBroadcastToProject = vi.fn();

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (...args: unknown[]) => mockInvokePlanningAgent(...args),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
}));

describe("PrdFromCodebaseService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates PRD sections and broadcasts each change", async () => {
    const service = new PrdFromCodebaseService() as unknown as PrdFromCodebaseServiceTestDouble;
    service.planService = {
      getCodebaseContext: vi.fn().mockResolvedValue({
        fileTree: "src/index.ts",
        keyFilesContent: "console.log('hi')",
      }),
    };
    service.projectService = {
      getSettings: vi.fn().mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        hilConfig: { scopeChanges: "automated", architectureDecisions: "automated", dependencyModifications: "automated" },
      }),
      getRepoPath: vi.fn().mockResolvedValue("/repo"),
    };
    service.chatService = {
      parsePrdUpdatesFromContent: vi.fn().mockReturnValue([
        { section: "executive_summary", content: "Summary" },
        { section: "feature_list", content: "Features" },
      ]),
      addSketchAssistantMessage: vi.fn().mockResolvedValue(undefined),
    };
    service.prdService = {
      updateSections: vi.fn().mockResolvedValue([
        { section: "executive_summary", newVersion: 2 },
        { section: "feature_list", newVersion: 3 },
      ]),
    };
    mockInvokePlanningAgent.mockResolvedValue({
      content: "[PRD_UPDATE:executive_summary]\nSummary\n[/PRD_UPDATE]",
    });

    await service.generatePrdFromCodebase("proj-1");

    expect(mockInvokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        cwd: "/repo",
      })
    );
    expect(mockBroadcastToProject).toHaveBeenCalledTimes(2);
    expect(service.chatService.addSketchAssistantMessage).toHaveBeenCalled();
  });

  it("throws a user-facing error when the agent returns no PRD sections", async () => {
    const service = new PrdFromCodebaseService() as unknown as PrdFromCodebaseServiceTestDouble;
    service.planService = {
      getCodebaseContext: vi.fn().mockResolvedValue({ fileTree: "", keyFilesContent: "" }),
    };
    service.projectService = {
      getSettings: vi.fn().mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        hilConfig: { scopeChanges: "automated", architectureDecisions: "automated", dependencyModifications: "automated" },
      }),
      getRepoPath: vi.fn().mockResolvedValue("/repo"),
    };
    service.chatService = {
      parsePrdUpdatesFromContent: vi.fn().mockReturnValue([]),
    };
    mockInvokePlanningAgent.mockResolvedValue({ content: "No sections" });

    await expect(service.generatePrdFromCodebase("proj-1")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("wraps planning-agent failures as AGENT_INVOKE_FAILED", async () => {
    const service = new PrdFromCodebaseService() as unknown as PrdFromCodebaseServiceTestDouble;
    service.planService = {
      getCodebaseContext: vi.fn().mockResolvedValue({ fileTree: "", keyFilesContent: "" }),
    };
    service.projectService = {
      getSettings: vi.fn().mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        hilConfig: { scopeChanges: "automated", architectureDecisions: "automated", dependencyModifications: "automated" },
      }),
      getRepoPath: vi.fn().mockResolvedValue("/repo"),
    };
    mockInvokePlanningAgent.mockRejectedValue(new Error("rate limit"));

    await expect(service.generatePrdFromCodebase("proj-1")).rejects.toMatchObject({
      code: "AGENT_INVOKE_FAILED",
    });
  });

  it("preserves structured agent failure details when wrapping the PRD-from-codebase context", async () => {
    const service = new PrdFromCodebaseService() as unknown as PrdFromCodebaseServiceTestDouble;
    service.planService = {
      getCodebaseContext: vi.fn().mockResolvedValue({ fileTree: "", keyFilesContent: "" }),
    };
    service.projectService = {
      getSettings: vi.fn().mockResolvedValue({
        simpleComplexityAgent: { type: "google", model: "gemini-2.5-pro", cliCommand: null },
        complexComplexityAgent: { type: "google", model: "gemini-2.5-pro", cliCommand: null },
        hilConfig: {
          scopeChanges: "automated",
          architectureDecisions: "automated",
          dependencyModifications: "automated",
        },
      }),
      getRepoPath: vi.fn().mockResolvedValue("/repo"),
    };
    mockInvokePlanningAgent.mockRejectedValue(
      new AppError(502, "AGENT_INVOKE_FAILED", "Google Gemini hit a rate limit.", {
        kind: "rate_limit",
        agentType: "google",
        raw: "RESOURCE_EXHAUSTED",
        userMessage: "Google Gemini hit a rate limit.",
        notificationMessage: "Google Gemini hit a rate limit.",
        isLimitError: true,
      })
    );

    await expect(service.generatePrdFromCodebase("proj-1")).rejects.toMatchObject({
      message: "The planning agent could not generate a PRD from the codebase. Google Gemini hit a rate limit.",
      details: expect.objectContaining({
        kind: "rate_limit",
        notificationMessage: "Google Gemini hit a rate limit.",
      }),
    });
  });
});
