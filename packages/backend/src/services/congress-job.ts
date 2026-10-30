import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client.js";
export interface CongressDraftClaim {
  nominationId: string;
  attempts: number;
  token: string;
  leaseExpiresAt: number;
  nextRetryAt?: number;
  error?: string;
}
/** Bounded durable claims recover after a crash and do not let old failures starve newer nominations. */
export async function claimCongressDraft(
  db: DbClient,
  projectId: string,
  nominationId: string,
  at = Date.now()
): Promise<CongressDraftClaim | null> {
  const jobId = `draft-${nominationId}`;
  const existing = await db.queryOne(
    "SELECT state,payload FROM governance_jobs WHERE project_id=$1 AND id=$2",
    [projectId, jobId]
  );
  let attempts = 0;
  if (existing) {
    const previous = JSON.parse(String(existing.payload)) as Partial<CongressDraftClaim>;
    attempts = previous.attempts ?? 0;
    if (
      existing.state === "complete" ||
      attempts >= 3 ||
      (existing.state === "running" && (previous.leaseExpiresAt ?? 0) > at) ||
      (previous.nextRetryAt ?? 0) > at
    )
      return null;
  }
  const claim = {
    nominationId,
    attempts: attempts + 1,
    token: randomUUID(),
    leaseExpiresAt: at + 600_000,
  };
  const payload = JSON.stringify(claim);
  const changed = existing
    ? await db.execute(
        "UPDATE governance_jobs SET state='running',payload=$1 WHERE project_id=$2 AND id=$3 AND state=$4 AND payload=$5",
        [payload, projectId, jobId, existing.state, existing.payload]
      )
    : await db.execute(
        "INSERT INTO governance_jobs(project_id,id,kind,state,payload) VALUES($1,$2,'draft_amendment','running',$3) ON CONFLICT DO NOTHING",
        [projectId, jobId, payload]
      );
  return changed === 1 ? claim : null;
}
export async function finishCongressDraft(
  db: DbClient,
  projectId: string,
  claim: CongressDraftClaim,
  error?: string
): Promise<void> {
  const oldPayload = JSON.stringify(claim);
  const payload = error
    ? JSON.stringify({
        ...claim,
        error,
        nextRetryAt: Date.now() + 60_000 * 2 ** (claim.attempts - 1),
      })
    : oldPayload;
  await db.execute(
    "UPDATE governance_jobs SET state=$1,payload=$2 WHERE project_id=$3 AND id=$4 AND state='running' AND payload=$5",
    [error ? "failed" : "complete", payload, projectId, `draft-${claim.nominationId}`, oldPayload]
  );
}
