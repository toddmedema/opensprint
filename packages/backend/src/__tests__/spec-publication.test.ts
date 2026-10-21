import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { SpecPublicationService } from "../services/spec-publication.service.js";
import type { ProjectService } from "../services/project.service.js";

const exec = promisify(execFile);
describe("immutable SPEC proposals and publication", () => {
  let db: AppDb;
  let repo: string;
  let service: SpecPublicationService;
  let projects: Pick<ProjectService, "getProject" | "getSettings">;
  const validate = vi.fn().mockResolvedValue(undefined);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: repo })).stdout.trim();
  const makeService = () =>
    new SpecPublicationService({
      store: { runWrite: (fn) => db.runWrite(fn), getDb: () => db.getClient() },
      projects,
      validate,
    });
  beforeEach(async () => {
    db = await initAppDb("sqlite://:memory:");
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-publication-"));
    await git("init", "-b", "main");
    await git("config", "user.name", "Publication test");
    await git("config", "user.email", "publication@example.test");
    await git("config", "core.autocrlf", "false");
    await fs.writeFile(
      path.join(repo, "SPEC.md"),
      "# Product Specification\n\n## Executive Summary\n\nOriginal\n"
    );
    await fs.writeFile(path.join(repo, "source.txt"), "Original code\n");
    await git("add", ".");
    await git("commit", "-m", "Initial");
    projects = {
      getProject: vi.fn().mockResolvedValue({ id: "project", repoPath: repo }),
      getSettings: vi.fn(),
    } as unknown as typeof projects;
    validate.mockReset().mockResolvedValue(undefined);
    service = makeService();
  });
  afterEach(async () => {
    await db.close();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("serializes concurrent draft revisions and preserves immutable prior content", async () => {
    const results = await Promise.allSettled([
      service.saveDraft("project", "One\n", 0),
      service.saveDraft("project", "Two\n", 0),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const first = await service.getDraft("project");
    await service.saveDraft("project", "Three\n", 1);
    expect((await service.getDraft("project", 1))?.content).toBe(first?.content);
    expect(await fs.readFile(path.join(repo, "SPEC.md"), "utf8")).toContain("Original");
  });

  it("binds approval to the latest immutable hash and rejects superseded approval", async () => {
    const draft = await service.saveDraft("project", "Proposal\n", 0);
    expect(draft.approved).toBe(false);
    await expect(service.approve("project", 1, "wrong")).rejects.toMatchObject({ statusCode: 409 });
    await service.approve("project", 1, String(draft.content_hash));
    expect((await makeService().getDraft("project"))?.approved).toBe(true);
    await service.saveDraft("project", "New proposal\n", 1);
    expect((await service.getDraft("project"))?.approved).toBe(false);
    await expect(service.publish("project", "publish-old", 1)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("publishes only SPEC, runs candidate validation, and deduplicates the operation after restart", async () => {
    const content = "# Product Specification\n\n## Executive Summary\n\nApproved\n";
    const draft = await service.saveDraft("project", content, 0);
    await service.approve("project", 1, String(draft.content_hash));
    await fs.writeFile(path.join(repo, "source.txt"), "Uncommitted editor work\n");
    const result = await service.publish("project", "publish-one", 1);
    expect(result.status).toBe("published");
    expect(validate).toHaveBeenCalledOnce();
    expect(await git("show", "HEAD:source.txt")).toBe("Original code");
    expect(await fs.readFile(path.join(repo, "source.txt"), "utf8")).toContain("Uncommitted");
    expect(await fs.readFile(path.join(repo, "SPEC.md"), "utf8")).toBe(content);
    expect(await git("show", "HEAD:SPEC.md")).toContain("Approved");
    expect(await makeService().publish("project", "publish-one", 1)).toEqual(result);
    expect(validate).toHaveBeenCalledOnce();
    const client = await db.getClient();
    expect(
      await client.query("SELECT * FROM prd_snapshots WHERE project_id = $1", ["project"])
    ).toHaveLength(1);
  });

  it("never advances Git when candidate validation fails", async () => {
    const draft = await service.saveDraft("project", "Proposal\n", 0);
    await service.approve("project", 1, String(draft.content_hash));
    const head = await git("rev-parse", "HEAD");
    validate.mockRejectedValue(new Error("Gate failed"));
    await expect(service.publish("project", "bad-gates", 1)).rejects.toThrow("Gate failed");
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect((await service.getOperation("project", "bad-gates"))?.status).toBe("failed");
  });

  it("rejects a candidate changed by its validation command", async () => {
    const draft = await service.saveDraft("project", "Approved\n", 0);
    await service.approve("project", 1, String(draft.content_hash));
    const head = await git("rev-parse", "HEAD");
    validate.mockImplementation(async (_projectId, _repoPath, candidatePath) => {
      await fs.writeFile(path.join(candidatePath, "SPEC.md"), "Gate changed this\n");
    });
    await expect(service.publish("project", "mutated-candidate", 1)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await git("rev-parse", "HEAD")).toBe(head);
  });

  it("retains uncertainty when ref advancement completed but working-copy restore did not", async () => {
    const original = await fs.readFile(path.join(repo, "SPEC.md"), "utf8");
    const draft = await service.saveDraft("project", "Approved\n", 0);
    await service.approve("project", 1, String(draft.content_hash));
    const operation = await service.publish("project", "restore-window", 1);
    // Recreate the precise crash boundary: the branch points to the published
    // commit, while the index and working copy still contain the previous SPEC.
    await git(
      "restore",
      "--source",
      String(draft.base_sha),
      "--staged",
      "--worktree",
      "--",
      "SPEC.md"
    );
    await db.runWrite(async (tx) => {
      await tx.execute(
        "UPDATE spec_publications SET status = 'publishing', document_version = NULL WHERE project_id = $1",
        ["project"]
      );
    });
    const recovered = await makeService().reconcile("project", "restore-window");
    expect(recovered?.status).toBe("uncertain");
    expect(await fs.readFile(path.join(repo, "SPEC.md"), "utf8")).toBe(original);
    expect(await git("rev-parse", "HEAD")).toBe(operation.commit_sha);
  });

  it("rejects editor changes appearing during validation", async () => {
    const draft = await service.saveDraft("project", "Proposal\n", 0);
    await service.approve("project", 1, String(draft.content_hash));
    const head = await git("rev-parse", "HEAD");
    validate.mockImplementation(async () => {
      await fs.writeFile(path.join(repo, "SPEC.md"), "Manual editor draft\n");
    });
    await expect(service.publish("project", "editor-conflict", 1)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(await fs.readFile(path.join(repo, "SPEC.md"), "utf8")).toBe("Manual editor draft\n");
  });

  it("reconciles an already published commit after a crash without duplicating metadata", async () => {
    const draft = await service.saveDraft("project", "Proposal\n", 0);
    await service.approve("project", 1, String(draft.content_hash));
    const operation = await service.publish("project", "crash-window", 1);
    await db.runWrite(async (tx) => {
      await tx.execute("UPDATE spec_publications SET status = 'publishing' WHERE project_id = $1", [
        "project",
      ]);
    });
    expect((await makeService().reconcile("project", "crash-window"))?.status).toBe("published");
    expect((await makeService().reconcile("project", "crash-window"))?.document_version).toBe(
      operation.document_version
    );
  });

  it("preserves an interrupted operation as uncertain and never retries its effects", async () => {
    const now = new Date().toISOString();
    await db.runWrite(async (tx) => {
      await tx.execute(
        `INSERT INTO spec_publications
      (project_id, operation_id, revision, status, updated_at) VALUES ($1, $2, 1, 'preparing', $3)`,
        ["project", "interrupted", now]
      );
    });
    expect((await makeService().publish("project", "interrupted", 1)).status).toBe("uncertain");
    expect((await makeService().listOperations("project"))[0]).toMatchObject({
      operation_id: "interrupted",
      status: "uncertain",
    });
    expect(await makeService().listOperations("another-project")).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });
});
