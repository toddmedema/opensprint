import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_HIL_CONFIG, type ProjectIdentity } from "@opensprint/shared";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { taskStore } from "../services/task-store.service.js";
import {
  setSettingsStorePathForTesting,
  transformRawSettingsInStore,
  getRawSettingsRecord,
  getSettingsWithMetaFromStore,
  deleteSettingsFromStore,
} from "../services/settings-store.service.js";
import { runWithRequestContext } from "../services/request-context.js";
import { NotificationService } from "../services/notification.service.js";
import { CollaborationService } from "../services/collaboration.service.js";

const alice: ProjectIdentity = {
  actorId: "alice",
  displayName: "Alice",
  role: "controller",
  permissions: ["read", "edit", "approve"],
  local: false,
};
const defaults = {
  simpleComplexityAgent: { type: "cursor" as const, model: null, cliCommand: null },
  complexComplexityAgent: { type: "cursor" as const, model: null, cliCommand: null },
  deployment: { mode: "custom" as const },
  hilConfig: DEFAULT_HIL_CONFIG,
  testFramework: null,
};

describe("SQL project settings and approvals", () => {
  let db: AppDb;
  let directory: string;
  let oldHome: string | undefined;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "settings-sql-"));
    oldHome = process.env.HOME;
    process.env.HOME = directory;
    setSettingsStorePathForTesting(null);
    await taskStore.closePool();
    db = await initAppDb("sqlite://:memory:");
    await taskStore.init(undefined, db);
  });
  afterEach(async () => {
    await taskStore.closePool();
    await db.close();
    process.env.HOME = oldHome;
    setSettingsStorePathForTesting(null);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("imports raw settings once, preserves absent inheritance, and does not resurrect deleted settings", async () => {
    await fs.mkdir(path.join(directory, ".opensprint"), { recursive: true });
    await fs.writeFile(
      path.join(directory, ".opensprint", "settings.json"),
      JSON.stringify({
        p: {
          settings: { testCommand: "legacy", apiKeys: { secret: "no" } },
          revision: 7,
          updatedAt: "2025-01-01T00:00:00Z",
        },
      })
    );
    expect(await getRawSettingsRecord("p")).toEqual({ testCommand: "legacy" });
    expect(await getSettingsWithMetaFromStore("p", defaults)).toMatchObject({ revision: 7 });
    await transformRawSettingsInStore("p", (current) => ({
      ...current,
      testCommand: "SQL authoritative",
    }));
    expect(await getRawSettingsRecord("p")).toEqual({ testCommand: "SQL authoritative" });
    await deleteSettingsFromStore("p");
    expect(await getRawSettingsRecord("p")).toEqual({});
  });

  it("compares settings revisions atomically and returns the original accepted retry", async () => {
    await transformRawSettingsInStore("p", () => ({
      testCommand: "before",
      background: "preserved",
    }));
    const edit = (requestId: string, testCommand: string) =>
      runWithRequestContext(
        { principal: alice, projectId: "p", requestId, expectedRevision: 1 },
        () =>
          transformRawSettingsInStore("p", (current) => ({ ...current, testCommand }), {
            testCommand,
          })
      );
    const results = await Promise.allSettled([edit("edit-a", "A"), edit("edit-b", "B")]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { statusCode: 409, details: { revision: 2, state: { testCommand: "A" } } },
    });
    await transformRawSettingsInStore("p", (current) => ({
      ...current,
      background: "new background",
    }));
    expect(await edit("edit-a", "A")).toMatchObject({
      revision: 2,
      settings: { background: "preserved" },
    });
    expect(await getRawSettingsRecord("p")).toEqual({
      testCommand: "A",
      background: "new background",
    });
    await expect(edit("edit-a", "mutated retry")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("persists exactly one approval decision with a semantic event and durable idempotent receipt", async () => {
    const notifications = new NotificationService();
    const notification = await notifications.createHilApproval({
      projectId: "p",
      source: "prd",
      sourceId: "proposal",
      description: "Approve this proposal",
      category: "scope",
    });
    const resolve = (actorId: string, requestId: string, approved: boolean) =>
      runWithRequestContext(
        { principal: { ...alice, actorId }, projectId: "p", requestId, expectedRevision: 1 },
        () => notifications.resolve("p", notification.id, { approved })
      );
    const results = await Promise.allSettled([
      resolve("alice", "yes", true),
      resolve("bob", "no", false),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { statusCode: 409, details: { revision: 2 } },
    });
    const first = (results[0] as PromiseFulfilledResult<unknown>).value;
    expect(await resolve("alice", "yes", true)).toEqual(first);
    expect(await notifications.getById("p", notification.id)).toMatchObject({
      status: "resolved",
      revision: 2,
      responses: [{ answer: "approved" }],
    });
    expect(
      (await new CollaborationService(taskStore).replay("p")).events.map((event) => event.type)
    ).toEqual(["approval_changed", "approval_changed"]);
  });
});
