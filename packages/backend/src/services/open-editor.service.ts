import { agentProcessEnvironment } from "../utils/agent-process-env.js";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import type { PreferredEditor } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { BranchManager } from "./branch-manager.js";
import { orchestratorService } from "./orchestrator.service.js";
import { getGlobalSettings } from "./global-settings.service.js";
import { AppError } from "../middleware/error-handler.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("open-editor");
const execFileAsync = promisify(execFile);
const WHICH_TIMEOUT_MS = 3_000;

export interface OpenEditorResult {
  worktreePath: string;
  editor: PreferredEditor | "none";
  opened: boolean;
}

/**
 * Probe whether a CLI command is available on the system PATH.
 * Returns true if `which <cmd>` (or `where` on Windows) exits successfully.
 */
async function isCliAvailable(cmd: string): Promise<boolean> {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(whichCmd, [cmd], {
      env: agentProcessEnvironment(),
      timeout: WHICH_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective editor to use given the user's preference and what CLIs are available.
 * "auto" probes for `cursor` first, then `code`.
 */
async function resolveEditor(
  preferred: PreferredEditor | undefined
): Promise<PreferredEditor | "none"> {
  const pref = preferred ?? "auto";

  if (pref === "cursor") {
    return (await isCliAvailable("cursor")) ? "cursor" : "none";
  }
  if (pref === "vscode") {
    return (await isCliAvailable("code")) ? "vscode" : "none";
  }

  // auto: prefer cursor, then vscode
  if (await isCliAvailable("cursor")) return "cursor";
  if (await isCliAvailable("code")) return "vscode";
  return "none";
}

/**
 * Resolve the worktree path and editor for the POST /tasks/:taskId/open-editor endpoint.
 *
 * 1. Looks up the task via orchestrator status to find the worktree path of the active slot.
 * 2. In branches mode (or when no worktree is assigned), falls back to the project repo root.
 * 3. Validates the path exists on disk.
 * 4. Reads preferredEditor from global settings and probes CLI availability.
 *
 * The backend does not spawn a GUI editor process in browser-only deployments.
 * The `opened` field is `true` when the path and editor are valid, signaling to the client
 * that it may launch the editor (e.g. via URI scheme or IPC).
 */
export async function resolveOpenEditor(
  projectId: string,
  taskId: string
): Promise<OpenEditorResult> {
  const projectService = new ProjectService();
  const branchManager = new BranchManager();

  const repoPath = await projectService.getRepoPath(projectId);
  const settings = await projectService.getSettings(projectId);
  const isBranchesMode = settings.gitWorkingMode === "branches";

  // Find the active task slot to get worktreePath
  const status = await orchestratorService.getStatus(projectId);
  const activeEntry = status.activeTasks.find((t) => t.taskId === taskId);

  if (!activeEntry) {
    throw new AppError(409, "TASK_NOT_EXECUTING", "Task is not currently executing");
  }

  let worktreePath: string;
  if (isBranchesMode) {
    worktreePath = repoPath;
  } else if (activeEntry.worktreePath) {
    worktreePath = activeEntry.worktreePath;
  } else {
    worktreePath = branchManager.getWorktreePath(taskId, repoPath);
  }

  // Validate path exists
  try {
    await fs.access(worktreePath);
  } catch {
    throw new AppError(404, "WORKTREE_NOT_FOUND", `Worktree path does not exist: ${worktreePath}`);
  }

  const globalSettings = await getGlobalSettings();
  const editor = await resolveEditor(globalSettings.preferredEditor);

  log.info("open-editor resolved", { projectId, taskId, worktreePath, editor, isBranchesMode });

  return {
    worktreePath,
    editor,
    opened: true,
  };
}

// Re-export for testing
export { isCliAvailable, resolveEditor };
