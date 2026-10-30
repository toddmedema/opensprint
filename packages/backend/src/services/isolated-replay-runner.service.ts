/**
 * Offline replay protocol. The owner pins a trusted image containing an actual coding agent,
 * its offline model/toolchain, and an independent evaluator. Docker supplies the external
 * filesystem/network boundary; a worktree or a prompt is never considered a sandbox.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { extractReplayArchive } from "./replay-source-archive.js";
import type { ReplayAgentRunner, ReplayOutcome } from "./experiment-replay.service.js";
import {
  replayFixtureService,
  replayInputHash,
  type ReplayFixtureService,
} from "./replay-fixture.service.js";

const execFileAsync = promisify(execFile);
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
export interface IsolatedReplayOptions {
  projectId: string;
  /** Server-owned configuration only; never read this from a task or agent result. */
  image?: string;
  fixtures?: ReplayFixtureService;
  /** Absolute trusted host executable, never resolved through a task-controlled PATH. */
  dockerExecutable?: string;
}
export class IsolatedReplayRunner implements ReplayAgentRunner {
  private fixtures: ReplayFixtureService;
  constructor(private readonly options: IsolatedReplayOptions) {
    this.fixtures = options.fixtures ?? replayFixtureService;
  }
  async run(params: Parameters<ReplayAgentRunner["run"]>[0]): Promise<ReplayOutcome> {
    const start = Date.now();
    let scratch: string | undefined;
    const containers: string[] = [];
    let docker: string | undefined;
    try {
      const image = this.options.image ?? process.env.OPENSPRINT_REPLAY_IMAGE;
      if (!image || !IMAGE_RE.test(image))
        throw new Error(
          "Replay unavailable: configure an immutable offline OPENSPRINT_REPLAY_IMAGE digest"
        );
      docker = await resolveReplayDocker(this.options.dockerExecutable);
      const { fixture, hash } = await this.fixtures.read(this.options.projectId, params.sessionId);
      const bundle = params.candidateBundle;
      if (params.variant === "candidate" && (!bundle?.baselineContent || !bundle.candidateContent))
        throw new Error("Replay unavailable: candidate has no complete instruction content");
      if (
        bundle?.baselineContent &&
        replayInputHash(fixture.instructions) !== replayInputHash(bundle.baselineContent)
      )
        throw new Error("Replay unavailable: candidate baseline differs from original task policy");
      const instructions =
        params.variant === "candidate" ? bundle!.candidateContent! : fixture.instructions;
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-replay-"));
      const workspace = path.join(scratch, "workspace");
      const input = path.join(scratch, "input");
      const evaluation = path.join(scratch, "evaluation");
      const original = path.join(scratch, "original");
      await Promise.all(
        [workspace, input, evaluation, original].map((dir) => fs.mkdir(dir, { mode: 0o700 }))
      );
      // Export tracked source from the ORIGINAL base; no .git, untracked env, task DB or live worktree state.
      const archive = path.join(scratch, "source.tar");
      await execFileAsync(
        "git",
        ["archive", "--format=tar", `--output=${archive}`, fixture.baseCommitSha],
        { cwd: params.worktreePath, timeout: 30_000 }
      );
      await extractReplayArchive(archive, workspace);
      await extractReplayArchive(archive, original);
      // Tracked secrets/runtime data are unsupported inputs, never silently made available to replay.
      await assertReplaySourceSafe(workspace);
      // A fresh local Git repository supports ordinary agent commits without exposing host refs/remotes.
      const gitEnv = { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" };
      for (const args of [
        ["init", "--template="],
        ["config", "user.name", "Open Sprint Replay"],
        ["config", "user.email", "replay@opensprint.invalid"],
        ["add", "--force", "."],
        [
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          "Retained replay input",
        ],
      ])
        await execFileAsync("git", args, { cwd: workspace, env: gitEnv, timeout: 30_000 });
      let contextDirectory: string | undefined;
      if (fixture.contextArtifacts) {
        if (
          !fixture.contextArtifacts.complete ||
          !fixture.taskId ||
          !/^[a-zA-Z0-9_.-]+$/.test(fixture.taskId) ||
          fixture.taskId.includes("..")
        )
          throw new Error("Replay unavailable: incomplete original context artifacts");
        const taskRoot = path.join(workspace, ".opensprint", "active", fixture.taskId);
        const contextRoot = path.join(taskRoot, "context");
        for (const [relative, encoded] of Object.entries(fixture.contextArtifacts.files)) {
          if (
            relative.startsWith("/") ||
            relative.includes("\\") ||
            relative.split("/").some((part) => part === ".." || part === "")
          )
            throw new Error("Replay unavailable: invalid retained context path");
          const destination = path.join(contextRoot, relative);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, Buffer.from(encoded, "base64"));
        }
        const selectedPolicy =
          params.variant === "candidate" ? bundle?.policyRelease : fixture.policyRelease;
        if (!selectedPolicy)
          throw new Error("Replay unavailable: full selected policy content is missing");
        await fs.writeFile(
          path.join(taskRoot, "policy-release.json"),
          JSON.stringify(selectedPolicy)
        );
        await fs.writeFile(path.join(contextRoot, "policy.md"), instructions.roles.coder ?? "");
        await fs.rm(path.join(contextRoot, "policy-receipt.json"), { force: true });
        contextDirectory = `/workspace/.opensprint/active/${fixture.taskId}/context`;
      }
      const taskPrompt = fixture.originalWorkspaceRoot
        ? fixture.taskPrompt.replaceAll(fixture.originalWorkspaceRoot, "/workspace")
        : fixture.taskPrompt;
      await fs.writeFile(
        path.join(input, "task.json"),
        JSON.stringify({
          version: 1,
          taskPrompt,
          instructions,
          toolchain: fixture.toolchain,
          contextDirectory,
          resultPath: fixture.taskId
            ? `/workspace/.opensprint/active/${fixture.taskId}/result.json`
            : "/workspace/result.json",
          executionContract:
            "This is an isolated replay. Use only the selected instructions. Resolve context/ references under contextDirectory. Git is a fresh local repository; commit locally if requested. Write results only to resultPath. No merging, publishing, live credentials, live databases, or external services are available.",
        }),
        { mode: 0o600 }
      );
      await fs.writeFile(
        path.join(evaluation, "rubric.json"),
        JSON.stringify({ version: 1, ...fixture.rubric, expectedLabel: fixture.label }),
        { mode: 0o600 }
      );
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      const dockerBase = [
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        "--memory=4g",
        "--cpus=2",
        "--user",
        `${uid}:${gid}`,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/tmp/replay-home",
        "--env",
        "NODE_ENV=test",
      ];
      const mount = (source: string, target: string, readOnly = false) => [
        "--mount",
        `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`,
      ];
      // Only PATH reaches the Docker client; neither server approval nor provider credentials reach a container.
      const env = { PATH: process.env.PATH, HOME: scratch };
      const agentContainer = `opensprint-replay-${randomUUID()}`;
      containers.push(agentContainer);
      const agent = await execFileAsync(
        docker,
        [
          ...dockerBase,
          "--name",
          agentContainer,
          ...mount(workspace, "/workspace"),
          ...mount(input, "/replay-input", true),
          "--entrypoint",
          "/opensprint-replay/agent",
          image,
          "/replay-input/task.json",
        ],
        { env, timeout: 600_000, maxBuffer: OUTPUT_LIMIT }
      );
      const usage = JSON.parse(agent.stdout.trim()) as {
        completed?: boolean;
        costUsd?: number;
        retryCount?: number;
      };
      if (
        usage.completed !== true ||
        !Number.isFinite(usage.costUsd) ||
        usage.costUsd! < 0 ||
        !Number.isSafeInteger(usage.retryCount) ||
        usage.retryCount! < 0
      )
        throw new Error("Incomplete measured agent result");
      // Fresh container, immutable evaluator, read-only candidate files, and rubric unavailable to the coder.
      const evaluatorContainer = `opensprint-replay-${randomUUID()}`;
      containers.push(evaluatorContainer);
      const evaluated = await execFileAsync(
        docker,
        [
          ...dockerBase,
          "--name",
          evaluatorContainer,
          ...mount(workspace, "/workspace", true),
          ...mount(evaluation, "/replay-evaluation", true),
          "--entrypoint",
          "/opensprint-replay/evaluate",
          image,
          "/replay-evaluation/rubric.json",
        ],
        { env, timeout: 600_000, maxBuffer: OUTPUT_LIMIT }
      );
      const result = JSON.parse(evaluated.stdout.trim()) as {
        rubricId?: string;
        label?: string;
        reviewPassed?: boolean;
        checks?: Array<{ name: string; passed: boolean }>;
      };
      if (
        result.rubricId !== fixture.rubric.id ||
        typeof result.reviewPassed !== "boolean" ||
        !Array.isArray(result.checks) ||
        fixture.rubric.checks.some(
          (check) =>
            !result.checks!.some((r) => r.name === check.name && typeof r.passed === "boolean")
        )
      )
        throw new Error("Incomplete independent evaluation");
      const passed =
        result.checks.every((check) => check.passed === true) && result.label === fixture.label;
      // Runtime artifacts and local commits are retained separately from the actual code diff.
      await fs.rm(path.join(workspace, ".git"), { recursive: true, force: true });
      await fs.rm(path.join(workspace, ".opensprint", "active"), { recursive: true, force: true });
      let codeDiff = "";
      try {
        codeDiff = (
          await execFileAsync(
            "git",
            ["diff", "--no-index", "--binary", "--no-ext-diff", "--", original, workspace],
            {
              timeout: 30_000,
              maxBuffer: 64 * 1024 * 1024,
              env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" },
            }
          )
        ).stdout;
      } catch (err) {
        const diffError = err as { code?: number; stdout?: string };
        if (diffError.code !== 1 || typeof diffError.stdout !== "string") throw err;
        codeDiff = diffError.stdout;
      }
      return {
        success: passed && result.reviewPassed,
        reviewPassed: result.reviewPassed && passed,
        retryCount: usage.retryCount!,
        costUsd: usage.costUsd!,
        latencyMs: Date.now() - start,
        evaluationComplete: true,
        inputHash: hash,
        rubricId: fixture.rubric.id,
        holdout: fixture.holdout,
        label: fixture.label,
        artifact: { agentResult: agent.stdout, evaluatorResult: evaluated.stdout, codeDiff },
      };
    } catch (err) {
      return {
        success: false,
        reviewPassed: false,
        retryCount: 0,
        costUsd: 0,
        latencyMs: Date.now() - start,
        evaluationComplete: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      for (const name of containers)
        await execFileAsync(docker!, ["rm", "--force", name], {
          timeout: 15_000,
          env: { PATH: process.env.PATH, HOME: scratch },
          maxBuffer: 4096,
        }).catch(() => {});
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    }
  }
}

async function resolveReplayDocker(configured?: string): Promise<string> {
  const selected = configured ?? process.env.OPENSPRINT_REPLAY_DOCKER;
  if (selected) {
    if (!path.isAbsolute(selected))
      throw new Error("Replay Docker executable must be an absolute server-owned path");
    await fs.access(selected, fs.constants.X_OK);
    return selected;
  }
  for (const candidate of [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ]) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* Try the next trusted installation location. */
    }
  }
  throw new Error("Replay unavailable: an installed trusted Docker executor is required");
}

async function assertReplaySourceSafe(root: string, relative = ""): Promise<void> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(relative, entry.name);
    const lower = entry.name.toLowerCase();
    if (
      lower === ".env" ||
      (lower.startsWith(".env.") && !/\.(example|sample|template)$/.test(lower)) ||
      [".git", ".aws", ".ssh", ".gnupg"].includes(lower) ||
      /\.(sqlite|sqlite3|db|pem|key)$/.test(lower) ||
      /(^|\/)\.opensprint\/(active|sessions|worktrees|data)(\/|$)/i.test(rel) ||
      /(^|\/)(\.opensprint\/(global-settings|settings|projects)\.json|\.codex\/auth\.json)$/i.test(
        rel
      )
    )
      throw new Error(`Replay unavailable: potentially sensitive tracked input ${rel}`);
    if (entry.isSymbolicLink()) {
      const target = await fs.realpath(path.join(root, rel));
      if (!target.startsWith(`${root}${path.sep}`))
        throw new Error(`Replay unavailable: escaping source link ${rel}`);
    } else if (entry.isDirectory()) await assertReplaySourceSafe(root, rel);
  }
}
