/**
 * Integration test: full Execute flow in Branches mode.
 * Verifies: create branch, agent runs (simulated), merge, branch deleted, removeTaskWorktree NOT called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { BranchManager } from "../services/branch-manager.js";
import { MergeCoordinatorService, type MergeCoordinatorHost, type MergeSlot } from "../services/merge-coordinator.service.js";
import type { StoredTask } from "../services/task-store.service.js";

const execAsync = promisify(exec);

// Mock task-store to avoid sql.js load in test env (git-commit-queue imports it)
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue({ title: "Integration test task" }),
  },
}));

// Minimal mocks for services MergeCoordinator needs but we don't test
vi.mock("../services/agent-identity.service.js", () => ({
  agentIdentityService: {
    recordAttempt: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    append: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

describe("Git working mode Branches — full Execute flow integration", () => {
  let repoPath: string;
  let branchManager: BranchManager;
  let removeTaskWorktreeSpy: ReturnType<typeof vi.spyOn>;
  const projectId = "proj-branches";
  const taskId = "os-branches-1";
  const branchName = `opensprint/${taskId}`;

  const makeTask = (): StoredTask => ({
    id: taskId,
    title: "Integration test task",
    status: "open",
    priority: 2,
    issue_type: "task",
    type: "task",
    labels: [],
    assignee: null,
    description: "",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });

  beforeEach(async () => {
    repoPath = path.join(os.tmpdir(), `git-branches-integration-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });

    // Init git repo
    await execAsync("git init", { cwd: repoPath });
    await execAsync("git branch -M main", { cwd: repoPath });
    await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
    await execAsync('git config user.name "Test"', { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README"), "initial");
    await execAsync('git add README && git commit -m "initial"', { cwd: repoPath });

    branchManager = new BranchManager();
    removeTaskWorktreeSpy = vi.spyOn(branchManager, "removeTaskWorktree");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("full Execute flow in Branches mode: create branch, agent runs, merge, branch deleted, removeTaskWorktree skipped", async () => {
    // 1. Pre-agent: create/checkout branch (simulates PhaseExecutor in branches mode)
    await branchManager.createOrCheckoutBranch(repoPath, branchName);

    // 2. Simulate agent work: make a commit on the task branch
    await fs.writeFile(path.join(repoPath, "feature.ts"), "export const x = 1;");
    await execAsync("git add feature.ts && git commit -m 'add feature'", { cwd: repoPath });

    // 3. Slot state as it would be after agent completes (worktreePath = repoPath in branches mode)
    const slot: MergeSlot = {
      taskId,
      attempt: 1,
      worktreePath: repoPath, // In Branches mode, agent runs in main repo
      branchName,
      phaseResult: {
        codingDiff: "",
        codingSummary: "Done",
        testResults: null,
        testOutput: "",
      },
      agent: { outputLog: [], startedAt: new Date().toISOString() },
    };

    const mockGetSettings = vi.fn().mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      deployment: { autoDeployOnEpicCompletion: false },
      gitWorkingMode: "branches",
    });

    const mockHost: MergeCoordinatorHost = {
      getState: vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalDone: 0, queueDepth: 0 },
        globalTimers: {},
      }),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue(makeTask()),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
      },
      branchManager,
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      fileScopeAnalyzer: {
        recordActual: vi.fn().mockResolvedValue(undefined),
      },
      feedbackService: {
        checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined),
      },
      projectService: {
        getSettings: mockGetSettings,
      },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
      runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
    };

    const coordinator = new MergeCoordinatorService(mockHost);

    // 4. Post-agent: merge and done (MergeCoordinator.performMergeAndDone)
    await coordinator.performMergeAndDone(projectId, repoPath, makeTask(), branchName);

    // 5. Assertions
    expect(removeTaskWorktreeSpy).not.toHaveBeenCalled();

    // Branch should be deleted
    const { stdout } = await execAsync("git branch", { cwd: repoPath });
    expect(stdout).not.toContain(branchName);

    // Merge should have succeeded: feature.ts exists on main
    const content = await fs.readFile(path.join(repoPath, "feature.ts"), "utf-8");
    expect(content).toBe("export const x = 1;");
  });
});
