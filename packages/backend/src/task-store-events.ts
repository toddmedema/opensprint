/**
 * Wires TaskStoreService to emit task create/update/close events via a broadcast callback.
 * Called from index.ts at startup; tests can call with mock broadcast to verify events.
 */
import type { TaskEventPayload, ServerEvent } from "@opensprint/shared";
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

function getMergePausedFromTask(task: StoredTask): {
  mergePausedUntil?: string;
  mergeWaitingOnMain?: boolean;
  mergeGateState?: TaskEventPayload["mergeGateState"];
} {
  const record = task as Record<string, unknown>;
  const mergePausedUntil = getMergePausedUntilFromIssue(record) ?? undefined;
  const mergeGateState = deriveMergeGateStateFromIssue(record) ?? undefined;
  return {
    ...(mergePausedUntil ? { mergePausedUntil, mergeWaitingOnMain: true } : {}),
    ...(mergeGateState ? { mergeGateState } : {}),
  };
}

function storedTaskToPayload(task: StoredTask): TaskEventPayload {
  const parentDep = (task.dependencies ?? []).find((d) => d.type === "parent-child");
  const parentId = parentDep?.depends_on_id ?? null;
  const source = (task as { source?: string }).source;
  const mergePaused = getMergePausedFromTask(task);
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
    ...(mergePaused.mergePausedUntil ? { mergePausedUntil: mergePaused.mergePausedUntil } : {}),
    ...(mergePaused.mergeWaitingOnMain
      ? { mergeWaitingOnMain: mergePaused.mergeWaitingOnMain }
      : {}),
    ...(mergePaused.mergeGateState ? { mergeGateState: mergePaused.mergeGateState } : {}),
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
      const mergePaused = getMergePausedFromTask(task);
      broadcast(projectId, {
        type: "task.updated",
        taskId: task.id,
        status: task.status as string,
        assignee: task.assignee ?? null,
        priority: task.priority,
        blockReason: (task as StoredTask & { block_reason?: string }).block_reason ?? null,
        title: task.title,
        description: task.description ?? undefined,
        kanbanColumn: storedTaskToKanbanColumn(task),
        ...(mergePaused.mergePausedUntil ? { mergePausedUntil: mergePaused.mergePausedUntil } : {}),
        ...(mergePaused.mergeWaitingOnMain
          ? { mergeWaitingOnMain: mergePaused.mergeWaitingOnMain }
          : {}),
        ...(mergePaused.mergeGateState ? { mergeGateState: mergePaused.mergeGateState } : {}),
      } as ServerEvent);
    } else {
      broadcast(projectId, {
        type: "task.closed",
        taskId: task.id,
        task: storedTaskToPayload(task),
      });
    }
  });
}
