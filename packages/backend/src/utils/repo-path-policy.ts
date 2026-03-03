import path from "node:path";
import {
  isWindowsMountedWslPath,
  UNSUPPORTED_WSL_REPO_PATH_MESSAGE,
} from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getBackendRuntimeInfo, type BackendRuntimeInfo } from "./runtime-info.js";

export function isUnsupportedRepoPathInCurrentRuntime(
  repoPath: string,
  runtime: BackendRuntimeInfo = getBackendRuntimeInfo()
): boolean {
  const trimmed = repoPath.trim();
  if (!runtime.isWsl) {
    return false;
  }
  return isWindowsMountedWslPath(trimmed) || isWindowsMountedWslPath(path.resolve(trimmed));
}

export function assertSupportedRepoPath(
  repoPath: string,
  runtime: BackendRuntimeInfo = getBackendRuntimeInfo()
): void {
  if (!isUnsupportedRepoPathInCurrentRuntime(repoPath, runtime)) {
    return;
  }
  throw new AppError(400, ErrorCodes.UNSUPPORTED_REPO_PATH, UNSUPPORTED_WSL_REPO_PATH_MESSAGE, {
    repoPath,
  });
}
