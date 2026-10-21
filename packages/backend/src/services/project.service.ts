import fs from "fs";
import type {
  Project,
  CreateProjectRequest,
  ProjectSettings,
  ProjectSettingsApiUpdate,
  ScaffoldProjectRequest,
  ScaffoldProjectResponse,
} from "@opensprint/shared";
import { deploymentConfigForApiResponse } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { getSettingsWithMetaFromStore } from "./settings-store.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import * as projectIndex from "./project-index.js";
import { projectGitRuntimeCache } from "./project-git-runtime-cache.js";
import { assertSupportedRepoPath } from "../utils/repo-path-policy.js";
import { getNextScheduledSelfImprovementRunAt } from "./project/project-scheduling.js";
import { buildDefaultSettings, normalizeRepoPath } from "./project/project-settings-helpers.js";
import { buildProjectListFromIndex } from "./project/project-list-operations.js";
import { runCreateProjectFlow } from "./project/project-create-flow.js";
import { runScaffoldProjectFlow } from "./project/project-scaffold-flow.js";
import {
  computeValidationTimeoutMs,
  loadProjectSettingsFromStore,
  recordValidationDurationInStore,
} from "./project/project-settings-load.js";
import { runUpdateSettingsFlow } from "./project/project-settings-update-flow.js";
import {
  runArchiveProjectFlow,
  runDeleteProjectFlow,
} from "./project/project-archive-delete-flow.js";

export { getNextScheduledSelfImprovementRunAt } from "./project/project-scheduling.js";

/** Canonicalize existing paths so /var/... and /private/var/... match on macOS. */
function normalizeRepoPathForLookup(p: string): string {
  const base = normalizeRepoPath(p);
  try {
    if (base && fs.existsSync(base)) {
      return fs.realpathSync(base);
    }
  } catch {
    /* keep base when realpath fails */
  }
  return base;
}

export class ProjectService {
  private taskStore = taskStoreSingleton;
  private invalidateListCache(): void {
    // Catalog and settings are read from SQL on every request, including on other replicas.
  }

  /** Retained for existing fixture callers; authoritative reads need no invalidation. */
  clearListCacheForTesting(): void {
    this.invalidateListCache();
  }

  async listProjects(): Promise<Project[]> {
    return buildProjectListFromIndex();
  }

  /** Create a new project */
  async createProject(input: CreateProjectRequest): Promise<Project> {
    return runCreateProjectFlow(
      {
        invalidateListCache: () => this.invalidateListCache(),
        getProject: (id) => this.getProject(id),
        taskStore: this.taskStore,
      },
      input
    );
  }

  /** Scaffold a new project from template (Create New wizard). */
  async scaffoldProject(input: ScaffoldProjectRequest): Promise<ScaffoldProjectResponse> {
    return runScaffoldProjectFlow(
      {
        createProject: (req) => this.createProject(req),
      },
      input
    );
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
    const normalized = normalizeRepoPathForLookup(repoPath);
    const entry = entries.find((e) => normalizeRepoPathForLookup(e.repoPath) === normalized);
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
    if (repoPathChanged && updates.repoPath) {
      assertSupportedRepoPath(updates.repoPath);
    }
    const updated = { ...project, ...updates, updatedAt: new Date().toISOString() };

    if (updates.name !== undefined || repoPathChanged) {
      const indexUpdates: { name?: string; repoPath?: string } = {};
      if (updates.name !== undefined) indexUpdates.name = updates.name;
      if (repoPathChanged) indexUpdates.repoPath = updates.repoPath;
      await projectIndex.updateProject(id, indexUpdates);
    }

    this.invalidateListCache();
    if (repoPathChanged) {
      projectGitRuntimeCache.invalidate(id);
    }
    return { project: updated, repoPathChanged };
  }

  /** Read project settings from global store. If missing, create defaults and return them. */
  async getSettings(projectId: string): Promise<ProjectSettings> {
    const repoPath = await this.getRepoPath(projectId);
    return loadProjectSettingsFromStore(projectId, repoPath);
  }

  async getSettingsWithRuntimeState(projectId: string): Promise<ProjectSettings> {
    const [settings, repoPath] = await Promise.all([
      this.getSettings(projectId),
      this.getRepoPath(projectId),
    ]);
    const preferredBaseBranch = settings.worktreeBaseBranch ?? "main";
    const runtime = projectGitRuntimeCache.getSnapshot(projectId, repoPath, preferredBaseBranch);
    const freq = settings.selfImprovementFrequency ?? "never";
    const nextRunAt =
      freq === "daily" || freq === "weekly"
        ? getNextScheduledSelfImprovementRunAt(freq)
        : undefined;
    return {
      ...settings,
      deployment: deploymentConfigForApiResponse(settings.deployment),
      worktreeBaseBranch: runtime.worktreeBaseBranch,
      gitRemoteMode: runtime.gitRemoteMode,
      gitRuntimeStatus: runtime.gitRuntimeStatus,
      ...(nextRunAt !== undefined && { nextRunAt }),
    };
  }

  /**
   * Compute project-specific validation timeout from manual override or adaptive history.
   * Scoped and full-suite runs keep separate rolling duration samples.
   */
  async getValidationTimeoutMs(projectId: string, scope: "scoped" | "full"): Promise<number> {
    const settings = await this.getSettings(projectId);
    return computeValidationTimeoutMs(settings, scope);
  }

  /**
   * Record validation duration sample for adaptive timeout tuning.
   * Stored in project settings as a rolling window.
   */
  async recordValidationDuration(
    projectId: string,
    scope: "scoped" | "full",
    durationMs: number
  ): Promise<void> {
    await recordValidationDurationInStore(projectId, scope, durationMs);
  }

  /** Update project settings (persisted in global store). */
  async updateSettings(
    projectId: string,
    updates: ProjectSettingsApiUpdate
  ): Promise<ProjectSettings> {
    return runUpdateSettingsFlow(
      {
        getRepoPath: (id) => this.getRepoPath(id),
        getSettingsWithRuntimeState: (id) => this.getSettingsWithRuntimeState(id),
      },
      projectId,
      updates
    );
  }

  /** Archive a project: remove from index only. Data in project folder remains. */
  async archiveProject(id: string): Promise<void> {
    await runArchiveProjectFlow(
      {
        getProject: (pid) => this.getProject(pid),
        invalidateListCache: () => this.invalidateListCache(),
        taskStore: this.taskStore,
        invalidateProjectGitRuntime: (pid) => projectGitRuntimeCache.invalidate(pid),
      },
      id
    );
  }

  /** Delete a project: remove all project data from global store and delete .opensprint directory. */
  async deleteProject(id: string): Promise<void> {
    await runDeleteProjectFlow(
      {
        getProject: (pid) => this.getProject(pid),
        invalidateListCache: () => this.invalidateListCache(),
        taskStore: this.taskStore,
        invalidateProjectGitRuntime: (pid) => projectGitRuntimeCache.invalidate(pid),
      },
      id
    );
  }
}
