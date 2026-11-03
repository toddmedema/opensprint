import type { DbClient } from "../db/client.js";
import { toPgParams } from "../db/sql-params.js";

/**
 * Removes lines from plan content that mention the given task ID (e.g. task bullets).
 * Used when cascading task deletion so plans no longer reference the removed task.
 */
function stripTaskLinesFromPlanContent(
  content: string,
  taskId: string
): { content: string; changed: boolean } {
  if (!content || !taskId) return { content, changed: false };
  const lines = content.split("\n");
  const kept = lines.filter((line) => !line.includes(taskId));
  if (kept.length === lines.length) return { content, changed: false };
  return { content: kept.join("\n"), changed: true };
}

/**
 * Recursively removes all occurrences of taskId from a JSON value (arrays and objects).
 * Used to clean plan metadata and feedback JSON so deleted task IDs are not left behind.
 */
function pruneTaskIdFromJson(value: unknown, taskId: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = [];
    for (const item of value) {
      if (typeof item === "string" && item === taskId) {
        changed = true;
        continue;
      }
      const pruned = pruneTaskIdFromJson(item, taskId);
      if (pruned.changed) changed = true;
      next.push(pruned.value);
    }
    return changed ? { value: next, changed: true } : { value, changed: false };
  }

  if (value != null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === "string" && raw === taskId) {
        changed = true;
        continue;
      }
      const pruned = pruneTaskIdFromJson(raw, taskId);
      if (pruned.changed) changed = true;
      next[key] = pruned.value;
    }
    return changed ? { value: next, changed: true } : { value, changed: false };
  }

  return { value, changed: false };
}

async function removeTaskReferencesFromFeedback(
  client: DbClient,
  projectId: string,
  taskId: string
): Promise<void> {
  const rows = await client.query(
    toPgParams(
      "SELECT id, created_task_ids, feedback_source_task_id, mapped_epic_id FROM feedback WHERE project_id = ?"
    ),
    [projectId]
  );

  for (const row of rows) {
    const feedbackId = row.id as string;
    const sourceTaskId = (row.feedback_source_task_id as string | null) ?? null;
    const mappedEpicId = (row.mapped_epic_id as string | null) ?? null;
    let createdTaskIds: string[] = [];
    try {
      createdTaskIds = JSON.parse((row.created_task_ids as string) || "[]") as string[];
    } catch {
      createdTaskIds = [];
    }
    const filteredTaskIds = createdTaskIds.filter((id) => id !== taskId);
    const createdChanged = filteredTaskIds.length !== createdTaskIds.length;
    const sourceChanged = sourceTaskId === taskId;
    const mappedEpicChanged = mappedEpicId === taskId;
    if (!createdChanged && !sourceChanged && !mappedEpicChanged) continue;
    await client.execute(
      toPgParams(
        "UPDATE feedback SET created_task_ids = ?, feedback_source_task_id = ?, mapped_epic_id = ? WHERE project_id = ? AND id = ?"
      ),
      [
        JSON.stringify(filteredTaskIds),
        sourceChanged ? null : sourceTaskId,
        mappedEpicChanged ? null : mappedEpicId,
        projectId,
        feedbackId,
      ]
    );
  }
}

async function removeTaskReferencesFromPlans(
  client: DbClient,
  projectId: string,
  taskId: string
): Promise<void> {
  const rows = await client.query(
    toPgParams(
      "SELECT plan_id, content, metadata, gate_task_id, re_execute_gate_task_id FROM plans WHERE project_id = ?"
    ),
    [projectId]
  );
  const now = new Date().toISOString();

  for (const row of rows) {
    const planId = row.plan_id as string;
    const currentContent = (row.content as string) ?? "";
    const currentMetadataRaw = (row.metadata as string) ?? "{}";
    const currentGateTaskId = (row.gate_task_id as string | null) ?? null;
    const currentReExecuteGateTaskId = (row.re_execute_gate_task_id as string | null) ?? null;

    let currentMetadata: Record<string, unknown>;
    try {
      currentMetadata = JSON.parse(currentMetadataRaw) as Record<string, unknown>;
    } catch {
      currentMetadata = {};
    }

    const strippedContent = stripTaskLinesFromPlanContent(currentContent, taskId);
    const prunedMetadata = pruneTaskIdFromJson(currentMetadata, taskId);
    const nextGateTaskId = currentGateTaskId === taskId ? null : currentGateTaskId;
    const nextReExecuteGateTaskId =
      currentReExecuteGateTaskId === taskId ? null : currentReExecuteGateTaskId;
    const gateChanged = nextGateTaskId !== currentGateTaskId;
    const reExecuteGateChanged = nextReExecuteGateTaskId !== currentReExecuteGateTaskId;

    if (
      !strippedContent.changed &&
      !prunedMetadata.changed &&
      !gateChanged &&
      !reExecuteGateChanged
    ) {
      continue;
    }

    await client.execute(
      toPgParams(
        "UPDATE plans SET content = ?, metadata = ?, gate_task_id = ?, re_execute_gate_task_id = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?"
      ),
      [
        strippedContent.content,
        JSON.stringify(prunedMetadata.value),
        nextGateTaskId,
        nextReExecuteGateTaskId,
        now,
        projectId,
        planId,
      ]
    );
  }
}

/**
 * Remove all references to a task from feedback and plans (content, metadata, gate_task_id, etc.).
 * Called before deleting a task so foreign data does not point at the removed task.
 */
export async function cascadeDeleteTaskReferences(
  client: DbClient,
  projectId: string,
  taskId: string
): Promise<void> {
  await removeTaskReferencesFromFeedback(client, projectId, taskId);
  await removeTaskReferencesFromPlans(client, projectId, taskId);
  await client.execute("DELETE FROM governance_task_scopes WHERE project_id=$1 AND task_id=$2", [
    projectId,
    taskId,
  ]);
}
