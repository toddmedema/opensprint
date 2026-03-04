import { normalizeWorktreeBaseBranch } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { shellExec } from "./shell-exec.js";

const GIT_TIMEOUT_MS = 5_000;

export type GitRemoteMode = "publishable" | "local_only" | "remote_error";

export interface GitIdentityState {
  name: string | null;
  email: string | null;
  valid: boolean;
}

export interface GitRepoState {
  isGitRepo: boolean;
  hasHead: boolean;
  currentBranch: string | null;
  baseBranch: string;
  hasOrigin: boolean;
  originReachable: boolean;
  remoteMode: GitRemoteMode;
  originUrl: string | null;
  identity: GitIdentityState;
}

export class RepoPreflightError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly commands: string[] = []
  ) {
    super(message);
    this.name = "RepoPreflightError";
  }
}

async function runGit(
  repoPath: string,
  command: string,
  timeout: number = GIT_TIMEOUT_MS
): Promise<string | null> {
  try {
    const { stdout } = await shellExec(command, { cwd: repoPath, timeout });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function readIdentityValue(
  repoValue: string | null,
  authorEnv: string | undefined,
  committerEnv: string | undefined
): string | null {
  const value = repoValue?.trim() || authorEnv?.trim() || committerEnv?.trim();
  return value ? value : null;
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const inside = await runGit(repoPath, "git rev-parse --is-inside-work-tree");
  return inside === "true";
}

export async function hasGitHead(repoPath: string): Promise<boolean> {
  const head = await runGit(repoPath, "git rev-parse --verify HEAD");
  return Boolean(head);
}

export async function getCurrentGitBranch(repoPath: string): Promise<string | null> {
  return runGit(repoPath, "git symbolic-ref --quiet --short HEAD");
}

export async function localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  const ref = await runGit(repoPath, `git show-ref --verify --quiet refs/heads/${branchName} && echo ok`);
  return ref === "ok";
}

export async function readGitIdentity(repoPath: string): Promise<GitIdentityState> {
  const name = readIdentityValue(
    await runGit(repoPath, "git config user.name"),
    process.env.GIT_AUTHOR_NAME,
    process.env.GIT_COMMITTER_NAME
  );
  const email = readIdentityValue(
    await runGit(repoPath, "git config user.email"),
    process.env.GIT_AUTHOR_EMAIL,
    process.env.GIT_COMMITTER_EMAIL
  );

  return {
    name,
    email,
    valid: Boolean(name && email),
  };
}

export function buildGitIdentityCommands(): string[] {
  return [
    'git config --global user.name "Your Name"',
    'git config --global user.email "you@example.com"',
  ];
}

export function assertGitIdentityConfigured(
  identity: GitIdentityState,
  options?: { appError?: boolean }
): void {
  if (identity.valid) return;
  const message =
    "Git author identity is required before OpenSprint can create commits. Configure user.name and user.email, then try again.";
  const commands = buildGitIdentityCommands();
  if (options?.appError !== false) {
    throw new AppError(400, ErrorCodes.GIT_IDENTITY_REQUIRED, message, {
      missingFields: [
        ...(identity.name ? [] : ["user.name"]),
        ...(identity.email ? [] : ["user.email"]),
      ],
      commands,
    });
  }
  throw new RepoPreflightError(message, ErrorCodes.GIT_IDENTITY_REQUIRED, commands);
}

function isValidBranchName(raw: string | null | undefined): raw is string {
  if (typeof raw !== "string" || !raw.trim()) return false;
  return normalizeWorktreeBaseBranch(raw) === raw.trim();
}

export async function getOriginUrl(repoPath: string): Promise<string | null> {
  return runGit(repoPath, "git remote get-url origin");
}

export async function detectRemoteDefaultBranch(repoPath: string): Promise<string | null> {
  const symref = await runGit(repoPath, "git ls-remote --symref origin HEAD", GIT_TIMEOUT_MS);
  if (!symref) return null;
  const line = symref
    .split("\n")
    .find((entry) => entry.startsWith("ref: ") && entry.includes("\tHEAD"));
  if (!line) return null;
  const ref = line.slice(5).split("\t")[0]?.trim();
  if (!ref?.startsWith("refs/heads/")) return null;
  return ref.slice("refs/heads/".length);
}

export async function detectRemoteMode(repoPath: string): Promise<{
  hasOrigin: boolean;
  originReachable: boolean;
  originUrl: string | null;
  remoteMode: GitRemoteMode;
}> {
  const originUrl = await getOriginUrl(repoPath);
  if (!originUrl) {
    return {
      hasOrigin: false,
      originReachable: false,
      originUrl: null,
      remoteMode: "local_only",
    };
  }
  const reachable = Boolean(await runGit(repoPath, "git ls-remote --symref origin HEAD", GIT_TIMEOUT_MS));
  return {
    hasOrigin: true,
    originReachable: reachable,
    originUrl,
    remoteMode: reachable ? "publishable" : "remote_error",
  };
}

export async function resolveBaseBranch(
  repoPath: string,
  preferredBaseBranch?: string | null
): Promise<string> {
  if (isValidBranchName(preferredBaseBranch)) {
    return preferredBaseBranch.trim();
  }

  const hasHead = await hasGitHead(repoPath);
  const currentBranch = await getCurrentGitBranch(repoPath);

  if (hasHead && isValidBranchName(currentBranch)) {
    return currentBranch.trim();
  }
  if (await localBranchExists(repoPath, "main")) return "main";
  if (await localBranchExists(repoPath, "master")) return "master";

  const remote = await detectRemoteMode(repoPath);
  if (remote.hasOrigin && remote.originReachable) {
    const remoteDefault = await detectRemoteDefaultBranch(repoPath);
    if (isValidBranchName(remoteDefault)) {
      return remoteDefault.trim();
    }
  }

  return "main";
}

export async function inspectGitRepoState(
  repoPath: string,
  preferredBaseBranch?: string | null
): Promise<GitRepoState> {
  const repo = await isGitRepo(repoPath);
  if (!repo) {
    return {
      isGitRepo: false,
      hasHead: false,
      currentBranch: null,
      baseBranch: isValidBranchName(preferredBaseBranch) ? preferredBaseBranch.trim() : "main",
      hasOrigin: false,
      originReachable: false,
      remoteMode: "local_only",
      originUrl: null,
      identity: await readGitIdentity(repoPath),
    };
  }

  const [identity, hasHead, currentBranch, remote] = await Promise.all([
    readGitIdentity(repoPath),
    hasGitHead(repoPath),
    getCurrentGitBranch(repoPath),
    detectRemoteMode(repoPath),
  ]);
  const baseBranch = await resolveBaseBranch(repoPath, preferredBaseBranch);

  return {
    isGitRepo: true,
    hasHead,
    currentBranch,
    baseBranch,
    hasOrigin: remote.hasOrigin,
    originReachable: remote.originReachable,
    remoteMode: remote.remoteMode,
    originUrl: remote.originUrl,
    identity,
  };
}

export async function ensureBaseBranchExists(repoPath: string, baseBranch: string): Promise<void> {
  if (!isValidBranchName(baseBranch)) {
    throw new AppError(
      400,
      ErrorCodes.GIT_BASE_BRANCH_INVALID,
      `Invalid base branch: ${baseBranch}`,
      { baseBranch }
    );
  }

  const [hasHead, currentBranch, existsLocally] = await Promise.all([
    hasGitHead(repoPath),
    getCurrentGitBranch(repoPath),
    localBranchExists(repoPath, baseBranch),
  ]);

  if (hasHead) {
    if (currentBranch === baseBranch) return;
    if (existsLocally) {
      await shellExec(`git checkout ${baseBranch}`, { cwd: repoPath, timeout: GIT_TIMEOUT_MS });
      return;
    }
    await shellExec(`git checkout -b ${baseBranch}`, { cwd: repoPath, timeout: GIT_TIMEOUT_MS });
    return;
  }

  if (currentBranch === baseBranch) return;
  if (currentBranch) {
    await shellExec(`git symbolic-ref HEAD refs/heads/${baseBranch}`, {
      cwd: repoPath,
      timeout: GIT_TIMEOUT_MS,
    });
    return;
  }

  await shellExec(`git checkout --orphan ${baseBranch}`, {
    cwd: repoPath,
    timeout: GIT_TIMEOUT_MS,
  });
}

export async function hasWorkingTreeChanges(repoPath: string): Promise<boolean> {
  const status = await runGit(repoPath, "git status --porcelain");
  return Boolean(status);
}
