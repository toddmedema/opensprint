import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  ContextAssembler,
  buildAutonomyDescription,
} from "../services/context-assembler.js";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { ensureRuntimeDir, getRuntimePath } from "../utils/runtime-dir.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn(),
    listAll: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    show: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "os-mock" }),
    update: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    deleteByProjectId: vi.fn(),
    ready: vi.fn().mockResolvedValue([]),
    setOnTaskChange: vi.fn(),
    closePool: vi.fn(),
  },
  TaskStoreService: vi.fn(),
}));

describe("buildAutonomyDescription", () => {
  it("returns confirm_all rule when aiAutonomyLevel is confirm_all", () => {
    const desc = buildAutonomyDescription("confirm_all", undefined);
    expect(desc).toContain("Confirm all scope changes");
    expect(desc).toContain("open_questions");
  });

  it("returns major_only rule when aiAutonomyLevel is major_only", () => {
    const desc = buildAutonomyDescription("major_only", undefined);
    expect(desc).toContain("Major scope changes only");
    expect(desc).toContain("scope or architecture");
  });

  it("returns full autonomy rule when aiAutonomyLevel is full", () => {
    const desc = buildAutonomyDescription("full", undefined);
    expect(desc).toContain("Full autonomy");
    expect(desc).toContain("genuinely blocked");
  });

  it("falls back to hilConfig when aiAutonomyLevel is absent", () => {
    const desc = buildAutonomyDescription(undefined, {
      scopeChanges: "automated",
      architectureDecisions: "automated",
      dependencyModifications: "automated",
    });
    expect(desc).toContain("Full autonomy");
  });
});

describe("ContextAssembler", () => {
  let assembler: ContextAssembler;
  let repoPath: string;

  beforeEach(async () => {
    assembler = new ContextAssembler();
    repoPath = path.join(os.tmpdir(), `opensprint-context-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should assemble task directory with PRD excerpt, plan, and deps", async () => {
    // Setup PRD
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({
        sections: {
          executive_summary: { content: "## Summary\n\nTest product." },
        },
      })
    );

    // Setup plan
    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planContent = `# Feature: Auth

## Overview
User authentication.

## Acceptance Criteria

- User can log in with email/password
- JWT tokens are issued on success

## Technical Approach

- Use bcrypt for password hashing
- JWT for session tokens
`;
    await fs.writeFile(path.join(plansDir, "auth.md"), planContent);

    const config = {
      invocation_id: "bd-a3f8.1",
      agent_role: "coder" as const,
      taskId: "bd-a3f8.1",
      repoPath,
      branch: "opensprint/bd-a3f8.1",
      testCommand: "npm test",
      attempt: 1,
      phase: "coding" as const,
      previousFailure: null as string | null,
      reviewFeedback: null as string | null,
    };

    const taskDir = await assembler.assembleTaskDirectory(repoPath, config.taskId, config, {
      taskId: config.taskId,
      title: "Implement login endpoint",
      description: "Add POST /auth/login",
      planContent,
      prdExcerpt: "# Product Requirements\n\nTest product.",
      dependencyOutputs: [{ taskId: "bd-a3f8.0", diff: "diff content", summary: "Gate closed" }],
    });

    expect(taskDir).toContain(".opensprint/active/bd-a3f8.1");

    const contextDir = path.join(taskDir, "context");
    const depsDir = path.join(contextDir, "deps");

    const configJson = JSON.parse(await fs.readFile(path.join(taskDir, "config.json"), "utf-8"));
    expect(configJson.invocation_id).toBe("bd-a3f8.1");
    expect(configJson.agent_role).toBe("coder");
    expect(configJson.taskId).toBe("bd-a3f8.1");
    expect(configJson.phase).toBe("coding");

    const prdExcerpt = await fs.readFile(path.join(contextDir, "prd_excerpt.md"), "utf-8");
    expect(prdExcerpt).toContain("Test product.");

    const planMd = await fs.readFile(path.join(contextDir, "plan.md"), "utf-8");
    expect(planMd).toContain("User authentication");

    const depDiff = await fs.readFile(path.join(depsDir, "bd-a3f8.0.diff"), "utf-8");
    expect(depDiff).toBe("diff content");

    const depSummary = await fs.readFile(path.join(depsDir, "bd-a3f8.0.summary.md"), "utf-8");
    expect(depSummary).toBe("Gate closed");

    const prompt = await fs.readFile(path.join(taskDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("# Task: Implement login endpoint");
    expect(prompt).toContain("## Acceptance Criteria");
    expect(prompt).toContain("User can log in with email/password");
    expect(prompt).toContain("## Technical Approach");
    expect(prompt).toContain("Use bcrypt for password hashing");
    expect(prompt).toContain("context/plan.md");
    expect(prompt).toContain("context/prd_excerpt.md");
    expect(prompt).toContain("context/deps/");
    expect(prompt).toContain("Commit after each logical unit");
    expect(prompt).toContain("Do not wait until the end to commit");
    // Terminology: use "done" and "finish" instead of "complete" (feedback consistency)
    expect(prompt).toContain("when the task is done");
    expect(prompt).toContain("could not finish it");
    expect(prompt).not.toContain("when the task is complete");
  });

  it("should include Review Feedback section in coding prompt when reviewFeedback is provided", async () => {
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({
        sections: {
          executive_summary: { content: "## Summary\n\nTest product." },
        },
      })
    );

    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planContent = `# Feature: Auth

## Overview
User authentication.

## Acceptance Criteria

- User can log in with email/password

## Technical Approach

- Use bcrypt for password hashing
`;
    await fs.writeFile(path.join(plansDir, "auth.md"), planContent);

    const config = {
      invocation_id: "bd-a3f8.1",
      agent_role: "coder" as const,
      taskId: "bd-a3f8.1",
      repoPath,
      branch: "opensprint/bd-a3f8.1",
      testCommand: "npm test",
      attempt: 2,
      phase: "coding" as const,
      previousFailure: null as string | null,
      reviewFeedback: "Tests do not cover edge cases.\nMissing error handling for invalid input.",
    };

    const taskDir = await assembler.assembleTaskDirectory(repoPath, config.taskId, config, {
      taskId: config.taskId,
      title: "Implement login endpoint",
      description: "Add POST /auth/login",
      planContent,
      prdExcerpt: "# Product Requirements\n\nTest product.",
      dependencyOutputs: [],
    });

    const prompt = await fs.readFile(path.join(taskDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("## Review Feedback");
    expect(prompt).toContain("The review agent rejected the previous implementation:");
    expect(prompt).toContain("Tests do not cover edge cases.");
    expect(prompt).toContain("Missing error handling for invalid input.");
  });

  it("should extract PRD excerpt when prd.json exists", async () => {
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({
        sections: {
          problem_statement: { content: "Users face fragmentation." },
        },
      })
    );

    const excerpt = await assembler.extractPrdExcerpt(repoPath);
    expect(excerpt).toContain("Product Requirements");
    expect(excerpt).toContain("Users face fragmentation.");
  });

  it("should return fallback when PRD missing", async () => {
    const excerpt = await assembler.extractPrdExcerpt(repoPath);
    expect(excerpt).toContain("No PRD available");
  });

  it("should getPlanContent return plan content from task store", async () => {
    const projectId = "test-project";
    const mockTaskStore = {
      planGet: async (_projectId: string, planId: string) =>
        planId === "auth"
          ? {
              content: "# Auth Plan\n\nLogin flow.",
              metadata: {},
              shipped_content: null,
              updated_at: new Date().toISOString(),
            }
          : null,
    };
    const content = await assembler.getPlanContent(
      projectId,
      "auth",
      mockTaskStore as Parameters<ContextAssembler["getPlanContent"]>[2]
    );
    expect(content).toContain("Auth Plan");
    expect(content).toContain("Login flow.");
  });

  it("should getPlanContentForTask return plan content when parent epic has plan in store", async () => {
    const projectId = "test-project";
    const mockTaskStore = {
      getParentId: (taskId: string) => {
        const lastDot = taskId.lastIndexOf(".");
        if (lastDot <= 0) return null;
        return taskId.slice(0, lastDot);
      },
      planGetByEpicId: async (_projectId: string, epicId: string) =>
        epicId === "bd-a3f8"
          ? {
              plan_id: "auth",
              content: "# Auth Plan\n\nLogin flow.",
              metadata: {},
              shipped_content: null,
              updated_at: new Date().toISOString(),
            }
          : null,
    };

    const task = { id: "bd-a3f8.1", title: "Implement login", description: "" };
    const content = await assembler.getPlanContentForTask(
      projectId,
      repoPath,
      task as Parameters<ContextAssembler["getPlanContentForTask"]>[2],
      mockTaskStore as Parameters<ContextAssembler["getPlanContentForTask"]>[3]
    );
    expect(content).toContain("Auth Plan");
    expect(content).toContain("Login flow.");
  });

  it("should getPlanContentForTask return empty string when task has no parent", async () => {
    const projectId = "test-project";
    const mockTaskStore = { getParentId: () => null };

    const task = { id: "bd-a3f8", title: "Epic", description: "" };
    const content = await assembler.getPlanContentForTask(
      projectId,
      repoPath,
      task as Parameters<ContextAssembler["getPlanContentForTask"]>[2],
      mockTaskStore as Parameters<ContextAssembler["getPlanContentForTask"]>[3]
    );
    expect(content).toBe("");
  });

  it("should getPlanContentForTask return empty string when parent epic has no plan in store", async () => {
    const projectId = "test-project";
    const mockTaskStore = {
      getParentId: (taskId: string) => {
        const lastDot = taskId.lastIndexOf(".");
        if (lastDot <= 0) return null;
        return taskId.slice(0, lastDot);
      },
      planGetByEpicId: async () => null,
    };

    const task = { id: "bd-a3f8.1", title: "Implement login", description: "" };
    const content = await assembler.getPlanContentForTask(
      projectId,
      repoPath,
      task as Parameters<ContextAssembler["getPlanContentForTask"]>[2],
      mockTaskStore as Parameters<ContextAssembler["getPlanContentForTask"]>[3]
    );
    expect(content).toBe("");
  });

  it("should getPlanContentForTask return empty string when parent epic has no plan", async () => {
    const projectId = "test-project";
    const mockTaskStore = {
      getParentId: () => "bd-nonexistent",
      planGetByEpicId: async () => null,
    };

    const task = { id: "bd-a3f8.1", title: "Implement login", description: "" };
    const content = await assembler.getPlanContentForTask(
      projectId,
      repoPath,
      task as Parameters<ContextAssembler["getPlanContentForTask"]>[2],
      mockTaskStore as Parameters<ContextAssembler["getPlanContentForTask"]>[3]
    );
    expect(content).toBe("");
  });

  it("should collect dependency outputs from approved sessions", async () => {
    await ensureRuntimeDir(repoPath);
    const sessionsDir = getRuntimePath(repoPath, OPENSPRINT_PATHS.sessions);
    await fs.mkdir(path.join(sessionsDir, "bd-a3f8.1-1"), { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "bd-a3f8.1-1", "session.json"),
      JSON.stringify({
        status: "approved",
        gitDiff: "diff from task 1",
        summary: "Implemented login endpoint",
      })
    );

    const outputs = await assembler.collectDependencyOutputs(repoPath, ["bd-a3f8.1"]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].taskId).toBe("bd-a3f8.1");
    expect(outputs[0].diff).toBe("diff from task 1");
    expect(outputs[0].summary).toBe("Implemented login endpoint");
  });

  it("should skip non-approved sessions", async () => {
    await ensureRuntimeDir(repoPath);
    const sessionsDir = getRuntimePath(repoPath, OPENSPRINT_PATHS.sessions);
    await fs.mkdir(path.join(sessionsDir, "bd-a3f8.1-1"), { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "bd-a3f8.1-1", "session.json"),
      JSON.stringify({ status: "failed", gitDiff: "", summary: "" })
    );

    const outputs = await assembler.collectDependencyOutputs(repoPath, ["bd-a3f8.1"]);
    expect(outputs).toHaveLength(0);
  });

  it("should buildContext given taskId: Plan from epic, PRD sections, dependency diffs", async () => {
    const projectId = "test-project";
    // Setup PRD
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({
        sections: {
          executive_summary: { content: "## Summary\n\nTest product." },
        },
      })
    );

    const planContent = "# Auth Plan\n\nUser authentication.";

    // Setup dependency session (branch merged, so we use archived session)
    await ensureRuntimeDir(repoPath);
    const sessionsDir = getRuntimePath(repoPath, OPENSPRINT_PATHS.sessions);
    await fs.mkdir(path.join(sessionsDir, "bd-a3f8.1-1"), { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "bd-a3f8.1-1", "session.json"),
      JSON.stringify({
        status: "approved",
        gitDiff: "diff from dep task",
        summary: "Implemented login endpoint",
      })
    );

    const mockTasks = {
      show: async (_projectId: string, id: string) => {
        if (id === "bd-a3f8.2") {
          return {
            id: "bd-a3f8.2",
            title: "Implement JWT validation",
            description: "Add JWT validation middleware",
            dependencies: [{ type: "blocks", depends_on_id: "bd-a3f8.1" }],
          };
        }
        if (id === "bd-a3f8") {
          return { id: "bd-a3f8", description: "auth" };
        }
        throw new Error(`Unknown id: ${id}`);
      },
      getParentId: (taskId: string) => {
        const lastDot = taskId.lastIndexOf(".");
        if (lastDot <= 0) return null;
        return taskId.slice(0, lastDot);
      },
      getBlockers: async () => ["bd-a3f8.1"],
      planGetByEpicId: async (_projectId: string, epicId: string) =>
        epicId === "bd-a3f8"
          ? {
              plan_id: "auth",
              content: planContent,
              metadata: {},
              shipped_content: null,
              updated_at: new Date().toISOString(),
            }
          : null,
    };

    const mockBranchManager = {
      getDiff: async () => {
        throw new Error("Branch merged"); // Simulate branch no longer exists
      },
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const context = await assembler.buildContext(
      projectId,
      repoPath,
      "bd-a3f8.2",
      mockTasks as any,
      mockBranchManager as any
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */

    expect(context.taskId).toBe("bd-a3f8.2");
    expect(context.title).toBe("Implement JWT validation");
    expect(context.description).toBe("Add JWT validation middleware");
    expect(context.planContent).toContain("Auth Plan");
    expect(context.planContent).toContain("User authentication");
    expect(context.prdExcerpt).toContain("Test product.");
    expect(context.dependencyOutputs).toHaveLength(1);
    expect(context.dependencyOutputs[0].taskId).toBe("bd-a3f8.1");
    expect(context.dependencyOutputs[0].diff).toBe("diff from dep task");
    expect(context.dependencyOutputs[0].summary).toBe("Implemented login endpoint");
  });

  it("should generate review prompt per PRD §12.3 when phase is review", async () => {
    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planContent = `# Feature: Auth

## Overview
User authentication.

## Acceptance Criteria

- User can log in with email/password
- JWT tokens are issued on success

## Technical Approach

- Use bcrypt for password hashing
`;
    await fs.writeFile(path.join(plansDir, "auth.md"), planContent);

    const config = {
      invocation_id: "bd-a3f8.2",
      agent_role: "reviewer" as const,
      taskId: "bd-a3f8.2",
      repoPath,
      branch: "opensprint/bd-a3f8.2",
      testCommand: "npm test",
      attempt: 1,
      phase: "review" as const,
      previousFailure: null as string | null,
      reviewFeedback: null as string | null,
    };

    const context = {
      taskId: config.taskId,
      title: "Implement JWT validation",
      description: "Add JWT validation middleware",
      planContent,
      prdExcerpt: "# Product Requirements\n\nTest product.",
      dependencyOutputs: [] as Array<{ taskId: string; diff: string; summary: string }>,
    };

    const taskDir = await assembler.assembleTaskDirectory(repoPath, config.taskId, config, context);

    const prompt = await fs.readFile(path.join(taskDir, "prompt.md"), "utf-8");

    // Review prompt structure
    expect(prompt).toContain("# Review Task: Implement JWT validation");
    expect(prompt).toContain("## Objective");
    expect(prompt).toContain("Scope compliance");
    expect(prompt).toContain("Code quality");

    // Original ticket context
    expect(prompt).toContain("## Original Ticket");
    expect(prompt).toContain("**Task ID:** bd-a3f8.2");
    expect(prompt).toContain("Add JWT validation middleware");

    // Acceptance criteria and technical approach from plan
    expect(prompt).toContain("## Acceptance Criteria");
    expect(prompt).toContain("User can log in with email/password");
    expect(prompt).toContain("## Technical Approach");
    expect(prompt).toContain("Use bcrypt for password hashing");

    // Context file references
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("context/plan.md");
    expect(prompt).toContain("context/prd_excerpt.md");

    // Implementation section
    expect(prompt).toContain("## Implementation");
    expect(prompt).toContain(
      "The coding agent has produced changes on branch `opensprint/bd-a3f8.2`"
    );
    expect(prompt).toContain("The orchestrator has already committed them before invoking you");
    expect(prompt).toContain(
      "Run `git diff main...opensprint/bd-a3f8.2` to review the committed changes"
    );

    // Two-part review checklist
    expect(prompt).toContain("## Review Checklist");
    expect(prompt).toContain("### Part 1: Scope Compliance");
    expect(prompt).toContain("ALL acceptance criteria are met");
    expect(prompt).toContain("### Part 2: Code Quality");
    expect(prompt).toContain("Correctness");
    expect(prompt).toContain("Error handling");
    expect(prompt).toContain("Test coverage");
    expect(prompt).toContain("All tests pass");

    // Working directory (so reviewer runs tests from repo root, not task dir)
    expect(prompt).toContain("## Working directory");
    expect(prompt).toContain("config.json");
    expect(prompt).toContain("repoPath");

    // Instructions
    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("Read the original ticket");
    expect(prompt).toContain(`git diff main...opensprint/bd-a3f8.2`);
    expect(prompt).toContain("full test suite: `npm test`");
    expect(prompt).toContain("6. Write your result to `.opensprint/active/bd-a3f8.2/result.json`");
    expect(prompt).toContain('"status": "approved"');
    expect(prompt).toContain("do NOT merge");
    expect(prompt).toContain('"status": "rejected"');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('The `status` field MUST be exactly `"approved"` or `"rejected"`');

    // Should NOT contain prior review history for first attempt
    expect(prompt).not.toContain("## Prior Review History");
  });

  it("should include prior review history in review prompt when provided", async () => {
    const planContent = `# Feature: Auth\n\n## Acceptance Criteria\n\n- Login works\n`;

    const config = {
      invocation_id: "bd-a3f8.2",
      agent_role: "reviewer" as const,
      taskId: "bd-a3f8.2",
      repoPath,
      branch: "opensprint/bd-a3f8.2",
      testCommand: "npm test",
      attempt: 2,
      phase: "review" as const,
      previousFailure: null as string | null,
      reviewFeedback: null as string | null,
    };

    const reviewHistory =
      "### Attempt 1 — Rejected\n\n**Reason:** Missing error handling for invalid JWT tokens\n";

    const context = {
      taskId: config.taskId,
      title: "Implement JWT validation",
      description: "Add JWT validation middleware",
      planContent,
      prdExcerpt: "# Product Requirements\n\nTest product.",
      dependencyOutputs: [] as Array<{ taskId: string; diff: string; summary: string }>,
      reviewHistory,
    };

    const taskDir = await assembler.assembleTaskDirectory(repoPath, config.taskId, config, context);
    const prompt = await fs.readFile(path.join(taskDir, "prompt.md"), "utf-8");

    expect(prompt).toContain("## Prior Review History");
    expect(prompt).toContain("has been reviewed and rejected before");
    expect(prompt).toContain("previously identified problems have actually been fixed");
    expect(prompt).toContain("### Attempt 1 — Rejected");
    expect(prompt).toContain("Missing error handling for invalid JWT tokens");
  });

  it("should include AI Autonomy Level section when aiAutonomyLevel or hilConfig is provided", async () => {
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({ sections: { executive_summary: { content: "Test" } } })
    );
    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(path.join(plansDir, "auth.md"), "# Auth\n\n## Overview\n\nAuth.\n");

    const configWithAutonomy = {
      invocation_id: "task-1",
      agent_role: "coder" as const,
      taskId: "task-1",
      repoPath,
      branch: "opensprint/task-1",
      testCommand: "npm test",
      attempt: 1,
      phase: "coding" as const,
      previousFailure: null as string | null,
      reviewFeedback: null as string | null,
      aiAutonomyLevel: "confirm_all" as const,
    };

    const taskDir = await assembler.assembleTaskDirectory(repoPath, "task-1", configWithAutonomy, {
      taskId: "task-1",
      title: "Test task",
      description: "Test",
      planContent: "# Auth\n\nOverview.",
      prdExcerpt: "# PRD\n\nTest.",
      dependencyOutputs: [],
    });

    const prompt = await fs.readFile(path.join(taskDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("## AI Autonomy Level");
    expect(prompt).toContain("Confirm all scope changes");
    expect(prompt).toContain("open_questions");
  });
});
