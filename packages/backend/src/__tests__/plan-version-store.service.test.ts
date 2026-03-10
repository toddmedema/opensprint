import { describe, it, expect, vi } from "vitest";
import { PlanVersionStore } from "../services/plan-version-store.service.js";

function createDbClient() {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    runInTransaction: vi.fn(),
  };
}

describe("PlanVersionStore", () => {
  it("insert returns stored row with all fields", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue({
      id: 1,
      project_id: "proj-1",
      plan_id: "plan-1",
      version_number: 1,
      title: "v1",
      content: "# Plan content",
      metadata: "{}",
      created_at: "2026-03-09T12:00:00Z",
      is_executed_version: 0,
    });
    const store = new PlanVersionStore(() => client);

    const row = await store.insert({
      project_id: "proj-1",
      plan_id: "plan-1",
      version_number: 1,
      title: "v1",
      content: "# Plan content",
      metadata: "{}",
      is_executed_version: false,
    });

    expect(row).toEqual({
      id: 1,
      project_id: "proj-1",
      plan_id: "plan-1",
      version_number: 1,
      title: "v1",
      content: "# Plan content",
      metadata: "{}",
      created_at: "2026-03-09T12:00:00Z",
      is_executed_version: false,
    });
  });

  it("insert with is_executed_version true and normalizes boolean from integer", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue({
      id: 2,
      project_id: "p",
      plan_id: "pl",
      version_number: 2,
      title: null,
      content: "x",
      metadata: null,
      created_at: "2026-03-09T12:00:00Z",
      is_executed_version: 1,
    });
    const store = new PlanVersionStore(() => client);

    const row = await store.insert({
      project_id: "p",
      plan_id: "pl",
      version_number: 2,
      content: "x",
      is_executed_version: true,
    });

    expect(row.is_executed_version).toBe(true);
  });

  it("list returns items ordered by version_number DESC", async () => {
    const client = createDbClient();
    client.query.mockResolvedValue([
      {
        id: 3,
        project_id: "proj-1",
        plan_id: "plan-1",
        version_number: 3,
        title: "v3",
        created_at: "2026-03-09T14:00:00Z",
        is_executed_version: 1,
      },
      {
        id: 2,
        project_id: "proj-1",
        plan_id: "plan-1",
        version_number: 2,
        title: "v2",
        created_at: "2026-03-09T13:00:00Z",
        is_executed_version: 0,
      },
      {
        id: 1,
        project_id: "proj-1",
        plan_id: "plan-1",
        version_number: 1,
        title: "v1",
        created_at: "2026-03-09T12:00:00Z",
        is_executed_version: 0,
      },
    ]);
    const store = new PlanVersionStore(() => client);

    const list = await store.list("proj-1", "plan-1");

    expect(list).toHaveLength(3);
    expect(list[0].version_number).toBe(3);
    expect(list[1].version_number).toBe(2);
    expect(list[2].version_number).toBe(1);
    expect(list[0].is_executed_version).toBe(true);
    expect(list[1].is_executed_version).toBe(false);
  });

  it("list returns empty when no versions", async () => {
    const client = createDbClient();
    client.query.mockResolvedValue([]);
    const store = new PlanVersionStore(() => client);

    const list = await store.list("proj-1", "plan-1");

    expect(list).toEqual([]);
  });

  it("getByVersionNumber returns full row", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue({
      id: 1,
      project_id: "proj-1",
      plan_id: "plan-1",
      version_number: 2,
      title: "v2",
      content: "# Full content",
      metadata: '{"key":"value"}',
      created_at: "2026-03-09T13:00:00Z",
      is_executed_version: 0,
    });
    const store = new PlanVersionStore(() => client);

    const row = await store.getByVersionNumber("proj-1", "plan-1", 2);

    expect(row.content).toBe("# Full content");
    expect(row.metadata).toBe('{"key":"value"}');
    expect(row.version_number).toBe(2);
  });

  it("getByVersionNumber throws 404 when version missing", async () => {
    const client = createDbClient();
    client.queryOne.mockResolvedValue(undefined);
    const store = new PlanVersionStore(() => client);

    await expect(store.getByVersionNumber("proj-1", "plan-1", 99)).rejects.toMatchObject({
      statusCode: 404,
      code: "PLAN_VERSION_NOT_FOUND",
    });
  });

  it("setExecutedVersion clears others and sets the one", async () => {
    const client = createDbClient();
    client.execute.mockResolvedValue(1);
    const store = new PlanVersionStore(() => client);

    await store.setExecutedVersion("proj-1", "plan-1", 2);

    expect(client.execute).toHaveBeenCalledTimes(2);
  });

  it("setExecutedVersion throws 404 when version missing", async () => {
    const client = createDbClient();
    client.execute.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const store = new PlanVersionStore(() => client);

    await expect(store.setExecutedVersion("proj-1", "plan-1", 99)).rejects.toMatchObject({
      statusCode: 404,
      code: "PLAN_VERSION_NOT_FOUND",
    });
  });
});
