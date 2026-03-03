import type { PlatformFamily } from "./platform";

function quotePath(repoPath: string): string {
  return `"${repoPath.replace(/"/g, '\\"')}"`;
}

export function getRunInstructions(repoPath: string, platform: PlatformFamily): string[] {
  const quotedPath = quotePath(repoPath);

  if (platform === "windows") {
    return [`pushd ${quotedPath}`, "npm run web"];
  }

  return [`cd ${quotedPath}`, "npm run web"];
}
