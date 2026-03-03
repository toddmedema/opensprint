import type { EnvRuntimeResponse } from "./types/api.js";

export const UNSUPPORTED_WSL_REPO_PATH_MESSAGE =
  "When running OpenSprint inside WSL, project repos must be in the WSL filesystem (for example /home/<user>/src/app), not under /mnt/c/...";

export function isWindowsMountedWslPath(repoPath: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(repoPath.trim());
}

export function requiresLinuxFilesystem(
  runtime: Pick<EnvRuntimeResponse, "repoPathPolicy">
): boolean {
  return runtime.repoPathPolicy === "linux_fs_only";
}
