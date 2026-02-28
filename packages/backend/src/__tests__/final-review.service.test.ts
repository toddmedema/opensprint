import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FinalReviewService,
  type FinalReviewProposedTask,
} from "../services/final-review.service.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    planGetByEpicId: vi.fn(),
    listAll: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: vi.fn(),
  },
}));

vi.mock("../services/plan.service.js", () => ({
  PlanService: vi.fn().mockImplementation(() => ({
    getCodebaseContext: vi.fn().mockResolvedValue({
      fileTree: "src/\n  index.ts\n",
      keyFilesContent: "// key files",
    }),
  })),
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getSettings: vi.fn().mockResolvedValue({
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet" },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet" },
    }),
  })),
}));

vi.mock("../services/context-assembler.js", () => ({
  ContextAssembler: vi.fn().mockImplementation(() => ({
    collectDependencyOutputs: vi.fn().mockResolvedValue([
      { taskId: "os-abc.1", diff: "", summary: "Task 1 done" },
    ]),
    extractPrdExcerpt: vi.fn().mockResolvedValue("# PRD\n\nExcerpt"),
  })),
}));

describe("FinalReviewService", () => {
  let service: FinalReviewService;
  const projectId = "proj-1";
  const epicId = "os-abc";
  const repoPath = "/tmp/repo";

  beforeEach(async () => {
    vi.clearAllMocks();
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.planGetByEpicId).mockResolvedValue({
      plan_id: "test-plan",
      content: "# Plan\n\nFeature plan",
      metadata: {},
      shipped_content: null,
      updated_at: "",
    });
    vi.mocked(taskStore.listAll).mockResolvedValue([
      {
        id: epicId,
        title: "Epic",
        status: "open",
        issue_type: "epic",
        type: "epic",
      } as never,
      {
        id: `${epicId}.1`,
        title: "Task 1",
        status: "closed",
        issue_type: "task",
        type: "task",
        close_reason: "Done",
      } as never,
    ]);
    service = new FinalReviewService();
  });

  it("returns null when epic has no plan (deploy-fix epic)", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.planGetByEpicId).mockResolvedValue(null);

    const result = await service.runFinalReview(projectId, epicId, repoPath);

    expect(result).toBeNull();
  });

  it("returns pass when agent returns status pass", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify({
        status: "pass",
        assessment: "Implementation meets plan scope.",
        proposedTasks: [],
      }),
    });

    const result = await service.runFinalReview(projectId, epicId, repoPath);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("pass");
    expect(result!.proposedTasks).toEqual([]);
  });

  it("returns issues and proposed tasks when agent finds problems", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify({
        status: "issues",
        assessment: "Missing error handling.",
        proposedTasks: [
          { title: "Add error handling", description: "Handle edge cases", priority: 1 },
        ],
      }),
    });

    const result = await service.runFinalReview(projectId, epicId, repoPath);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("issues");
    expect(result!.proposedTasks).toHaveLength(1);
    expect(result!.proposedTasks[0]).toEqual({
      title: "Add error handling",
      description: "Handle edge cases",
      priority: 1,
    });
  });

  it("creates tasks from proposed tasks and links to epic", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({
      id: `${epicId}.2`,
      title: "New task",
      status: "open",
    } as never);

    const proposed: FinalReviewProposedTask[] = [
      { title: "Fix X", description: "Fix X", priority: 0 },
    ];
    const ids = await service.createTasksFromReview(projectId, epicId, proposed);

    expect(ids).toEqual([`${epicId}.2`]);
    expect(taskStore.create).toHaveBeenCalledWith(projectId, "Fix X", {
      type: "task",
      description: "Fix X",
      priority: 0,
      parentId: epicId,
    });
  });
});
