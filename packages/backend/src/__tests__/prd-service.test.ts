import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { PrdService } from "../services/prd.service.js";
import { ProjectService } from "../services/project.service.js";

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: vi.fn().mockResolvedValue({
      id: "test-project",
      name: "Test",
      repoPath: "/tmp/opensprint-test-prd",
    }),
  })),
}));

describe("PrdService", () => {
  let prdService: PrdService;
  const repoPath = "/tmp/opensprint-test-prd";
  const prdPath = path.join(repoPath, ".opensprint", "prd.json");

  const mockPrd = {
    version: 1,
    sections: {
      executive_summary: { content: "Test summary", version: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
      problem_statement: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      user_personas: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      goals_and_metrics: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      feature_list: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      technical_architecture: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      data_model: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      api_contracts: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      non_functional_requirements: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      open_questions: { content: "", version: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
    },
    changeLog: [],
  };

  beforeEach(async () => {
    prdService = new PrdService();
    await fs.mkdir(path.dirname(prdPath), { recursive: true });
    await fs.writeFile(prdPath, JSON.stringify(mockPrd, null, 2));
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
    expect(prd.version).toBe(1);
    expect(prd.sections.executive_summary.content).toBe("Test summary");
  });

  it("should get a specific section", async () => {
    const section = await prdService.getSection("test-project", "executive_summary");
    expect(section.content).toBe("Test summary");
    expect(section.version).toBe(1);
  });

  it("should reject invalid section keys", async () => {
    await expect(prdService.getSection("test-project", "invalid_key")).rejects.toThrow("Invalid PRD section key");
  });

  it("should update a section with versioning", async () => {
    const result = await prdService.updateSection(
      "test-project",
      "executive_summary",
      "Updated summary content",
      "design",
    );

    expect(result.previousVersion).toBe(1);
    expect(result.newVersion).toBe(2);
    expect(result.section.content).toBe("Updated summary content");

    // Verify persisted
    const prd = await prdService.getPrd("test-project");
    expect(prd.version).toBe(2);
    expect(prd.sections.executive_summary.version).toBe(2);
    expect(prd.changeLog).toHaveLength(1);
    expect(prd.changeLog[0].section).toBe("executive_summary");
    expect(prd.changeLog[0].source).toBe("design");
  });

  it("should update multiple sections at once", async () => {
    const changes = await prdService.updateSections(
      "test-project",
      [
        { section: "executive_summary", content: "New summary" },
        { section: "problem_statement", content: "New problem" },
      ],
      "plan",
    );

    expect(changes).toHaveLength(2);
    expect(changes[0].section).toBe("executive_summary");
    expect(changes[1].section).toBe("problem_statement");

    const prd = await prdService.getPrd("test-project");
    expect(prd.changeLog).toHaveLength(2);
  });

  it("should get change history", async () => {
    await prdService.updateSection("test-project", "executive_summary", "v2", "design");
    await prdService.updateSection("test-project", "executive_summary", "v3", "plan");

    const history = await prdService.getHistory("test-project");
    expect(history).toHaveLength(2);
    expect(history[0].source).toBe("design");
    expect(history[1].source).toBe("plan");
  });
});
