/**
 * OrchestratorDispatchService — task selection and agent dispatch (slot creation, transition, coding phase).
 * Extracted from OrchestratorService so the main orchestrator composes dispatch as a dependency.
 */

import { getAgentName } from "@opensprint/shared";
import type { StoredTask } from "./task-store.service.js";
import { resolveEpicId } from "./task-store.service.js";
import { resolveBaseBranch } from "../utils/git-repo-state.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator-dispatch");

/** Slot shape required by dispatch (must have branchName, fileScope assignable). */
export interface DispatchSlotLike {
  taskId: string;
  taskTitle: string | null;
  branchName: string;
  worktreeKey?: string;
  worktreePath: string | null;
  attempt: number;
  assignee?: string;
  fileScope?: unknown;
  [key: string]: unknown;
}

/** State shape required by dispatch (must have nextCoderIndex and status). */
export interface DispatchStateLike {
  nextCoderIndex: number;
  status: { queueDepth: number };
  slots: Map<string, unknown>;
}

export interface OrchestratorDispatchHost {
  getState(projectId: string): DispatchStateLike;
  createSlot(
    taskId: string,
    taskTitle: string | null,
    branchName: string,
    attempt: number,
    assignee: string,
    worktreeKey?: string
  ): DispatchSlotLike;
  transition(
    projectId: string,
    t: {
      to: "start_task";
      taskId: string;
      taskTitle: string | null;
      branchName: string;
      attempt: number;
      queueDepth: number;
      slot: DispatchSlotLike;
    }
  ): void;
  persistCounters(projectId: string, repoPath: string): Promise<void>;
  getTaskStore(): {
    update(projectId: string, taskId: string, fields: Record<string, unknown>): Promise<void>;
    getCumulativeAttemptsFromIssue(task: StoredTask): number;
    listAll(projectId: string): Promise<StoredTask[]>;
  };
  getProjectService(): { getSettings(projectId: string): Promise<{ mergeStrategy?: string; worktreeBaseBranch?: string }> };
  getBranchManager(): { ensureOnMain(repoPath: string, baseBranch: string): Promise<void> };
  getFileScopeAnalyzer(): {
    predict(
      projectId: string,
      repoPath: string,
      task: StoredTask,
      taskStore: { listAll(projectId: string): Promise<StoredTask[]> }
    ): Promise<unknown>;
  };
  executeCodingPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slot: DispatchSlotLike,
    retryContext?: unknown
  ): Promise<void>;
}

export class OrchestratorDispatchService {
  constructor(private host: OrchestratorDispatchHost) {}

  async dispatchTask(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    slotQueueDepth: number
  ): Promise<void> {
    const state = this.host.getState(projectId);
    log.info("Picking task", { projectId, taskId: task.id, title: task.title });

    const assignee = getAgentName(state.nextCoderIndex);
    state.nextCoderIndex += 1;

    const taskStore = this.host.getTaskStore();
    await taskStore.update(projectId, task.id, {
      status: "in_progress",
      assignee,
    });
    const cumulativeAttempts = taskStore.getCumulativeAttemptsFromIssue(task);
    const settings = await this.host.getProjectService().getSettings(projectId);
    const mergeStrategy = settings.mergeStrategy ?? "per_task";
    const allIssues = await taskStore.listAll(projectId);
    const epicId = resolveEpicId(task.id, allIssues);
    const useEpicBranch = mergeStrategy === "per_epic" && epicId != null;
    const branchName = useEpicBranch
      ? `opensprint/epic_${epicId}`
      : `opensprint/${task.id}`;
    const worktreeKey = useEpicBranch ? `epic_${epicId}` : task.id;

    const slot = this.host.createSlot(
      task.id,
      task.title ?? null,
      branchName,
      cumulativeAttempts + 1,
      assignee,
      worktreeKey
    );
    slot.fileScope = await this.host.getFileScopeAnalyzer().predict(
      projectId,
      repoPath,
      task,
      { listAll: (p: string) => taskStore.listAll(p) }
    );

    this.host.transition(projectId, {
      to: "start_task",
      taskId: task.id,
      taskTitle: task.title ?? null,
      branchName,
      attempt: cumulativeAttempts + 1,
      queueDepth: slotQueueDepth,
      slot,
    });

    await this.host.persistCounters(projectId, repoPath);
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    await this.host.getBranchManager().ensureOnMain(repoPath, baseBranch);
    await this.host.executeCodingPhase(projectId, repoPath, task, slot, undefined);
  }
}
