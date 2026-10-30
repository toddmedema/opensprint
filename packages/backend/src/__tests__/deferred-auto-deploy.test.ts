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
it("retains and deduplicates task/epic deploy actions across service restart", async () => {
  const first = service();
  await first.enqueue("project", "each_task", "task", "completed");
  await first.enqueue("project", "each_task", "task", "completed");
  await first.enqueue("project", "each_epic", "epic", "reviewed");
  expect(deploy).not.toHaveBeenCalled();
  const restarted = service();
  await restarted.drain("project", repo, head, async () => {});
  expect(deploy).toHaveBeenCalledTimes(2);
  expect(deploy).toHaveBeenCalledWith(
    "project",
    "each_task",
    expect.objectContaining({ expectedCommitHash: head, idempotencyKey: expect.any(String) })
  );
  await restarted.drain("project", repo, head, async () => {});
  expect(deploy).toHaveBeenCalledTimes(2);
});
it("withholds deploy when the actual checkout differs from the published reviewed head", async () => {
  const queue = service();
  await queue.enqueue("project", "each_task", "task", "completed");
  await expect(queue.drain("project", repo, "0".repeat(40), async () => {})).rejects.toThrow(
    "Published code changed"
  );
  expect(deploy).not.toHaveBeenCalled();
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("pending");
});
it("does not rerun an interrupted external deployment blindly", async () => {
  const queue = service("running");
  await queue.enqueue("project", "each_epic", "epic", "reviewed");
  await queue.drain("project", repo, head, async () => {});
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("needs_attention");
  expect(notify).toHaveBeenCalledTimes(1);
  await service().drain("project", repo, head, async () => {});
  expect(deploy).toHaveBeenCalledTimes(1);
});
it("retries a known busy deployment without losing the durable action", async () => {
  const queue = service();
  await queue.enqueue("project", "each_task", "task", "completed");
  deploy.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "DEPLOYMENT_BUSY" }));
  await queue.drain("project", repo, head, async () => {});
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("pending");
  await queue.drain("project", repo, head, async () => {});
  expect((await db.queryOne("SELECT state FROM governance_jobs"))?.state).toBe("complete");
  expect(notify).not.toHaveBeenCalled();
});
