import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";
import type {
  Project,
  CreateProjectRequest,
  ProjectSettings,
  CodingAgentByComplexity,
} from "@opensprint/shared";
import {
  OPENSPRINT_DIR,
  OPENSPRINT_PATHS,
  DEFAULT_HIL_CONFIG,
  DEFAULT_DEPLOYMENT_CONFIG,
  DEFAULT_REVIEW_MODE,
  getTestCommandForFramework,
} from "@opensprint/shared";
import type { DeploymentConfig, HilConfig, PlanComplexity } from "@opensprint/shared";
import { BeadsService } from "./beads.service.js";
import { detectTestFramework } from "./test-framework.service.js";
import { ensureEasConfig } from "./eas-config.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import * as projectIndex from "./project-index.js";
import { parseAgentConfig } from "../schemas/agent-config.js";
import { writeJsonAtomic } from "../utils/file-utils.js";

const execAsync = promisify(exec);

const VALID_DEPLOYMENT_MODES = ["expo", "custom"] as const;

/** Normalize deployment config: ensure valid mode, merge with defaults (PRD §6.4, §7.5.4) */
function normalizeDeployment(input: CreateProjectRequest["deployment"]): DeploymentConfig {
  const mode =
    input?.mode && VALID_DEPLOYMENT_MODES.includes(input.mode as "expo" | "custom")
      ? (input.mode as "expo" | "custom")
      : "custom";
  return {
    ...DEFAULT_DEPLOYMENT_CONFIG,
    ...input,
    mode,
    targets: input?.targets,
    envVars: input?.envVars,
    expoConfig: mode === "expo" ? { channel: input?.expoConfig?.channel ?? "preview" } : undefined,
    customCommand: mode === "custom" ? input?.customCommand : undefined,
    webhookUrl: mode === "custom" ? input?.webhookUrl : undefined,
  };
}

/** Normalize HIL config: merge partial input with defaults (PRD §6.5). Only valid keys are used. Test failures are always automated (PRD §6.5.1) — not configurable, so testFailuresAndRetries is never in HilConfig. */
const HIL_CONFIG_KEYS: (keyof HilConfig)[] = [
  "scopeChanges",
  "architectureDecisions",
  "dependencyModifications",
];

function normalizeHilConfig(input: CreateProjectRequest["hilConfig"] | Record<string, unknown>): HilConfig {
  if (!input) return DEFAULT_HIL_CONFIG;
  const defined = Object.fromEntries(
    HIL_CONFIG_KEYS.filter((k) => (input as Record<string, unknown>)[k] !== undefined).map((k) => [
      k,
      (input as Record<string, unknown>)[k],
    ]),
  );
  const result = {
    ...DEFAULT_HIL_CONFIG,
    ...defined,
  };
  // Strip legacy testFailuresAndRetries if present (PRD §6.5.1: never persisted)
  const { testFailuresAndRetries: _legacy, ...clean } = result as HilConfig & { testFailuresAndRetries?: unknown };
  return clean as HilConfig;
}

export class ProjectService {
  private beads = new BeadsService();

  /** Compute overall progress from beads tasks (done / total, excluding epics and gating tasks) */
  private async computeProgressPercent(repoPath: string): Promise<number> {
    try {
      const issues = await this.beads.listAll(repoPath);
      const buildTasks = issues.filter(
        (i) => (i.type ?? i.issue_type) !== "epic" && !/\.0$/.test(i.id) && i.id.includes(".")
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
    const entries = await projectIndex.getProjects();
    const projects: Project[] = [];

    for (const entry of entries) {
      try {
        const settingsPath = path.join(entry.repoPath, OPENSPRINT_PATHS.settings);
        const stat = await fs.stat(settingsPath);
        const progressPercent = await this.computeProgressPercent(entry.repoPath);
        projects.push({
          id: entry.id,
          name: entry.name,
          description: entry.description ?? "",
          repoPath: entry.repoPath,
          currentPhase: "sketch",
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
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Project name is required");
    }
    if (!repoPath) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Repository path is required");
    }

    // Validate agent config schema
    let planningAgent: {
      type: "claude" | "cursor" | "custom";
      model: string | null;
      cliCommand: string | null;
    };
    let codingAgent: {
      type: "claude" | "cursor" | "custom";
      model: string | null;
      cliCommand: string | null;
    };
    try {
      planningAgent = parseAgentConfig(input.planningAgent, "planningAgent");
      codingAgent = parseAgentConfig(input.codingAgent, "codingAgent");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid agent configuration";
      throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
    }

    const id = uuid();
    const now = new Date().toISOString();

    // Guard against overwriting an existing OpenSprint project
    const opensprintDir = path.join(repoPath, OPENSPRINT_DIR);
    try {
      await fs.access(opensprintDir);
      throw new AppError(
        400,
        ErrorCodes.ALREADY_OPENSPRINT_PROJECT,
        `Path already contains an OpenSprint project: ${repoPath}`,
        { repoPath }
      );
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
        throw new AppError(
          500,
          ErrorCodes.BEADS_INIT_FAILED,
          `Failed to initialize beads: ${msg}`,
          { cause: msg }
        );
      }
    }

    // PRD §5.9: Disable beads auto-commit and auto-flush; orchestrator manages persistence explicitly
    await this.beads.configSet(repoPath, "auto-flush", false);
    await this.beads.configSet(repoPath, "auto-commit", false);

    // PRD §5.9: Add orchestrator state and worktrees to .gitignore during setup
    const gitignorePath = path.join(repoPath, ".gitignore");
    const gitignoreEntries = [".opensprint/orchestrator-state.json", ".opensprint/worktrees/"];
    try {
      let content = await fs.readFile(gitignorePath, "utf-8");
      for (const entry of gitignoreEntries) {
        if (!content.includes(entry)) {
          content += `\n${entry}`;
        }
      }
      await fs.writeFile(gitignorePath, content.trimEnd() + "\n");
    } catch {
      // No .gitignore yet — create one
      await fs.writeFile(gitignorePath, gitignoreEntries.join("\n") + "\n");
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
    await writeJsonAtomic(prdPath, {
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

    // Write settings (deployment and HIL normalized per PRD §6.4, §6.5)
    const deployment = normalizeDeployment(input.deployment);
    const hilConfig = normalizeHilConfig(input.hilConfig);
    const detected = await detectTestFramework(repoPath);
    const testFramework = input.testFramework ?? detected?.framework ?? null;
    const testCommand =
      (detected?.testCommand ?? getTestCommandForFramework(testFramework)) || null;
    const settings: ProjectSettings = {
      planningAgent,
      codingAgent,
      deployment,
      hilConfig,
      testFramework,
      testCommand,
      reviewMode: DEFAULT_REVIEW_MODE,
    };
    const settingsPath = path.join(repoPath, OPENSPRINT_PATHS.settings);
    await writeJsonAtomic(settingsPath, settings);

    // Create eas.json for Expo projects (PRD §6.4)
    if (deployment.mode === "expo") {
      await ensureEasConfig(repoPath);
    }

    // Add to global index
    await projectIndex.addProject({
      id,
      name,
      description: input.description ?? "",
      repoPath,
      createdAt: now,
    });

    return {
      id,
      name,
      description: input.description ?? "",
      repoPath,
      currentPhase: "sketch",
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Get a single project by ID */
  async getProject(id: string): Promise<Project> {
    const entries = await projectIndex.getProjects();
    const entry = entries.find((p) => p.id === id);
    if (!entry) {
      throw new AppError(404, ErrorCodes.PROJECT_NOT_FOUND, `Project ${id} not found`, {
        projectId: id,
      });
    }

    // Guard against corrupt index entries missing repoPath
    if (!entry.repoPath || typeof entry.repoPath !== "string") {
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_ERROR,
        `Project ${id} has invalid repoPath in index`,
        {
          projectId: id,
          repoPath: entry.repoPath,
        }
      );
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
      currentPhase: "sketch",
      createdAt: entry.createdAt,
      updatedAt,
    };
  }

  /** Get the repo path for a project */
  async getRepoPath(id: string): Promise<string> {
    const project = await this.getProject(id);
    return project.repoPath;
  }

  /** Update project (name, description, repoPath, etc.) */
  async updateProject(
    id: string,
    updates: Partial<Project>
  ): Promise<{ project: Project; repoPathChanged: boolean }> {
    const project = await this.getProject(id);
    const repoPathChanged = updates.repoPath !== undefined && updates.repoPath !== project.repoPath;
    const updated = { ...project, ...updates, updatedAt: new Date().toISOString() };

    // Update global index if name, description, or repoPath changed
    if (updates.name !== undefined || updates.description !== undefined || repoPathChanged) {
      const indexUpdates: { name?: string; description?: string; repoPath?: string } = {};
      if (updates.name !== undefined) indexUpdates.name = updates.name;
      if (updates.description !== undefined) indexUpdates.description = updates.description;
      if (repoPathChanged) indexUpdates.repoPath = updates.repoPath;
      await projectIndex.updateProject(id, indexUpdates);
    }

    return { project: updated, repoPathChanged };
  }

  /** Read project settings */
  async getSettings(projectId: string): Promise<ProjectSettings> {
    const repoPath = await this.getRepoPath(projectId);
    const settingsPath = path.join(repoPath, OPENSPRINT_PATHS.settings);
    try {
      const raw = await fs.readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as ProjectSettings;
      return {
        ...parsed,
        hilConfig: normalizeHilConfig(parsed.hilConfig ?? {}),
      };
    } catch {
      throw new AppError(404, ErrorCodes.SETTINGS_NOT_FOUND, "Project settings not found");
    }
  }

  /** Update project settings */
  async updateSettings(
    projectId: string,
    updates: Partial<ProjectSettings>
  ): Promise<ProjectSettings> {
    const repoPath = await this.getRepoPath(projectId);
    const current = await this.getSettings(projectId);

    // Validate agent config if provided
    let planningAgent = updates.planningAgent ?? current.planningAgent;
    let codingAgent = updates.codingAgent ?? current.codingAgent;
    if (updates.planningAgent !== undefined) {
      try {
        planningAgent = parseAgentConfig(updates.planningAgent, "planningAgent");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid planning agent configuration";
        throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
      }
    }
    if (updates.codingAgent !== undefined) {
      try {
        codingAgent = parseAgentConfig(updates.codingAgent, "codingAgent");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid coding agent configuration";
        throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
      }
    }

    // Validate codingAgentByComplexity if provided
    let codingAgentByComplexity: CodingAgentByComplexity | undefined =
      current.codingAgentByComplexity;
    if (updates.codingAgentByComplexity !== undefined) {
      if (
        updates.codingAgentByComplexity === null ||
        Object.keys(updates.codingAgentByComplexity).length === 0
      ) {
        codingAgentByComplexity = undefined;
      } else {
        codingAgentByComplexity = {};
        const validKeys: PlanComplexity[] = ["low", "medium", "high", "very_high"];
        for (const [key, value] of Object.entries(updates.codingAgentByComplexity)) {
          if (!validKeys.includes(key as PlanComplexity)) continue;
          if (!value) continue;
          try {
            codingAgentByComplexity[key as PlanComplexity] = parseAgentConfig(value, "codingAgent");
          } catch (err) {
            const msg = err instanceof Error ? err.message : `Invalid agent config for ${key}`;
            throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
          }
        }
        if (Object.keys(codingAgentByComplexity).length === 0) {
          codingAgentByComplexity = undefined;
        }
      }
    }

    const hilConfig = normalizeHilConfig(
      (updates.hilConfig ?? current.hilConfig) as CreateProjectRequest["hilConfig"],
    );
    const updated: ProjectSettings = {
      ...current,
      ...updates,
      planningAgent,
      codingAgent,
      codingAgentByComplexity,
      hilConfig,
    };
    const settingsPath = path.join(repoPath, OPENSPRINT_PATHS.settings);
    await writeJsonAtomic(settingsPath, updated);
    return updated;
  }

  /** Delete a project from the index (does not delete repo) */
  async deleteProject(id: string): Promise<void> {
    await projectIndex.removeProject(id);
  }
}
