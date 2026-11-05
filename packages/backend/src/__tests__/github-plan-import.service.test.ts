import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/client.js";
import { initAppDb } from "../db/app-db.js";
import { GitHubPlanImportService } from "../services/github-plan-import.service.js";
import type { RawExternalItem } from "../services/integration-adapter.js";
import { createTestPostgresClient } from "./test-db-helper.js";

function issue(overrides: Partial<RawExternalItem> = {}): RawExternalItem {
  return {
    externalId: "123",
    title: "Add project search",
    body: "Search projects by name.",
    rawPayload: {
      id: "123",
      number: 42,
      repository: "octocat/hello-world",
      url: "https://github.com/octocat/hello-world/issues/42",
    },
    ...overrides,
  };
}

describe.each(["sqlite", "postgres"] as const)("GitHub plan import with %s", (dialect) => {
  let client: DbClient;
  let runWrite: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
  let close: () => Promise<void>;
  let projectId: string;
  let importer: GitHubPlanImportService;

  beforeEach(async () => {
    projectId = `github-import-${randomUUID()}`;
    if (dialect === "sqlite") {
      const db = await initAppDb("sqlite://:memory:");
      client = await db.getClient();
      runWrite = (fn) => db.runWrite(fn);
      close = () => db.close();
    } else {
      const db = await createTestPostgresClient();
      if (!db) throw new Error("PostgreSQL is required to verify GitHub issue import.");
      client = db.client;
      runWrite = (fn) => client.runInTransaction(fn);
      close = () => db.pool.end();
    }
    importer = new GitHubPlanImportService({ runWrite });
  });

  afterEach(async () => {
    if (!client) return;
    for (const table of ["plan_versions", "plans", "governance_task_scopes", "tasks"]) {
      await client.execute(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]);
    }
    await close();
  });

  it("persists a blocked planning epic, source metadata and first version together", async () => {
    expect(await importer.importIssue(projectId, issue())).toBe(true);
    const plans = await client.query("SELECT * FROM plans WHERE project_id = $1", [projectId]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      plan_id: "github-issue-123",
      content: "# Add project search\n\nSearch projects by name.",
      current_version_number: 1,
      last_executed_version_number: null,
    });
    expect(JSON.parse(plans[0].metadata as string).githubIssue).toEqual(issue().rawPayload);
    const tasks = await client.query("SELECT * FROM tasks WHERE project_id = $1", [projectId]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: plans[0].epic_id,
      title: "Add project search",
      issue_type: "epic",
      status: "blocked",
    });
    expect(
      await client.query("SELECT * FROM plan_versions WHERE project_id = $1", [projectId])
    ).toHaveLength(1);
    expect(
      await client.query("SELECT * FROM governance_task_scopes WHERE project_id = $1", [projectId])
    ).toHaveLength(1);
  });

  it("imports once under concurrent retries and preserves local edits and the original source", async () => {
    const outcomes = await Promise.all([
      importer.importIssue(projectId, issue()),
      importer.importIssue(projectId, issue()),
      importer.importIssue(projectId, issue()),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await client.execute("UPDATE plans SET content = $1 WHERE project_id = $2", [
      "# My local plan\n\nRevised scope.",
      projectId,
    ]);
    expect(
      await importer.importIssue(
        projectId,
        issue({ title: "Renamed upstream issue", body: "Changed upstream description" })
      )
    ).toBe(false);
    const plans = await client.query("SELECT * FROM plans WHERE project_id = $1", [projectId]);
    expect(plans).toHaveLength(1);
    expect(plans[0].content).toBe("# My local plan\n\nRevised scope.");
    expect(JSON.parse(plans[0].metadata as string).githubIssue).toEqual(issue().rawPayload);
    expect(
      await client.query("SELECT * FROM tasks WHERE project_id = $1", [projectId])
    ).toHaveLength(1);
    expect(
      await client.query("SELECT * FROM plan_versions WHERE project_id = $1", [projectId])
    ).toHaveLength(1);
  });

  it("keeps equal titles and issue numbers in different repositories distinct", async () => {
    expect(await importer.importIssue(projectId, issue())).toBe(true);
    expect(
      await importer.importIssue(
        projectId,
        issue({
          externalId: "456",
          rawPayload: {
            id: "456",
            number: 42,
            repository: "octocat/another-repo",
            url: "https://github.com/octocat/another-repo/issues/42",
          },
        })
      )
    ).toBe(true);
    expect(
      await client.query("SELECT * FROM plans WHERE project_id = $1", [projectId])
    ).toHaveLength(2);
    expect(
      await client.query("SELECT * FROM tasks WHERE project_id = $1", [projectId])
    ).toHaveLength(2);
  });

  it("rolls back every write when the initial version cannot be stored and retries cleanly", async () => {
    const failingImporter = new GitHubPlanImportService({
      runWrite: (fn) =>
        runWrite((tx) =>
          fn({
            ...tx,
            execute: async (sql, params) => {
              if (sql.includes("INSERT INTO plan_versions"))
                throw new Error("Version storage unavailable");
              return tx.execute(sql, params);
            },
          })
        ),
    });
    await expect(failingImporter.importIssue(projectId, issue())).rejects.toThrow(
      "Version storage unavailable"
    );
    for (const table of ["plans", "tasks", "governance_task_scopes", "plan_versions"]) {
      expect(
        await client.query(`SELECT * FROM ${table} WHERE project_id = $1`, [projectId])
      ).toHaveLength(0);
    }
    expect(await importer.importIssue(projectId, issue())).toBe(true);
  });

  it("reports a conflicting ordinary plan instead of claiming the issue is already tracked", async () => {
    await client.execute(
      "INSERT INTO plans (project_id, plan_id, epic_id, content, metadata, updated_at) VALUES ($1, 'github-issue-123', 'manual-epic', '# Manual plan', '{}', $2)",
      [projectId, new Date().toISOString()]
    );
    await expect(importer.importIssue(projectId, issue())).rejects.toThrow("different plan");
    const plans = await client.query("SELECT * FROM plans WHERE project_id = $1", [projectId]);
    expect(plans).toHaveLength(1);
    expect(plans[0].content).toBe("# Manual plan");
    expect(
      await client.query("SELECT * FROM tasks WHERE project_id = $1", [projectId])
    ).toHaveLength(0);
  });

  it.each([
    { ...issue(), title: " \n " },
    issue({ externalId: "999" }),
    issue({ rawPayload: { ...(issue().rawPayload as object), url: "https://example.com/stolen" } }),
    issue({
      rawPayload: { ...(issue().rawPayload as object), repository: "octocat/repo/../../evil" },
    }),
  ])("rejects invalid source data before persisting a plan", async (invalid) => {
    await expect(importer.importIssue(projectId, invalid)).rejects.toThrow();
    expect(
      await client.query("SELECT * FROM plans WHERE project_id = $1", [projectId])
    ).toHaveLength(0);
    expect(
      await client.query("SELECT * FROM tasks WHERE project_id = $1", [projectId])
    ).toHaveLength(0);
  });
});
