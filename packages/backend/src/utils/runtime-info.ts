import os from "node:os";
import { readFileSync } from "node:fs";
import type { BackendPlatform, EnvRuntimeResponse } from "@opensprint/shared";

export type BackendRuntimeInfo = EnvRuntimeResponse;

interface RuntimeDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  osRelease?: string;
  procVersion?: string | null;
}

let runtimeInfoOverrideForTesting: BackendRuntimeInfo | null = null;

function normalizePlatform(platform: NodeJS.Platform): BackendPlatform {
  if (platform === "linux" || platform === "darwin" || platform === "win32") {
    return platform;
  }
  return "linux";
}

function readProcVersion(): string | null {
  try {
    return readFileSync("/proc/version", "utf-8");
  } catch {
    return null;
  }
}

export function detectBackendRuntime(
  options: RuntimeDetectionOptions = {}
): BackendRuntimeInfo {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const env = options.env ?? process.env;
  const osRelease = (options.osRelease ?? os.release()).toLowerCase();
  const procVersion = (options.procVersion ?? readProcVersion() ?? "").toLowerCase();
  const isWsl =
    platform === "linux" &&
    (Boolean(env.WSL_DISTRO_NAME) ||
      Boolean(env.WSL_INTEROP) ||
      osRelease.includes("microsoft") ||
      procVersion.includes("microsoft"));

  return {
    platform,
    isWsl,
    wslDistroName: isWsl ? env.WSL_DISTRO_NAME?.trim() || null : null,
    repoPathPolicy: isWsl ? "linux_fs_only" : "any",
  };
}

export function getBackendRuntimeInfo(): BackendRuntimeInfo {
  return runtimeInfoOverrideForTesting ?? detectBackendRuntime();
}

export function setBackendRuntimeInfoForTesting(runtime: BackendRuntimeInfo | null): void {
  runtimeInfoOverrideForTesting = runtime;
}
