import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { getCombinedInstructions } from "../services/agent-instructions.service.js";

const { mockDbClient } = vi.hoisted(() => {
  const client = {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(0),
    runInTransaction: vi.fn().mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client)),
  };
  return { mockDbClient: client };
});
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    listInProgressWithAgentAssignee: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue([]),
    addDependency: vi.fn().mockResolvedValue(undefined),
    syncForPush: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockResolvedValue(mockDbClient),
    runWrite: vi.fn().mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(mockDbClient)),
  },
  TaskStoreService: vi.fn(),
  SCHEMA_SQL: "",
}));

describe("getCombinedInstructions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-agent-instructions-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns general content only when AGENTS.md exists and role file is missing", async () => {
    const generalContent = "# Agent Instructions\n\nUse bd for tasks.";
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), generalContent, "utf-8");

    const result = await getCombinedInstructions(tempDir, "coder");

    expect(result).toBe(`## Agent Instructions\n\n${generalContent}`);
  });

  it("returns general + role content when both exist", async () => {
    const generalContent = "# General\n\nShared instructions.";
    const roleContent = "# Coder-specific\n\nWrite tests.";
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), generalContent, "utf-8");
    await fs.mkdir(path.join(tempDir, OPENSPRINT_PATHS.agents), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, OPENSPRINT_PATHS.agents, "coder.md"),
      roleContent,
      "utf-8"
    );

    const result = await getCombinedInstructions(tempDir, "coder");

    expect(result).toBe(
      `## Agent Instructions\n\n${generalContent}\n\n## Role-specific Instructions\n\n${roleContent}`
    );
  });

  it("returns general content only when role file is empty", async () => {
    const generalContent = "# General\n\nShared.";
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), generalContent, "utf-8");
    await fs.mkdir(path.join(tempDir, OPENSPRINT_PATHS.agents), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, OPENSPRINT_PATHS.agents, "reviewer.md"),
      "",
      "utf-8"
    );

    const result = await getCombinedInstructions(tempDir, "reviewer");

    expect(result).toBe(`## Agent Instructions\n\n${generalContent}`);
  });

  it("returns general content only when role file has only whitespace", async () => {
    const generalContent = "# General\n\nShared.";
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), generalContent, "utf-8");
    await fs.mkdir(path.join(tempDir, OPENSPRINT_PATHS.agents), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, OPENSPRINT_PATHS.agents, "merger.md"),
      "   \n\t\n  ",
      "utf-8"
    );

    const result = await getCombinedInstructions(tempDir, "merger");

    expect(result).toBe(`## Agent Instructions\n\n${generalContent}`);
  });

  it("returns header + empty general when AGENTS.md is missing and role file is missing", async () => {
    const result = await getCombinedInstructions(tempDir, "dreamer");

    expect(result).toBe("## Agent Instructions\n\n");
  });

  it("returns header + role content when AGENTS.md is missing but role file exists", async () => {
    const roleContent = "Dreamer-specific instructions.";
    await fs.mkdir(path.join(tempDir, OPENSPRINT_PATHS.agents), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, OPENSPRINT_PATHS.agents, "dreamer.md"),
      roleContent,
      "utf-8"
    );

    const result = await getCombinedInstructions(tempDir, "dreamer");

    expect(result).toBe(
      `## Agent Instructions\n\n\n\n## Role-specific Instructions\n\n${roleContent}`
    );
  });

  it("works for all valid roles in AGENT_ROLE_CANONICAL_ORDER", async () => {
    const roles = [
      "dreamer",
      "planner",
      "harmonizer",
      "analyst",
      "summarizer",
      "auditor",
      "coder",
      "reviewer",
      "merger",
    ] as const;

    for (const role of roles) {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "general", "utf-8");
      await fs.mkdir(path.join(tempDir, OPENSPRINT_PATHS.agents), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, OPENSPRINT_PATHS.agents, `${role}.md`),
        `role: ${role}`,
        "utf-8"
      );

      const result = await getCombinedInstructions(tempDir, role);

      expect(result).toContain("## Agent Instructions");
      expect(result).toContain("general");
      expect(result).toContain("## Role-specific Instructions");
      expect(result).toContain(`role: ${role}`);

      await fs.unlink(path.join(tempDir, OPENSPRINT_PATHS.agents, `${role}.md`));
    }
  });

  it("throws for invalid role", async () => {
    await expect(getCombinedInstructions(tempDir, "invalid" as "coder")).rejects.toThrow(
      /Invalid agent role: invalid/
    );
  });
});
