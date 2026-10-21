import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { specMarkdownToPrd } from "@opensprint/shared";
import type { DbClient, DbRow } from "../db/client.js";
import { taskStore } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";
import { hashSpecContent } from "./prd-proposal-store.js";
import { withProjectMutation } from "./project-mutation-lock.js";
import { validationWorkspaceService } from "./validation-workspace.service.js";
import { runMergeQualityGates } from "./merge-quality-gate-runner.js";
import { AppError } from "../middleware/error-handler.js";
import { getGitNoHooksPath } from "../utils/git-no-hooks.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";

const execFileAsync = promisify(execFile);
async function git(repoPath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

interface PublicationStore {
  runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  getDb(): Promise<DbClient>;
}
interface PublicationDeps {
  store?: PublicationStore;
  projects?: Pick<ProjectService, "getProject" | "getSettings">;
  validate?: (
    projectId: string,
    repoPath: string,
    candidatePath: string,
    baseSha: string
  ) => Promise<void>;
}
function conflict(message: string, details?: unknown): never {
  throw new AppError(409, "REVISION_CONFLICT", message, details);
}

/** Immutable SQL drafts; only this trusted local publisher advances their Git destination. */
export class SpecPublicationService {
  private store: PublicationStore;
  private projects: NonNullable<PublicationDeps["projects"]>;
  private validate: NonNullable<PublicationDeps["validate"]>;
  constructor(deps: PublicationDeps = {}) {
    this.store = deps.store ?? taskStore;
    this.projects = deps.projects ?? new ProjectService();
    this.validate =
      deps.validate ??
      (async (projectId, repoPath, candidatePath, baseSha) => {
        const settings = await this.projects.getSettings(projectId);
        const failure = await runMergeQualityGates({
          projectId,
          repoPath,
          worktreePath: candidatePath,
          taskId: "spec-publication",
          branchName: "HEAD",
          baseBranch: baseSha,
          validationWorkspace: "merged_candidate",
          toolchainProfile: settings.toolchainProfile,
        });
        if (failure)
          throw new Error(`Publication gate failed: ${failure.command}: ${failure.reason}`);
      });
  }

  async getDraft(projectId: string, revision?: number): Promise<DbRow | null> {
    await this.projects.getProject(projectId);
    const db = await this.store.getDb();
    const draft = await db.queryOne(
      revision === undefined
        ? `SELECT d.*, EXISTS (SELECT 1 FROM spec_draft_approvals a
           WHERE a.project_id = d.project_id AND a.revision = d.revision
           AND a.content_hash = d.content_hash AND a.base_sha = d.base_sha
           AND a.destination = d.base_ref) AS approved FROM spec_drafts d JOIN spec_draft_heads h
           ON h.project_id = d.project_id AND h.revision = d.revision WHERE d.project_id = $1`
        : `SELECT d.*, EXISTS (SELECT 1 FROM spec_draft_approvals a
           WHERE a.project_id = d.project_id AND a.revision = d.revision
           AND a.content_hash = d.content_hash AND a.base_sha = d.base_sha
           AND a.destination = d.base_ref) AS approved FROM spec_drafts d
           WHERE d.project_id = $1 AND d.revision = $2`,
      revision === undefined ? [projectId] : [projectId, revision]
    );
    return draft ? { ...draft, approved: Boolean(draft.approved) } : null;
  }

  async saveDraft(projectId: string, content: string, expectedRevision: number): Promise<DbRow> {
    content = content.replace(/\r\n?/g, "\n");
    return withProjectMutation(projectId, async () => {
      const project = await this.projects.getProject(projectId);
      const baseSha = await git(project.repoPath, "rev-parse", "HEAD");
      const baseRef = await git(project.repoPath, "symbolic-ref", "HEAD");
      const baseContent = await fs.readFile(path.join(project.repoPath, "SPEC.md"), "utf8");
      const revision = expectedRevision + 1;
      await this.store.runWrite(async (tx) => {
        await tx.execute(
          `INSERT INTO spec_draft_heads (project_id, revision) VALUES ($1, 0)
          ON CONFLICT(project_id) DO NOTHING`,
          [projectId]
        );
        const changed = await tx.execute(
          "UPDATE spec_draft_heads SET revision = $1 WHERE project_id = $2 AND revision = $3",
          [revision, projectId, expectedRevision]
        );
        if (changed !== 1) conflict("The draft changed. Refresh before saving.");
        await tx.execute(
          `INSERT INTO spec_drafts
          (project_id, revision, content, content_hash, base_sha, base_ref, base_content_hash, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            projectId,
            revision,
            content,
            hashSpecContent(content),
            baseSha,
            baseRef,
            hashSpecContent(baseContent),
            new Date().toISOString(),
          ]
        );
      });
      return (await this.getDraft(projectId, revision))!;
    });
  }

  async approve(projectId: string, revision: number, contentHash: string): Promise<void> {
    await this.projects.getProject(projectId);
    await this.store.runWrite(async (tx) => {
      // Lock the head before checking: another draft invalidates this approval.
      await tx.execute("UPDATE spec_draft_heads SET revision = revision WHERE project_id = $1", [
        projectId,
      ]);
      const draft = await tx.queryOne(
        `SELECT d.* FROM spec_drafts d JOIN spec_draft_heads h
        ON h.project_id = d.project_id AND h.revision = d.revision
        WHERE d.project_id = $1 AND d.revision = $2`,
        [projectId, revision]
      );
      if (!draft || draft.content_hash !== contentHash)
        conflict("The proposal changed before approval.");
      await tx.execute(
        `INSERT INTO spec_draft_approvals
        (project_id, revision, content_hash, base_sha, destination, approved_at)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(project_id, revision) DO NOTHING`,
        [projectId, revision, contentHash, draft.base_sha, draft.base_ref, new Date().toISOString()]
      );
    });
  }

  private async updateOperation(
    projectId: string,
    operationId: string,
    status: string,
    commitSha: string | null,
    error: string | null = null
  ): Promise<void> {
    await this.store.runWrite(async (tx) => {
      await tx.execute(
        `UPDATE spec_publications SET status = $1, commit_sha = $2,
        error = $3, updated_at = $4 WHERE project_id = $5 AND operation_id = $6`,
        [status, commitSha, error, new Date().toISOString(), projectId, operationId]
      );
    });
  }

  private async finalizePublished(
    projectId: string,
    operationId: string,
    draft: DbRow,
    commitSha: string
  ): Promise<void> {
    await this.store.runWrite(async (tx) => {
      const operation = await tx.queryOne(
        "SELECT document_version FROM spec_publications WHERE project_id = $1 AND operation_id = $2",
        [projectId, operationId]
      );
      if (operation?.document_version != null) {
        await tx.execute(
          "UPDATE spec_publications SET status = 'published', error = NULL WHERE project_id = $1 AND operation_id = $2",
          [projectId, operationId]
        );
        return;
      }
      const metadata = await tx.queryOne(
        "SELECT version, change_log FROM prd_metadata WHERE project_id = $1",
        [projectId]
      );
      const version = Number(metadata?.version ?? 0) + 1;
      const prd = specMarkdownToPrd(String(draft.content));
      const versions = Object.fromEntries(Object.keys(prd.sections).map((key) => [key, version]));
      const now = new Date().toISOString();
      let changeLog: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(String(metadata?.change_log ?? "[]"));
        if (Array.isArray(parsed)) changeLog = parsed;
      } catch {
        /* Repair malformed legacy history. */
      }
      changeLog.push({
        section: "document",
        version,
        source: "sketch",
        timestamp: now,
        diff: `Published approved draft ${draft.revision}`,
        documentVersion: version,
      });
      await tx.execute(
        `INSERT INTO prd_metadata (project_id, version, change_log, section_versions, updated_at)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT(project_id) DO UPDATE SET version = excluded.version,
        change_log = excluded.change_log, section_versions = excluded.section_versions, updated_at = excluded.updated_at`,
        [projectId, version, JSON.stringify(changeLog), JSON.stringify(versions), now]
      );
      await tx.execute(
        `INSERT INTO prd_snapshots (project_id, version, content, created_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT(project_id, version) DO NOTHING`,
        [projectId, version, draft.content, now]
      );
      await tx.execute(
        `UPDATE spec_publications SET status = 'published', commit_sha = $1,
        document_version = $2, error = NULL, updated_at = $3 WHERE project_id = $4 AND operation_id = $5`,
        [commitSha, version, now, projectId, operationId]
      );
    });
  }

  async getOperation(projectId: string, operationId: string): Promise<DbRow | null> {
    await this.projects.getProject(projectId);
    const db = await this.store.getDb();
    return (
      (await db.queryOne(
        "SELECT * FROM spec_publications WHERE project_id = $1 AND operation_id = $2",
        [projectId, operationId]
      )) ?? null
    );
  }

  async listOperations(projectId: string): Promise<DbRow[]> {
    await this.projects.getProject(projectId);
    const db = await this.store.getDb();
    return db.query(
      "SELECT * FROM spec_publications WHERE project_id = $1 ORDER BY updated_at DESC, operation_id DESC LIMIT 20",
      [projectId]
    );
  }

  /** Read-only reconciliation never reruns an uncertain external effect. */
  async reconcile(projectId: string, operationId: string): Promise<DbRow | null> {
    return withProjectMutation(projectId, () => this.reconcileOwned(projectId, operationId));
  }

  private async reconcileOwned(projectId: string, operationId: string): Promise<DbRow | null> {
    const operation = await this.getOperation(projectId, operationId);
    if (!operation || operation.status === "published" || operation.status === "failed")
      return operation;
    const project = await this.projects.getProject(projectId);
    const draft = await this.getDraft(projectId, Number(operation.revision));
    let published = false;
    if (draft && operation.commit_sha) {
      try {
        await git(
          project.repoPath,
          "merge-base",
          "--is-ancestor",
          String(operation.commit_sha),
          String(draft.base_ref)
        );
        const content = await execFileAsync("git", ["show", `${operation.commit_sha}:SPEC.md`], {
          cwd: project.repoPath,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 30_000,
        });
        // A known commit alone cannot prove the interrupted working-copy effect
        // completed. Do not overwrite manual edits or older index contents.
        const current = await fs.readFile(path.join(project.repoPath, "SPEC.md"), "utf8");
        const staged = await git(
          project.repoPath,
          "diff",
          "--cached",
          "--name-only",
          "--",
          "SPEC.md"
        );
        const head = await git(project.repoPath, "rev-parse", "HEAD");
        published =
          hashSpecContent(content.stdout) === draft.content_hash &&
          hashSpecContent(current) === draft.content_hash &&
          !staged &&
          head === operation.commit_sha;
      } catch {
        /* No verified commit: retain an explicit uncertain state. */
      }
    }
    if (published && draft)
      await this.finalizePublished(projectId, operationId, draft, String(operation.commit_sha));
    else
      await this.updateOperation(
        projectId,
        operationId,
        "uncertain",
        operation.commit_sha ? String(operation.commit_sha) : null,
        "Publication was interrupted. Inspect the repository before retrying."
      );
    return this.getOperation(projectId, operationId);
  }

  async publish(projectId: string, operationId: string, revision: number): Promise<DbRow> {
    return withProjectMutation(projectId, async () => {
      const existing = await this.getOperation(projectId, operationId);
      if (existing) {
        if (Number(existing.revision) !== revision)
          conflict("Operation ID already belongs to another revision.");
        return (await this.reconcileOwned(projectId, operationId))!;
      }
      const project = await this.projects.getProject(projectId);
      const draft = await this.getDraft(projectId, revision);
      const latest = await this.getDraft(projectId);
      if (!draft || latest?.revision !== draft.revision)
        conflict("Publish the current draft revision.");
      const db = await this.store.getDb();
      const approval = await db.queryOne(
        `SELECT * FROM spec_draft_approvals WHERE project_id = $1 AND revision = $2`,
        [projectId, revision]
      );
      if (
        !approval ||
        approval.content_hash !== draft.content_hash ||
        approval.base_sha !== draft.base_sha ||
        approval.destination !== draft.base_ref
      )
        conflict("This exact proposal requires approval.");
      await this.store.runWrite(async (tx) => {
        await tx.execute(
          `INSERT INTO spec_publications
          (project_id, operation_id, revision, status, updated_at) VALUES ($1, $2, $3, 'preparing', $4)`,
          [projectId, operationId, revision, new Date().toISOString()]
        );
      });
      let candidate:
        | Awaited<ReturnType<typeof validationWorkspaceService.createBaselineWorkspace>>
        | undefined;
      let candidateSha: string | null = null;
      let advanced = false;
      const publishCandidate = async (): Promise<DbRow> => {
        try {
          const assertBase = async () => {
            if (
              (await git(project.repoPath, "rev-parse", "HEAD")) !== draft.base_sha ||
              (await git(project.repoPath, "symbolic-ref", "HEAD")) !== draft.base_ref
            )
              conflict("The Git base changed. Create a fresh proposal.");
            const current = await fs.readFile(path.join(project.repoPath, "SPEC.md"), "utf8");
            if (hashSpecContent(current) !== draft.base_content_hash)
              conflict("SPEC.md changed in an editor. Import or reconcile those edits first.");
            const staged = await git(project.repoPath, "diff", "--cached", "--name-only");
            if (staged) conflict("Finish or unstage pending repository changes before publishing.");
          };
          await assertBase();
          candidate = await validationWorkspaceService.createBaselineWorkspace(
            project.repoPath,
            String(draft.base_ref).replace(/^refs\/heads\//, "")
          );
          if ((await git(candidate.worktreePath, "rev-parse", "HEAD")) !== draft.base_sha)
            conflict("The Git base changed while preparing validation.");
          await fs.writeFile(
            path.join(candidate.worktreePath, "SPEC.md"),
            String(draft.content),
            "utf8"
          );
          await git(candidate.worktreePath, "add", "--", "SPEC.md");
          await git(
            candidate.worktreePath,
            "-c",
            `core.hooksPath=${getGitNoHooksPath()}`,
            "commit",
            "--allow-empty",
            "-m",
            `prd: publish draft ${revision}\n\nOpenSprint-Publication: ${operationId}`
          );
          candidateSha = await git(candidate.worktreePath, "rev-parse", "HEAD");
          await this.updateOperation(projectId, operationId, "validating", candidateSha);
          await this.validate(
            projectId,
            project.repoPath,
            candidate.worktreePath,
            String(draft.base_sha)
          );
          if (
            (await git(candidate.worktreePath, "rev-parse", "HEAD")) !== candidateSha ||
            (await git(candidate.worktreePath, "status", "--porcelain", "--untracked-files=no"))
          ) {
            conflict(
              "Validation changed the prepared candidate. Review and validate a fresh proposal."
            );
          }
          const approvedBlob = await execFileAsync("git", ["show", `${candidateSha}:SPEC.md`], {
            cwd: candidate.worktreePath,
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
          });
          if (hashSpecContent(approvedBlob.stdout) !== draft.content_hash)
            conflict("The committed candidate differs from the approved content.");
          await assertBase();
          // The prepared immutable commit is recorded before the external effect.
          await this.updateOperation(projectId, operationId, "publishing", candidateSha);
          await git(
            project.repoPath,
            "update-ref",
            String(draft.base_ref),
            candidateSha,
            String(draft.base_sha)
          );
          advanced = true;
          // Refuse to overwrite a manual edit that appeared while Git advanced.
          const current = await fs.readFile(path.join(project.repoPath, "SPEC.md"), "utf8");
          if (hashSpecContent(current) !== draft.base_content_hash)
            conflict("Publication committed; working copy changed and needs reconciliation.");
          await git(
            project.repoPath,
            "restore",
            "--source",
            candidateSha,
            "--staged",
            "--worktree",
            "--",
            "SPEC.md"
          );
          await this.finalizePublished(projectId, operationId, draft, candidateSha);
          return (await this.getOperation(projectId, operationId))!;
        } catch (err) {
          await this.updateOperation(
            projectId,
            operationId,
            advanced ? "uncertain" : "failed",
            candidateSha,
            (err instanceof Error ? err.message : String(err)).slice(0, 1000)
          );
          throw err;
        } finally {
          await candidate?.cleanup();
        }
      };
      let result!: DbRow;
      try {
        await gitCommitQueue.enqueueAndWait({
          type: "repository_operation",
          repoPath: project.repoPath,
          run: async () => {
            result = await publishCandidate();
          },
        });
      } catch (err) {
        // The queue can reject before invoking the operation (e.g. unmerged files).
        if (!candidateSha)
          await this.updateOperation(
            projectId,
            operationId,
            "failed",
            null,
            (err instanceof Error ? err.message : String(err)).slice(0, 1000)
          );
        throw err;
      }
      return result;
    });
  }
}

export const specPublicationService = new SpecPublicationService();
