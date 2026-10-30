/** Immutable replay inputs live outside the pruned agent-session archive. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BehaviorExperimentInstructionBaseline } from "./self-improvement-experiment.service.js";
import type { PolicyRelease } from "@opensprint/shared";
import type { GovernanceContextArtifacts } from "./governance-context-artifacts.js";

const execFileAsync = promisify(execFile);
export const REPLAY_LABELS = [
  "compliant",
  "exception",
  "defect",
  "conflict",
  "retrieval_miss",
] as const;
export interface ReplayFixture {
  version: 1;
  projectId: string;
  sessionId: number;
  baseCommitSha: string;
  taskPrompt: string;
  /** Full archived prompt is evidence; executor receives decomposed task input plus the selected policy. */
  originalPrompt?: string;
  instructions: BehaviorExperimentInstructionBaseline;
  toolchain: string;
  /** A human-authored rubric, mounted only into the independent evaluator. */
  rubric: {
    id: string;
    text: string;
    checks: Array<{ name: string; command: string; args: string[] }>;
  };
  label: (typeof REPLAY_LABELS)[number];
  holdout: boolean;
  humanActor: string;
  createdAt: string;
  policyReleaseId?: string;
  changedPaths?: string[];
  taskId?: string;
  originalWorkspaceRoot?: string;
  contextArtifacts?: GovernanceContextArtifacts;
  policyRelease?: PolicyRelease;
}
export interface StoredReplayFixture {
  fixture: ReplayFixture;
  hash: string;
}
export function replayInputHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function safeProjectKey(projectId: string): string {
  if (!projectId.trim()) throw new Error("Project ID is required");
  return createHash("sha256").update(projectId).digest("hex");
}
export function validateReplayFixture(value: ReplayFixture): void {
  if (
    value.policyReleaseId &&
    (!value.taskId ||
      !value.originalWorkspaceRoot ||
      !value.contextArtifacts?.complete ||
      !value.policyRelease ||
      value.policyRelease.id !== value.policyReleaseId)
  )
    throw new Error("Complete original context artifacts and policy provenance are required");
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.sessionId) ||
    value.sessionId < 1 ||
    !/^[0-9a-f]{40,64}$/.test(value.baseCommitSha)
  )
    throw new Error("Invalid replay fixture identity");
  if (
    !value.taskPrompt?.trim() ||
    !value.toolchain?.trim() ||
    !value.humanActor?.trim() ||
    !value.rubric?.id?.trim() ||
    !value.rubric.text?.trim() ||
    !REPLAY_LABELS.includes(value.label) ||
    typeof value.holdout !== "boolean"
  )
    throw new Error(
      "Replay fixture requires complete inputs and a human-labeled independent rubric"
    );
  if (
    !value.instructions ||
    typeof value.instructions.general !== "string" ||
    typeof value.instructions.roles?.coder !== "string" ||
    typeof value.instructions.roles?.reviewer !== "string" ||
    !value.instructions.templates ||
    ["coder", "reviewer", "finalReview", "selfImprovement"].some(
      (key) =>
        typeof value.instructions.templates[key as keyof typeof value.instructions.templates] !==
        "string"
    )
  )
    throw new Error("Missing complete instruction snapshot");
  if (
    !Array.isArray(value.rubric.checks) ||
    value.rubric.checks.length === 0 ||
    value.rubric.checks.some(
      (c) =>
        !c.name?.trim() ||
        !c.command?.trim() ||
        !Array.isArray(c.args) ||
        c.args.some((arg) => typeof arg !== "string")
    )
  )
    throw new Error("At least one independent deterministic check is required");
}

export class ReplayFixtureService {
  constructor(
    private readonly root = path.join(os.homedir(), ".opensprint", "governance-replay")
  ) {}
  private file(projectId: string, sessionId: number): string {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Invalid session ID");
    return path.join(this.root, safeProjectKey(projectId), `${sessionId}.json`);
  }
  async capture(fixture: ReplayFixture, repoPath: string): Promise<StoredReplayFixture> {
    validateReplayFixture(fixture);
    // Retain the original commit independently of disposable branches and session pruning.
    const ref = `refs/opensprint/replay/${safeProjectKey(fixture.projectId)}/${fixture.sessionId}`;
    await execFileAsync("git", ["cat-file", "-e", `${fixture.baseCommitSha}^{commit}`], {
      cwd: repoPath,
    });
    const stored = { fixture, hash: replayInputHash(fixture) };
    const file = this.file(fixture.projectId, fixture.sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Exclusive creation prevents a fixture/rubric from being changed after an evaluation.
    try {
      await execFileAsync(
        "git",
        ["update-ref", ref, fixture.baseCommitSha, "0".repeat(fixture.baseCommitSha.length)],
        { cwd: repoPath }
      );
    } catch {
      const existing = await execFileAsync("git", ["rev-parse", ref], { cwd: repoPath });
      if (existing.stdout.trim() !== fixture.baseCommitSha)
        throw new Error("Replay commit retention conflict");
    }
    try {
      await fs.writeFile(file, JSON.stringify(stored), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const previous = await this.read(fixture.projectId, fixture.sessionId);
      if (previous.hash !== stored.hash)
        throw new Error("Replay fixtures are immutable; use a new session ID");
      return previous;
    }
    return stored;
  }
  async read(projectId: string, sessionId: number): Promise<StoredReplayFixture> {
    const stored = JSON.parse(
      await fs.readFile(this.file(projectId, sessionId), "utf8")
    ) as StoredReplayFixture;
    validateReplayFixture(stored.fixture);
    if (
      stored.fixture.projectId !== projectId ||
      stored.fixture.sessionId !== sessionId ||
      stored.hash !== replayInputHash(stored.fixture)
    )
      throw new Error("Replay evidence hash or project mismatch");
    return stored;
  }
  async list(projectId: string): Promise<StoredReplayFixture[]> {
    const dir = path.join(this.root, safeProjectKey(projectId));
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return Promise.all(
      files
        .filter((file) => /^\d+\.json$/.test(file))
        .map((file) => this.read(projectId, Number(file.slice(0, -5))))
    );
  }
  async saveEvaluation(projectId: string, payload: unknown): Promise<string> {
    const hash = replayInputHash(payload);
    const dir = path.join(this.root, safeProjectKey(projectId), "evaluations");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(path.join(dir, `${hash}.json`), JSON.stringify(payload), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return hash;
  }
}
export const replayFixtureService = new ReplayFixtureService();
