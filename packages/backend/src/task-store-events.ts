/**
 * Wires TaskStoreService to emit task create/update/close events via a broadcast callback.
 * Called from index.ts at startup; tests can call with mock broadcast to verify events.
 */
import type { TaskEventPayload, ServerEvent, MergeGateState } from "@opensprint/shared";
import { mapStatusToKanban, type KanbanColumn } from "@opensprint/shared";
import { getMergeStageFromIssue } from "./services/task-store-helpers.js";
import {
  deriveMergeGateStateFromIssue,
  getMergePausedUntilFromIssue,
} from "./services/merge-gate-state.js";
import { taskStore, type StoredTask } from "./services/task-store.service.js";

const WAITING_TO_MERGE_STAGES = ["quality_gate", "merge_to_main", "rebase_before_merge"] as const;

function storedTaskToKanbanColumn(task: StoredTask): KanbanColumn {
  if (task.status === "open") {
    const mergeStage = getMergeStageFromIssue(task);
    if (mergeStage && (WAITING_TO_MERGE_STAGES as readonly string[]).includes(mergeStage)) {
      return "waiting_to_merge";
    }
  }
  return mapStatusToKanban(task.status as string);
}

/**
 * Authoritative merge-related fields for WebSocket payloads. Always include on task.updated /
 * full task snapshots so live clients can clear stale merge-gate UI when baseline pause lifts
 * or merge stage changes (omitting keys left old `mergeGateState` stuck on the client).
 */
export function getAuthoritativeMergeWsFields(task: StoredTask): {
  mergePausedUntil: string | null;
  mergeWaitingOnMain: boolean;
  mergeGateState: MergeGateState | null;
} {
  const record = task as Record<string, unknown>;
  const mergePausedUntil = getMergePausedUntilFromIssue(record);
  const mergeGateState = deriveMergeGateStateFromIssue(record);
  return {
    mergePausedUntil,
    mergeWaitingOnMain: mergePausedUntil != null,
    mergeGateState,
  };
}

/** Full `task.updated` payload from DB state — use for WS so clients always get merge fields (null clears stale UI). */
export function buildTaskUpdatedServerEvent(task: StoredTask): ServerEvent {
  const merge = getAuthoritativeMergeWsFields(task);
  return {
    type: "task.updated",
    taskId: task.id,
    status: task.status as string,
    assignee: task.assignee ?? null,
    priority: task.priority,
    blockReason: (task as StoredTask & { block_reason?: string }).block_reason ?? null,
    title: task.title,
    description: task.description ?? undefined,
    kanbanColumn: storedTaskToKanbanColumn(task),
    mergePausedUntil: merge.mergePausedUntil,
    mergeWaitingOnMain: merge.mergeWaitingOnMain,
    mergeGateState: merge.mergeGateState,
  } as ServerEvent;
}

/**
 * Re-fetch task and broadcast authoritative `task.updated` (merge gate / pause fields included).
 * Use after ad-hoc WS events or when callers need the same shape as TaskStoreService emits.
 */
export async function broadcastAuthoritativeTaskUpdated(
  broadcast: BroadcastFn,
  projectId: string,
  taskId: string
): Promise<void> {
  try {
    const task = await taskStore.show(projectId, taskId);
    broadcast(projectId, buildTaskUpdatedServerEvent(task));
  } catch {
    // Missing task or DB error — skip broadcast
  }
}

function storedTaskToPayload(task: StoredTask): TaskEventPayload {
  const parentDep = (task.dependencies ?? []).find((d) => d.type === "parent-child");
  const parentId = parentDep?.depends_on_id ?? null;
  const source = (task as { source?: string }).source;
  const merge = getAuthoritativeMergeWsFields(task);
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    issue_type: task.issue_type ?? (task as { type?: string }).type ?? "task",
    status: task.status as string,
    priority: task.priority ?? 2,
    assignee: task.assignee ?? null,
    labels: (task.labels ?? []) as string[],
    created_at: task.created_at,
    updated_at: task.updated_at,
    close_reason: task.close_reason ?? null,
    parentId: parentId ?? null,
    ...(source ? { source } : {}),
    kanbanColumn: storedTaskToKanbanColumn(task),
    mergePausedUntil: merge.mergePausedUntil,
    mergeWaitingOnMain: merge.mergeWaitingOnMain,
    mergeGateState: merge.mergeGateState,
  } as TaskEventPayload;
}

export type BroadcastFn = (projectId: string, event: ServerEvent) => void;

export function wireTaskStoreEvents(broadcast: BroadcastFn): void {
  taskStore.setOnTaskChange((projectId, changeType, task) => {
    if (changeType === "create") {
      broadcast(projectId, {
        type: "task.created",
        taskId: task.id,
        task: storedTaskToPayload(task),
      });
    } else if (changeType === "update") {
      broadcast(projectId, buildTaskUpdatedServerEvent(task));
    } else {
      broadcast(projectId, {
        type: "task.closed",
        taskId: task.id,
        task: storedTaskToPayload(task),
      });
    }
  });
}
