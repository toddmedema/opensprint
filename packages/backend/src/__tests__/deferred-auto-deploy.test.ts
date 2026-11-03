import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient } from "../db/sqlite-client.js";
import { runSchema } from "../db/schema.js";
import { DeferredAutoDeployService } from "../services/deferred-auto-deploy.service.js";
const run = promisify(execFile);
let repo: string, native: Database.Database, db: DbClient, head: string;
const deploy = vi.fn(),
  notify = vi.fn();
beforeEach(async () => {
  deploy.mockReset().mockResolvedValue(["deploy"]);
  notify.mockReset();
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "deferred-deploy-"));
  await run("git", ["init", "-b", "main"], { cwd: repo });
  await fs.writeFile(path.join(repo, "app.ts"), "export const app = true;\n");
  await run("git", ["add", "."], { cwd: repo });
  await run(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "reviewed"],
    { cwd: repo }
  );
  head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  native = new Database(":memory:");
  db = createSqliteDbClient(native);
  await runSchema(db, "sqlite");
});
afterEach(async () => {
  native.close();
  await fs.rm(repo, { recursive: true, force: true });
});
function service(status = "success") {
  return new DeferredAutoDeployService({
    read: async () => db,
    write: (fn) => db.runInTransaction(fn),
    deploy,
    status: async () => status,
    notify,
  });
}
/** The lock covers claim; runClaimed happens after the caller has released it. */
async function drain(queue: DeferredAutoDeployService, expectedHead: string) {
  await queue.runClaimed(
    "project",
    await queue.claim("project", repo, expectedHead, async () => {})
  );
}
it("retains and deduplicates task/epic deploy actions across service restart", async () => {
  const first = service();
  await first.enqueue("project", "each_task", "task", "completed");
  await first.enqueue("project", "each_task", "task", "completed");
  await first.enqueue("project", "each_epic", "epic", "reviewed");
  expect(deploy).not.toHaveBeenCalled();
  const restarted = service();
  await drain(restarted, head);
  expect(deploy).toHaveBeenCalledTimes(2);
  expect(deploy).toHaveBeenCalledWith(
    "project",
    "each_task",
    expect.objectContaining({ expectedCommitHash: head, idempotencyKey: expect.any(String) })
  );
  await drain(restarted, head);
  expect(deploy).toHaveBeenCalledTimes(2);
});
it("withholds deploy when the actual checkout differs from the published reviewed head", async () => {
  const queue = service();
  await queue.enqueue("project", "each_task", "task", "completed");
  await expect(drain(queue, "0".repeat(40))).rejects.toThrow("Published code changed");
  expect(deploy).not.toHaveBeenCalled();
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("pending");
});
it("does not rerun an interrupted external deployment blindly", async () => {
  const queue = service("running");
  await queue.enqueue("project", "each_epic", "epic", "reviewed");
  await drain(queue, head);
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("needs_attention");
  expect(notify).toHaveBeenCalledTimes(1);
  await drain(service(), head);
  expect(deploy).toHaveBeenCalledTimes(1);
});
it("retries a known busy deployment without losing the durable action", async () => {
  const queue = service();
  await queue.enqueue("project", "each_task", "task", "completed");
  deploy.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "DEPLOYMENT_BUSY" }));
  await drain(queue, head);
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("pending");
  await drain(queue, head);
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("complete");
  expect(notify).not.toHaveBeenCalled();
});
it("claims under the lock and does not start the deployment until runClaimed", async () => {
  const queue = service();
  await queue.enqueue("project", "each_task", "task", "completed");
  const claimed = await queue.claim("project", repo, head, async () => {});
  expect(claimed).toHaveLength(1);
  expect(deploy).not.toHaveBeenCalled();
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("dispatching");
  await queue.runClaimed("project", claimed);
  expect(deploy).toHaveBeenCalledOnce();
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("complete");
});
it("does not claim a job that is still running in this process", async () => {
  const queue = service();
  await queue.enqueue("project", "each_task", "task", "completed");
  const claimed = await queue.claim("project", repo, head, async () => {});
  expect(await queue.claim("project", repo, head, async () => {})).toEqual([]);
  await queue.runClaimed("project", claimed);
  expect(deploy).toHaveBeenCalledOnce();
});
