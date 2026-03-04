/**
 * In-memory buffer for plan-scoped agent output (e.g. Auditor during Re-execute).
 * Used for backfill when clients subscribe mid-stream.
 */
type BufferKey = string;

const buffers = new Map<BufferKey, string>();

function key(projectId: string, planId: string): BufferKey {
  return `${projectId}:${planId}`;
}

export function appendPlanAgentOutput(projectId: string, planId: string, chunk: string): void {
  const k = key(projectId, planId);
  const existing = buffers.get(k) ?? "";
  buffers.set(k, existing + chunk);
}

export function getPlanAgentOutput(projectId: string, planId: string): string {
  return buffers.get(key(projectId, planId)) ?? "";
}

export function clearPlanAgentOutput(projectId: string, planId: string): void {
  buffers.delete(key(projectId, planId));
}
