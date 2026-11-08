import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolchainProfile } from "@opensprint/shared";
import { runCommand, resolveCommandExecutable } from "../utils/command-runner.js";
import { resolveToolchainProfile } from "./toolchain-profile.service.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)])
    );
  return value;
}
export function executionAuthorityHash(profile?: ToolchainProfile): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(resolveToolchainProfile(profile))))
    .digest("hex");
}

export interface RuntimeBinding {
  tool: string;
  executable: string;
  expectedRange: string;
  evidencePath: string;
}
export interface ProjectExecutionProfile {
  authorityHash: string;
  contextHash: string;
  /** Reusable execution facts; validation results remain fenced by the full contextHash. */
  recipeHash?: string;
  head: string;
  cwd: string;
  workspaceRoot?: string;
  inputs: string[];
  baseSha?: string;
  runtimeCandidates?: Record<string, string[]>;
  documents?: Record<string, string>;
  contract?: ReturnType<typeof resolveToolchainProfile>;
}

/** Capture generic declared commands and their inputs, without an ecosystem registry. */
export async function captureExecutionProfile(
  worktree: string,
  profile?: ToolchainProfile,
  baseRef = "HEAD"
): Promise<ProjectExecutionProfile> {
  const resolved = resolveToolchainProfile(profile);
  const root = await fs.realpath(worktree);
  const cwd = await fs.realpath(path.resolve(root, resolved.workingDirectory));
  const relative = path.relative(root, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Validation cwd escapes the retained workspace");
  const git = async (args: string[]) =>
    (await runCommand({ command: "git", args }, { cwd: root, maxStdoutBytes: 8 * 1024 * 1024 }))
      .stdout;
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const baseSha = (await git(["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
  const index = await git(["ls-files", "--stage", "-z"]);
  const inputs = index
    .split("\0")
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf("\t") + 1));
  const authorityHash = executionAuthorityHash(profile);
  const environment = JSON.stringify({
    authorityHash,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    environment: { ...process.env, ...resolved.executionEnvironment },
  });
  const hash = createHash("sha256").update(environment).update(baseSha).update(index);
  const reusable = createHash("sha256").update(environment);
  // Git blob identities cover every committed language/helper. Hash actual dirty inputs
  // too; a passing artifact must not survive an uncommitted validator modification.
  const dirty = [
    ...new Set(
      (
        (await git(["diff", "--name-only", "-z", "HEAD"])) +
        (await git(["ls-files", "--others", "--exclude-standard", "-z"]))
      )
        .split("\0")
        .filter(Boolean)
    ),
  ];
  for (const file of dirty.sort()) {
    const real = await fs.realpath(path.join(root, file)).catch(() => null);
    if (!real || !real.startsWith(root + path.sep)) {
      hash.update(`${file}:unavailable`);
      continue;
    }
    const { createReadStream } = await import("node:fs");
    hash.update(file);
    for await (const chunk of createReadStream(real)) hash.update(chunk);
  }
  const { parseCommandSpec } = await import("./merge-quality-gate-runner.js");
  const commands = [
    ...resolved.mergeQualityGateCommands,
    resolved.dependencyInstallCommand,
    resolved.dependencyHealthCheckCommand,
    resolved.resourceProbeCommand,
  ].filter((s): s is string => !!s);
  const tools = [
    ...new Set([...commands.map((c) => parseCommandSpec(c).command), ...resolved.runtimeTools]),
  ];
  const env = { ...process.env, ...resolved.executionEnvironment };
  const bins = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const runtimeCandidates: Record<string, string[]> = {};
  for (const tool of tools) {
    const candidates = new Set<string>();
    try {
      const selected = resolveCommandExecutable(tool, env, cwd);
      if (selected) candidates.add(selected);
    } catch (err) {
      hash.update(String(err));
    }
    for (const bin of bins) {
      const candidate = path.resolve(cwd, bin, process.platform === "win32" ? `${tool}.exe` : tool);
      if (tool.includes("/") || tool.includes("\\")) continue;
      try {
        await fs.access(candidate, (await import("node:fs")).constants.X_OK);
        candidates.add(candidate);
      } catch {
        /*not installed here*/
      }
    }
    runtimeCandidates[tool] = [...candidates];
    for (const executable of candidates) {
      const real = await fs.realpath(executable);
      const stat = await fs.stat(real);
      hash.update(`${tool}:${real}:${stat.size}:${stat.mtimeMs}`);
      reusable.update(`${tool}:${real}:${stat.size}:${stat.mtimeMs}`);
    }
  }
  // Supply bounded trusted-base documents, not task-authored instructions, to diagnosis.
  const documents: Record<string, string> = {};
  let bytes = 0;
  for (const file of inputs
    .filter(
      (f) =>
        f.split("/").length <= 2 &&
        !/(?:^|\/)(?:\.env|.*(?:secret|credential|token))/i.test(f) &&
        /(?:readme|config|version|tool|build|requirements|\.toml$|\.xml$|\.json$|\.ya?ml$)/i.test(f)
    )
    .sort()) {
    if (bytes >= 48000) break;
    const content = await git(["show", `${baseSha}:${file}`]).catch(() => "");
    if (!content || content.includes("\0")) continue;
    reusable.update(file).update(content);
    if (content.length > 16000) continue;
    documents[file] = content;
    bytes += content.length;
  }
  return {
    workspaceRoot: root,
    authorityHash,
    contextHash: hash.digest("hex"),
    recipeHash: reusable.digest("hex"),
    head,
    cwd,
    inputs,
    baseSha,
    runtimeCandidates,
    documents,
    contract: resolved,
  };
}

/** Bounded, immutable evidence reads for unfamiliar project layouts; never read local secrets. */
export async function readExecutionEvidence(
  profile: ProjectExecutionProfile,
  paths: string[],
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const documents: Record<string, string> = {};
  if (!profile.baseSha || !profile.workspaceRoot) return documents;
  for (const file of paths.slice(0, 8)) {
    if (
      typeof file !== "string" ||
      !profile.inputs.includes(file) ||
      /(?:^|\/)(?:\.env|.*(?:secret|credential|token))/i.test(file)
    )
      continue;
    try {
      const content = (
        await runCommand(
          { command: "git", args: ["show", `${profile.baseSha}:${file}`] },
          { cwd: profile.workspaceRoot, timeout: 10000, maxStdoutBytes: 16000, signal }
        )
      ).stdout;
      if (!content.includes("\0")) documents[file] = content;
    } catch {
      /* Missing, binary and oversized evidence is unavailable, never inferred. */
    }
  }
  profile.documents = { ...profile.documents, ...documents };
  return documents;
}
