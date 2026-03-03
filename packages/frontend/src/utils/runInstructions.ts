import type { EnvRuntimeResponse } from "@opensprint/shared";

function quotePath(repoPath: string): string {
  return `"${repoPath.replace(/"/g, '\\"')}"`;
}

export function getRunInstructions(repoPath: string, runtime: EnvRuntimeResponse): string[] {
  const quotedPath = quotePath(repoPath);

  if (runtime.isWsl) {
    return [`cd ${quotedPath}`, "npm run web"];
  }

  if (runtime.platform === "win32") {
    return [`pushd ${quotedPath}`, "npm run web"];
  }

  return [`cd ${quotedPath}`, "npm run web"];
}
