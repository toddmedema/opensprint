import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { OperationService } from "../services/operation.service.js";
import { ConversationStore } from "../services/conversation-store.service.js";
import { withOperationEffect } from "../services/operation-effect-context.js";

describe("durable model operation write fencing", () => {
  let db: AppDb;
  let store: TaskStoreService;
  beforeEach(async () => {
    db = await initAppDb("sqlite://:memory:");
    store = new TaskStoreService();
    await store.init("sqlite://:memory:", db);
  });
  afterEach(async () => {
    await db.close();
  });

  it.each(["plan.generate", "chat.send"])(
    "rejects late %s writes after lease expiry and reconciliation",
    async (kind) => {
      const operations = new OperationService(store);
      const queued = await operations.accept({
        projectId: "A",
        actorId: "local-user",
        requestId: "model-request",
        kind,
        target: "sketch",
        payload: {},
      });
      const claimed = (await operations.claim("A", queued.id, "owner"))!;
      const conversations = new ConversationStore(store);
      const conversation = { id: "conversation", context: "sketch" as const, messages: [] };
      const message = {
        role: "assistant" as const,
        content: "Model result",
        timestamp: new Date().toISOString(),
      };
      await withOperationEffect(claimed, () => store.create("A", "Accepted before expiry"));
      await db.runWrite((tx) =>
        tx.execute("UPDATE operation_owners SET expires_at = $1", [new Date(0).toISOString()])
      );
      await expect(
        withOperationEffect(claimed, () => conversations.append("A", conversation, [message]))
      ).rejects.toMatchObject({ code: "OPERATION_FENCE_LOST" });
      await operations.recoverExpired("A");
      await expect(
        withOperationEffect(claimed, () => store.create("A", "Late plan task"))
      ).rejects.toMatchObject({ code: "OPERATION_FENCE_LOST" });
      expect(await conversations.read("A", "sketch")).toBeNull();
      expect(await store.listAll("A")).toHaveLength(1);
      expect((await operations.get("A", queued.id))?.status).toBe("uncertain");
    }
  );
});
