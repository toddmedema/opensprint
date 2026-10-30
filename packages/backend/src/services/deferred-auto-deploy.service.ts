import { agentProcessEnvironment } from "../utils/agent-process-env.js";
import { governanceHash } from "./policy-context.js";
import { taskStore } from "./task-store.service.js";
import { triggerDeployForEvent } from "./deploy-trigger.service.js";
import { notificationService } from "./notification.service.js";
import { deployStorageService } from "./deploy-storage.service.js";
import type { DeployEvent } from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
interface DeferredDeploy {
  event: "each_task" | "each_epic";
  sourceId: string;
  generation: string;
  id: string;
  expectedHeadSha?: string;
}
interface Dependencies {
  read: () => Promise<DbClient>;
  write: <T>(fn: (db: DbClient) => Promise<T>) => Promise<T>;
  deploy: (
    projectId: string,
    event: DeployEvent,
    options: {
      expectedCommitHash: string;
      idempotencyKey: string;
      assertPublicationLease: () => Promise<void>;
    }
  ) => Promise<string[]>;
  status: (projectId: string, id: string) => Promise<string | null>;
  notify?: (projectId: string, id: string, text: string) => Promise<unknown>;
}
const defaults: Dependencies = {
  read: () => taskStore.getDb(),
  write: (fn) => taskStore.runWrite(fn),
  deploy: triggerDeployForEvent,
  status: async (projectId, id) =>
    (await deployStorageService.getRecord(projectId, id))?.status ?? null,
  notify: (projectId, id, text) =>
    notificationService.create({
      projectId,
      source: "execute",
      sourceId: id,
      questions: [{ id, text }],
    }),
};
/** Durable, action-only continuation; it does not repeat task cleanup, counters, review, or self-improvement. */
export class DeferredAutoDeployService {
  constructor(private deps: Dependencies = defaults) {}
  async hasPending(projectId: string): Promise<boolean> {
    return Boolean(
      await (
        await this.deps.read()
      ).queryOne(
        "SELECT id FROM governance_jobs WHERE project_id=$1 AND kind='deferred_auto_deploy' AND state IN ('pending','dispatching') LIMIT 1",
        [projectId]
      )
    );
  }
  async enqueue(
    projectId: string,
    event: DeferredDeploy["event"],
    sourceId: string,
    generation: string
  ): Promise<void> {
    const job: DeferredDeploy = {
      event,
      sourceId,
      generation,
      id: `auto-deploy-${governanceHash([event, sourceId, generation])}`,
    };
    await this.deps.write((db) =>
      db.execute(
        "INSERT INTO governance_jobs(project_id,id,kind,state,payload)VALUES($1,$2,'deferred_auto_deploy','pending',$3) ON CONFLICT DO NOTHING",
        [projectId, job.id, JSON.stringify(job)]
      )
    );
  }
  /** Caller holds publication serialization. Only the exact successfully published head may be deployed. */
  async drain(
    projectId: string,
    repoPath: string,
    expectedHeadSha: string,
    assertPublicationLease: () => Promise<void>
  ): Promise<void> {
    const rows = await (
      await this.deps.read()
    ).query(
      "SELECT id,payload,state FROM governance_jobs WHERE project_id=$1 AND kind='deferred_auto_deploy' AND state IN ('pending','dispatching') ORDER BY id",
      [projectId]
    );
    for (const row of rows) {
      await assertPublicationLease();
      const head = (
        await exec("git", ["rev-parse", "HEAD"], {
          env: agentProcessEnvironment(),
          cwd: repoPath,
          timeout: 10_000,
        })
      ).stdout.trim();
      if (head !== expectedHeadSha)
        throw new Error("Published code changed before its deferred auto-deployment.");
      const job = JSON.parse(String(row.payload)) as DeferredDeploy;
      if (job.expectedHeadSha && job.expectedHeadSha !== expectedHeadSha) {
        await this.deps.write((db) =>
          db.execute(
            "UPDATE governance_jobs SET state='needs_attention' WHERE project_id=$1 AND id=$2",
            [projectId, job.id]
          )
        );
        await this.deps.notify?.(
          projectId,
          job.id,
          "A deferred auto-deployment belongs to an earlier published revision. Inspect Deliver and explicitly deploy the current reviewed revision if needed; it was not run against changed code."
        );
        continue;
      }
      const payload = { ...job, expectedHeadSha };
      await this.deps.write((db) =>
        db.execute(
          "UPDATE governance_jobs SET state='dispatching',payload=$1 WHERE project_id=$2 AND id=$3 AND state IN ('pending','dispatching')",
          [JSON.stringify(payload), projectId, job.id]
        )
      );
      try {
        const ids = await this.deps.deploy(projectId, job.event, {
          expectedCommitHash: expectedHeadSha,
          idempotencyKey: job.id,
          assertPublicationLease,
        });
        const statuses = await Promise.all(ids.map((id) => this.deps.status(projectId, id)));
        const state = statuses.some(
          (status) => status === "pending" || status === "running" || status === null
        )
          ? "needs_attention"
          : statuses.some((status) => status === "failed")
            ? "failed"
            : "complete";
        await this.deps.write((db) =>
          db.execute(
            "UPDATE governance_jobs SET state=$1,payload=$2 WHERE project_id=$3 AND id=$4",
            [state, JSON.stringify({ ...payload, deployIds: ids }), projectId, job.id]
          )
        );
        if (state === "needs_attention")
          await this.deps.notify?.(
            projectId,
            job.id,
            "A deferred auto-deployment has an interrupted or running delivery record. Inspect Deliver before retrying; the server will not launch the same deployment twice."
          );
      } catch (error) {
        const busy = (error as { code?: string }).code === "DEPLOYMENT_BUSY";
        await this.deps.write((db) =>
          db.execute(
            "UPDATE governance_jobs SET state=$1,payload=$2 WHERE project_id=$3 AND id=$4",
            [
              busy ? "pending" : "needs_attention",
              JSON.stringify({
                ...payload,
                error: error instanceof Error ? error.message : String(error),
              }),
              projectId,
              job.id,
            ]
          )
        );
        if (!busy)
          await this.deps.notify?.(
            projectId,
            job.id,
            `Deferred auto-deployment requires attention in Deliver: ${error instanceof Error ? error.message : String(error)}`
          );
      }
    }
  }
}
export const deferredAutoDeployService = new DeferredAutoDeployService();
