import { createHash } from "node:crypto";
import type { DbClient } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";
import { getRequestContext } from "./request-context.js";

/** Lock before touching project resources. Held until the caller's transaction commits. */
export async function lockProject(tx: DbClient, projectId: string): Promise<number> {
  await tx.execute(
    "INSERT INTO collaboration_projects (project_id, cursor) VALUES ($1, 0) ON CONFLICT (project_id) DO NOTHING",
    [projectId]
  );
  const row = await tx.queryOne(
    "UPDATE collaboration_projects SET cursor = cursor WHERE project_id = $1 RETURNING cursor",
    [projectId]
  );
  return Number(row!.cursor);
}

export async function appendProjectEvent(
  tx: DbClient,
  input: { projectId: string; actorId?: string; type: string; payload: unknown },
  retention = 10_000
): Promise<number> {
  const cursor = (await lockProject(tx, input.projectId)) + 1;
  if (!Number.isSafeInteger(cursor)) throw new Error("Project event cursor exhausted.");
  const event = {
    ...input,
    actorId: input.actorId ?? getRequestContext()?.principal.actorId ?? "system",
    cursor,
    createdAt: new Date().toISOString(),
  };
  await tx.execute("UPDATE collaboration_projects SET cursor = $2 WHERE project_id = $1", [
    input.projectId,
    cursor,
  ]);
  await tx.execute(
    "INSERT INTO collaboration_events (project_id, cursor, event) VALUES ($1, $2, $3)",
    [input.projectId, cursor, JSON.stringify(event)]
  );
  await tx.execute("DELETE FROM collaboration_events WHERE project_id = $1 AND cursor <= $2", [
    input.projectId,
    cursor - retention,
  ]);
  return cursor;
}

export async function getResourceRevision(
  tx: DbClient,
  projectId: string,
  type: string,
  id: string
): Promise<number> {
  const row = await tx.queryOne(
    "SELECT revision FROM resource_revisions WHERE project_id = $1 AND resource_type = $2 AND resource_id = $3",
    [projectId, type, id]
  );
  return Number(row?.revision ?? 0);
}

export async function assertResourceRevision(
  tx: DbClient,
  projectId: string,
  type: string,
  id: string,
  expected: number,
  state?: unknown
): Promise<number> {
  const revision = await getResourceRevision(tx, projectId, type, id);
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw new AppError(
      400,
      "EXPECTED_REVISION_REQUIRED",
      "A nonnegative expected revision is required."
    );
  if (revision !== expected)
    throw new AppError(409, "REVISION_CONFLICT", "The resource changed. Refresh before retrying.", {
      revision,
      state,
    });
  return revision;
}

export async function resourceChanged(
  tx: DbClient,
  projectId: string,
  type: string,
  id: string,
  payload: unknown,
  actorId?: string
): Promise<number> {
  const row = await tx.queryOne(
    "INSERT INTO resource_revisions (project_id, resource_type, resource_id, revision) VALUES ($1, $2, $3, 1) ON CONFLICT (project_id, resource_type, resource_id) DO UPDATE SET revision = resource_revisions.revision + 1 RETURNING revision",
    [projectId, type, id]
  );
  const revision = Number(row!.revision);
  await appendProjectEvent(tx, {
    projectId,
    actorId,
    type: `${type}_changed`,
    payload: { id, revision, state: payload },
  });
  return revision;
}

/** Stable JSON: object key order does not change idempotency identity. */
export function stableFingerprint(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)])
      );
    return input;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
