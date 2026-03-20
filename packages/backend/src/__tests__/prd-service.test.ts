import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { PrdService } from "../services/prd.service.js";
import { SPEC_MD, prdToSpecMarkdown } from "@opensprint/shared";

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: vi.fn().mockResolvedValue({
      id: "test-project",
      name: "Test",
      repoPath: "/tmp/opensprint-test-prd",
    }),
    getProjectByRepoPath: vi.fn().mockResolvedValue(null),
  })),
}));

const prdMetadataStore: Record<
  string,
  { version: number; change_log: string; section_versions: string }
> = {};

/** Key: "projectId:version". Used to verify prd_snapshots persistence. */
const prdSnapshotsStore: Record<
  string,
  { project_id: string; version: number; content: string; created_at: string }
> = {};

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    getDb: vi.fn().mockImplementation(() =>
      Promise.resolve({
        queryOne: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
          if (sql.includes("prd_metadata") && params?.[0]) {
            const row = prdMetadataStore[String(params[0])];
            if (row)
              return {
                version: row.version,
                change_log: row.change_log,
                section_versions: row.section_versions,
              };
          }
          if (sql.includes("prd_snapshots") && params?.[0] != null && params?.[1] != null) {
            const key = `${String(params[0])}:${Number(params[1])}`;
            const row = prdSnapshotsStore[key];
            if (row) return { ...row };
            return undefined;
          }
          return null;
        }),
      })
    ),
    runWrite: vi
      .fn()
      .mockImplementation(
        async (
          fn: (client: {
            execute: (sql: string, args: unknown[]) => Promise<void>;
          }) => Promise<unknown>
        ) => {
          const client = {
            execute: vi.fn().mockImplementation(async (sql: string, args: unknown[]) => {
              if (
                sql.includes("prd_metadata") &&
                sql.includes("INSERT") &&
                Array.isArray(args) &&
                args.length >= 4
              ) {
                const projectId = String(args[0]);
                prdMetadataStore[projectId] = {
                  version: Number(args[1]),
                  change_log: String(args[2]),
                  section_versions: String(args[3]),
                };
              }
              if (
                sql.includes("prd_snapshots") &&
                sql.includes("INSERT") &&
                Array.isArray(args) &&
                args.length >= 4
              ) {
                const projectId = String(args[0]);
                const version = Number(args[1]);
                const content = String(args[2]);
                const created_at = String(args[3]);
                prdSnapshotsStore[`${projectId}:${version}`] = {
                  project_id: projectId,
                  version,
                  content,
                  created_at,
                };
              }
            }),
          };
          return fn(client);
        }
      ),
  },
  TaskStoreService: vi.fn(),
}));

vi.mock("../services/git-commit-queue.service.js", () => ({
  gitCommitQueue: {
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueueAndWait: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("PrdService", () => {
  let prdService: PrdService;
  const repoPath = "/tmp/opensprint-test-prd";
  const specPath = path.join(repoPath, SPEC_MD);

  const mockPrd = {
    version: 1,
    sections: {
      executive_summary: {
        content: "Test summary",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      problem_statement: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      user_personas: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      goals_and_metrics: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      assumptions_and_constraints: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      feature_list: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      technical_architecture: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      data_model: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      api_contracts: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      non_functional_requirements: {
        content: "",
        version: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      open_questions: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
    },
    changeLog: [],
  };

  beforeEach(async () => {
    for (const k of Object.keys(prdMetadataStore)) delete prdMetadataStore[k];
    for (const k of Object.keys(prdSnapshotsStore)) delete prdSnapshotsStore[k];
    prdService = new PrdService();
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, prdToSpecMarkdown(mockPrd as never), "utf-8");
    // Do not write legacy spec-metadata.json: PrdService reads metadata from DB; if no row
    // and legacy file exists, assertMigrationCompleteForResource throws.
  });

  afterEach(async () => {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should get the full PRD", async () => {
    const prd = await prdService.getPrd("test-project");
    // Version is 0 when loading from SPEC.md only (no prd_metadata row yet)
    expect(prd.version).toBe(0);
    expect(prd.sections.executive_summary.content).toBe("Test summary");
  });

  it("should get a specific section", async () => {
    const section = await prdService.getSection("test-project", "executive_summary");
    expect(section.content).toBe("Test summary");
    expect(section.version).toBe(1);
  });

  it("should reject invalid section key format", async () => {
    await expect(prdService.getSection("test-project", "invalid-section")).rejects.toThrow(
      "Invalid PRD section key"
    );
  });

  it("should return 404 for non-existent section (valid format)", async () => {
    await expect(prdService.getSection("test-project", "nonexistent_section")).rejects.toThrow(
      "PRD section 'nonexistent_section' not found"
    );
  });

  it("should update a section with versioning and append to change log with diff", async () => {
    const result = await prdService.updateSection(
      "test-project",
      "executive_summary",
      "Updated summary content",
      "sketch"
    );

    expect(result.previousVersion).toBe(1);
    expect(result.newVersion).toBe(2);
    expect(result.section.content).toBe("Updated summary content");

    // Verify persisted and change log entry has diff (PRD version increments once per update)
    const prd = await prdService.getPrd("test-project");
    expect(prd.version).toBe(1);
    expect(prd.sections.executive_summary.version).toBe(2);
    expect(prd.changeLog).toHaveLength(1);
    expect(prd.changeLog[0].section).toBe("executive_summary");
    expect(prd.changeLog[0].source).toBe("sketch");
    expect(prd.changeLog[0].version).toBe(2);
    expect(prd.changeLog[0].documentVersion).toBe(1);
    expect(prd.changeLog[0].timestamp).toBeDefined();
    expect(prd.changeLog[0].diff).toMatch(/lines|chars|Initial content|Content removed|No changes/);
  });

  it("should accept Sketch agent dynamic sections (e.g. competitive_landscape)", async () => {
    const result = await prdService.updateSection(
      "test-project",
      "competitive_landscape",
      "Our main competitors are X, Y, and Z.",
      "sketch"
    );

    expect(result.previousVersion).toBe(0);
    expect(result.newVersion).toBe(1);
    expect(result.section.content).toBe("Our main competitors are X, Y, and Z.");

    const prd = await prdService.getPrd("test-project");
    expect(prd.sections.competitive_landscape).toBeDefined();
    expect(prd.sections.competitive_landscape.content).toBe(
      "Our main competitors are X, Y, and Z."
    );
    expect(prd.changeLog[0].section).toBe("competitive_landscape");
  });

  it("should update multiple sections at once and append each to change log with diff", async () => {
    const changes = await prdService.updateSections(
      "test-project",
      [
        { section: "executive_summary", content: "New summary" },
        { section: "problem_statement", content: "New problem" },
      ],
      "plan"
    );

    expect(changes).toHaveLength(2);
    expect(changes[0].section).toBe("executive_summary");
    expect(changes[1].section).toBe("problem_statement");

    const prd = await prdService.getPrd("test-project");
    expect(prd.changeLog).toHaveLength(2);
    expect(prd.changeLog[0].diff).toBeDefined();
    expect(prd.changeLog[1].diff).toBeDefined();
    expect(prd.changeLog[0].documentVersion).toBe(1);
    expect(prd.changeLog[1].documentVersion).toBe(1);
  });

  it("should handle PRD without changeLog (backward compatibility)", async () => {
    const prdWithoutChangeLog = { ...mockPrd };
    delete (prdWithoutChangeLog as { changeLog?: unknown }).changeLog;
    await fs.writeFile(specPath, prdToSpecMarkdown(prdWithoutChangeLog as never), "utf-8");
    // No legacy spec-metadata.json: service uses DB; loading from SPEC.md only gives changeLog [].

    const result = await prdService.updateSection(
      "test-project",
      "executive_summary",
      "Migrated content",
      "sketch"
    );
    expect(result.newVersion).toBe(2);

    const prd = await prdService.getPrd("test-project");
    expect(prd.changeLog).toHaveLength(1);
    expect(prd.changeLog[0].section).toBe("executive_summary");
  });

  it("should get change history", async () => {
    await prdService.updateSection("test-project", "executive_summary", "v2", "sketch");
    await prdService.updateSection("test-project", "executive_summary", "v3", "plan");

    const history = await prdService.getHistory("test-project");
    expect(history).toHaveLength(2);
    expect(history[0].source).toBe("sketch");
    expect(history[1].source).toBe("plan");
    expect(history[0].documentVersion).toBe(1);
    expect(history[1].documentVersion).toBe(2);
  });

  it("should persist a prd_snapshot for the version after updateSection", async () => {
    await prdService.updateSection(
      "test-project",
      "executive_summary",
      "Updated summary content",
      "sketch"
    );

    const snapshot = prdSnapshotsStore["test-project:1"];
    expect(snapshot).toBeDefined();
    expect(snapshot.project_id).toBe("test-project");
    expect(snapshot.version).toBe(1);
    expect(snapshot.content).toContain("Updated summary content");
    expect(snapshot.created_at).toBeDefined();
  });

  it("should persist a prd_snapshot for the version after savePrd (via updateSections)", async () => {
    await prdService.updateSections(
      "test-project",
      [
        { section: "executive_summary", content: "New summary" },
        { section: "problem_statement", content: "New problem" },
      ],
      "plan"
    );

    const snapshot = prdSnapshotsStore["test-project:1"];
    expect(snapshot).toBeDefined();
    expect(snapshot.version).toBe(1);
    expect(snapshot.content).toContain("New summary");
    expect(snapshot.content).toContain("New problem");
  });

  it("getSnapshot returns content when snapshot exists", async () => {
    await prdService.updateSection(
      "test-project",
      "executive_summary",
      "Snapshot content",
      "sketch"
    );

    const content = await prdService.getSnapshot("test-project", 1);
    expect(content).not.toBeNull();
    expect(content).toContain("Snapshot content");
  });

  it("getSnapshot returns null when version has no snapshot", async () => {
    const content = await prdService.getSnapshot("test-project", 999);
    expect(content).toBeNull();
  });
});
