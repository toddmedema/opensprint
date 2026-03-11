import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ProjectService } from "../services/project.service.js";
import { notificationService } from "../services/notification.service.js";
import { setGlobalSettings } from "../services/global-settings.service.js";
import {
  DEFAULT_HIL_CONFIG,
  DEFAULT_REVIEW_MODE,
  MIN_VALIDATION_TIMEOUT_MS,
  MAX_VALIDATION_TIMEOUT_MS,
} from "@opensprint/shared";

// Full mock so we never load task-store.service (which pulls in drizzle). ProjectService only needs
// listAll, deleteOpenQuestionsByProjectId, deleteByProjectId for these tests.
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    deleteOpenQuestionsByProjectId: vi.fn().mockResolvedValue(undefined),
    deleteByProjectId: vi.fn().mockResolvedValue(undefined),
  },
  TaskStoreService: vi.fn(),
}));

/** Read project settings from global store (when HOME=tempDir in tests). */
async function readSettingsFromGlobalStore(
  tempDir: string,
  projectId: string
): Promise<Record<string, unknown>> {
  const storePath = path.join(tempDir, ".opensprint", "settings.json");
  const raw = await fs.readFile(storePath, "utf-8");
  const store = JSON.parse(raw) as Record<string, { settings?: Record<string, unknown> }>;
  const entry = store[projectId];
  return (entry?.settings ?? entry ?? {}) as Record<string, unknown>;
}

describe("ProjectService", () => {
  let projectService: ProjectService;
  let suiteTempDir: string;
  let tempDir: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    suiteTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-project-suite-"));
    originalHome = process.env.HOME;
    process.env.HOME = suiteTempDir;
  });

  beforeEach(async () => {
    await fs.rm(suiteTempDir, { recursive: true, force: true });
    await fs.mkdir(suiteTempDir, { recursive: true });
    tempDir = suiteTempDir;
    projectService = new ProjectService();
    await setGlobalSettings({
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "test-ant", value: "sk-ant-test" }],
        CURSOR_API_KEY: [{ id: "test-cur", value: "cursor-test" }],
      },
    });
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await fs.rm(suiteTempDir, { recursive: true, force: true });
  });

  it("should create a project with full setup flow", async () => {
    const repoPath = path.join(tempDir, "my-project");

    const project = await projectService.createProject({
      name: "Test Project",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe("Test Project");
    expect(project.repoPath).toBe(repoPath);
    expect(project.currentPhase).toBe("sketch");

    // Verify .opensprint marker directory exists
    const opensprintDir = path.join(repoPath, ".opensprint");
    const stat = await fs.stat(opensprintDir);
    expect(stat.isDirectory()).toBe(true);

    // Canonical state is DB-backed; these legacy canonical directories are not bootstrapped.
    const legacyCanonicalDirs = ["plans", "conversations", "feedback", "active"];
    for (const sub of legacyCanonicalDirs) {
      await expect(fs.stat(path.join(opensprintDir, sub))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    // Verify settings in global store
    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settings.simpleComplexityAgent).toBeDefined();
    expect((settings.simpleComplexityAgent as { type: string }).type).toBe("claude");
    expect((settings.complexComplexityAgent as { type: string }).type).toBe("claude");
    expect(settings.hilConfig).toEqual(DEFAULT_HIL_CONFIG);
    expect(settings.testFramework).toBeNull();
    expect(settings.reviewMode).toBe(DEFAULT_REVIEW_MODE);

    // Verify SPEC.md (Sketch phase output)
    const specPath = path.join(repoPath, "SPEC.md");
    const specRaw = await fs.readFile(specPath, "utf-8");
    expect(specRaw).toContain("# Product Specification");
    expect(specRaw).toContain("## Executive Summary");

    // Verify git repo
    const gitDir = path.join(repoPath, ".git");
    const gitStat = await fs.stat(gitDir);
    expect(gitStat.isDirectory()).toBe(true);

    // Task store: global DB, no per-repo data

    // Verify AGENTS.md created with bd instruction
    const agentsMd = await fs.readFile(path.join(repoPath, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("Use 'bd' for task tracking");

    // PRD §5.9: Verify .gitignore has orchestrator-state and worktrees
    const gitignorePath = path.join(repoPath, ".gitignore");
    const gitignore = await fs.readFile(gitignorePath, "utf-8");
    expect(gitignore).toContain(".opensprint/orchestrator-state.json");
    expect(gitignore).toContain(".opensprint/worktrees/");

    // Verify global index
    const indexPath = path.join(tempDir, ".opensprint", "projects.json");
    const indexRaw = await fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(indexRaw);
    expect(index.projects).toHaveLength(1);
    expect(index.projects[0].id).toBe(project.id);
    expect(index.projects[0].name).toBe("Test Project");
    expect(index.projects[0].repoPath).toBe(repoPath);

    // Verify getProject returns the project
    const fetched = await projectService.getProject(project.id);
    expect(fetched.id).toBe(project.id);
  });

  it("should not include description in created project", async () => {
    const repoPath = path.join(tempDir, "no-desc-project");

    const project = await projectService.createProject({
      name: "No Description",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe("No Description");
    expect((project as Record<string, unknown>).description).toBeUndefined();

    const fetched = await projectService.getProject(project.id);
    expect((fetched as Record<string, unknown>).description).toBeUndefined();
  });

  it("should load project without error when index has stale description", async () => {
    const repoPath = path.join(tempDir, "stale-desc-project");

    const project = await projectService.createProject({
      name: "Stale Desc",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    // Manually inject a stale description into the index file
    const indexPath = path.join(tempDir, ".opensprint", "projects.json");
    const indexRaw = await fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(indexRaw);
    index.projects[0].description = "stale description from old version";
    await fs.writeFile(indexPath, JSON.stringify(index));

    // Verify project loads without error and response has no description
    const fetched = await projectService.getProject(project.id);
    expect(fetched.id).toBe(project.id);
    expect(fetched.name).toBe("Stale Desc");
    expect((fetched as Record<string, unknown>).description).toBeUndefined();

    // Verify listProjects also works
    const all = await projectService.listProjects();
    const found = all.find((p) => p.id === project.id);
    expect(found).toBeDefined();
    expect((found as Record<string, unknown>).description).toBeUndefined();
  });

  it("should append bd instruction to existing AGENTS.md that lacks it", async () => {
    const repoPath = path.join(tempDir, "existing-agents-md");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, "AGENTS.md"),
      "# My Project\n\nCustom instructions here.\n"
    );

    await projectService.createProject({
      name: "Existing AGENTS.md",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const content = await fs.readFile(path.join(repoPath, "AGENTS.md"), "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Custom instructions here.");
    expect(content).toContain("Use 'bd' for task tracking");
  });

  it("should not duplicate bd instruction if AGENTS.md already has it", async () => {
    const repoPath = path.join(tempDir, "agents-md-with-bd");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, "AGENTS.md"),
      "# My Project\n\nUse 'bd' for task tracking\n"
    );

    await projectService.createProject({
      name: "Already Has BD",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const content = await fs.readFile(path.join(repoPath, "AGENTS.md"), "utf-8");
    const matches = content.match(/Use 'bd' for task tracking/g);
    expect(matches).toHaveLength(1);
  });

  it("should reject empty project name", async () => {
    await expect(
      projectService.createProject({
        name: "",
        repoPath: path.join(tempDir, "proj"),
        simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
        complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Project name is required" });
  });

  it("should reject empty repo path", async () => {
    await expect(
      projectService.createProject({
        name: "Test",
        repoPath: "",
        simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
        complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Project folder is required" });
  });

  it("should create eas.json when deployment mode is expo", async () => {
    const repoPath = path.join(tempDir, "expo-project");

    await projectService.createProject({
      name: "Expo Project",

      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "expo", expoConfig: { channel: "preview" } },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const easPath = path.join(repoPath, "eas.json");
    const easRaw = await fs.readFile(easPath, "utf-8");
    const eas = JSON.parse(easRaw);
    expect(eas.build).toBeDefined();
    expect(eas.build.preview).toBeDefined();
    expect(eas.build.preview.channel).toBe("preview");
    expect(eas.build.production).toBeDefined();
  });

  it("should save testFramework when provided", async () => {
    const repoPath = path.join(tempDir, "jest-project");

    const project = await projectService.createProject({
      name: "Jest Project",

      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: "jest",
    });

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settings.testFramework).toBe("jest");
  });

  it("should persist customCommand and webhookUrl when deployment mode is custom", async () => {
    const repoPath = path.join(tempDir, "custom-deploy");

    const project = await projectService.createProject({
      name: "Custom Deploy Project",

      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: {
        mode: "custom",
        customCommand: "./deploy.sh",
        webhookUrl: "https://api.example.com/deploy",
      },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settings.deployment).toBeDefined();
    expect((settings.deployment as { mode: string }).mode).toBe("custom");
    expect((settings.deployment as { customCommand?: string }).customCommand).toBe("./deploy.sh");
    expect((settings.deployment as { webhookUrl?: string }).webhookUrl).toBe(
      "https://api.example.com/deploy"
    );
  });

  it("should not persist customCommand/webhookUrl when deployment mode is expo", async () => {
    const repoPath = path.join(tempDir, "expo-ignores-custom");

    const project = await projectService.createProject({
      name: "Expo Ignores Custom",

      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: {
        mode: "expo",
        expoConfig: { channel: "preview" },
        customCommand: "./deploy.sh",
        webhookUrl: "https://api.example.com/deploy",
      },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect((settings.deployment as { mode: string }).mode).toBe("expo");
    expect((settings.deployment as { customCommand?: string }).customCommand).toBeUndefined();
    expect((settings.deployment as { webhookUrl?: string }).webhookUrl).toBeUndefined();
  });

  it("should normalize invalid deployment mode to custom", async () => {
    const repoPath = path.join(tempDir, "invalid-deployment");

    const project = await projectService.createProject({
      name: "Invalid Deployment",

      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "invalid" as "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settings.deployment).toBeDefined();
    expect((settings.deployment as { mode: string }).mode).toBe("custom");
  });

  it("should merge partial hilConfig with defaults", async () => {
    const repoPath = path.join(tempDir, "partial-hil");

    const project = await projectService.createProject({
      name: "Partial HIL",

      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: { scopeChanges: "automated" } as typeof DEFAULT_HIL_CONFIG,
    });

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect((settings.hilConfig as { scopeChanges: string }).scopeChanges).toBe("automated");
    expect((settings.hilConfig as { architectureDecisions: string }).architectureDecisions).toBe(
      "automated"
    );
    expect(
      (settings.hilConfig as { dependencyModifications: string }).dependencyModifications
    ).toBe("automated");
  });

  it("should adopt path that has .opensprint when project not in index", async () => {
    const repoPath = path.join(tempDir, "existing");
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });

    const project = await projectService.createProject({
      name: "Test",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    expect(project.repoPath).toBe(repoPath);
    expect(project.name).toBe("Test");
  });

  it("should return existing project when path has .opensprint and project is in index", async () => {
    const repoPath = path.join(tempDir, "existing-in-index");
    const first = await projectService.createProject({
      name: "First",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    const again = await projectService.createProject({
      name: "Other",
      repoPath: repoPath + "/",
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe(first.name);
    expect(again.repoPath).toBe(first.repoPath);
  });

  it("should reject createProject when simpleComplexityAgent/complexComplexityAgent are missing", async () => {
    const repoPath = path.join(tempDir, "missing-agents");
    await expect(
      projectService.createProject({
        name: "Test",
        repoPath,
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      } as Record<string, unknown>)
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });

  it("should reject invalid simpleComplexityAgent schema", async () => {
    const repoPath = path.join(tempDir, "invalid-low");

    await expect(
      projectService.createProject({
        name: "Test",
        repoPath,
        simpleComplexityAgent: { type: "invalid" as "claude", model: null, cliCommand: null },
        complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });

  it("should reject invalid complexComplexityAgent schema", async () => {
    const repoPath = path.join(tempDir, "invalid-high");

    await expect(
      projectService.createProject({
        name: "Test",
        repoPath,
        simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
        complexComplexityAgent: {
          type: "cursor",
          model: 123 as unknown as string,
          cliCommand: null,
        },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });

  it("should accept cursor agent with model", async () => {
    const repoPath = path.join(tempDir, "cursor-project");

    const project = await projectService.createProject({
      name: "Cursor Project",

      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    expect(project.id).toBeDefined();
    const settings = await projectService.getSettings(project.id);
    expect(settings.simpleComplexityAgent.type).toBe("cursor");
    expect(settings.simpleComplexityAgent.model).toBe("composer-1.5");
    expect(settings.complexComplexityAgent.type).toBe("cursor");
  });

  it("should accept custom agent with cliCommand", async () => {
    const repoPath = path.join(tempDir, "custom-agent");

    const project = await projectService.createProject({
      name: "Custom Agent",

      repoPath,
      simpleComplexityAgent: { type: "custom", model: null, cliCommand: "/usr/bin/my-agent" },
      complexComplexityAgent: { type: "custom", model: null, cliCommand: "/usr/bin/my-agent" },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    expect(project.id).toBeDefined();
    const settings = await projectService.getSettings(project.id);
    expect(settings.simpleComplexityAgent.type).toBe("custom");
    expect(settings.simpleComplexityAgent.cliCommand).toBe("/usr/bin/my-agent");
  });

  it("should accept and persist simpleComplexityAgent and complexComplexityAgent in updateSettings", async () => {
    const repoPath = path.join(tempDir, "complexity-overrides");
    const project = await projectService.createProject({
      name: "Complexity Project",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const updated = await projectService.updateSettings(project.id, {
      simpleComplexityAgent: { type: "cursor", model: "fast-model", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-opus-5", cliCommand: null },
    });

    expect(updated.simpleComplexityAgent.type).toBe("cursor");
    expect(updated.simpleComplexityAgent.model).toBe("fast-model");
    expect(updated.complexComplexityAgent.model).toBe("claude-opus-5");

    const reloaded = await projectService.getSettings(project.id);
    expect(reloaded.complexComplexityAgent.model).toBe("claude-opus-5");
  });

  it("should persist aiAutonomyLevel in updateSettings", async () => {
    const repoPath = path.join(tempDir, "ai-autonomy");
    const project = await projectService.createProject({
      name: "AI Autonomy",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      aiAutonomyLevel: "full",
    });

    const updated = await projectService.updateSettings(project.id, {
      aiAutonomyLevel: "confirm_all",
    });

    expect(updated.aiAutonomyLevel).toBe("confirm_all");
    expect(updated.hilConfig.scopeChanges).toBe("requires_approval");

    const reloaded = await projectService.getSettings(project.id);
    expect(reloaded.aiAutonomyLevel).toBe("confirm_all");
    expect(reloaded.hilConfig.scopeChanges).toBe("requires_approval");
  });

  it("should accept and persist teamMembers in updateSettings", async () => {
    const repoPath = path.join(tempDir, "team-members");
    const project = await projectService.createProject({
      name: "Team Members",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const teamMembers = [{ id: "alice", name: "Alice" }];
    const updated = await projectService.updateSettings(project.id, { teamMembers });

    expect(updated.teamMembers).toEqual(teamMembers);

    const reloaded = await projectService.getSettings(project.id);
    expect(reloaded.teamMembers).toEqual(teamMembers);

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settings.teamMembers).toEqual(teamMembers);
  });

  it("should accept and persist mergeStrategy in updateSettings", async () => {
    const repoPath = path.join(tempDir, "merge-strategy");
    const project = await projectService.createProject({
      name: "Merge Strategy",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const first = await projectService.getSettings(project.id);
    expect(first.mergeStrategy).toBe("per_task");

    const updated = await projectService.updateSettings(project.id, { mergeStrategy: "per_epic" });
    expect(updated.mergeStrategy).toBe("per_epic");

    const reloaded = await projectService.getSettings(project.id);
    expect(reloaded.mergeStrategy).toBe("per_epic");

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settings.mergeStrategy).toBe("per_epic");
  });

  it("should persist reviewAngles (single, multiple, and empty) in updateSettings", async () => {
    const repoPath = path.join(tempDir, "review-angles");
    const project = await projectService.createProject({
      name: "Review Angles",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const withTwo = await projectService.updateSettings(project.id, {
      reviewAngles: ["security", "performance"],
    });
    expect(withTwo.reviewAngles).toEqual(["security", "performance"]);

    const withOne = await projectService.updateSettings(project.id, {
      reviewAngles: ["security"],
    });
    expect(withOne.reviewAngles).toEqual(["security"]);

    const reloadedOne = await projectService.getSettings(project.id);
    expect(reloadedOne.reviewAngles).toEqual(["security"]);

    const withEmpty = await projectService.updateSettings(project.id, {
      reviewAngles: [],
    });
    expect(withEmpty.reviewAngles).toBeUndefined();

    const reloadedEmpty = await projectService.getSettings(project.id);
    expect(reloadedEmpty.reviewAngles).toBeUndefined();
  });

  it("should reject invalid mergeStrategy in updateSettings", async () => {
    const repoPath = path.join(tempDir, "merge-strategy-invalid");
    const project = await projectService.createProject({
      name: "Merge Strategy Invalid",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await expect(
      projectService.updateSettings(project.id, {
        mergeStrategy: "invalid" as "per_task",
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_INPUT",
      message: expect.stringMatching(/not valid|per_task|per_epic|Per task|Per epic/),
    });
  });

  it("should default selfImprovementFrequency to never and accept valid values in updateSettings", async () => {
    const repoPath = path.join(tempDir, "self-improvement-default");
    const project = await projectService.createProject({
      name: "Self-Improvement Default",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const first = await projectService.getSettings(project.id);
    expect(first.selfImprovementFrequency).toBe("never");

    const updated = await projectService.updateSettings(project.id, {
      selfImprovementFrequency: "daily",
    });
    expect(updated.selfImprovementFrequency).toBe("daily");

    const reloaded = await projectService.getSettings(project.id);
    expect(reloaded.selfImprovementFrequency).toBe("daily");

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settings.selfImprovementFrequency).toBe("daily");
  });

  it("should persist all four selfImprovementFrequency values and round-trip", async () => {
    const repoPath = path.join(tempDir, "self-improvement-values");
    const project = await projectService.createProject({
      name: "Self-Improvement Values",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    for (const freq of ["never", "after_each_plan", "daily", "weekly"] as const) {
      const updated = await projectService.updateSettings(project.id, {
        selfImprovementFrequency: freq,
      });
      expect(updated.selfImprovementFrequency).toBe(freq);
      const reloaded = await projectService.getSettings(project.id);
      expect(reloaded.selfImprovementFrequency).toBe(freq);
    }
  });

  it("should reject invalid selfImprovementFrequency in updateSettings", async () => {
    const repoPath = path.join(tempDir, "self-improvement-invalid");
    const project = await projectService.createProject({
      name: "Self-Improvement Invalid",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await expect(
      projectService.updateSettings(project.id, {
        selfImprovementFrequency: "invalid" as "never",
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_INPUT",
      message: expect.stringMatching(/selfImprovementFrequency|never|after_each_plan|daily|weekly/),
    });
  });

  it("should ignore selfImprovementLastRunAt and selfImprovementLastCommitSha from client in updateSettings", async () => {
    const repoPath = path.join(tempDir, "self-improvement-strip");
    const project = await projectService.createProject({
      name: "Self-Improvement Strip",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const updated = await projectService.updateSettings(project.id, {
      selfImprovementFrequency: "weekly",
      selfImprovementLastRunAt: "2025-01-15T12:00:00Z",
      selfImprovementLastCommitSha: "client-sha",
    } as Record<string, unknown>);

    expect(updated.selfImprovementFrequency).toBe("weekly");
    expect(updated.selfImprovementLastRunAt).toBeUndefined();
    expect(updated.selfImprovementLastCommitSha).toBeUndefined();

    const settings = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settings.selfImprovementFrequency).toBe("weekly");
    expect(settings.selfImprovementLastRunAt).toBeUndefined();
    expect(settings.selfImprovementLastCommitSha).toBeUndefined();
  });

  it("getSettingsWithRuntimeState returns nextRunAt when frequency is daily or weekly", async () => {
    const repoPath = path.join(tempDir, "next-run-at");
    const project = await projectService.createProject({
      name: "Next Run At",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.updateSettings(project.id, { selfImprovementFrequency: "daily" });
    const withDaily = await projectService.getSettingsWithRuntimeState(project.id);
    expect(withDaily.nextRunAt).toBeDefined();
    expect(withDaily.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);

    await projectService.updateSettings(project.id, { selfImprovementFrequency: "weekly" });
    const withWeekly = await projectService.getSettingsWithRuntimeState(project.id);
    expect(withWeekly.nextRunAt).toBeDefined();
    expect(withWeekly.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);

    await projectService.updateSettings(project.id, { selfImprovementFrequency: "never" });
    const withNever = await projectService.getSettingsWithRuntimeState(project.id);
    expect(withNever.nextRunAt).toBeUndefined();

    await projectService.updateSettings(project.id, { selfImprovementFrequency: "after_each_plan" });
    const withPlan = await projectService.getSettingsWithRuntimeState(project.id);
    expect(withPlan.nextRunAt).toBeUndefined();
  });

  it("uses validationTimeoutMsOverride when set and validates bounds", async () => {
    const repoPath = path.join(tempDir, "validation-timeout-override");
    const project = await projectService.createProject({
      name: "Validation Timeout Override",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.updateSettings(project.id, {
      validationTimeoutMsOverride: MIN_VALIDATION_TIMEOUT_MS + 45_000,
    });

    await expect(
      projectService.updateSettings(project.id, {
        validationTimeoutMsOverride: MIN_VALIDATION_TIMEOUT_MS - 1,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_INPUT" });

    await expect(
      projectService.updateSettings(project.id, {
        validationTimeoutMsOverride: MAX_VALIDATION_TIMEOUT_MS + 1,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_INPUT" });

    const timeoutMs = await projectService.getValidationTimeoutMs(project.id, "scoped");
    expect(timeoutMs).toBe(MIN_VALIDATION_TIMEOUT_MS + 45_000);
  });

  it("records validation timings and derives adaptive timeout per scope", async () => {
    const repoPath = path.join(tempDir, "validation-timeout-adaptive");
    const project = await projectService.createProject({
      name: "Validation Timeout Adaptive",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const initial = await projectService.getValidationTimeoutMs(project.id, "scoped");
    expect(initial).toBe(300_000);

    await projectService.recordValidationDuration(project.id, "scoped", 20_000);
    await projectService.recordValidationDuration(project.id, "scoped", 30_000);
    await projectService.recordValidationDuration(project.id, "scoped", 25_000);

    const adaptiveScoped = await projectService.getValidationTimeoutMs(project.id, "scoped");
    expect(adaptiveScoped).toBeGreaterThanOrEqual(MIN_VALIDATION_TIMEOUT_MS);
    expect(adaptiveScoped).toBeLessThan(300_000);

    await projectService.recordValidationDuration(project.id, "full", 420_000);
    const adaptiveFull = await projectService.getValidationTimeoutMs(project.id, "full");
    expect(adaptiveFull).toBeGreaterThan(300_000);
    expect(adaptiveFull).toBeLessThanOrEqual(MAX_VALIDATION_TIMEOUT_MS);
  });

  it("should strip testFailuresAndRetries from hilConfig when reading settings (PRD §6.5.1)", async () => {
    const repoPath = path.join(tempDir, "hil-read-strip");
    const project = await projectService.createProject({
      name: "HIL Read Strip",

      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    // Manually inject legacy testFailuresAndRetries into global store
    const storePath = path.join(tempDir, ".opensprint", "settings.json");
    const raw = await fs.readFile(storePath, "utf-8");
    const store = JSON.parse(raw) as Record<string, { settings: Record<string, unknown> }>;
    const entry = store[project.id];
    if (entry?.settings?.hilConfig && typeof entry.settings.hilConfig === "object") {
      (entry.settings.hilConfig as Record<string, unknown>).testFailuresAndRetries =
        "requires_approval";
      await fs.writeFile(storePath, JSON.stringify(store));
    }

    const fetched = await projectService.getSettings(project.id);
    expect(fetched.hilConfig).not.toHaveProperty("testFailuresAndRetries");
    expect(fetched.hilConfig.scopeChanges).toBe("automated");
  });

  it("should return two-tier ProjectSettings when reading from global store", async () => {
    const repoPath = path.join(tempDir, "read-settings");
    const project = await projectService.createProject({
      name: "Read Settings",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "code-model", cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: "plan-model", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const fetched = await projectService.getSettings(project.id);
    expect(fetched.simpleComplexityAgent.type).toBe("claude");
    expect(fetched.simpleComplexityAgent.model).toBe("code-model");
    expect(fetched.complexComplexityAgent.type).toBe("cursor");
    expect(fetched.complexComplexityAgent.model).toBe("plan-model");
  });

  it("should persist two-tier shape on save", async () => {
    const repoPath = path.join(tempDir, "persist-settings");
    const project = await projectService.createProject({
      name: "Persist Settings",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.updateSettings(project.id, { testFramework: "vitest" });

    const persisted = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(persisted.simpleComplexityAgent).toBeDefined();
    expect(persisted.complexComplexityAgent).toBeDefined();
    expect(persisted.testFramework).toBe("vitest");
  });

  it("should force maxConcurrentCoders to 1 when gitWorkingMode is branches", async () => {
    const repoPath = path.join(tempDir, "branches-max-coders");
    const project = await projectService.createProject({
      name: "Branches Max Coders",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const updated = await projectService.updateSettings(project.id, {
      gitWorkingMode: "branches",
      maxConcurrentCoders: 5,
    });

    expect(updated.gitWorkingMode).toBe("branches");
    expect(updated.maxConcurrentCoders).toBe(1);

    const reloaded = await projectService.getSettings(project.id);
    expect(reloaded.maxConcurrentCoders).toBe(1);
  });

  it("should reject invalid agent config in updateSettings", async () => {
    const repoPath = path.join(tempDir, "update-settings");
    const project = await projectService.createProject({
      name: "Test",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await expect(
      projectService.updateSettings(project.id, {
        simpleComplexityAgent: { type: "invalid" as "claude", model: null, cliCommand: null },
      })
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });

  it("should reject updateSettings when agent config requires API keys but global store has none", async () => {
    const repoPath = path.join(tempDir, "api-keys-validation");
    const project = await projectService.createProject({
      name: "Test",
      repoPath,
      simpleComplexityAgent: { type: "claude-cli", model: null, cliCommand: "claude" },
      complexComplexityAgent: { type: "claude-cli", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await setGlobalSettings({ apiKeys: {} });

    await expect(
      projectService.updateSettings(project.id, {
        simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      })
    ).rejects.toMatchObject({
      code: "INVALID_AGENT_CONFIG",
      message: "Configure API keys in Settings.",
    });
  });

  it("should reject updateSettings when switching to cursor without CURSOR_API_KEY in global store", async () => {
    const repoPath = path.join(tempDir, "cursor-validation");
    const project = await projectService.createProject({
      name: "Test",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await setGlobalSettings({
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-test" }],
      },
    });

    await expect(
      projectService.updateSettings(project.id, {
        complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      })
    ).rejects.toMatchObject({
      code: "INVALID_AGENT_CONFIG",
      message: "Configure API keys in Settings.",
    });
  });

  it("should allow updateSettings when global store has required API keys", async () => {
    const repoPath = path.join(tempDir, "api-keys-ok");
    const project = await projectService.createProject({
      name: "Test",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const updated = await projectService.updateSettings(project.id, {
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
    });
    expect(updated.simpleComplexityAgent.model).toBe("claude-sonnet-4");
  });

  it("should allow updateSettings to claude-cli without API keys (CLI uses local auth)", async () => {
    const repoPath = path.join(tempDir, "claude-cli-no-keys");
    const project = await projectService.createProject({
      name: "Test",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await setGlobalSettings({ apiKeys: {} });

    const updated = await projectService.updateSettings(project.id, {
      simpleComplexityAgent: { type: "claude-cli", model: null, cliCommand: "claude" },
      complexComplexityAgent: { type: "claude-cli", model: null, cliCommand: null },
    });
    expect(updated.simpleComplexityAgent.type).toBe("claude-cli");
  });

  it("archiveProject removes from index only, leaves .opensprint intact", async () => {
    const repoPath = path.join(tempDir, "archive-project");
    const project = await projectService.createProject({
      name: "Archive Me",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.archiveProject(project.id);

    const projects = await projectService.listProjects();
    expect(projects).toHaveLength(0);

    const opensprintDir = path.join(repoPath, ".opensprint");
    const stat = await fs.stat(opensprintDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it.skip("archiveProject cascades delete of open_questions for the project (requires real task-store DB)", async () => {
    const repoPath = path.join(tempDir, "archive-oq-test");
    const project = await projectService.createProject({
      name: "Archive OQ",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await notificationService.create({
      projectId: project.id,
      source: "execute",
      sourceId: "task-1",
      questions: [{ id: "q1", text: "Clarification?", createdAt: new Date().toISOString() }],
    });
    const before = await notificationService.listByProject(project.id);
    expect(before).toHaveLength(1);

    await projectService.archiveProject(project.id);

    const after = await notificationService.listByProject(project.id);
    expect(after).toHaveLength(0);
  });

  it("archiveProject throws 404 for non-existent project", async () => {
    await expect(projectService.archiveProject("non-existent")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("deleteProject removes from index and deletes .opensprint directory", async () => {
    const repoPath = path.join(tempDir, "delete-project");
    const project = await projectService.createProject({
      name: "Delete Me",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await projectService.deleteProject(project.id);

    const projects = await projectService.listProjects();
    expect(projects).toHaveLength(0);

    await expect(fs.stat(path.join(repoPath, ".opensprint"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("deleteProject removes settings from global store", async () => {
    const repoPath = path.join(tempDir, "delete-settings-test");
    const project = await projectService.createProject({
      name: "Delete Settings",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const settingsBefore = await readSettingsFromGlobalStore(tempDir, project.id);
    expect(settingsBefore.simpleComplexityAgent).toBeDefined();

    await projectService.deleteProject(project.id);

    const storePath = path.join(tempDir, ".opensprint", "settings.json");
    const raw = await fs.readFile(storePath, "utf-8");
    const store = JSON.parse(raw) as Record<string, unknown>;
    expect(store[project.id]).toBeUndefined();
  });

  it("deleteProject removes project from projects.json index", async () => {
    const repoPath = path.join(tempDir, "delete-index-test");
    const project = await projectService.createProject({
      name: "Delete Index",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const indexPath = path.join(tempDir, ".opensprint", "projects.json");
    const beforeRaw = await fs.readFile(indexPath, "utf-8");
    const before = JSON.parse(beforeRaw) as { projects: Array<{ id: string }> };
    expect(before.projects.some((p) => p.id === project.id)).toBe(true);

    await projectService.deleteProject(project.id);

    const afterRaw = await fs.readFile(indexPath, "utf-8");
    const after = JSON.parse(afterRaw) as { projects: Array<{ id: string }> };
    expect(after.projects.some((p) => p.id === project.id)).toBe(false);
  });

  it.skip("deleteProject cascades delete of open_questions for the project (requires real task-store DB)", async () => {
    const repoPath = path.join(tempDir, "delete-oq-test");
    const project = await projectService.createProject({
      name: "Delete OQ",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await notificationService.create({
      projectId: project.id,
      source: "execute",
      sourceId: "task-1",
      questions: [{ id: "q1", text: "Clarification?", createdAt: new Date().toISOString() }],
    });
    const before = await notificationService.listByProject(project.id);
    expect(before).toHaveLength(1);

    await projectService.deleteProject(project.id);

    const after = await notificationService.listByProject(project.id);
    expect(after).toHaveLength(0);
  });

  it("deleteProject removes feedback-assets from global store", async () => {
    const repoPath = path.join(tempDir, "delete-feedback-assets-test");
    const project = await projectService.createProject({
      name: "Delete Feedback Assets",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: null, cliCommand: null },
      complexComplexityAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const feedbackAssetsDir = path.join(tempDir, ".opensprint", "feedback-assets", project.id);
    await fs.mkdir(path.join(feedbackAssetsDir, "fb-1"), { recursive: true });
    await fs.writeFile(path.join(feedbackAssetsDir, "fb-1", "0.png"), "fake-png");

    await projectService.deleteProject(project.id);

    await expect(fs.stat(feedbackAssetsDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
