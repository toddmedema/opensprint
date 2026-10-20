import { describe, expect, it, vi } from "vitest";
import { initAppDb } from "../db/app-db.js";
import { TaskStoreService } from "../services/task-store.service.js";

describe("atomic SQLite task batches", () => {
  it.each(["updateMany", "closeMany"] as const)(
    "rolls back %s for missing and foreign project rows",
    async (method) => {
      const appDb = await initAppDb("sqlite://:memory:");
      const store = new TaskStoreService(await appDb.getClient());
      await store.init();
      try {
        const a = await store.create("A", "First");
        const b = await store.create("B", "Foreign");
        const second = await store.create("A", "Second");
        const before = await store.show("A", a.id);
        const changed = vi.fn();
        store.setOnTaskChange(changed);
        for (const id of ["missing", b.id]) {
          const promise =
            method === "updateMany"
              ? store.updateMany("A", [
                  { id: a.id, priority: 0 },
                  { id, priority: 0 },
                ])
              : store.closeMany("A", [
                  { id: a.id, reason: "done" },
                  { id, reason: "done" },
                ]);
          await expect(promise).rejects.toMatchObject({ statusCode: 404, code: "ISSUE_NOT_FOUND" });
          expect(await store.show("A", a.id)).toEqual(before);
          expect(changed).not.toHaveBeenCalled();
        }
        const successful =
          method === "updateMany"
            ? await store.updateMany("A", [
                { id: second.id, priority: 1 },
                { id: a.id, priority: 1 },
              ])
            : await store.closeMany("A", [
                { id: second.id, reason: "done" },
                { id: a.id, reason: "done" },
              ]);
        expect(successful.map((task) => task.id)).toEqual([second.id, a.id]);
        expect(changed.mock.calls.map((call) => call[2].id)).toEqual([second.id, a.id]);
      } finally {
        await appDb.close();
      }
    }
  );
});
