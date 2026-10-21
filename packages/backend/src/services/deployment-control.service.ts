import { AsyncLocalStorage } from "node:async_hooks";
import { deployStorageService } from "./deploy-storage.service.js";
import { taskStore } from "./task-store.service.js";
import { databaseNow } from "../db/database-clock.js";

type Effect = {
  projectId: string;
  deployId: string;
  controller: AbortController;
  observedStop: boolean;
  uncertain: boolean;
};
const effects = new Map<string, Effect>();
const context = new AsyncLocalStorage<Effect>();
export function deploymentSignal(): AbortSignal | undefined {
  return context.getStore()?.controller.signal;
}
export function confirmDeploymentStop(): void {
  const effect = context.getStore();
  if (effect) effect.observedStop = true;
}
export function deploymentStopConfirmed(): boolean {
  return context.getStore()?.observedStop ?? false;
}
export function markDeploymentUncertain(): void {
  const effect = context.getStore();
  if (effect) effect.uncertain = true;
}
export function deploymentUncertain(): boolean {
  return context.getStore()?.uncertain ?? false;
}
export async function withDeploymentEffect<T>(
  projectId: string,
  deployId: string,
  fn: () => Promise<T>
): Promise<T> {
  const effect = {
    projectId,
    deployId,
    controller: new AbortController(),
    observedStop: false,
    uncertain: false,
  };
  effects.set(deployId, effect);
  let checking = false;
  const observe = async () => {
    if (checking) return;
    checking = true;
    try {
      const record = await deployStorageService.getRecord(projectId, deployId);
      if (record && ["stop_requested", "uncertain"].includes(record.status))
        effect.controller.abort();
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => {
    void observe().catch(() => effect.controller.abort());
  }, 500);
  timer.unref();
  try {
    await observe();
    return await context.run(effect, fn);
  } finally {
    clearInterval(timer);
    effects.delete(deployId);
  }
}
/** A stop is requested immediately; only an observed command exit completes it. */
export async function requestDeploymentStop(
  projectId: string,
  deployId: string
): Promise<{ stopRequested: boolean; uncertain: boolean }> {
  const record = await deployStorageService.getRecord(projectId, deployId);
  if (!record || !["running", "pending", "stop_requested", "uncertain"].includes(record.status))
    return { stopRequested: false, uncertain: false };
  const effect = effects.get(deployId);
  if (!effect || effect.projectId !== projectId) {
    const healthy = await taskStore.runRead(async (tx) => {
      const now = new Date(await databaseNow(tx)).toISOString();
      return !!(await tx.queryOne(
        "SELECT o.id FROM durable_operations o JOIN operation_owners w ON w.owner_id=o.owner_id WHERE o.project_id=$1 AND o.id=$2 AND o.status='running' AND w.expires_at>$3",
        [projectId, deployId, now]
      ));
    });
    if (healthy) {
      await deployStorageService.updateRecord(projectId, deployId, {
        status: "stop_requested",
        error: "Stop requested; waiting for the owning backend to observe completion.",
      });
      return { stopRequested: true, uncertain: false };
    }
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "uncertain",
      error: "Execution ownership is unknown; inspect the deployment provider before reconciling.",
    });
    return { stopRequested: false, uncertain: true };
  }
  await deployStorageService.updateRecord(projectId, deployId, {
    status: "stop_requested",
    error: "Stop requested; waiting for observed completion.",
  });
  effect.controller.abort();
  return { stopRequested: true, uncertain: false };
}
