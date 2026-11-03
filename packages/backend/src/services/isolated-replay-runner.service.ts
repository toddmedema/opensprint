import { agentProcessEnvironment } from "../utils/agent-process-env.js";
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
import {
  REPLAY_LABELS,
  replayFixtureService,
  replayInputHash,
  type ReplayFixtureService,
} from "./replay-fixture.service.js";
import type { BehaviorExperimentCandidateBundle } from "./self-improvement-experiment.service.js";
import { scoreReplayVerdict, type ReplayVerdict } from "./experiment-scoring.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("isolated-replay");
const execFileAsync = promisify(execFile);
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
/** Enforced by PID 1 inside the container, so a lost client or crashed server cannot extend it. */
const CONTAINER_TIMEOUT_SECONDS = 590;
const CLIENT_TIMEOUT_MS = 600_000;
const REPLAY_LABEL = "opensprint.replay";
const REPLAY_STARTED_LABEL = "opensprint.replay.started";
const DISK_LIMIT_BYTES = 1024 * 1024 * 1024;
const DISK_POLL_MS = 2_000;
const DISK_ENTRY_LIMIT = 200_000;

/** Per-session outcome from a single replay run. */
export interface ReplayOutcome {
  /** Trusted server score: the fixture's expected outcome was met. */
  success: boolean;
  /** Review produced the fixture's expected result; a blocked violation counts. */
  reviewPassed: boolean;
  verdict?: ReplayVerdict;
  /** Image-reported through container stdout; recorded, never used as a guardrail. */
  retryCount: number;
  latencyMs: number;
  /** Image-reported through container stdout; recorded, never used as a guardrail. */
  costUsd: number;
  error?: string;
  evaluationComplete?: boolean;
  inputHash?: string;
  rubricId?: string;
  holdout?: boolean;
  label?: string;
  artifact?: { agentResult: string; evaluatorResult: string; codeDiff: string };
}
export interface ReplayAgentRunner {
  run(params: {
    sessionId: number;
    worktreePath: string;
    variant: "baseline" | "candidate";
    candidateBundle?: BehaviorExperimentCandidateBundle;
  }): Promise<ReplayOutcome>;
}
export interface IsolatedReplayOptions {
  projectId: string;
  /** Server-owned configuration only; never read this from a task or agent result. */
  image?: string;
  fixtures?: ReplayFixtureService;
  /** Absolute trusted host executable, never resolved through a task-controlled PATH. */
  dockerExecutable?: string;
  /** Workspace budget while the coder runs. */
  diskLimitBytes?: number;
  diskPollMs?: number;
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
    const potentiallyRunning = new Set<string>();
    let docker: string | undefined;
    const diskBudget = new AbortController();
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
        { env: agentProcessEnvironment(), cwd: params.worktreePath, timeout: 30_000 }
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
        await execFileAsync("git", args, {
          cwd: workspace,
          env: agentProcessEnvironment(gitEnv),
          timeout: 30_000,
        });
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
        // The evaluator's verdict stays blind: the human label is applied only by server scoring.
        JSON.stringify({ version: 1, ...fixture.rubric }),
        { mode: 0o600 }
      );
      const hostUid = process.getuid?.() ?? 1000;
      const uid = hostUid === 0 ? 65534 : hostUid;
      const gid = hostUid === 0 ? 65534 : (process.getgid?.() ?? 1000);
      if (hostUid === 0) {
        // These validated directories contain only exported source and server-owned input;
        // hand them to an unprivileged UID before the coder can create any filesystem entries.
        const assignOwnership = async (directory: string): Promise<void> => {
          await fs.chown(directory, uid, gid);
          for (const name of await fs.readdir(directory)) {
            const file = path.join(directory, name);
            const stat = await fs.lstat(file);
            if (stat.isDirectory()) await assignOwnership(file);
            else if (stat.isFile() && stat.nlink === 1) await fs.chown(file, uid, gid);
            else throw new Error("Replay unavailable: unsupported input ownership path");
          }
        };
        for (const directory of [workspace, input, evaluation]) await assignOwnership(directory);
      }
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
        "--label",
        `${REPLAY_LABEL}=1`,
        "--label",
        `${REPLAY_STARTED_LABEL}=${Date.now()}`,
        "--env",
        "HOME=/tmp/replay-home",
        "--env",
        "NODE_ENV=test",
      ];
      const mount = (source: string, target: string, readOnly = false) => [
        "--mount",
        `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`,
      ];
      const env = dockerClientEnvironment();
      const agentContainer = `opensprint-replay-${randomUUID()}`;
      containers.push(agentContainer);
      potentiallyRunning.add(agentContainer);
      const stopDiskWatchdog = watchReplayDisk(
        workspace,
        this.options.diskLimitBytes ?? DISK_LIMIT_BYTES,
        this.options.diskPollMs ?? DISK_POLL_MS,
        () => diskBudget.abort()
      );
      const agent = await execFileAsync(
        docker,
        [
          ...dockerBase,
          "--name",
          agentContainer,
          ...mount(workspace, "/workspace"),
          ...mount(input, "/replay-input", true),
          ...containerCommand("/opensprint-replay/agent", image, "/replay-input/task.json"),
        ],
        { env, timeout: CLIENT_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT, signal: diskBudget.signal }
      ).finally(stopDiskWatchdog);
      potentiallyRunning.delete(agentContainer);
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
      // Container output is untrusted. After Docker has stopped the coder, reject links and
      // special files before any host traversal, nested cleanup, or independent evaluation.
      await makeTreeRemovable(workspace);
      await assertReplayOutputSafe(workspace);
      // Fresh container, immutable evaluator, read-only candidate files, and rubric unavailable to the coder.
      const evaluatorContainer = `opensprint-replay-${randomUUID()}`;
      containers.push(evaluatorContainer);
      potentiallyRunning.add(evaluatorContainer);
      const evaluated = await execFileAsync(
        docker,
        [
          ...dockerBase,
          "--name",
          evaluatorContainer,
          ...mount(workspace, "/workspace", true),
          ...mount(evaluation, "/replay-evaluation", true),
          ...containerCommand(
            "/opensprint-replay/evaluate",
            image,
            "/replay-evaluation/rubric.json"
          ),
        ],
        { env, timeout: CLIENT_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT }
      );
      potentiallyRunning.delete(evaluatorContainer);
      const result = JSON.parse(evaluated.stdout.trim()) as {
        rubricId?: string;
        label?: string;
        reviewPassed?: boolean;
        checks?: Array<{ name: string; passed: boolean }>;
      };
      if (
        result.rubricId !== fixture.rubric.id ||
        typeof result.reviewPassed !== "boolean" ||
        !(REPLAY_LABELS as readonly (string | undefined)[]).includes(result.label) ||
        !Array.isArray(result.checks) ||
        fixture.rubric.checks.some(
          (check) =>
            !result.checks!.some((r) => r.name === check.name && typeof r.passed === "boolean")
        )
      )
        throw new Error("Incomplete independent evaluation");
      const scored = scoreReplayVerdict(fixture.label, {
        label: result.label!,
        reviewPassed: result.reviewPassed,
        checksPassed: result.checks.every((check) => check.passed === true),
      });
      // Runtime artifacts and local commits are retained separately from the actual code diff.
      await removeQuietly(path.join(workspace, ".git"));
      await removeQuietly(path.join(workspace, ".opensprint", "active"));
      let codeDiff = "";
      try {
        codeDiff = (
          await execFileAsync(
            "git",
            [
              "diff",
              "--no-index",
              "--binary",
              "--no-ext-diff",
              "--no-textconv",
              "--",
              original,
              workspace,
            ],
            {
              timeout: 30_000,
              maxBuffer: 64 * 1024 * 1024,
              env: agentProcessEnvironment({
                PATH: process.env.PATH,
                HOME: scratch,
                GIT_CONFIG_NOSYSTEM: "1",
              }),
            }
          )
        ).stdout;
      } catch (err) {
        const diffError = err as { code?: number; stdout?: string };
        if (diffError.code !== 1 || typeof diffError.stdout !== "string") throw err;
        codeDiff = diffError.stdout;
      }
      return {
        success: scored.success,
        reviewPassed: scored.success,
        verdict: scored.verdict,
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
        error: diskBudget.signal.aborted
          ? "Replay unavailable: coder output exceeded its disk budget"
          : err instanceof Error
            ? err.message
            : String(err),
      };
    } finally {
      for (const name of containers) {
        try {
          await execFileAsync(docker!, ["rm", "--force", name], {
            timeout: 15_000,
            env: dockerClientEnvironment(),
            maxBuffer: 4096,
          });
          potentiallyRunning.delete(name);
        } catch {
          // A successful run already confirms container exit. After a timeout/transport failure,
          // an unsuccessful forced stop leaves its private directory quarantined: never traverse
          // a writable tree while an untrusted process may still rename its ancestors.
        }
      }
      if (scratch && potentiallyRunning.size === 0) await removeQuietly(scratch);
    }
  }
}

/** The client needs its daemon selection and config; containers never receive this environment. */
function dockerClientEnvironment(): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT"])
    if (process.env[key]) selected[key] = process.env[key];
  return agentProcessEnvironment(selected);
}
/** A coreutils or BusyBox `timeout` in the image kills the executable from inside the container. */
function containerCommand(executable: string, image: string, input: string): string[] {
  return [
    "--entrypoint",
    "timeout",
    image,
    "-s",
    "KILL",
    String(CONTAINER_TIMEOUT_SECONDS),
    executable,
    input,
  ];
}
/** Remove replay containers that outlived the in-container limit. Never fails server startup. */
export async function sweepReplayContainers(dockerExecutable?: string): Promise<number> {
  try {
    const docker = await resolveReplayDocker(dockerExecutable);
    const env = dockerClientEnvironment();
    const listed = await execFileAsync(
      docker,
      [
        "ps",
        "--all",
        "--filter",
        `label=${REPLAY_LABEL}=1`,
        "--format",
        `{{.ID}} {{.Label "${REPLAY_STARTED_LABEL}"}}`,
      ],
      { env, timeout: 15_000, maxBuffer: OUTPUT_LIMIT }
    );
    // Younger containers may belong to another live server and end themselves by their own limit.
    const cutoff = Date.now() - CLIENT_TIMEOUT_MS;
    const stale = listed.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([id, started]) => id && !(Number(started) > cutoff))
      .map(([id]) => id!);
    if (stale.length)
      await execFileAsync(docker, ["rm", "--force", ...stale], { env, timeout: 30_000 });
    return stale.length;
  } catch {
    return 0;
  }
}
/** Lets host cleanup remove restrictive modes from a stopped container; links are not followed. */
async function makeTreeRemovable(root: string): Promise<void> {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    await fs.chmod(root, stat.mode | 0o600).catch(() => undefined);
    return;
  }
  if (!stat.isDirectory()) return;
  await fs.chmod(root, stat.mode | 0o700).catch(() => undefined);
  for (const name of await fs.readdir(root).catch(() => []))
    await makeTreeRemovable(path.join(root, name));
}
/** Cleanup is best effort: it must never replace the replay outcome already measured. */
async function removeQuietly(target: string): Promise<void> {
  try {
    await makeTreeRemovable(target);
    await fs.rm(target, { recursive: true, force: true });
  } catch (err) {
    log.warn("Replay cleanup incomplete", {
      target,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
/** Abort when lstat-measured workspace bytes or entries exceed the budget. Never follows links. */
function watchReplayDisk(
  root: string,
  limitBytes: number,
  pollMs: number,
  onExceeded: () => void
): () => void {
  const over = async (): Promise<boolean> => {
    let bytes = 0;
    let entries = 0;
    const pending = [root];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (++entries > DISK_ENTRY_LIMIT) return true;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else bytes += (await fs.lstat(file).catch(() => null))?.size ?? 0;
        if (bytes > limitBytes) return true;
      }
    }
    return false;
  };
  let active = true;
  const poll = async (): Promise<void> => {
    if (!active) return;
    if (await over()) {
      if (active) onExceeded();
      return;
    }
    if (active) timer = setTimeout(() => void poll(), pollMs);
  };
  let timer = setTimeout(() => void poll(), pollMs);
  return () => {
    active = false;
    clearTimeout(timer);
  };
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
      [".npmrc", ".netrc", ".pypirc", "credentials.json"].includes(lower) ||
      /^id_(rsa|dsa|ecdsa|ed25519)$/.test(lower) ||
      /\.(p12|pfx|jks|keystore)$/.test(lower) ||
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

/** No host operation may follow a path introduced by the coder outside its disposable mount. */
async function assertReplayOutputSafe(root: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(
          "Replay unavailable: coder output contains an unsupported link or special file"
        );
      if (stat.isFile() && stat.nlink !== 1)
        throw new Error("Replay unavailable: coder output contains unsupported hard links");
      if (++files > 100_000 || (stat.isFile() && (bytes += stat.size) > 512 * 1024 * 1024))
        throw new Error("Replay unavailable: coder output exceeds bounded artifact limits");
      if (stat.isDirectory()) await visit(file);
    }
  }
  await visit(root);
}
