import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";
import type {
  Project,
  CreateProjectRequest,
  ProjectSettings,
  ScaffoldProjectRequest,
  ScaffoldProjectResponse,
  ScaffoldRecoveryInfo,
} from "@opensprint/shared";
import type { ApiKeyEntry, ApiKeys } from "@opensprint/shared";
import {
  OPENSPRINT_DIR,
  OPENSPRINT_PATHS,
  DEFAULT_HIL_CONFIG,
  DEFAULT_DEPLOYMENT_CONFIG,
  DEFAULT_REVIEW_MODE,
  getTestCommandForFramework,
  parseSettings,
  sanitizeApiKeys,
  getProvidersInUse,
  API_KEY_PROVIDERS,
} from "@opensprint/shared";
import type { DeploymentConfig, HilConfig } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import {
  getSettingsFromStore,
  setSettingsInStore,
  deleteSettingsFromStore,
  getSettingsWithMetaFromStore,
} from "./settings-store.service.js";
import { deleteFeedbackAssetsForProject } from "./feedback-store.service.js";
import { BranchManager } from "./branch-manager.js";
import { detectTestFramework } from "./test-framework.service.js";
import { ensureEasConfig } from "./eas-config.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import * as projectIndex from "./project-index.js";
import { parseAgentConfig, type AgentConfigInput } from "../schemas/agent-config.js";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { createLogger } from "../utils/logger.js";
import { classifyInitError, attemptRecovery } from "./scaffold-recovery.service.js";

const execAsync = promisify(exec);
const log = createLogger("project");

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

function normalizeHilConfig(
  input: CreateProjectRequest["hilConfig"] | Record<string, unknown>
): HilConfig {
  if (!input) return DEFAULT_HIL_CONFIG;
  const defined = Object.fromEntries(
    HIL_CONFIG_KEYS.filter((k) => (input as Record<string, unknown>)[k] !== undefined).map((k) => [
      k,
      (input as Record<string, unknown>)[k],
    ])
  );
  return {
    ...DEFAULT_HIL_CONFIG,
    ...defined,
  };
}

/** Normalize path for comparison: trim and remove trailing slashes. */
function normalizeRepoPath(p: string): string {
  return p.trim().replace(/\/+$/, "") || "";
}

/**
 * Merge incoming apiKeys with current. When an entry has id but no value (frontend
 * sends masked data), use the existing value from current so we can persist unchanged keys.
 */
function mergeApiKeysWithCurrent(
  incoming: unknown,
  current: ApiKeys | undefined
): ApiKeys | undefined {
  if (incoming == null || typeof incoming !== "object" || Array.isArray(incoming)) {
    return undefined;
  }
  const obj = incoming as Record<string, unknown>;
  const result: ApiKeys = {};
  for (const provider of API_KEY_PROVIDERS) {
    const arr = obj[provider];
    if (arr == null || !Array.isArray(arr)) continue;
    const currentEntries = current?.[provider] ?? [];
    const merged: ApiKeyEntry[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id.trim() : "";
      if (!id) continue;
      let value = e.value;
      if (typeof value !== "string" || !value.trim()) {
        const existing = currentEntries.find((x) => x.id === id);
        value = existing?.value ?? "";
      }
      if (!value) continue;
      merged.push({
        id,
        value,
        ...(e.limitHitAt != null && typeof e.limitHitAt === "string" && { limitHitAt: e.limitHitAt }),
      });
    }
    if (merged.length > 0) result[provider] = merged;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Default agent config used when creating or repairing settings (e.g. adopt path). */
const DEFAULT_AGENT_CONFIG = {
  type: "cursor" as const,
  model: null as string | null,
  cliCommand: null as string | null,
};

/** Build default ProjectSettings for a repo (no user input). Used when adopting or repairing. */
function buildDefaultSettings(): ProjectSettings {
  return {
    simpleComplexityAgent: { ...DEFAULT_AGENT_CONFIG },
    complexComplexityAgent: { ...DEFAULT_AGENT_CONFIG },
    deployment: { ...DEFAULT_DEPLOYMENT_CONFIG },
    hilConfig: { ...DEFAULT_HIL_CONFIG },
    testFramework: null,
    testCommand: null,
    reviewMode: DEFAULT_REVIEW_MODE,
    gitWorkingMode: "worktree",
  };
}

/** Build canonical ProjectSettings for persistence. */
function toCanonicalSettings(s: ProjectSettings): ProjectSettings {
  return {
    simpleComplexityAgent: s.simpleComplexityAgent,
    complexComplexityAgent: s.complexComplexityAgent,
    deployment: s.deployment,
    hilConfig: s.hilConfig,
    testFramework: s.testFramework ?? null,
    testCommand: s.testCommand ?? null,
    reviewMode: s.reviewMode ?? DEFAULT_REVIEW_MODE,
    ...(s.maxConcurrentCoders !== undefined && { maxConcurrentCoders: s.maxConcurrentCoders }),
    ...(s.unknownScopeStrategy !== undefined && { unknownScopeStrategy: s.unknownScopeStrategy }),
    gitWorkingMode: s.gitWorkingMode ?? "worktree",
    ...(s.apiKeys && Object.keys(s.apiKeys).length > 0 && { apiKeys: s.apiKeys }),
  };
}

export class ProjectService {
  private taskStore = taskStoreSingleton;
  /** In-memory cache for listProjects() so GET /projects returns instantly when the event loop is busy (e.g. orchestrator). Invalidated on create/update/delete. */
  private listCache: Project[] | null = null;

  private invalidateListCache(): void {
    this.listCache = null;
  }

  /** List all projects (cached; invalidated on create/update/delete). Settings are in global DB. */
  async listProjects(): Promise<Project[]> {
    if (this.listCache !== null) {
      return this.listCache;
    }
    const entries = await projectIndex.getProjects();
    const projects: Project[] = [];

    for (const entry of entries) {
      try {
        await fs.access(path.join(entry.repoPath, OPENSPRINT_DIR));
        const { updatedAt } = await getSettingsWithMetaFromStore(
          entry.id,
          buildDefaultSettings()
        );
        projects.push({
          id: entry.id,
          name: entry.name,
          repoPath: entry.repoPath,
          currentPhase: "sketch",
          createdAt: entry.createdAt,
          updatedAt: updatedAt ?? entry.createdAt,
        });
      } catch {
        // Project directory may no longer exist — skip it
      }
    }

    this.listCache = projects;
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
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Project folder is required");
    }

    // Validate agent config schema (accept new or legacy keys)
    const simpleInput = input.simpleComplexityAgent ?? input.lowComplexityAgent;
    const complexInput = input.complexComplexityAgent ?? input.highComplexityAgent;
    let simpleComplexityAgent: AgentConfigInput;
    let complexComplexityAgent: AgentConfigInput;
    try {
      simpleComplexityAgent = parseAgentConfig(simpleInput, "simpleComplexityAgent");
      complexComplexityAgent = parseAgentConfig(complexInput, "complexComplexityAgent");
    } catch (err) {
      const msg = getErrorMessage(err, "Invalid agent configuration");
      throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
    }

    const id = uuid();
    const now = new Date().toISOString();

    // If path already has OpenSprint, return the existing project instead of creating
    const opensprintDir = path.join(repoPath, OPENSPRINT_DIR);
    try {
      await fs.access(opensprintDir);
      const normalized = normalizeRepoPath(repoPath);
      const entries = await projectIndex.getProjects();
      const existing = entries.find((e) => normalizeRepoPath(e.repoPath) === normalized);
      if (existing) {
        return this.getProject(existing.id);
      }
      // Repo has .opensprint but no index entry (e.g. index from another machine or cleared). Adopt it.
      const adoptId = uuid();
      const adoptName = name || "Existing project";
      await projectIndex.addProject({
        id: adoptId,
        name: adoptName,
        repoPath: normalized,
        createdAt: now,
      });
      // Ensure settings exist in global store so getSettings() and Sketch/Plan flows work (PRD §6.3).
      const defaults = buildDefaultSettings();
      await setSettingsInStore(adoptId, defaults);
      this.invalidateListCache();
      return this.getProject(adoptId);
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

    // Task store uses global server only. No per-repo data.

    // Ensure AGENTS.md exists and contains bd task-tracking instruction
    const agentsMdPath = path.join(repoPath, "AGENTS.md");
    const bdInstruction = "Use 'bd' for task tracking";
    try {
      let agentsContent = await fs.readFile(agentsMdPath, "utf-8");
      if (!agentsContent.includes(bdInstruction)) {
        agentsContent = agentsContent.trimEnd() + `\n\n${bdInstruction}\n`;
        await fs.writeFile(agentsMdPath, agentsContent);
      }
    } catch {
      await fs.writeFile(agentsMdPath, `# Agent Instructions\n\n${bdInstruction}\n`);
    }

    // PRD §5.9: Add orchestrator state and worktrees to .gitignore during setup
    const gitignorePath = path.join(repoPath, ".gitignore");
    // Runtime and WIP paths only; feedback, counters, events, agent-stats, deployments are DB-only
    const gitignoreEntries = [
      ".opensprint/orchestrator-state.json",
      ".opensprint/worktrees/",
      ".opensprint/pending-commits.json",
      ".opensprint/sessions/",
      ".opensprint/active/",
    ];
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

    // Create .opensprint directory structure (sessions live in runtime dir, not repo)
    await fs.mkdir(path.join(opensprintDir, "plans"), { recursive: true });
    await fs.mkdir(path.join(opensprintDir, "conversations"), { recursive: true });
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
    const gitWorkingMode = input.gitWorkingMode === "branches" ? "branches" : "worktree";
    const effectiveMaxConcurrentCoders =
      gitWorkingMode === "branches" ? 1 : (input.maxConcurrentCoders ?? 1);
    const apiKeys = sanitizeApiKeys(input.apiKeys);
    const settings: ProjectSettings = {
      simpleComplexityAgent,
      complexComplexityAgent,
      deployment,
      hilConfig,
      testFramework,
      testCommand,
      reviewMode: DEFAULT_REVIEW_MODE,
      gitWorkingMode,
      maxConcurrentCoders: effectiveMaxConcurrentCoders,
      ...(effectiveMaxConcurrentCoders > 1 &&
        input.unknownScopeStrategy && {
          unknownScopeStrategy: input.unknownScopeStrategy,
        }),
      ...(apiKeys && Object.keys(apiKeys).length > 0 && { apiKeys }),
    };
    await setSettingsInStore(id, settings);

    // Create eas.json for Expo projects (PRD §6.4)
    if (deployment.mode === "expo") {
      await ensureEasConfig(repoPath);
    }

    // Add to global index
    await projectIndex.addProject({
      id,
      name,
      repoPath,
      createdAt: now,
    });

    this.invalidateListCache();

    // Prime global task store schema so first list-tasks works (ensure-dolt.sh fixes schema at dev start; this touches it at create time).
    try {
      await this.taskStore.listAll(id);
    } catch (e) {
      log.warn("Task store schema not ready after create project", { err: getErrorMessage(e) });
    }

    return {
      id,
      name,
      repoPath,
      currentPhase: "sketch",
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Scaffold a new project from template (Create New wizard). */
  async scaffoldProject(input: ScaffoldProjectRequest): Promise<ScaffoldProjectResponse> {
    const name = (input.name ?? "").trim();
    const parentPath = (input.parentPath ?? "").trim();
    const template = input.template;

    if (!name) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Project name is required");
    }
    if (!parentPath) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Project folder (parentPath) is required");
    }
    if (template !== "web-app-expo-react") {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        `Unsupported template: ${template}. Only "web-app-expo-react" is supported.`
      );
    }

    const repoPath = path.resolve(parentPath);
    const agentConfig = (input.simpleComplexityAgent ?? DEFAULT_AGENT_CONFIG) as AgentConfigInput & { type: "cursor" | "claude" | "claude-cli" | "custom" };
    let recovery: ScaffoldRecoveryInfo | undefined;

    if (template === "web-app-expo-react") {
      await fs.mkdir(repoPath, { recursive: true });

      // Step 1: scaffold Expo app
      const scaffoldResult = await this.runWithRecovery(
        "npx create-expo-app@latest . --template blank --yes",
        repoPath,
        agentConfig,
        "Failed to scaffold Expo app",
      );
      if (scaffoldResult.recovery) {
        recovery = scaffoldResult.recovery;
      }
      if (!scaffoldResult.success) {
        throw new AppError(
          500,
          ErrorCodes.SCAFFOLD_INIT_FAILED,
          scaffoldResult.errorMessage!,
          { repoPath, recovery },
        );
      }

      // Step 2: npm install
      const installResult = await this.runWithRecovery(
        "npm install",
        repoPath,
        agentConfig,
        "Failed to run npm install",
      );
      if (!recovery && installResult.recovery) {
        recovery = installResult.recovery;
      }
      if (!installResult.success) {
        throw new AppError(
          500,
          ErrorCodes.SCAFFOLD_INIT_FAILED,
          installResult.errorMessage!,
          { repoPath, recovery: installResult.recovery ?? recovery },
        );
      }
    }

    const simpleInput = input.simpleComplexityAgent ?? DEFAULT_AGENT_CONFIG;
    const complexInput = input.complexComplexityAgent ?? DEFAULT_AGENT_CONFIG;
    const createRequest: CreateProjectRequest = {
      name,
      repoPath,
      simpleComplexityAgent: simpleInput as AgentConfigInput,
      complexComplexityAgent: complexInput as AgentConfigInput,
      deployment: DEFAULT_DEPLOYMENT_CONFIG,
      hilConfig: DEFAULT_HIL_CONFIG,
      gitWorkingMode: "worktree",
      maxConcurrentCoders: 1,
      testFramework: null,
    };

    const project = await this.createProject(createRequest);

    const absPath = path.resolve(repoPath);
    const runCommand =
      process.platform === "win32"
        ? `cd /d ${absPath} && npm run web`
        : `cd ${absPath} && npm run web`;

    return { project, runCommand, ...(recovery && { recovery }) };
  }

  /**
   * Run a shell command with agent-driven error recovery.
   * On failure: classifies the error, invokes an agent to fix it, retries once.
   */
  private async runWithRecovery(
    command: string,
    cwd: string,
    agentConfig: AgentConfigInput & { type: string },
    fallbackMessage: string,
  ): Promise<{ success: boolean; errorMessage?: string; recovery?: ScaffoldRecoveryInfo }> {
    try {
      await execAsync(command, { cwd });
      return { success: true };
    } catch (firstErr) {
      const rawError = getErrorMessage(firstErr, fallbackMessage);
      const classification = classifyInitError(rawError);

      log.info("Scaffold command failed, attempting recovery", {
        command,
        category: classification.category,
        recoverable: classification.recoverable,
      });

      if (!classification.recoverable) {
        return {
          success: false,
          errorMessage: `${classification.summary}: ${rawError}`,
          recovery: {
            attempted: false,
            success: false,
            errorCategory: classification.category,
            errorSummary: classification.summary,
          },
        };
      }

      const recoveryResult = await attemptRecovery(
        classification,
        cwd,
        agentConfig as AgentConfigInput & { type: "cursor" | "claude" | "claude-cli" | "custom" },
      );

      if (!recoveryResult.success) {
        return {
          success: false,
          errorMessage: recoveryResult.errorMessage ?? `${classification.summary}: ${rawError}`,
          recovery: {
            attempted: true,
            success: false,
            errorCategory: classification.category,
            errorSummary: classification.summary,
            agentOutput: recoveryResult.agentOutput,
          },
        };
      }

      // Agent claims success — retry the original command
      log.info("Recovery agent succeeded, retrying command", { command });
      try {
        await execAsync(command, { cwd });
        return {
          success: true,
          recovery: {
            attempted: true,
            success: true,
            errorCategory: classification.category,
            errorSummary: classification.summary,
            agentOutput: recoveryResult.agentOutput,
          },
        };
      } catch (retryErr) {
        const retryMsg = getErrorMessage(retryErr, fallbackMessage);
        return {
          success: false,
          errorMessage: `Recovery agent ran but the command still failed: ${retryMsg}`,
          recovery: {
            attempted: true,
            success: false,
            errorCategory: classification.category,
            errorSummary: classification.summary,
            agentOutput: recoveryResult.agentOutput,
          },
        };
      }
    }
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

    const { updatedAt } = await getSettingsWithMetaFromStore(id, buildDefaultSettings());

    return {
      id: entry.id,
      name: entry.name,
      repoPath: entry.repoPath,
      currentPhase: "sketch",
      createdAt: entry.createdAt,
      updatedAt: updatedAt ?? entry.createdAt,
    };
  }

  /** Get the repo path for a project */
  async getRepoPath(id: string): Promise<string> {
    const project = await this.getProject(id);
    return project.repoPath;
  }

  /** Get project by repo path (for callers that only have repoPath). */
  async getProjectByRepoPath(repoPath: string): Promise<Project | null> {
    const entries = await projectIndex.getProjects();
    const normalized = normalizeRepoPath(repoPath);
    const entry = entries.find((e) => normalizeRepoPath(e.repoPath) === normalized);
    if (!entry) return null;
    try {
      return await this.getProject(entry.id);
    } catch {
      return null;
    }
  }

  /** Update project (name, repoPath, etc.) */
  async updateProject(
    id: string,
    updates: Partial<Project>
  ): Promise<{ project: Project; repoPathChanged: boolean }> {
    const project = await this.getProject(id);
    const repoPathChanged = updates.repoPath !== undefined && updates.repoPath !== project.repoPath;
    const updated = { ...project, ...updates, updatedAt: new Date().toISOString() };

    // Update global index if name or repoPath changed
    if (updates.name !== undefined || repoPathChanged) {
      const indexUpdates: { name?: string; repoPath?: string } = {};
      if (updates.name !== undefined) indexUpdates.name = updates.name;
      if (repoPathChanged) indexUpdates.repoPath = updates.repoPath;
      await projectIndex.updateProject(id, indexUpdates);
    }

    this.invalidateListCache();
    return { project: updated, repoPathChanged };
  }

  /** Read project settings from global store. If missing, create defaults and return them. */
  async getSettings(projectId: string): Promise<ProjectSettings> {
    const repoPath = await this.getRepoPath(projectId);
    const defaults = buildDefaultSettings();
    let stored = await getSettingsFromStore(projectId, defaults);
    if (stored === defaults) {
      const detected = await detectTestFramework(repoPath);
      const enriched: ProjectSettings = {
        ...defaults,
        testFramework: detected?.framework ?? null,
        testCommand: detected?.testCommand ?? (getTestCommandForFramework(null) || null),
      };
      await setSettingsInStore(projectId, enriched);
      return toCanonicalSettings(enriched);
    }
    const normalized = {
      ...stored,
      hilConfig: normalizeHilConfig(stored.hilConfig ?? {}),
    };
    return toCanonicalSettings(parseSettings(normalized));
  }

  /** Update project settings (persisted in global store). */
  async updateSettings(
    projectId: string,
    updates: Partial<ProjectSettings>
  ): Promise<ProjectSettings> {
    await this.getRepoPath(projectId);
    const current = await this.getSettings(projectId);

    // Validate agent config if provided (accept new or legacy keys)
    const raw = updates as Partial<ProjectSettings> & { lowComplexityAgent?: unknown; highComplexityAgent?: unknown };
    const simpleUpdate = updates.simpleComplexityAgent ?? raw.lowComplexityAgent;
    const complexUpdate = updates.complexComplexityAgent ?? raw.highComplexityAgent;
    let simpleComplexityAgent = current.simpleComplexityAgent;
    let complexComplexityAgent = current.complexComplexityAgent;
    if (simpleUpdate !== undefined) {
      try {
        simpleComplexityAgent = parseAgentConfig(simpleUpdate, "simpleComplexityAgent");
      } catch (err) {
        const msg = getErrorMessage(err, "Invalid simple complexity agent configuration");
        throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
      }
    }
    if (complexUpdate !== undefined) {
      try {
        complexComplexityAgent = parseAgentConfig(complexUpdate, "complexComplexityAgent");
      } catch (err) {
        const msg = getErrorMessage(err, "Invalid complex complexity agent configuration");
        throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
      }
    }

    const hilConfig = normalizeHilConfig(
      (updates.hilConfig ?? current.hilConfig) as CreateProjectRequest["hilConfig"]
    );
    const gitWorkingMode =
      updates.gitWorkingMode === "worktree" || updates.gitWorkingMode === "branches"
        ? updates.gitWorkingMode
        : (current.gitWorkingMode ?? "worktree");
    const apiKeys =
      updates.apiKeys !== undefined
        ? sanitizeApiKeys(mergeApiKeysWithCurrent(updates.apiKeys, current.apiKeys)) ?? undefined
        : current.apiKeys;
    const effectiveSettings: ProjectSettings = {
      ...current,
      ...updates,
      simpleComplexityAgent,
      complexComplexityAgent,
      hilConfig,
      gitWorkingMode,
      apiKeys,
    };
    if (updates.apiKeys !== undefined) {
      const providersInUse = getProvidersInUse(effectiveSettings);
      const effectiveApiKeys = apiKeys ?? {};
      for (const provider of providersInUse) {
        const entries = effectiveApiKeys[provider];
        if (!entries || entries.length === 0) {
          throw new AppError(
            400,
            ErrorCodes.INVALID_INPUT,
            `API keys for ${provider} cannot be empty when this provider is selected in agent config`
          );
        }
      }
    }
    const updated: ProjectSettings = {
      ...effectiveSettings,
      // Branches mode forces maxConcurrentCoders=1 regardless of stored value
      ...(gitWorkingMode === "branches" && { maxConcurrentCoders: 1 }),
    };
    await setSettingsInStore(projectId, toCanonicalSettings(updated));
    return updated;
  }

  /** Archive a project: remove from index only. Data in project folder remains. */
  async archiveProject(id: string): Promise<void> {
    await this.getProject(id); // validate exists, throws 404 if not
    await projectIndex.removeProject(id);
    this.invalidateListCache();
  }

  /** Delete a project: remove all project data from global store and delete .opensprint directory. */
  async deleteProject(id: string): Promise<void> {
    const project = await this.getProject(id);
    const repoPath = project.repoPath;

    // Remove worktrees for this project so watchdog/orphan recovery never see them again.
    // Use listTaskWorktrees (from git) to find all worktrees regardless of tmpdir.
    const branchManager = new BranchManager();
    try {
      const worktrees = await branchManager.listTaskWorktrees(repoPath);
      for (const { taskId, worktreePath } of worktrees) {
        try {
          await branchManager.removeTaskWorktree(repoPath, taskId, worktreePath);
        } catch {
          // Best effort; worktree may already be gone
        }
      }
    } catch {
      // Repo may not exist or have no worktrees
    }

    await this.taskStore.deleteByProjectId(id);
    await deleteSettingsFromStore(id);
    await deleteFeedbackAssetsForProject(id);

    const opensprintPath = path.join(repoPath, OPENSPRINT_DIR);
    try {
      await fs.rm(opensprintPath, { recursive: true, force: true });
    } catch (err) {
      const msg = getErrorMessage(err);
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, `Failed to delete project data: ${msg}`, {
        projectId: id,
        repoPath,
      });
    }

    await projectIndex.removeProject(id);
    this.invalidateListCache();
  }
}
