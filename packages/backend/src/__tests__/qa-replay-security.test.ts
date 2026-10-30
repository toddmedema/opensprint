import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ReplayFixtureService, type ReplayFixture } from "../services/replay-fixture.service.js";
import { IsolatedReplayRunner } from "../services/isolated-replay-runner.service.js";
const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
describe("security QA round 3: replay host boundary", () => {
  let root: string;
  let repo: string;
  let docker: string;
  let marker: string;
  let calls: string;
  let fixture: ReplayFixture;
  let store: ReplayFixtureService;
  const image = `offline/trusted@sha256:${"a".repeat(64)}`;
  const git = async (args: string[], input?: string) =>
    (await exec("git", args, { cwd: repo, ...(input === undefined ? {} : {}) })).stdout.trim();
  async function gitInput(args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile("git", args, { cwd: repo }, (error, stdout) =>
        error ? reject(error) : resolve(stdout.trim())
      );
      child.stdin!.end(input);
    });
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-replay-security-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(["init", "-q"]);
    await git(["config", "user.name", "QA"]);
    await git(["config", "user.email", "qa@example.invalid"]);
    await fs.writeFile(path.join(repo, "input.txt"), "original\n");
    await git(["add", "."]);
    await git(["commit", "-m", "original"]);
    marker = path.join(root, "host-filter-executed");
    calls = path.join(root, "docker-called");
    docker = path.join(root, "docker");
    await fs.writeFile(
      docker,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(calls)},'called'); const args=process.argv.slice(2); if(args[0]==='rm')process.exit(0); process.stdout.write(JSON.stringify(args.includes('/opensprint-replay/agent')?{completed:true,retryCount:0,costUsd:0}:{rubricId:'qa',label:'defect',reviewPassed:true,checks:[{name:'independent',passed:true}]}));\n`,
      { mode: 0o700 }
    );
    fixture = {
      version: 1,
      projectId: "qa-replay",
      sessionId: 1,
      baseCommitSha: await git(["rev-parse", "HEAD"]),
      taskPrompt: "Inspect code",
      instructions: {
        general: "policy",
        roles: { coder: "coder", reviewer: "reviewer" },
        templates: {
          coder: "coder",
          reviewer: "reviewer",
          finalReview: "final",
          selfImprovement: "audit",
        },
      },
      toolchain: "offline",
      rubric: {
        id: "qa",
        text: "Independent classification",
        checks: [{ name: "independent", command: "check", args: [] }],
      },
      label: "defect",
      holdout: true,
      humanActor: "QA",
      createdAt: "2026-10-30T12:00:00Z",
    };
    store = new ReplayFixtureService(path.join(root, "fixtures"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  it("refuses a raw Git tree containing case-folded metadata before host Git filters or Docker execute", async () => {
    const filter = `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'host code executed');process.stdin.pipe(process.stdout)`)}`;
    const configPath = path.join(root, "untrusted-config");
    await git(["config", "--file", configPath, "filter.qa.clean", filter]);
    const config = await gitInput(
      ["hash-object", "-w", "--stdin"],
      await fs.readFile(configPath, "utf8")
    );
    const attrs = await gitInput(["hash-object", "-w", "--stdin"], "*.txt filter=qa\n");
    const code = await gitInput(["hash-object", "-w", "--stdin"], "untrusted source\n");
    const metadata = await gitInput(["mktree"], `100644 blob ${config}\tconfig\n`);
    const tree = await gitInput(
      ["mktree"],
      `040000 tree ${metadata}\t.GIT\n100644 blob ${attrs}\t.gitattributes\n100644 blob ${code}\tinput.txt\n`
    );
    const commit = await gitInput(["commit-tree", tree, "-m", "raw archive attack"], "");
    await store.capture({ ...fixture, baseCommitSha: commit }, repo);
    const outcome = await new IsolatedReplayRunner({
      projectId: fixture.projectId,
      fixtures: store,
      image,
      dockerExecutable: docker,
    }).run({ sessionId: 1, worktreePath: repo, variant: "baseline" });
    expect(outcome).toMatchObject({ success: false, evaluationComplete: false });
    expect(outcome.error).toMatch(/invalid path|reserved|unsafe/i);
    expect(
      await fs.access(marker).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(
      await fs.access(calls).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });
  it("does not resolve Docker through a candidate-controlled PATH", async () => {
    await store.capture(fixture, repo);
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    const outcome = await new IsolatedReplayRunner({
      projectId: fixture.projectId,
      fixtures: store,
      image,
      dockerExecutable: "docker",
    }).run({ sessionId: 1, worktreePath: repo, variant: "baseline" });
    expect(outcome).toMatchObject({ success: false, evaluationComplete: false });
    expect(outcome.error).toContain("absolute");
    expect(
      await fs.access(calls).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });
  it("rejects retained context path traversal before launching any executor", async () => {
    await store.capture(
      {
        ...fixture,
        taskId: "qa-task",
        contextArtifacts: {
          complete: true,
          files: { "../outside": Buffer.from("unsafe").toString("base64") },
        },
      },
      repo
    );
    const outcome = await new IsolatedReplayRunner({
      projectId: fixture.projectId,
      fixtures: store,
      image,
      dockerExecutable: docker,
    }).run({ sessionId: 1, worktreePath: repo, variant: "baseline" });
    expect(outcome).toMatchObject({ success: false, evaluationComplete: false });
    expect(outcome.error).toContain("invalid retained context path");
    expect(
      await fs.access(calls).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });
});
