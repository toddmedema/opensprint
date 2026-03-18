export const UNSUPPORTED_WSL_REPO_PATH_MESSAGE =
  "When running Open Sprint inside WSL, project repos must be in the WSL filesystem (for example /home/<user>/src/app), not under /mnt/c/...";
export function isWindowsMountedWslPath(repoPath) {
  return /^\/mnt\/[a-z](\/|$)/i.test(repoPath.trim());
}
export function requiresLinuxFilesystem(runtime) {
  return runtime.repoPathPolicy === "linux_fs_only";
}
//# sourceMappingURL=runtime-policy.js.map
