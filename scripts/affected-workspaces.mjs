import { isMainModule } from "./node-cli.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const WORKSPACE_ORDER = ["shared", "backend", "frontend", "electron"];
const COVERAGE_WORKSPACES = new Set(["shared", "backend", "frontend", "electron"]);
const ALWAYS_ALL_PREFIXES = [
  ".github/",
  "scripts/",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
];

function git(args) {
  return execFileSync("git", args, {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function refExists(ref) {
  try {
    git(["rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

function findMergeBase(baseRef, headRef) {
  try {
    return git(["merge-base", baseRef, headRef]);
  } catch {
    // A shallow checkout can contain both refs without their common ancestor.
    // Unknown change scope must run every workspace, just like a missing ref.
    return null;
  }
}

function parseArgs(argv) {
  const args = {
    json: false,
    base: null,
    head: "HEAD",
    coverageOnly: false,
    all: process.env.OPENSPRINT_AFFECTED_ALL === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--coverage-only") {
      args.coverageOnly = true;
    } else if (arg === "--all") {
      args.all = true;
    } else if (arg === "--base") {
      args.base = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--head") {
      args.head = argv[i + 1] ?? "HEAD";
      i += 1;
    }
  }

  return args;
}

function resolveBaseRef(baseArg, headRef) {
  if (baseArg) {
    return refExists(baseArg) ? findMergeBase(baseArg, headRef) : null;
  }

  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef) {
    const candidates = [`origin/${githubBaseRef}`, githubBaseRef];
    for (const candidate of candidates) {
      if (refExists(candidate)) {
        return findMergeBase(candidate, headRef);
      }
    }
  }

  if (process.env.GITHUB_EVENT_NAME === "push" && refExists("HEAD^")) {
    return "HEAD^";
  }

  for (const candidate of ["origin/main", "main"]) {
    if (refExists(candidate)) {
      return findMergeBase(candidate, headRef);
    }
  }

  return null;
}

function listChangedFiles(baseRef, headRef) {
  const changed = new Set();

  if (baseRef) {
    for (const file of git(["diff", "--name-only", `${baseRef}...${headRef}`]).split("\n")) {
      if (file) changed.add(file);
    }
  }

  for (const file of git(["diff", "--name-only", "HEAD"]).split("\n")) {
    if (file) changed.add(file);
  }

  try {
    for (const file of git(["ls-files", "--others", "--exclude-standard"]).split("\n")) {
      if (file) changed.add(file);
    }
  } catch {
    // Ignore: no untracked files or git unavailable.
  }

  return [...changed].sort();
}

function mapFileToWorkspaces(filePath) {
  if (ALWAYS_ALL_PREFIXES.some((prefix) => filePath === prefix || filePath.startsWith(prefix))) {
    return new Set(WORKSPACE_ORDER);
  }

  if (filePath.startsWith("packages/shared/")) {
    return new Set(["shared", "backend", "frontend", "electron"]);
  }
  if (filePath.startsWith("packages/backend/")) return new Set(["backend"]);
  if (filePath.startsWith("packages/frontend/")) return new Set(["frontend"]);
  if (filePath.startsWith("packages/electron/")) return new Set(["electron"]);

  return new Set();
}

export function computeWorkspacesFromFiles(changedFiles, { coverageOnly = false } = {}) {
  const affected = new Set();
  for (const filePath of changedFiles) {
    for (const workspace of mapFileToWorkspaces(filePath)) {
      affected.add(workspace);
    }
  }

  const workspaces = WORKSPACE_ORDER.filter((workspace) => {
    if (!affected.has(workspace)) return false;
    return coverageOnly ? COVERAGE_WORKSPACES.has(workspace) : true;
  });

  if (coverageOnly && workspaces.length === 0 && changedFiles.length > 0) {
    return {
      workspaces: WORKSPACE_ORDER.filter((w) => COVERAGE_WORKSPACES.has(w)),
      reason: "coverage-fallback",
    };
  }

  return { workspaces, reason: "git-diff" };
}

export function getAffectedWorkspaces(options = {}) {
  const {
    base = null,
    head = "HEAD",
    coverageOnly = false,
    all = process.env.OPENSPRINT_AFFECTED_ALL === "1",
  } = options;

  if (all) {
    return {
      reason: "explicit-all",
      baseRef: null,
      changedFiles: [],
      workspaces: WORKSPACE_ORDER.filter((workspace) =>
        coverageOnly ? COVERAGE_WORKSPACES.has(workspace) : true
      ),
    };
  }

  const baseRef = resolveBaseRef(base, head);
  if (!baseRef) {
    return {
      reason: "no-base-ref",
      baseRef: null,
      changedFiles: [],
      workspaces: WORKSPACE_ORDER.filter((workspace) =>
        coverageOnly ? COVERAGE_WORKSPACES.has(workspace) : true
      ),
    };
  }

  const changedFiles = listChangedFiles(baseRef, head);
  const { workspaces, reason } = computeWorkspacesFromFiles(changedFiles, { coverageOnly });

  return {
    reason,
    baseRef,
    changedFiles,
    workspaces,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = getAffectedWorkspaces(args);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${result.workspaces.join("\n")}\n`);
}

if (isMainModule(import.meta.url)) {
  main();
}
