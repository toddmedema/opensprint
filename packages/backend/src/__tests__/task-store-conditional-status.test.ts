import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAppDb, type AppDb } from "../db/app-db.js";
import type { DbClient } from "../db/client.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { createTestPostgresClient } from "./test-db-helper.js";

describe.each(["sqlite", "postgres"] as const)("conditional status (%s)", (dialect) => {
  let app: AppDb | undefined;
  let client: DbClient;
  let store: TaskStoreService;
  let projectId: string;
  let close: () => Promise<unknown>;

  beforeEach(async () => {
    if (dialect === "sqlite") {
      app = await initAppDb("sqlite://:memory:");
      client = await app.getClient();
      close = () => app!.close();
    } else {
      const pg = await createTestPostgresClient();
      if (!pg) throw new Error("Isolated PostgreSQL test database is required");
      client = pg.client;
      close = () => pg.pool.end();
    }
    projectId = randomUUID();
    store = new TaskStoreService(client);
    await store.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.deleteByProjectId(projectId);
    await close();
  });

  it("holds active validation without changing a task closed before the atomic write", async () => {
    const task = await store.create(projectId, "Retain completed coding work");
    await store.update(projectId, task.id, { status: "in_progress" });
    const held = await store.update(projectId, task.id, {
      expectedStatus: "in_progress",
      status: "blocked",
      extra: { local_recovery_incident_id: "incident" },
    });
    expect(held.status).toBe("blocked");
    await store.update(projectId, task.id, { status: "in_progress" });
    const events = vi.fn();
    store.setOnTaskChange(events);
    const execute = client.execute.bind(client);
    const write = vi.spyOn(client, "execute").mockImplementation(async (sql, params) => {
      if (sql.startsWith("UPDATE tasks SET") && sql.includes(" AND status = ")) {
        // Another task-state authority closes it after update() has read its
        // metadata, immediately before the delayed validation writes its hold.
        await execute("UPDATE tasks SET status = $1 WHERE id = $2 AND project_id = $3", [
          "closed",
          task.id,
          projectId,
        ]);
      }
      return execute(sql, params);
    });
    await expect(
      store.update(projectId, task.id, {
        expectedStatus: "in_progress",
        status: "blocked",
        extra: { local_recovery_incident_id: "stale-incident" },
      })
    ).rejects.toMatchObject({ code: ErrorCodes.TASK_STATE_CHANGED, statusCode: 409 });
    write.mockRestore();
    expect(await store.show(projectId, task.id)).toMatchObject({
      status: "closed",
      local_recovery_incident_id: "incident",
    });
    expect(events).not.toHaveBeenCalled();
  });
});
