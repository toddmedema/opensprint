/**
 * Persists promoted behavior version records and the active promoted pointer per project.
 * Execute-session replay metadata reads the active version and template id from this store
 * (not from selfImprovementLastCommitSha or plan version numbers).
 */

import { taskStore } from "./task-store.service.js";
import { BehaviorVersionStore } from "./behavior-version-store.core.js";
import type { AgentRole } from "@opensprint/shared";
import type { BehaviorExperimentCandidateBundle } from "./self-improvement-experiment.service.js";

export { BehaviorVersionStore } from "./behavior-version-store.core.js";

/** Run store mutations under the task store write lock (same transaction as other task DB writes). */
export async function runBehaviorVersionStoreWrite<T>(
  fn: (store: BehaviorVersionStore) => Promise<T>
): Promise<T> {
  return taskStore.runWrite(async (client) => {
    const scoped = new BehaviorVersionStore(() => client);
    return fn(scoped);
  });
}

/** Resolve active behavior + template for Execute under the write lock (may insert sync rows). */
export async function resolveActiveBehaviorForExecute(
  projectId: string,
  activeBehaviorVersionId: string | undefined,
  promotedVersions?: Array<{ id: string; promotedAt: string }>
): Promise<{ behaviorVersionId: string; templateVersionId?: string } | null> {
  return taskStore.runWrite(async (client) => {
    const scoped = new BehaviorVersionStore(() => client);
    return scoped.resolveActiveForExecute(projectId, activeBehaviorVersionId, promotedVersions);
  });
}

/** Active promoted behavior for replay metadata — reads {@link BehaviorVersionStore} only. */
export async function readActivePromotedForExecuteReplay(
  projectId: string
): Promise<{ behaviorVersionId: string; templateVersionId?: string } | null> {
  const client = await taskStore.getDb();
  const scoped = new BehaviorVersionStore(() => client);
  return scoped.readActivePromotedReplayBinding(projectId);
}

/** Content and pointer are read together; legacy metadata-only versions cannot install instructions. */
export async function readActiveBehaviorInstructionContent(
  projectId: string,
  role: AgentRole
): Promise<{
  general: string;
  role: string;
  templates: NonNullable<BehaviorExperimentCandidateBundle["candidateContent"]>["templates"];
  versionId: string;
} | null> {
  const client = await taskStore.getDb();
  const row = await client.queryOne(
    `SELECT v.id, v.bundle FROM project_behavior_state s JOIN behavior_versions v ON v.project_id = s.project_id AND v.id = s.active_promoted_version_id WHERE s.project_id = $1 AND v.version_type = 'promoted'`,
    [projectId]
  );
  if (!row?.bundle) return null;
  const bundle = JSON.parse(String(row.bundle)) as BehaviorExperimentCandidateBundle;
  if (!bundle.candidateContent) return null;
  const content = bundle.candidateContent;
  if (
    typeof content.general !== "string" ||
    typeof content.roles?.[role] !== "string" ||
    !content.templates
  )
    throw new Error("Active behavior release has incomplete content");
  return {
    general: content.general,
    role: content.roles[role]!,
    templates: content.templates,
    versionId: String(row.id),
  };
}
