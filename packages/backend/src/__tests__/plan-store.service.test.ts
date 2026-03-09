import { describe, it, expect, vi } from "vitest";
import { PlanStore } from "../services/plan-store.service.js";
import type { DrizzlePg } from "../db/app-db.js";

function createDbClient() {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    runInTransaction: vi.fn(),
  };
}

describe("PlanStore", () => {
  it("falls back to empty metadata when stored metadata is invalid JSON", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue({
      content: "# Plan",
      metadata: "{invalid",
      shipped_content: null,
      updated_at: "2026-03-03T00:00:00Z",
    });
    const store = new PlanStore(() => client);

    await expect(store.planGet("proj-1", "plan-1")).resolves.toEqual({
      content: "# Plan",
      metadata: {},
      shipped_content: null,
      updated_at: "2026-03-03T00:00:00Z",
    });
  });

  it("returns plans by epic id with parsed metadata", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue({
      plan_id: "plan-1",
      content: "# Plan",
      metadata: JSON.stringify({ epicId: "epic-1" }),
      shipped_content: "shipped",
      updated_at: "2026-03-03T00:00:00Z",
    });
    const store = new PlanStore(() => client);

    await expect(store.planGetByEpicId("proj-1", "epic-1")).resolves.toEqual({
      plan_id: "plan-1",
      content: "# Plan",
      metadata: { epicId: "epic-1" },
      shipped_content: "shipped",
      updated_at: "2026-03-03T00:00:00Z",
    });
  });

  it("decodes double-encoded metadata on read", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue({
      content: "# Plan",
      metadata: JSON.stringify(
        JSON.stringify({
          planId: "plan-1",
          epicId: "epic-1",
          reviewedAt: null,
        })
      ),
      shipped_content: null,
      updated_at: "2026-03-03T00:00:00Z",
    });
    const store = new PlanStore(() => client);

    await expect(store.planGet("proj-1", "plan-1")).resolves.toEqual({
      content: "# Plan",
      metadata: { planId: "plan-1", epicId: "epic-1", reviewedAt: null },
      shipped_content: null,
      updated_at: "2026-03-03T00:00:00Z",
    });
  });

  it("does not double-encode metadata strings when inserting via drizzle", async () => {
    const client = createDbClient();
    const values = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn().mockReturnValue({ values }),
    };
    const store = new PlanStore(() => client, async () => db as unknown as DrizzlePg);

    const metadata = JSON.stringify({ planId: "plan-1", epicId: "epic-1" });
    await store.planInsert("proj-1", "plan-1", {
      epic_id: "epic-1",
      content: "# Plan",
      metadata,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata,
      })
    );
  });

  it("throws PLAN_NOT_FOUND when updating missing plans", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue(undefined);
    const store = new PlanStore(() => client);

    await expect(store.planUpdateContent("proj-1", "plan-404", "# Missing")).rejects.toMatchObject({
      code: "PLAN_NOT_FOUND",
    });
    await expect(store.planSetShippedContent("proj-1", "plan-404", "ship")).rejects.toMatchObject(
      {
        code: "PLAN_NOT_FOUND",
      }
    );
  });

  it("reads and writes shipped content", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValueOnce({ 1: 1 }).mockResolvedValueOnce({ shipped_content: "ok" });
    client.execute.mockResolvedValue(1);
    const store = new PlanStore(() => client);

    await store.planSetShippedContent("proj-1", "plan-1", "ok");
    await expect(store.planGetShippedContent("proj-1", "plan-1")).resolves.toBe("ok");
  });

  it("returns false when deleting a missing plan", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue(undefined);
    const store = new PlanStore(() => client);

    await expect(store.planDelete("proj-1", "plan-1")).resolves.toBe(false);
  });
});
