import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ProjectService } from "../services/project.service.js";
import { DEFAULT_HIL_CONFIG, DEFAULT_REVIEW_MODE } from "@opensprint/shared";

describe("ProjectService", () => {
  let projectService: ProjectService;
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-project-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should create a project with full setup flow", async () => {
    const repoPath = path.join(tempDir, "my-project");

    const project = await projectService.createProject({
      name: "Test Project",
      description: "A test project",
      repoPath,
      planningAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe("Test Project");
    expect(project.description).toBe("A test project");
    expect(project.repoPath).toBe(repoPath);
    expect(project.currentPhase).toBe("sketch");

    // Verify .opensprint directory structure
    const opensprintDir = path.join(repoPath, ".opensprint");
    const stat = await fs.stat(opensprintDir);
    expect(stat.isDirectory()).toBe(true);

    const subdirs = ["plans", "conversations", "sessions", "feedback", "active"];
    for (const sub of subdirs) {
      const subStat = await fs.stat(path.join(opensprintDir, sub));
      expect(subStat.isDirectory()).toBe(true);
    }

    // Verify settings.json
    const settingsPath = path.join(repoPath, ".opensprint", "settings.json");
    const settingsRaw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.planningAgent.type).toBe("claude");
    expect(settings.codingAgent.type).toBe("claude");
    expect(settings.hilConfig).toEqual(DEFAULT_HIL_CONFIG);
    expect(settings.testFramework).toBeNull();
    expect(settings.reviewMode).toBe(DEFAULT_REVIEW_MODE);

    // Verify prd.json
    const prdPath = path.join(repoPath, ".opensprint", "prd.json");
    const prdRaw = await fs.readFile(prdPath, "utf-8");
    const prd = JSON.parse(prdRaw);
    expect(prd.sections).toBeDefined();
    expect(prd.sections.executive_summary).toBeDefined();

    // Verify git repo
    const gitDir = path.join(repoPath, ".git");
    const gitStat = await fs.stat(gitDir);
    expect(gitStat.isDirectory()).toBe(true);

    // Verify beads initialized
    const beadsDir = path.join(repoPath, ".beads");
    const beadsStat = await fs.stat(beadsDir);
    expect(beadsStat.isDirectory()).toBe(true);

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
    expect(index.projects[0].description).toBe("A test project");
    expect(index.projects[0].repoPath).toBe(repoPath);

    // Verify getProject returns the project
    const fetched = await projectService.getProject(project.id);
    expect(fetched.id).toBe(project.id);
    expect(fetched.description).toBe("A test project");
  });

  it("should reject empty project name", async () => {
    await expect(
      projectService.createProject({
        name: "",
        description: "",
        repoPath: path.join(tempDir, "proj"),
        planningAgent: { type: "claude", model: null, cliCommand: null },
        codingAgent: { type: "claude", model: null, cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Project name is required" });
  });

  it("should reject empty repo path", async () => {
    await expect(
      projectService.createProject({
        name: "Test",
        description: "",
        repoPath: "",
        planningAgent: { type: "claude", model: null, cliCommand: null },
        codingAgent: { type: "claude", model: null, cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Repository path is required" });
  });

  it("should create eas.json when deployment mode is expo", async () => {
    const repoPath = path.join(tempDir, "expo-project");

    await projectService.createProject({
      name: "Expo Project",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
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

    await projectService.createProject({
      name: "Jest Project",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: "jest",
    });

    const settingsPath = path.join(repoPath, ".opensprint", "settings.json");
    const settingsRaw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.testFramework).toBe("jest");
  });

  it("should persist customCommand and webhookUrl when deployment mode is custom", async () => {
    const repoPath = path.join(tempDir, "custom-deploy");

    await projectService.createProject({
      name: "Custom Deploy Project",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: {
        mode: "custom",
        customCommand: "./deploy.sh",
        webhookUrl: "https://api.example.com/deploy",
      },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const settingsPath = path.join(repoPath, ".opensprint", "settings.json");
    const settingsRaw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.deployment).toBeDefined();
    expect(settings.deployment.mode).toBe("custom");
    expect(settings.deployment.customCommand).toBe("./deploy.sh");
    expect(settings.deployment.webhookUrl).toBe("https://api.example.com/deploy");
  });

  it("should not persist customCommand/webhookUrl when deployment mode is expo", async () => {
    const repoPath = path.join(tempDir, "expo-ignores-custom");

    await projectService.createProject({
      name: "Expo Ignores Custom",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: {
        mode: "expo",
        expoConfig: { channel: "preview" },
        customCommand: "./deploy.sh",
        webhookUrl: "https://api.example.com/deploy",
      },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const settingsPath = path.join(repoPath, ".opensprint", "settings.json");
    const settingsRaw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.deployment.mode).toBe("expo");
    expect(settings.deployment.customCommand).toBeUndefined();
    expect(settings.deployment.webhookUrl).toBeUndefined();
  });

  it("should normalize invalid deployment mode to custom", async () => {
    const repoPath = path.join(tempDir, "invalid-deployment");

    await projectService.createProject({
      name: "Invalid Deployment",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "invalid" as "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const settingsPath = path.join(repoPath, ".opensprint", "settings.json");
    const settingsRaw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.deployment).toBeDefined();
    expect(settings.deployment.mode).toBe("custom");
  });

  it("should merge partial hilConfig with defaults", async () => {
    const repoPath = path.join(tempDir, "partial-hil");

    await projectService.createProject({
      name: "Partial HIL",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: { scopeChanges: "automated" } as typeof DEFAULT_HIL_CONFIG,
    });

    const settingsPath = path.join(repoPath, ".opensprint", "settings.json");
    const settingsRaw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.hilConfig.scopeChanges).toBe("automated");
    expect(settings.hilConfig.architectureDecisions).toBe("requires_approval");
    expect(settings.hilConfig.dependencyModifications).toBe("automated");
  });

  it("should reject path that already has .opensprint", async () => {
    const repoPath = path.join(tempDir, "existing");
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });

    await expect(
      projectService.createProject({
        name: "Test",
        description: "",
        repoPath,
        planningAgent: { type: "claude", model: null, cliCommand: null },
        codingAgent: { type: "claude", model: null, cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "ALREADY_OPENSPRINT_PROJECT" });
  });

  it("should reject invalid planningAgent schema", async () => {
    const repoPath = path.join(tempDir, "invalid-planning");

    await expect(
      projectService.createProject({
        name: "Test",
        description: "",
        repoPath,
        planningAgent: { type: "invalid" as "claude", model: null, cliCommand: null },
        codingAgent: { type: "claude", model: null, cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });

  it("should reject invalid codingAgent schema", async () => {
    const repoPath = path.join(tempDir, "invalid-coding");

    await expect(
      projectService.createProject({
        name: "Test",
        description: "",
        repoPath,
        planningAgent: { type: "claude", model: null, cliCommand: null },
        codingAgent: { type: "cursor", model: 123 as unknown as string, cliCommand: null },
        deployment: { mode: "custom" },
        hilConfig: DEFAULT_HIL_CONFIG,
      })
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });

  it("should accept cursor agent with model", async () => {
    const repoPath = path.join(tempDir, "cursor-project");

    const project = await projectService.createProject({
      name: "Cursor Project",
      description: "",
      repoPath,
      planningAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      codingAgent: { type: "cursor", model: "composer-1.5", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    expect(project.id).toBeDefined();
    const settings = await projectService.getSettings(project.id);
    expect(settings.planningAgent.type).toBe("cursor");
    expect(settings.planningAgent.model).toBe("composer-1.5");
    expect(settings.codingAgent.type).toBe("cursor");
  });

  it("should accept custom agent with cliCommand", async () => {
    const repoPath = path.join(tempDir, "custom-agent");

    const project = await projectService.createProject({
      name: "Custom Agent",
      description: "",
      repoPath,
      planningAgent: { type: "custom", model: null, cliCommand: "/usr/bin/my-agent" },
      codingAgent: { type: "custom", model: null, cliCommand: "/usr/bin/my-agent" },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    expect(project.id).toBeDefined();
    const settings = await projectService.getSettings(project.id);
    expect(settings.planningAgent.type).toBe("custom");
    expect(settings.planningAgent.cliCommand).toBe("/usr/bin/my-agent");
  });

  it("should accept and persist codingAgentByComplexity in updateSettings", async () => {
    const repoPath = path.join(tempDir, "complexity-overrides");
    const project = await projectService.createProject({
      name: "Complexity Project",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const updated = await projectService.updateSettings(project.id, {
      codingAgentByComplexity: {
        high: { type: "claude", model: "claude-opus-5", cliCommand: null },
        low: { type: "cursor", model: "fast-model", cliCommand: null },
      },
    });

    expect(updated.codingAgentByComplexity).toBeDefined();
    expect(updated.codingAgentByComplexity?.high?.model).toBe("claude-opus-5");
    expect(updated.codingAgentByComplexity?.low?.type).toBe("cursor");

    // Verify persistence
    const reloaded = await projectService.getSettings(project.id);
    expect(reloaded.codingAgentByComplexity?.high?.model).toBe("claude-opus-5");
  });

  it("should strip testFailuresAndRetries from hilConfig in updateSettings (PRD §6.5.1)", async () => {
    const repoPath = path.join(tempDir, "hil-strip");
    const project = await projectService.createProject({
      name: "HIL Strip",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    const updated = await projectService.updateSettings(project.id, {
      hilConfig: {
        ...DEFAULT_HIL_CONFIG,
        testFailuresAndRetries: "requires_approval",
      } as typeof DEFAULT_HIL_CONFIG & { testFailuresAndRetries: string },
    });

    expect(updated.hilConfig).not.toHaveProperty("testFailuresAndRetries");
    expect(updated.hilConfig.scopeChanges).toBe("requires_approval");

    const reloaded = await projectService.getSettings(project.id);
    expect(reloaded.hilConfig).not.toHaveProperty("testFailuresAndRetries");
  });

  it("should strip testFailuresAndRetries from hilConfig when reading settings (PRD §6.5.1)", async () => {
    const repoPath = path.join(tempDir, "hil-read-strip");
    const project = await projectService.createProject({
      name: "HIL Read Strip",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    // Manually write settings with legacy testFailuresAndRetries
    const settingsPath = path.join(repoPath, ".opensprint", "settings.json");
    const raw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    settings.hilConfig.testFailuresAndRetries = "requires_approval";
    await fs.writeFile(settingsPath, JSON.stringify(settings));

    const fetched = await projectService.getSettings(project.id);
    expect(fetched.hilConfig).not.toHaveProperty("testFailuresAndRetries");
    expect(fetched.hilConfig.scopeChanges).toBe("requires_approval");
  });

  it("should reject invalid agent config in codingAgentByComplexity", async () => {
    const repoPath = path.join(tempDir, "bad-complexity");
    const project = await projectService.createProject({
      name: "Bad Complexity",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await expect(
      projectService.updateSettings(project.id, {
        codingAgentByComplexity: {
          high: { type: "invalid" as "claude", model: null, cliCommand: null },
        },
      })
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });

  it("should reject invalid agent config in updateSettings", async () => {
    const repoPath = path.join(tempDir, "update-settings");
    const project = await projectService.createProject({
      name: "Test",
      description: "",
      repoPath,
      planningAgent: { type: "claude", model: null, cliCommand: null },
      codingAgent: { type: "claude", model: null, cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });

    await expect(
      projectService.updateSettings(project.id, {
        planningAgent: { type: "invalid" as "claude", model: null, cliCommand: null },
      })
    ).rejects.toMatchObject({ code: "INVALID_AGENT_CONFIG" });
  });
});
