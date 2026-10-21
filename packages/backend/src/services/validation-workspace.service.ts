import fs from "fs/promises";
import os from "os";
import path from "path";
import { ensureRepoHasInitialCommit } from "../utils/git-repo-state.js";
import { getGitNoHooksPath } from "../utils/git-no-hooks.js";
import { unlinkWorktreeLinks } from "../utils/worktree-links.js";
import { createLogger } from "../utils/logger.js";
import { runCommand as runCommandDefault, type CommandRunResult } from "../utils/command-runner.js";
import { assertWorktreeIntegrity, type WorktreeIntegrityResult } from "../utils/worktree-health.js";
import { BranchManager } from "./branch-manager.js";

const log = createLogger("validation-workspace");
const NPM_CI_TIMEOUT_MS = 10 * 60 * 1000;
const NPM_INCLUDE_DEV_ENV = {
  NPM_CONFIG_INCLUDE: "dev",
  npm_config_include: "dev",
  NPM_CONFIG_OMIT: "",
  npm_config_omit: "",
} as const;

export type ValidationWorkspaceKind = "baseline" | "merged_candidate";

export type NodeModulesStrategy =
  | "symlink"
  | "repo_repair_then_symlink"
  | "npm_ci_worktree"
  | "none";

export interface NodeModulesResult {
  ok: boolean;
  strategy: NodeModulesStrategy;
  error?: string;
}

export interface ValidationWorkspaceHandle {
  kind: ValidationWorkspaceKind;
  worktreePath: string;
  branchName: string | null;
  cleanup(): Promise<void>;
}

interface ValidationWorkspaceServiceDeps {
  runCommand?: (
    spec: { command: string; args?: string[] },
    options: { cwd: string; timeout?: number; env?: Record<string, string> }
  ) => Promise<CommandRunResult>;
  branchManager?: BranchManager;
}

function slugifyForGitRef(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "workspace"
  );
}

export class ValidationWorkspaceService {
  private runCommand: NonNullable<ValidationWorkspaceServiceDeps["runCommand"]>;
  private branchManager: BranchManager;

  constructor(deps: ValidationWorkspaceServiceDeps = {}) {
    this.runCommand = deps.runCommand ?? runCommandDefault;
    this.branchManager = deps.branchManager ?? new BranchManager();
  }

  private async createWorkspaceBaseDir(kind: ValidationWorkspaceKind): Promise<string> {
    const baseDir = path.join(os.tmpdir(), "opensprint-validation");
    await fs.mkdir(baseDir, { recursive: true });
    return fs.mkdtemp(path.join(baseDir, `${kind}-`));
  }

  private async cleanupWorktree(
    repoPath: string,
    worktreePath: string,
    branchName: string | null
  ): Promise<void> {
    await unlinkWorktreeLinks(worktreePath);
    try {
      await this.runCommand(
        {
          command: "git",
          args: ["worktree", "remove", worktreePath, "--force"],
        },
        {
          cwd: repoPath,
          timeout: 30_000,
        }
      );
    } catch (err) {
      log.warn("Failed to remove validation worktree via git; falling back to fs cleanup", {
        worktreePath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    await fs.rm(path.dirname(worktreePath), { recursive: true, force: true }).catch((err: unknown) => {
      log.warn("validation workspace cleanup failed", { err: err instanceof Error ? err.message : String(err) });
    });
    if (branchName) {
      await this.runCommand(
        {
          command: "git",
          args: ["branch", "-D", branchName],
        },
        {
          cwd: repoPath,
          timeout: 30_000,
        }
      ).catch((err: unknown) => {
        log.warn("validation branch cleanup failed", { err: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  async checkWorktreeReadiness(
    repoPath: string,
    worktreePath: string,
    taskId: string
  ): Promise<WorktreeIntegrityResult> {
    return assertWorktreeIntegrity(repoPath, worktreePath, taskId, "merge");
  }

  async verifyWorkspaceHealth(
    repoPath: string,
    worktreePath: string,
    label: ValidationWorkspaceKind | "task_worktree" | "repo_root" = "task_worktree"
  ): Promise<{ healthy: boolean; errors: string[] }> {
    const errors: string[] = [];
    const isNpmWorkspace = await this.repoHasFile(repoPath, "package.json");
    if (isNpmWorkspace) {
      const packageJsonPath = path.join(worktreePath, "package.json");
      try {
        await fs.access(packageJsonPath);
      } catch {
        errors.push(`package.json missing at ${packageJsonPath}`);
      }

      const workspaceLockfilePath = path.join(worktreePath, "package-lock.json");
      const repoHasLockfile = await this.repoHasFile(repoPath, "package-lock.json");
      if (repoHasLockfile) {
        try {
          await fs.access(workspaceLockfilePath);
        } catch {
          errors.push(`package-lock.json missing at ${workspaceLockfilePath}`);
        }
      }

      const nodeModulesPath = path.join(worktreePath, "node_modules");
      if (!(await this.isNodeModulesUsable(nodeModulesPath))) {
        errors.push(`node_modules missing or unusable at ${nodeModulesPath}`);
      }
    }

    try {
      await this.runCommand(
        { command: "git", args: ["rev-parse", "--verify", "HEAD"] },
        { cwd: worktreePath, timeout: 30_000 }
      );
    } catch {
      errors.push(`git HEAD not valid in ${label} workspace at ${worktreePath}`);
    }

    if (errors.length > 0) {
      log.warn(`Workspace health check failed for ${label}`, { worktreePath, errors });
    }
    return { healthy: errors.length === 0, errors };
  }

  private async verifyWorkspaceReady(
    repoPath: string,
    worktreePath: string,
    kind: ValidationWorkspaceKind
  ): Promise<void> {
    const { healthy, errors } = await this.verifyWorkspaceHealth(repoPath, worktreePath, kind);
    if (!healthy) {
      throw new Error(`Validation workspace not ready (${kind}): ${errors.join("; ")}`);
    }
  }

  async createBaselineWorkspace(
    repoPath: string,
    baseBranch: string
  ): Promise<ValidationWorkspaceHandle> {
    await ensureRepoHasInitialCommit(repoPath, baseBranch);
    const baseDir = await this.createWorkspaceBaseDir("baseline");
    const worktreePath = path.join(baseDir, "workspace");
    const noHooks = getGitNoHooksPath();
    await this.runCommand(
      {
        command: "git",
        args: [
          "-c",
          `core.hooksPath=${noHooks}`,
          "worktree",
          "add",
          "--detach",
          worktreePath,
          baseBranch,
        ],
      },
      {
        cwd: repoPath,
        timeout: 30_000,
      }
    );
    if (await this.repoHasFile(repoPath, "package.json")) {
      await this.ensureWorktreeNodeModules(repoPath, worktreePath, "baseline");
    }
    await this.verifyWorkspaceReady(repoPath, worktreePath, "baseline");

    return {
      kind: "baseline",
      worktreePath,
      branchName: null,
      cleanup: async () => {
        await this.cleanupWorktree(repoPath, worktreePath, null);
      },
    };
  }

  async createMergeCandidateWorkspace(
    repoPath: string,
    taskId: string,
    baseBranch: string
  ): Promise<ValidationWorkspaceHandle> {
    await ensureRepoHasInitialCommit(repoPath, baseBranch);
    const baseDir = await this.createWorkspaceBaseDir("merged_candidate");
    const worktreePath = path.join(baseDir, "workspace");
    const branchName = `opensprint/validation/${slugifyForGitRef(taskId)}-${Date.now().toString(36)}`;
    const noHooks = getGitNoHooksPath();
    await this.runCommand(
      {
        command: "git",
        args: [
          "-c",
          `core.hooksPath=${noHooks}`,
          "worktree",
          "add",
          "-b",
          branchName,
          worktreePath,
          baseBranch,
        ],
      },
      {
        cwd: repoPath,
        timeout: 30_000,
      }
    );

    if (await this.repoHasFile(repoPath, "package.json")) {
      await this.ensureWorktreeNodeModules(repoPath, worktreePath, "merged_candidate");
    }
    await this.verifyWorkspaceReady(repoPath, worktreePath, "merged_candidate");

    return {
      kind: "merged_candidate",
      worktreePath,
      branchName,
      cleanup: async () => {
        await this.cleanupWorktree(repoPath, worktreePath, branchName);
      },
    };
  }

  /**
   * Check whether node_modules at the given path is a real, non-empty directory
   * (or a symlink pointing to one). Returns true only when the path is usable.
   */
  private async isNodeModulesUsable(nodeModulesPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(nodeModulesPath);
      if (!stat.isDirectory()) return false;
      const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  private async repoHasFile(repoPath: string, fileName: string): Promise<boolean> {
    return fs
      .access(path.join(repoPath, fileName))
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Public alias kept for backward compatibility.
   */
  async ensureMergedCandidateNodeModules(
    repoPath: string,
    worktreePath: string
  ): Promise<NodeModulesResult> {
    return this.ensureWorktreeNodeModules(repoPath, worktreePath, "merged_candidate");
  }

  /**
   * Ensure node_modules is present and accessible in any validation worktree.
   *
   * Strategy (ordered by cost):
   *   1. Symlink from main repo (fast path).
   *   2. If the symlink target is broken, ensure the main repo has healthy deps
   *      (ensureRepoNodeModules) and re-symlink.
   *   3. Fall back to `npm ci` inside the worktree itself.
   *   4. After every strategy, verify node_modules is usable.
   *
   * Returns a result describing the outcome so callers (and the gate runner's
   * repair loop) can decide what to do next.
   */
  async ensureWorktreeNodeModules(
    repoPath: string,
    worktreePath: string,
    kind: ValidationWorkspaceKind
  ): Promise<NodeModulesResult> {
    const nodeModulesPath = path.join(worktreePath, "node_modules");

    // --- Strategy 1: symlink from main repo ---
    await this.branchManager.symlinkNodeModules(repoPath, worktreePath);
    if (await this.isNodeModulesUsable(nodeModulesPath)) {
      return { ok: true, strategy: "symlink" };
    }

    // --- Strategy 2: repair main repo deps, then re-symlink ---
    log.info(
      `${kind} symlink target missing or empty; ensuring main repo deps are healthy`,
      { worktreePath, repoPath }
    );
    const repoRepaired = await this.branchManager.ensureRepoNodeModules(repoPath);
    if (repoRepaired) {
      await this.branchManager.symlinkNodeModules(repoPath, worktreePath);
      if (await this.isNodeModulesUsable(nodeModulesPath)) {
        return { ok: true, strategy: "repo_repair_then_symlink" };
      }
    }

    // --- Strategy 3: npm ci in the worktree (requires package.json + lockfile) ---
    const pkgPath = path.join(worktreePath, "package.json");
    try {
      await fs.access(pkgPath);
    } catch {
      log.warn(`${kind} worktree has no package.json; cannot run npm ci fallback`, {
        worktreePath,
      });
      return {
        ok: false,
        strategy: "none",
        error:
          "node_modules missing: symlink target empty and no package.json in worktree. " +
          "Ensure the host repo has a valid package-lock.json and run 'npm ci' in the repo root.",
      };
    }

    log.info(
      `${kind} symlink still broken after repo repair; running npm ci in worktree`,
      { worktreePath }
    );
    try {
      await this.runCommand(
        { command: "npm", args: ["ci"] },
        { cwd: worktreePath, timeout: NPM_CI_TIMEOUT_MS, env: NPM_INCLUDE_DEV_ENV }
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        `npm ci failed in ${kind} worktree after symlink failure. ` +
          "Merge quality gates will attempt auto-repair. " +
          "To fix manually, run 'npm ci' in the repo root.",
        { worktreePath, err: errMsg }
      );
      return {
        ok: false,
        strategy: "npm_ci_worktree",
        error:
          `All strategies to provide node_modules for ${kind} failed. ` +
          `npm ci error: ${errMsg}. ` +
          `Run 'npm ci' in the repo root and ensure package-lock.json is valid.`,
      };
    }

    if (await this.isNodeModulesUsable(nodeModulesPath)) {
      return { ok: true, strategy: "npm_ci_worktree" };
    }

    return {
      ok: false,
      strategy: "npm_ci_worktree",
      error:
        "npm ci completed but node_modules is missing or empty. " +
        "Check that package-lock.json is valid and 'npm ci' succeeds in the repo root.",
    };
  }
}

export const validationWorkspaceService = new ValidationWorkspaceService();
