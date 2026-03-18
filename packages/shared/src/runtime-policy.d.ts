import type { EnvRuntimeResponse } from "./types/api.js";
export declare const UNSUPPORTED_WSL_REPO_PATH_MESSAGE =
  "When running Open Sprint inside WSL, project repos must be in the WSL filesystem (for example /home/<user>/src/app), not under /mnt/c/...";
export declare function isWindowsMountedWslPath(repoPath: string): boolean;
export declare function requiresLinuxFilesystem(
  runtime: Pick<EnvRuntimeResponse, "repoPathPolicy">
): boolean;
//# sourceMappingURL=runtime-policy.d.ts.map
