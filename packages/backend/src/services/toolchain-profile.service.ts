import type { DependencyStrategy, ToolchainProfile } from "@opensprint/shared";

export const DEFAULT_MERGE_QUALITY_GATE_COMMANDS = [
  "npm run build",
  "npm run lint",
  "npm run test",
] as const;

export const DEFAULT_DEPENDENCY_CHANGE_PATHS = [
  "package.json",
  "package-lock.json",
  ":(glob)packages/**/package.json",
  ":(glob)apps/**/package.json",
];

const DEFAULT_DEPENDENCY_STRATEGY: DependencyStrategy = "npm";

export interface ResolvedToolchainProfile {
  runtimeTools: string[];
  workingDirectory: string;
  executionEnvironment: Record<string, string>;
  resourceProbeCommand: string | null;
  mergeQualityGateCommands: string[];
  dependencyStrategy: DependencyStrategy;
  dependencyInstallCommand: string | null;
  dependencyHealthCheckCommand: string | null;
  dependencyChangePathspecs: string[];
  deterministicTestCommand: string | null;
  deterministicTestEnv: Record<string, string>;
}

function normalizeCommands(values: string[] | undefined): string[] {
  const commands = (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  return commands.length > 0 ? commands : [...DEFAULT_MERGE_QUALITY_GATE_COMMANDS];
}

function normalizePathspecs(values: string[] | undefined): string[] {
  const specs = (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  return specs.length > 0 ? specs : [...DEFAULT_DEPENDENCY_CHANGE_PATHS];
}

function defaultInstallCommand(strategy: DependencyStrategy): string | null {
  if (strategy === "npm" || strategy === "npm_ci_worktree") return "npm ci";
  if (strategy === "pnpm") return "pnpm install --frozen-lockfile";
  if (strategy === "yarn") return "yarn install --immutable";
  return null;
}

function defaultHealthCommand(strategy: DependencyStrategy): string | null {
  if (strategy === "npm" || strategy === "npm_ci_worktree") return "npm ls --depth=0 --include=dev";
  if (strategy === "pnpm") return "pnpm list --depth -1";
  if (strategy === "yarn") return "yarn list --depth=0";
  return null;
}

export function resolveToolchainProfile(
  profile: ToolchainProfile | null | undefined
): ResolvedToolchainProfile {
  const dependencyStrategy = profile?.dependencyStrategy ?? DEFAULT_DEPENDENCY_STRATEGY;
  const deterministicTestCommand = profile?.deterministicTestCommand?.trim() || "npm run test";
  return {
    runtimeTools: [
      ...new Set((profile?.runtimeTools ?? []).map((s) => s.trim()).filter(Boolean)),
    ].sort(),
    workingDirectory: profile?.workingDirectory?.trim() || ".",
    executionEnvironment: { ...(profile?.executionEnvironment ?? {}) },
    resourceProbeCommand: profile?.resourceProbeCommand?.trim() || null,
    mergeQualityGateCommands: normalizeCommands(profile?.mergeQualityGateCommands),
    dependencyStrategy,
    dependencyInstallCommand:
      profile?.dependencyInstallCommand?.trim() || defaultInstallCommand(dependencyStrategy),
    dependencyHealthCheckCommand:
      profile?.dependencyHealthCheckCommand?.trim() || defaultHealthCommand(dependencyStrategy),
    dependencyChangePathspecs: normalizePathspecs(profile?.dependencyChangePathspecs),
    deterministicTestCommand,
    deterministicTestEnv: { ...(profile?.deterministicTestEnv ?? {}) },
  };
}

export function isNodeDependencyStrategy(strategy: DependencyStrategy): boolean {
  return (
    strategy === "npm" ||
    strategy === "npm_ci_worktree" ||
    strategy === "pnpm" ||
    strategy === "yarn"
  );
}

/** When set, merge gates install dependencies with `npm ci` in the worktree instead of symlinking host `node_modules`. */
export function usesHermeticWorktreeNodeModules(strategy: DependencyStrategy): boolean {
  return strategy === "npm_ci_worktree";
}
