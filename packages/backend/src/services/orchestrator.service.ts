import fs from 'fs/promises';
import path from 'path';
import type {
  OrchestratorStatus,
  AgentPhase,
  ActiveTaskConfig,
  CodingAgentResult,
  ReviewAgentResult,
} from '@opensprint/shared';
import { OPENSPRINT_PATHS, DEFAULT_RETRY_LIMIT, AGENT_INACTIVITY_TIMEOUT_MS } from '@opensprint/shared';
import { BeadsService, type BeadsIssue } from './beads.service.js';
import { ProjectService } from './project.service.js';
import { AgentClient } from './agent-client.js';
import { BranchManager } from './branch-manager.js';
import { ContextAssembler } from './context-assembler.js';
import { SessionManager } from './session-manager.js';
import { TestRunner } from './test-runner.js';
import { broadcastToProject } from '../websocket/index.js';

interface RetryContext {
  previousFailure?: string;
  reviewFeedback?: string;
  useExistingBranch?: boolean;
}

interface OrchestratorState {
  status: OrchestratorStatus;
  loopTimer: ReturnType<typeof setTimeout> | null;
  activeProcess: { kill: () => void } | null;
  lastOutputTime: number;
  inactivityTimer: ReturnType<typeof setInterval> | null;
  outputLog: string[];
  startedAt: string;
  attempt: number;
  lastCodingDiff: string;
}

/**
 * Build orchestrator service.
 * Manages the single-agent build loop: poll bd ready -> assign -> spawn agent -> monitor -> handle result.
 */
export class OrchestratorService {
  private state = new Map<string, OrchestratorState>();
  private beads = new BeadsService();
  private projectService = new ProjectService();
  private agentClient = new AgentClient();
  private branchManager = new BranchManager();
  private contextAssembler = new ContextAssembler();
  private sessionManager = new SessionManager();
  private testRunner = new TestRunner();

  private getState(projectId: string): OrchestratorState {
    if (!this.state.has(projectId)) {
      this.state.set(projectId, {
        status: this.defaultStatus(),
        loopTimer: null,
        activeProcess: null,
        lastOutputTime: 0,
        inactivityTimer: null,
        outputLog: [],
        startedAt: '',
        attempt: 1,
        lastCodingDiff: '',
      });
    }
    return this.state.get(projectId)!;
  }

  private defaultStatus(): OrchestratorStatus {
    return {
      running: false,
      currentTask: null,
      currentPhase: null,
      queueDepth: 0,
      totalCompleted: 0,
      totalFailed: 0,
    };
  }

  /** Start the build orchestrator for a project */
  async start(projectId: string): Promise<OrchestratorStatus> {
    const state = this.getState(projectId);

    if (state.status.running) {
      return state.status;
    }

    state.status.running = true;

    // Broadcast status
    broadcastToProject(projectId, {
      type: 'build.status',
      running: true,
      currentTask: null,
      queueDepth: state.status.queueDepth,
    });

    // Start the orchestrator loop
    this.runLoop(projectId);

    return state.status;
  }

  /** Pause the build orchestrator */
  async pause(projectId: string): Promise<OrchestratorStatus> {
    const state = this.getState(projectId);
    state.status.running = false;

    // Clear timers
    if (state.loopTimer) {
      clearTimeout(state.loopTimer);
      state.loopTimer = null;
    }
    if (state.inactivityTimer) {
      clearInterval(state.inactivityTimer);
      state.inactivityTimer = null;
    }

    broadcastToProject(projectId, {
      type: 'build.status',
      running: false,
      currentTask: state.status.currentTask,
      queueDepth: state.status.queueDepth,
    });

    return state.status;
  }

  /** Get orchestrator status */
  async getStatus(projectId: string): Promise<OrchestratorStatus> {
    return this.getState(projectId).status;
  }

  /** Resolve plan content for a task (from parent epic or task description) */
  private async getPlanContentForTask(repoPath: string, task: BeadsIssue): Promise<string> {
    if (task.description?.startsWith('.opensprint/plans/')) {
      const planId = path.basename(task.description, '.md');
      return this.contextAssembler.readPlanContent(repoPath, planId);
    }
    const parentId = this.beads.getParentId(task.id);
    if (parentId) {
      try {
        const parent = await this.beads.show(repoPath, parentId);
        const desc = parent.description as string;
        if (desc?.startsWith('.opensprint/plans/')) {
          const planId = path.basename(desc, '.md');
          return this.contextAssembler.readPlanContent(repoPath, planId);
        }
      } catch {
        // Parent might not exist
      }
    }
    return task.description || '';
  }

  /** Get IDs of tasks that block this one (must complete before this task) */
  private async getBlockingDependencyIds(repoPath: string, taskId: string): Promise<string[]> {
    const blockers = await this.beads.getBlockers(repoPath, taskId);
    return blockers;
  }

  // ─── Main Orchestrator Loop ───

  private async runLoop(projectId: string): Promise<void> {
    const state = this.getState(projectId);

    if (!state.status.running) return;

    try {
      const repoPath = await this.projectService.getRepoPath(projectId);

      // 1. Poll bd ready for next task
      const readyTasks = await this.beads.ready(repoPath);
      state.status.queueDepth = readyTasks.length;

      if (readyTasks.length === 0) {
        // No tasks available, poll again in 5 seconds
        state.loopTimer = setTimeout(() => this.runLoop(projectId), 5000);
        broadcastToProject(projectId, {
          type: 'build.status',
          running: true,
          currentTask: null,
          queueDepth: 0,
        });
        return;
      }

      // 2. Pick the highest-priority task
      const task = readyTasks[0];

      // 3. Assign the task
      await this.beads.update(repoPath, task.id, {
        status: 'in_progress',
        assignee: 'agent-1',
      });

      state.status.currentTask = task.id;
      state.status.currentPhase = 'coding';
      state.attempt = 1;

      broadcastToProject(projectId, {
        type: 'task.updated',
        taskId: task.id,
        status: 'in_progress',
        assignee: 'agent-1',
      });

      broadcastToProject(projectId, {
        type: 'build.status',
        running: true,
        currentTask: task.id,
        queueDepth: readyTasks.length - 1,
      });

      // 4. Execute the coding phase
      await this.executeCodingPhase(projectId, repoPath, task, undefined);

    } catch (error) {
      console.error(`Orchestrator loop error for project ${projectId}:`, error);
      // Retry loop after delay
      const state2 = this.getState(projectId);
      if (state2.status.running) {
        state2.loopTimer = setTimeout(() => this.runLoop(projectId), 10000);
      }
    }
  }

  private async executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    retryContext?: RetryContext,
  ): Promise<void> {
    const state = this.getState(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const branchName = `opensprint/${task.id}`;

    try {
      // Create or checkout task branch (use existing when retrying after review rejection)
      if (retryContext?.useExistingBranch) {
        await this.branchManager.createOrCheckoutBranch(repoPath, branchName);
      } else {
        await this.branchManager.createBranch(repoPath, branchName);
      }

      // Assemble context
      const prdExcerpt = await this.contextAssembler.extractPrdExcerpt(repoPath);
      const planContent = await this.getPlanContentForTask(repoPath, task);
      const dependencyOutputs = await this.contextAssembler.collectDependencyOutputs(
        repoPath,
        await this.getBlockingDependencyIds(repoPath, task.id),
      );

      const config: ActiveTaskConfig = {
        taskId: task.id,
        repoPath,
        branch: branchName,
        testCommand: settings.testFramework ? `npm test` : 'echo "No test command configured"',
        attempt: state.attempt,
        phase: 'coding',
        previousFailure: retryContext?.previousFailure ?? null,
        reviewFeedback: retryContext?.reviewFeedback ?? null,
      };

      await this.contextAssembler.assembleTaskDirectory(repoPath, task.id, config, {
        taskId: task.id,
        title: task.title,
        description: task.description || '',
        planContent,
        prdExcerpt,
        dependencyOutputs,
      });

      state.startedAt = new Date().toISOString();
      state.outputLog = [];
      state.lastOutputTime = Date.now();

      // Spawn the coding agent
      const taskDir = this.sessionManager.getActiveDir(repoPath, task.id);
      const promptPath = path.join(taskDir, 'prompt.md');

      state.activeProcess = this.agentClient.spawnWithTaskFile(
        settings.codingAgent,
        promptPath,
        repoPath,
        // onOutput
        (chunk: string) => {
          state.outputLog.push(chunk);
          state.lastOutputTime = Date.now();
          broadcastToProject(projectId, {
            type: 'agent.output',
            taskId: task.id,
            chunk,
          } as any);
        },
        // onExit
        async (code: number | null) => {
          state.activeProcess = null;
          if (state.inactivityTimer) {
            clearInterval(state.inactivityTimer);
            state.inactivityTimer = null;
          }

          await this.handleCodingComplete(projectId, repoPath, task, branchName, code);
        },
      );

      // Start inactivity monitoring
      state.inactivityTimer = setInterval(() => {
        const elapsed = Date.now() - state.lastOutputTime;
        if (elapsed > AGENT_INACTIVITY_TIMEOUT_MS) {
          console.warn(`Agent timeout for task ${task.id}: ${elapsed}ms of inactivity`);
          if (state.activeProcess) {
            state.activeProcess.kill();
          }
        }
      }, 30000); // Check every 30 seconds

    } catch (error) {
      console.error(`Coding phase failed for task ${task.id}:`, error);
      await this.handleTaskFailure(projectId, repoPath, task, branchName, String(error));
    }
  }

  private async handleCodingComplete(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    exitCode: number | null,
  ): Promise<void> {
    const state = this.getState(projectId);

    // Check for result.json
    const result = await this.sessionManager.readResult(repoPath, task.id) as CodingAgentResult | null;

    if (result && result.status === 'success') {
      state.lastCodingDiff = await this.branchManager.getDiff(repoPath, branchName);

      const settings = await this.projectService.getSettings(projectId);
      const testCommand = settings.testFramework ? 'npm test' : undefined;
      const testResults = await this.testRunner.runTests(repoPath, testCommand);
      if (testResults.failed > 0) {
        await this.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Tests failed: ${testResults.failed} failed, ${testResults.passed} passed`,
        );
        return;
      }

      // Move to review phase
      state.status.currentPhase = 'review';
      broadcastToProject(projectId, {
        type: 'task.updated',
        taskId: task.id,
        status: 'in_progress',
        assignee: 'agent-1',
      });

      await this.executeReviewPhase(projectId, repoPath, task, branchName);
    } else {
      // Coding failed
      const reason = result?.summary || `Agent exited with code ${exitCode}`;
      await this.handleTaskFailure(projectId, repoPath, task, branchName, reason);
    }
  }

  private async executeReviewPhase(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
  ): Promise<void> {
    const state = this.getState(projectId);
    const settings = await this.projectService.getSettings(projectId);

    try {
      // Update config for review phase
      const config: ActiveTaskConfig = {
        taskId: task.id,
        repoPath,
        branch: branchName,
        testCommand: settings.testFramework ? 'npm test' : 'echo "No test command configured"',
        attempt: state.attempt,
        phase: 'review',
        previousFailure: null,
        reviewFeedback: null,
      };

      const taskDir = this.sessionManager.getActiveDir(repoPath, task.id);
      await fs.writeFile(
        path.join(taskDir, 'config.json'),
        JSON.stringify(config, null, 2),
      );

      // Generate review prompt
      const prdExcerpt = await this.contextAssembler.extractPrdExcerpt(repoPath);
      await this.contextAssembler.assembleTaskDirectory(repoPath, task.id, config, {
        taskId: task.id,
        title: task.title,
        description: task.description || '',
        planContent: '',
        prdExcerpt,
        dependencyOutputs: [],
      });

      state.startedAt = new Date().toISOString();
      state.outputLog = [];
      state.lastOutputTime = Date.now();

      const promptPath = path.join(taskDir, 'prompt.md');

      state.activeProcess = this.agentClient.spawnWithTaskFile(
        settings.codingAgent, // Use same agent for review in v1
        promptPath,
        repoPath,
        (chunk: string) => {
          state.outputLog.push(chunk);
          state.lastOutputTime = Date.now();
          broadcastToProject(projectId, {
            type: 'agent.output',
            taskId: task.id,
            chunk,
          } as any);
        },
        async (code: number | null) => {
          state.activeProcess = null;
          if (state.inactivityTimer) {
            clearInterval(state.inactivityTimer);
            state.inactivityTimer = null;
          }

          await this.handleReviewComplete(projectId, repoPath, task, branchName, code);
        },
      );

      // Start inactivity monitoring
      state.inactivityTimer = setInterval(() => {
        const elapsed = Date.now() - state.lastOutputTime;
        if (elapsed > AGENT_INACTIVITY_TIMEOUT_MS) {
          if (state.activeProcess) {
            state.activeProcess.kill();
          }
        }
      }, 30000);

    } catch (error) {
      console.error(`Review phase failed for task ${task.id}:`, error);
      await this.handleTaskFailure(projectId, repoPath, task, branchName, String(error));
    }
  }

  private async handleReviewComplete(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    exitCode: number | null,
  ): Promise<void> {
    const state = this.getState(projectId);
    const result = await this.sessionManager.readResult(repoPath, task.id) as ReviewAgentResult | null;

    if (result && result.status === 'approved') {
      // Verify merge
      const merged = await this.branchManager.verifyMerge(repoPath, branchName);
      if (!merged) {
        // Review agent should have merged; if not, try to merge
        try {
          await this.branchManager.checkout(repoPath, 'main');
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);
          await execAsync(`git merge ${branchName}`, { cwd: repoPath });
        } catch {
          // Merge failed, handle as failure
        }
      }

      // Close the task in beads
      await this.beads.close(repoPath, task.id, result.summary || 'Implemented and reviewed');

      // Archive session (include coding diff for dependency context)
      const session = await this.sessionManager.createSession(repoPath, {
        taskId: task.id,
        attempt: state.attempt,
        agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
        agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || '',
        gitBranch: branchName,
        status: 'approved',
        outputLog: state.outputLog.join(''),
        gitDiff: state.lastCodingDiff,
        startedAt: state.startedAt,
      });
      await this.sessionManager.archiveSession(repoPath, task.id, state.attempt, session);

      // Clean up branch
      await this.branchManager.deleteBranch(repoPath, branchName);

      state.status.totalCompleted += 1;
      state.status.currentTask = null;
      state.status.currentPhase = null;

      broadcastToProject(projectId, {
        type: 'task.updated',
        taskId: task.id,
        status: 'closed',
        assignee: null,
      });

      broadcastToProject(projectId, {
        type: 'agent.completed',
        taskId: task.id,
        status: 'approved',
        testResults: null,
      });

      // Continue the loop
      if (state.status.running) {
        state.loopTimer = setTimeout(() => this.runLoop(projectId), 1000);
      }

    } else if (result && result.status === 'rejected') {
      // Review rejected — retry coding with feedback
      state.attempt += 1;
      const retryLimit = DEFAULT_RETRY_LIMIT;

      if (state.attempt <= retryLimit + 1) {
        console.log(`Review rejected for ${task.id}, retrying (attempt ${state.attempt})`);

        // Archive rejection session
        const session = await this.sessionManager.createSession(repoPath, {
          taskId: task.id,
          attempt: state.attempt - 1,
          agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
          agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || '',
          gitBranch: branchName,
          status: 'rejected',
          outputLog: state.outputLog.join(''),
          failureReason: result.summary,
          startedAt: state.startedAt,
        });
        await this.sessionManager.archiveSession(repoPath, task.id, state.attempt - 1, session);

        const reviewFeedback = [
          result.summary,
          ...(result.issues ?? []),
        ].filter(Boolean).join('\n');

        await this.executeCodingPhase(projectId, repoPath, task, {
          reviewFeedback,
          useExistingBranch: true,
        });
      } else {
        // Retry limit reached — escalate
        await this.handleTaskFailure(
          projectId,
          repoPath,
          task,
          branchName,
          `Review rejected ${state.attempt - 1} times. Issues: ${result.issues?.join('; ') || result.summary}`,
        );
      }
    } else {
      // No result.json or unexpected status
      await this.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        `Review agent exited with code ${exitCode} without producing a valid result`,
      );
    }
  }

  private async handleTaskFailure(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
    branchName: string,
    reason: string,
  ): Promise<void> {
    const state = this.getState(projectId);

    console.error(`Task ${task.id} failed: ${reason}`);

    // Revert changes and return to main
    await this.branchManager.revertAndReturnToMain(repoPath, branchName);

    // Archive failure session
    const session = await this.sessionManager.createSession(repoPath, {
      taskId: task.id,
      attempt: state.attempt,
      agentType: (await this.projectService.getSettings(projectId)).codingAgent.type,
      agentModel: (await this.projectService.getSettings(projectId)).codingAgent.model || '',
      gitBranch: branchName,
      status: 'failed',
      outputLog: state.outputLog.join(''),
      failureReason: reason,
      startedAt: state.startedAt,
    });
    await this.sessionManager.archiveSession(repoPath, task.id, state.attempt, session);

    const retryLimit = DEFAULT_RETRY_LIMIT;
    const canRetry = state.attempt <= retryLimit;

    if (canRetry) {
      state.attempt += 1;
      console.log(`Coding failed for ${task.id}, retrying (attempt ${state.attempt})`);
      await this.executeCodingPhase(projectId, repoPath, task, {
        previousFailure: reason,
      });
    } else {
      // Retry limit reached — return task to Ready queue
      try {
        await this.beads.update(repoPath, task.id, {
          status: 'open',
          assignee: '',
        });
      } catch {
        // Task might already be in the right state
      }

      state.status.totalFailed += 1;
      state.status.currentTask = null;
      state.status.currentPhase = null;

      broadcastToProject(projectId, {
        type: 'task.updated',
        taskId: task.id,
        status: 'open',
        assignee: null,
      });

      broadcastToProject(projectId, {
        type: 'agent.completed',
        taskId: task.id,
        status: 'failed',
        testResults: null,
      });

      if (state.status.running) {
        state.loopTimer = setTimeout(() => this.runLoop(projectId), 2000);
      }
    }
  }
}
