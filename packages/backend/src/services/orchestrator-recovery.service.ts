/**
 * Orchestrator recovery adapter — builds RecoveryHost from orchestrator for unified recovery.
 * Extracted from OrchestratorService so recovery host construction and dependency injection
 * live in one place.
 */

import type { RecoveryHost, GuppAssignment } from "./recovery.service.js";
import type { StoredTask } from "./task-store.service.js";

export interface OrchestratorRecoveryHost {
  resumeRetainedLocalValidation?(
    projectId: string,
    repoPath: string,
    taskId: string
  ): Promise<boolean>;
  getRetainedLocalRecoveryTasks?(
    projectId: string
  ): Promise<Array<{ taskId: string; checkpoint: { worktreePath: string; branchName: string } }>>;
  getSlottedTaskIds(projectId: string): string[];
  getActiveAgentIds(projectId: string): string[];
  getSlottedWorktreeKeys(projectId: string): string[];
  getSlottedWorktreePaths(projectId: string): string[];
  reattachRecoveredCodingTask(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment,
    options?: { suspendReason?: import("@opensprint/shared").AgentSuspendReason }
  ): Promise<boolean>;
  resumeRecoveredReviewPhase(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment,
    options: { pidAlive: boolean; suspendReason?: import("@opensprint/shared").AgentSuspendReason }
  ): Promise<boolean>;
  handleRecoverableHeartbeatGap(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean>;
  handleCompletedRecoveredAssignment(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    assignment: GuppAssignment
  ): Promise<boolean>;
  removeStaleSlot(projectId: string, taskId: string, repoPath: string): Promise<void>;
}

/** Build the RecoveryHost implementation used by RecoveryService from the orchestrator. */
export function buildOrchestratorRecoveryHost(host: OrchestratorRecoveryHost): RecoveryHost {
  return {
    getRetainedLocalRecoveryTasks: host.getRetainedLocalRecoveryTasks?.bind(host),
    resumeRetainedLocalValidation: host.resumeRetainedLocalValidation?.bind(host),
    getSlottedTaskIds: (projectId) => host.getSlottedTaskIds(projectId),
    getActiveAgentIds: (projectId) => host.getActiveAgentIds(projectId),
    getSlottedWorktreeKeys: (projectId) => host.getSlottedWorktreeKeys(projectId),
    getSlottedWorktreePaths: (projectId) => host.getSlottedWorktreePaths(projectId),
    reattachSlot: (projectId, repoPath, task, assignment) =>
      host.reattachRecoveredCodingTask(projectId, repoPath, task, assignment),
    resumeReviewPhase: (projectId, repoPath, task, assignment, options) =>
      host.resumeRecoveredReviewPhase(projectId, repoPath, task, assignment, options),
    handleRecoverableHeartbeatGap: (projectId, repoPath, task, assignment) =>
      host.handleRecoverableHeartbeatGap(projectId, repoPath, task, assignment),
    handleCompletedAssignment: (projectId, repoPath, task, assignment) =>
      host.handleCompletedRecoveredAssignment(projectId, repoPath, task, assignment),
    removeStaleSlot: (projectId, taskId, repoPath) =>
      host.removeStaleSlot(projectId, taskId, repoPath),
  };
}
