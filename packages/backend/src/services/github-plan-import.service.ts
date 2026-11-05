import { randomBytes } from "node:crypto";
import type { PlanMetadata } from "@opensprint/shared";
import type { RawExternalItem } from "./integration-adapter.js";
import { taskStore, type TaskStoreService } from "./task-store.service.js";
import { planComplexityToTask } from "./plan-complexity.js";

/** An issue's immutable GitHub id identifies its plan even after a title/repository change. */
export class GitHubPlanImportService {
  constructor(private store: Pick<TaskStoreService, "runWrite"> = taskStore) {}

  async importIssue(projectId: string, raw: RawExternalItem): Promise<boolean> {
    const issue = raw.rawPayload as PlanMetadata["githubIssue"] | undefined;
    if (
      !issue ||
      typeof issue.id !== "string" ||
      !/^\d+$/.test(issue.id) ||
      raw.externalId !== issue.id ||
      !Number.isSafeInteger(issue.number) ||
      issue.number < 1 ||
      typeof issue.repository !== "string" ||
      !/^[\w.-]+\/[\w.-]+$/.test(issue.repository) ||
      issue.url !== `https://github.com/${issue.repository}/issues/${issue.number}`
    ) {
      throw new Error("GitHub issue is missing a valid identity.");
    }
    const planId = `github-issue-${issue.id}`;
    const epicId = `os-${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    const title = raw.title.replace(/[\r\n]+/g, " ").trim();
    if (!title) throw new Error("GitHub issue requires a title.");
    const content = `# ${title}\n\n${raw.body?.trim() || "No description provided."}`;
    const metadata: PlanMetadata = {
      planId,
      epicId,
      shippedAt: null,
      reviewedAt: null,
      complexity: "medium",
      githubIssue: issue,
    };

    return this.store.runWrite(async (client) => {
      // Claim the deterministic plan identity first. The plan, blocked epic, scope, and
      // first version commit together; a crash or concurrent sync cannot orphan an epic.
      const inserted = await client.execute(
        `INSERT INTO plans (project_id, plan_id, epic_id, content, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (project_id, plan_id) DO NOTHING`,
        [projectId, planId, epicId, content, JSON.stringify(metadata), now]
      );
      if (!inserted) {
        const existing = await client.queryOne(
          "SELECT metadata FROM plans WHERE project_id = $1 AND plan_id = $2",
          [projectId, planId]
        );
        let existingMetadata: PlanMetadata | undefined;
        try {
          existingMetadata = JSON.parse(String(existing?.metadata)) as PlanMetadata;
        } catch {
          // Missing or corrupt provenance must not claim that an issue is already tracked.
        }
        if (existingMetadata?.githubIssue?.id !== issue.id) {
          throw new Error("A different plan already uses this GitHub issue's plan ID.");
        }
        return false;
      }
      await client.execute(
        `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, labels, created_at, updated_at, complexity, extra)
         VALUES ($1, $2, $3, $4, 'epic', 'blocked', 2, '[]', $5, $5, $6, '{}')`,
        [epicId, projectId, title, planId, now, planComplexityToTask(metadata.complexity)]
      );
      await client.execute(
        `INSERT INTO governance_task_scopes (project_id, task_id, scope) VALUES ($1, $2, $3)`,
        [projectId, epicId, `${title}\n${planId}`]
      );
      await client.execute(
        `INSERT INTO plan_versions (project_id, plan_id, version_number, title, content, metadata, created_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6)`,
        [projectId, planId, title, content, JSON.stringify(metadata), now]
      );
      return true;
    });
  }
}

export const githubPlanImport = new GitHubPlanImportService();
