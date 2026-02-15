import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";
import type {
  Project,
  CreateProjectRequest,
  ProjectIndex,
  ProjectIndexEntry,
  ProjectSettings,
} from "@opensprint/shared";
import { OPENSPRINT_DIR, OPENSPRINT_PATHS, DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import { BeadsService } from "./beads.service.js";
import { ensureEasConfig } from "./eas-config.js";
import { AppError } from "../middleware/error-handler.js";

const execAsync = promisify(exec);

function getProjectIndexPaths(): { dir: string; file: string } {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".opensprint");
  return { dir, file: path.join(dir, "projects.json") };
}

export class ProjectService {
  private beads = new BeadsService();

  /** Load the global project index */
  private async loadIndex(): Promise<ProjectIndex> {
    const { file } = getProjectIndexPaths();
    try {
      const data = await fs.readFile(file, "utf-8");
      return JSON.parse(data) as ProjectIndex;
    } catch {
      return { projects: [] };
    }
  }

  /** Save the global project index (atomic write) */
  private async saveIndex(index: ProjectIndex): Promise<void> {
    const { dir, file } = getProjectIndexPaths();
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = file + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(index, null, 2));
    await fs.rename(tmpPath, file);
  }

  /** Atomic JSON write */
  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  /** Compute overall progress from beads tasks (done / total, excluding epics and gating tasks) */
  private async computeProgressPercent(repoPath: string): Promise<number> {
    try {
      const issues = await this.beads.listAll(repoPath);
      const buildTasks = issues.filter(
        (i) =>
          (i.type ?? i.issue_type) !== "epic" &&
          !/\.0$/.test(i.id) &&
          i.id.includes("."),
      );
      const done = buildTasks.filter((i) => (i.status as string) === "closed").length;
      const total = buildTasks.length;
      return total > 0 ? Math.round((done / total) * 100) : 0;
    } catch {
      return 0;
    }
  }

  /** List all projects */
  async listProjects(): Promise<Project[]> {
    const index = await this.loadIndex();
    const projects: Project[] = [];

    for (const entry of index.projects) {
      try {
        const settingsPath = path.join(entry.repoPath, OPENSPRINT_PATHS.settings);
        const stat = await fs.stat(settingsPath);
        const progressPercent = await this.computeProgressPercent(entry.repoPath);
        projects.push({
          id: entry.id,
          name: entry.name,
          description: entry.description ?? "",
          repoPath: entry.repoPath,
          currentPhase: "design",
          createdAt: entry.createdAt,
          updatedAt: stat.mtime.toISOString(),
          progressPercent,
        });
      } catch {
        // Project directory may no longer exist — skip it
      }
    }

    return projects;
  }

  /** Create a new project */
  async createProject(input: CreateProjectRequest): Promise<Project> {
    // Validate required fields
    const name = (input.name ?? "").trim();
    const repoPath = (input.repoPath ?? "").trim();
    if (!name) {
      throw new AppError(400, "INVALID_INPUT", "Project name is required");
    }
    if (!repoPath) {
      throw new AppError(400, "INVALID_INPUT", "Repository path is required");
    }

    const id = uuid();
    const now = new Date().toISOString();

    // Guard against overwriting an existing OpenSprint project
    const opensprintDir = path.join(repoPath, OPENSPRINT_DIR);
    try {
      await fs.access(opensprintDir);
      throw new AppError(400, "ALREADY_OPENSPRINT_PROJECT", `Path already contains an OpenSprint project: ${repoPath}`);
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Directory doesn't exist — proceed
    }

    // Ensure repo directory exists
    await fs.mkdir(repoPath, { recursive: true });

    // Initialize git if not already a repo
    try {
      await execAsync("git rev-parse --is-inside-work-tree", { cwd: repoPath });
    } catch {
      await execAsync("git init", { cwd: repoPath });
    }

    // Initialize beads (ignore "already initialized", propagate other errors)
    try {
      await this.beads.init(repoPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("already initialized")) {
        throw new AppError(500, "BEADS_INIT_FAILED", `Failed to initialize beads: ${msg}`);
      }
    }

    // Create .opensprint directory structure
    await fs.mkdir(path.join(opensprintDir, "plans"), { recursive: true });
    await fs.mkdir(path.join(opensprintDir, "conversations"), { recursive: true });
    await fs.mkdir(path.join(opensprintDir, "sessions"), { recursive: true });
    await fs.mkdir(path.join(opensprintDir, "feedback"), { recursive: true });
    await fs.mkdir(path.join(opensprintDir, "active"), { recursive: true });

    // Write initial PRD with all sections
    const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
    const emptySection = () => ({ content: "", version: 0, updatedAt: now });
    await this.writeJson(prdPath, {
      version: 0,
      sections: {
        executive_summary: emptySection(),
        problem_statement: emptySection(),
        user_personas: emptySection(),
        goals_and_metrics: emptySection(),
        feature_list: emptySection(),
        technical_architecture: emptySection(),
        data_model: emptySection(),
        api_contracts: emptySection(),
        non_functional_requirements: emptySection(),
        open_questions: emptySection(),
      },
      changeLog: [],
    });

    // Write settings
    const settings: ProjectSettings = {
      planningAgent: input.planningAgent,
      codingAgent: input.codingAgent,
      deployment: input.deployment,
      hilConfig: input.hilConfig ?? DEFAULT_HIL_CONFIG,
      testFramework: input.testFramework ?? null,
    };
    const settingsPath = path.join(repoPath, OPENSPRINT_PATHS.settings);
    await this.writeJson(settingsPath, settings);

    // Create eas.json for Expo projects (PRD §6.4)
    if (input.deployment?.mode === 'expo') {
      await ensureEasConfig(repoPath);
    }

    // Add to global index
    const index = await this.loadIndex();
    index.projects.push({
      id,
      name,
      description: input.description ?? "",
      repoPath,
      createdAt: now,
    });
    await this.saveIndex(index);

    return {
      id,
      name,
      description: input.description ?? "",
      repoPath,
      currentPhase: "design",
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Get a single project by ID */
  async getProject(id: string): Promise<Project> {
    const index = await this.loadIndex();
    const entry = index.projects.find((p) => p.id === id);
    if (!entry) {
      throw new AppError(404, "PROJECT_NOT_FOUND", `Project ${id} not found`);
    }

    let updatedAt = new Date().toISOString();
    try {
      const stat = await fs.stat(path.join(entry.repoPath, OPENSPRINT_PATHS.settings));
      updatedAt = stat.mtime.toISOString();
    } catch {
      // Settings file might not exist yet
    }

    return {
      id: entry.id,
      name: entry.name,
      description: entry.description ?? "",
      repoPath: entry.repoPath,
      currentPhase: "design",
      createdAt: entry.createdAt,
      updatedAt,
    };
  }

  /** Get the repo path for a project */
  async getRepoPath(id: string): Promise<string> {
    const project = await this.getProject(id);
    return project.repoPath;
  }

  /** Update project (name, settings, etc.) */
  async updateProject(id: string, updates: Partial<Project>): Promise<Project> {
    const project = await this.getProject(id);
    const updated = { ...project, ...updates, updatedAt: new Date().toISOString() };

    // Update global index if name or description changed
    if (updates.name !== undefined || updates.description !== undefined) {
      const index = await this.loadIndex();
      const entry = index.projects.find((p) => p.id === id);
      if (entry) {
        if (updates.name !== undefined) entry.name = updates.name;
        if (updates.description !== undefined) entry.description = updates.description;
        await this.saveIndex(index);
      }
    }

    return updated;
  }

  /** Read project settings */
  async getSettings(projectId: string): Promise<ProjectSettings> {
    const repoPath = await this.getRepoPath(projectId);
    const settingsPath = path.join(repoPath, OPENSPRINT_PATHS.settings);
    try {
      const raw = await fs.readFile(settingsPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      throw new AppError(404, "SETTINGS_NOT_FOUND", "Project settings not found");
    }
  }

  /** Update project settings */
  async updateSettings(projectId: string, updates: Partial<ProjectSettings>): Promise<ProjectSettings> {
    const repoPath = await this.getRepoPath(projectId);
    const current = await this.getSettings(projectId);
    const updated = { ...current, ...updates };
    const settingsPath = path.join(repoPath, OPENSPRINT_PATHS.settings);
    await this.writeJson(settingsPath, updated);
    return updated;
  }

  /** Delete a project from the index (does not delete repo) */
  async deleteProject(id: string): Promise<void> {
    const index = await this.loadIndex();
    index.projects = index.projects.filter((p) => p.id !== id);
    await this.saveIndex(index);
  }
}
