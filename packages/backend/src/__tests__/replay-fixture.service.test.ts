import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ReplayFixtureService, type ReplayFixture } from "../services/replay-fixture.service.js";
import { IsolatedReplayRunner } from "../services/isolated-replay-runner.service.js";
const exec = promisify(execFile);

describe("durable replay inputs", () => {
  let root: string;
  let repo: string;
  let fixture: ReplayFixture;
  let store: ReplayFixtureService;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "replay-test-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await exec("git", ["init", repo]);
    await fs.writeFile(path.join(repo, "source.ts"), "export const x = 1;\n");
    await exec("git", ["add", "source.ts"], { cwd: repo });
    await exec(
      "git",
      [
        "-c",
        "user.name=Replay",
        "-c",
        "user.email=replay@example.test",
        "commit",
        "-m",
        "original",
      ],
      { cwd: repo }
    );
    const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    store = new ReplayFixtureService(path.join(root, "evidence"));
    fixture = {
      version: 1,
      projectId: "project-1",
      sessionId: 7,
      baseCommitSha: sha,
      taskPrompt: "Add diagnostic",
      instructions: {
        general: "Approved instructions",
        roles: { coder: "Implement", reviewer: "Review" },
        templates: {
          coder: "Complete coding prompt",
          reviewer: "Full review prompt",
          finalReview: "Epic review",
          selfImprovement: "Audit",
        },
      },
      toolchain: "node24-typescript",
      rubric: {
        id: "rubric1",
        text: "Detect direct writes",
        checks: [{ name: "unit", command: "npm", args: ["test"] }],
      },
      label: "defect",
      holdout: true,
      humanActor: "Owner",
      createdAt: "2026-10-30T12:00:00Z",
    };
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  it("retains original commits and full evidence independently of session cleanup", async () => {
    const stored = await store.capture(fixture, repo);
    await fs.mkdir(path.join(repo, ".opensprint", "sessions"), { recursive: true });
    await fs.rm(path.join(repo, ".opensprint"), { recursive: true });
    expect(await store.read("project-1", 7)).toEqual(stored);
    const refs = (
      await exec("git", ["for-each-ref", "--format=%(objectname)", "refs/opensprint/replay"], {
        cwd: repo,
      })
    ).stdout;
    expect(refs.trim()).toBe(fixture.baseCommitSha);
    expect(await store.list("other-project")).toEqual([]);
  });
  it("is idempotent and forbids rubric/content replacement", async () => {
    const first = await store.capture(fixture, repo);
    expect(await store.capture(fixture, repo)).toEqual(first);
    await expect(
      store.capture({ ...fixture, taskPrompt: "Change benchmark" }, repo)
    ).rejects.toThrow("immutable");
  });
  it("treats missing inputs and absent sandbox as incomplete, never success", async () => {
    const runner = new IsolatedReplayRunner({
      projectId: "project-1",
      fixtures: store,
      image: "mutable:latest",
    });
    const result = await runner.run({ sessionId: 7, worktreePath: repo, variant: "baseline" });
    expect(result).toMatchObject({
      success: false,
      evaluationComplete: false,
      reviewPassed: false,
    });
    expect(result.error).toContain("immutable");
    await expect(store.read("project-1", 7)).rejects.toThrow();
  });
  it("requires explicit independent checks and complete original instructions", async () => {
    await expect(
      store.capture({ ...fixture, rubric: { ...fixture.rubric, checks: [] } }, repo)
    ).rejects.toThrow("independent deterministic check");
    await expect(
      store.capture({ ...fixture, instructions: { ...fixture.instructions, roles: {} } }, repo)
    ).rejects.toThrow("instruction snapshot");
  });
  it("runs distinct coder/evaluator containers with external isolation flags and retains measured evidence", async () => {
    await store.capture(fixture, repo);
    const bin = path.join(root, "bin");
    const calls = path.join(root, "docker-calls.jsonl");
    await fs.mkdir(bin);
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, approval:process.env.OPENSPRINT_GOVERNANCE_APPROVAL_SECRET, provider:process.env.OPENAI_API_KEY})+'\\n');
if(args[0]==='rm')process.exit(0);
if(args.includes('/opensprint-replay/agent')){
 const mount=args.find(a=>a.includes('target=/workspace'));
 const source=mount.match(/source=([^,]+)/)[1];
 fs.writeFileSync(source+'/source.ts','export const x = 2;\\n');
 process.stdout.write(JSON.stringify({completed:true,costUsd:0.03,retryCount:1}));
} else process.stdout.write(JSON.stringify({rubricId:'rubric1',label:'defect',reviewPassed:true,checks:[{name:'unit',passed:true}]}));
`;
    await fs.writeFile(path.join(bin, "docker"), script, { mode: 0o700 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "not-in-container");
    vi.stubEnv("OPENAI_API_KEY", "not-in-container-either");
    const runner = new IsolatedReplayRunner({
      projectId: "project-1",
      fixtures: store,
      image: `offline/agent@sha256:${"a".repeat(64)}`,
      dockerExecutable: path.join(bin, "docker"),
    });
    const result = await runner.run({ sessionId: 7, worktreePath: repo, variant: "baseline" });
    expect(result).toMatchObject({
      success: true,
      evaluationComplete: true,
      costUsd: 0.03,
      retryCount: 1,
      rubricId: "rubric1",
    });
    expect(result.artifact?.codeDiff).toContain("+export const x = 2;");
    const invocations = (await fs.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; approval?: string; provider?: string });
    const runs = invocations.filter((call) => call.args[0] === "run");
    expect(runs).toHaveLength(2);
    for (const call of runs) {
      expect(call.args).toEqual(
        expect.arrayContaining([
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pull=never",
        ])
      );
      expect(call.approval).toBeUndefined();
      expect(call.provider).toBeUndefined();
    }
    expect(runs[0].args.some((arg) => arg.includes("replay-evaluation"))).toBe(false);
    expect(runs[1].args.find((arg) => arg.includes("target=/workspace"))).toContain("readonly");
    expect(invocations.filter((call) => call.args[0] === "rm")).toHaveLength(2);
  });
});
