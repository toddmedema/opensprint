import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ProjectService } from "../services/project.service.js";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

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
    expect(project.currentPhase).toBe("design");

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
      }),
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
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Repository path is required" });
  });

  it("should create eas.json when deployment mode is expo", async () => {
    const repoPath = path.join(tempDir, "expo-project");

    const project = await projectService.createProject({
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

    const project = await projectService.createProject({
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
      }),
    ).rejects.toMatchObject({ code: "ALREADY_OPENSPRINT_PROJECT" });
  });
});
