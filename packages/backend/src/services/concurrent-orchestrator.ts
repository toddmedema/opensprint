import path from 'path';
import type { OrchestratorStatus, AgentPhase, ActiveTaskConfig } from '@opensprint/shared';
import { DEFAULT_RETRY_LIMIT, AGENT_INACTIVITY_TIMEOUT_MS, getTestCommandForFramework } from '@opensprint/shared';
import { BeadsService, type BeadsIssue } from './beads.service.js';
import { ProjectService } from './project.service.js';
import { agentService } from './agent.service.js';
import { BranchManager } from './branch-manager.js';
import { ContextAssembler } from './context-assembler.js';
import { SessionManager } from './session-manager.js';
import { ConductorAgent } from './conductor-agent.js';
import { broadcastToProject, sendAgentOutputToProject } from '../websocket/index.js';

interface AgentSlot {
  taskId: string;
  phase: AgentPhase;
  process: { kill: () => void } | null;
  lastOutputTime: number;
  outputLog: string[];
  startedAt: string;
  attempt: number;
  branchName: string;
}

interface ConcurrentState {
  running: boolean;
  maxAgents: number;
  activeSlots: Map<string, AgentSlot>;
  loopTimer: ReturnType<typeof setTimeout> | null;
  inactivityTimer: ReturnType<typeof setInterval> | null;
  totalCompleted: number;
  totalFailed: number;
}

/**
 * Concurrent multi-agent orchestrator (v2.0).
 * Extends the single-agent orchestrator to support multiple simultaneous agents.
 */
export class ConcurrentOrchestrator {
  private state = new Map<string, ConcurrentState>();
  private beads = new BeadsService();
  private projectService = new ProjectService();
  private branchManager = new BranchManager();
  private contextAssembler = new ContextAssembler();
  private sessionManager = new SessionManager();
  private conductorAgent = new ConductorAgent();

  private getState(projectId: string): ConcurrentState {
    if (!this.state.has(projectId)) {
      this.state.set(projectId, {
        running: false,
        maxAgents: 3, // Default concurrent agent slots
        activeSlots: new Map(),
        loopTimer: null,
        inactivityTimer: null,
        totalCompleted: 0,
        totalFailed: 0,
      });
    }
    return this.state.get(projectId)!;
  }

  /** Start the concurrent orchestrator */
  async start(projectId: string, maxAgents?: number): Promise<OrchestratorStatus> {
    const state = this.getState(projectId);

    if (state.running) {
      return this.buildStatus(state);
    }

    state.running = true;
    if (maxAgents) state.maxAgents = maxAgents;

    // Start inactivity monitoring
    state.inactivityTimer = setInterval(() => {
      for (const [taskId, slot] of state.activeSlots) {
        const elapsed = Date.now() - slot.lastOutputTime;
        if (elapsed > AGENT_INACTIVITY_TIMEOUT_MS && slot.process) {
          console.warn(`Agent timeout for task ${taskId}: ${elapsed}ms of inactivity`);
          slot.process.kill();
        }
      }
    }, 30000);

    this.runLoop(projectId);
    return this.buildStatus(state);
  }

  /** Pause the concurrent orchestrator */
  async pause(projectId: string): Promise<OrchestratorStatus> {
    const state = this.getState(projectId);
    state.running = false;

    if (state.loopTimer) {
      clearTimeout(state.loopTimer);
      state.loopTimer = null;
    }
    if (state.inactivityTimer) {
      clearInterval(state.inactivityTimer);
      state.inactivityTimer = null;
    }

    return this.buildStatus(state);
  }

  /** Get status */
  async getStatus(projectId: string): Promise<OrchestratorStatus> {
    return this.buildStatus(this.getState(projectId));
  }

  /** Get detailed agent status for the dashboard */
  getAgentDetails(projectId: string): Array<{
    taskId: string;
    phase: AgentPhase;
    branchName: string;
    startedAt: string;
    outputLength: number;
  }> {
    const state = this.getState(projectId);
    return Array.from(state.activeSlots.values()).map((slot) => ({
      taskId: slot.taskId,
      phase: slot.phase,
      branchName: slot.branchName,
      startedAt: slot.startedAt,
      outputLength: slot.outputLog.length,
    }));
  }

  private async runLoop(projectId: string): Promise<void> {
    const state = this.getState(projectId);
    if (!state.running) return;

    try {
      const repoPath = await this.projectService.getRepoPath(projectId);
      const availableSlots = state.maxAgents - state.activeSlots.size;

      if (availableSlots > 0) {
        let readyTasks = await this.beads.ready(repoPath);

        // Filter out Plan approval gate tasks — they are closed by user "Ship it!", not by agents
        readyTasks = readyTasks.filter((t: BeadsIssue) => (t.title ?? '') !== 'Plan approval gate');
        readyTasks = readyTasks.filter((t: BeadsIssue) => (t.issue_type ?? t.type) !== 'epic');

        // Filter out tasks that are already being worked on
        const activeTasks = new Set(state.activeSlots.keys());
        const availableTasks = readyTasks.filter((t: BeadsIssue) => !activeTasks.has(t.id));

        // Pre-flight: only assign tasks whose blocks dependencies are all closed
        const withClosedBlockers: BeadsIssue[] = [];
        for (const task of availableTasks) {
          const allClosed = await this.beads.areAllBlockersClosed(repoPath, task.id);
          if (allClosed) {
            withClosedBlockers.push(task);
          }
        }

        // Assign tasks to available slots
        const toAssign = withClosedBlockers.slice(0, availableSlots);
        for (const task of toAssign) {
          await this.assignTask(projectId, repoPath, task);
        }
      }
    } catch (error) {
      console.error(`Concurrent orchestrator error for ${projectId}:`, error);
    }

    // Schedule next loop iteration
    if (state.running) {
      state.loopTimer = setTimeout(() => this.runLoop(projectId), 5000);
    }
  }

  /** Resolve plan content for a task from its parent epic. task.description is the task spec, not a path. */
  private async getPlanContentForTask(repoPath: string, task: BeadsIssue): Promise<string> {
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
    return '';
  }

  private async assignTask(
    projectId: string,
    repoPath: string,
    task: BeadsIssue,
  ): Promise<void> {
    const state = this.getState(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const branchName = `opensprint/${task.id}`;
    const agentId = `agent-${state.activeSlots.size + 1}`;

    try {
      // Assign in beads
      await this.beads.update(repoPath, task.id, {
        status: 'in_progress',
        assignee: agentId,
      });

      // Create branch
      await this.branchManager.createBranch(repoPath, branchName);

      // Resolve plan content from parent epic (task.description is spec, not path)
      const planContent = await this.getPlanContentForTask(repoPath, task);

      // Use conductor agent for context summarization (v2.0 feature)
      const prdExcerpt = await this.contextAssembler.extractPrdExcerpt(repoPath);
      const optimizedContext = await this.conductorAgent.summarizeContext(
        settings.planningAgent,
        repoPath,
        task.title,
        task.description || '',
        planContent,
        prdExcerpt,
        [],
      );

      // Create agent slot
      const slot: AgentSlot = {
        taskId: task.id,
        phase: 'coding',
        process: null,
        lastOutputTime: Date.now(),
        outputLog: [],
        startedAt: new Date().toISOString(),
        attempt: 1,
        branchName,
      };
      state.activeSlots.set(task.id, slot);

      broadcastToProject(projectId, {
        type: 'agent.started',
        taskId: task.id,
        phase: 'coding',
        branchName,
      });

      // Assemble and spawn (simplified for concurrent execution)
      const config: ActiveTaskConfig = {
        taskId: task.id,
        repoPath,
        branch: branchName,
        testCommand: (() => {
          const cmd = getTestCommandForFramework(settings.testFramework);
          return cmd || 'echo "No tests"';
        })(),
        attempt: 1,
        phase: 'coding',
        previousFailure: null,
        reviewFeedback: null,
      };

      const taskDir = await this.contextAssembler.assembleTaskDirectory(
        repoPath,
        task.id,
        config,
        {
          taskId: task.id,
          title: task.title,
          description: task.description || '',
          planContent: optimizedContext,
          prdExcerpt: '',
          dependencyOutputs: [],
        },
      );

      const promptPath = `${taskDir}/prompt.md`;

      slot.process = agentService.invokeCodingAgent(
        promptPath,
        settings.codingAgent,
        {
          cwd: repoPath,
          onOutput: (chunk: string) => {
            slot.outputLog.push(chunk);
            slot.lastOutputTime = Date.now();
            sendAgentOutputToProject(projectId, task.id, chunk);
          },
          onExit: async (_code: number | null) => {
            slot.process = null;
            state.activeSlots.delete(task.id);
            state.totalCompleted += 1;

            broadcastToProject(projectId, {
              type: 'agent.completed',
              taskId: task.id,
              status: 'success',
              testResults: null,
            });
          },
        },
      );

      broadcastToProject(projectId, {
        type: 'task.updated',
        taskId: task.id,
        status: 'in_progress',
        assignee: agentId,
      });

    } catch (error) {
      console.error(`Failed to assign task ${task.id}:`, error);
      state.activeSlots.delete(task.id);
    }
  }

  private buildStatus(state: ConcurrentState): OrchestratorStatus {
    const activeSlots = Array.from(state.activeSlots.values());
    return {
      running: state.running,
      currentTask: activeSlots.length > 0 ? activeSlots[0].taskId : null,
      currentPhase: activeSlots.length > 0 ? activeSlots[0].phase : null,
      queueDepth: 0,
      totalCompleted: state.totalCompleted,
      totalFailed: state.totalFailed,
    };
  }
}

export const concurrentOrchestrator = new ConcurrentOrchestrator();
