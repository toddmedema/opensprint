import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createForgeApp } from "./app.js";
import type { ReplayRunner } from "./evolve/replay.js";

const SECRET = "super-secret-token";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("walking skeleton", () => {
  it("ships a Node repo and a Make repo without a default npm gate", async () => {
    await shipFixture("node");
    await shipFixture("make");
  });

  it("keeps guidance off the thread and recovers a durable result", async () => {
    const fx = boot();
    const remote = seedRepo(fx.root, "node");
    await fx.agent.post("/session/register").send(person("ada"));
    const team = await fx.agent.post("/teams").send({ name: "Forge" });
    const created = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
      name: "Node",
      remoteUrl: remote,
      baseBranch: "main",
      agentRuntime: { argv: ["node", fx.runtime], timeoutSec: 60 },
      credential: { type: "https_token", username: "git", token: SECRET },
    });
    const projectId = created.body.project.id as string;
    const discovered = await fx.agent.post(`/projects/${projectId}/runbook/discover`).send({});
    expect(discovered.body.outcome).toBe("active");
    const runbook = await fx.agent.get(`/projects/${projectId}/runbook`);
    const commands = JSON.stringify(runbook.body.revisions.at(-1).probe);
    expect(commands).not.toContain("npm");
    expect(commands).toContain("verify.mjs");

    const guest = request.agent(fx.app);
    await guest.post("/session/register").send(person("bea"));
    const invite = await fx.agent.post(`/teams/${team.body.team.id}/invites`).send({ role: "steer" });
    await guest.post(`/invites/${invite.body.invite.token}/accept`).send({});
    const item = await fx.agent.post(`/projects/${projectId}/order`).send({
      title: "Wait once",
      body: "WAIT",
    });
    const workItemId = item.body.item.id as string;
    await waitFor(() => fs.existsSync(echoPath(fx, projectId, 1)));
    const room = await guest.get(`/projects/${projectId}/order/${workItemId}`);
    expect(room.status).toBe(200);
    await guest.post(`/projects/${projectId}/order/${workItemId}/thread`).send({
      body: "THREAD_TOKEN stays here",
      idempotencyKey: "post-1",
    });
    const claim = await guest.post(`/projects/${projectId}/order/${workItemId}/steer/claim`).send({
      revision: room.body.run.controlRevision,
    });
    await guest.post(`/projects/${projectId}/order/${workItemId}/steer/guidance`).send({
      revision: claim.body.revision,
      body: "GUIDANCE_TOKEN",
    });
    fs.writeFileSync(path.join(worktree(fx, projectId), "release"), "go");
    await fx.engine.whenIdle();
    const shipped = await fx.agent.get(`/projects/${projectId}/order`);
    expect(shipped.body.items.find((entry: { id: string }) => entry.id === workItemId).status).toBe("done");
    const echo = show(remote, "echo-2.txt");
    expect(echo).toContain("GUIDANCE_TOKEN");
    expect(echo).not.toContain("THREAD_TOKEN");
    expect(show(remote, "echo-1.txt")).not.toContain("GUIDANCE_TOKEN");
    expect(audit(fx)).toMatchObject({
      TOKEN_ENCRYPTION_KEY: null,
      OPENSPRINT_OWNER_KEY: null,
      OPENSPRINT_SESSION_SECRET: null,
    });
    const assignments = fs.readdirSync(path.join(fx.dataDir, "active")).map((runId) =>
      fs.readFileSync(path.join(fx.dataDir, "active", runId, "assignment.json"), "utf8")
    );
    expect(assignments.join("\n")).not.toContain(SECRET);
  });

  it("holds a red probe and a merge conflict", async () => {
    const fx = boot();
    const remote = seedRepo(fx.root, "node");
    await fx.agent.post("/session/register").send(person("ada"));
    const team = await fx.agent.post("/teams").send({ name: "Forge" });
    const created = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
      name: "Node",
      remoteUrl: remote,
      baseBranch: "main",
      agentRuntime: { argv: ["node", fx.runtime], timeoutSec: 60 },
      credential: { type: "none" },
    });
    const projectId = created.body.project.id as string;
    const first = await fx.agent.post(`/projects/${projectId}/runbook/discover`).send({});
    const digest = first.body.digest as string;
    const rejected = await fx.agent.post(`/projects/${projectId}/runbook/proposals`).send({
      document: runbook(["node", "-e", "process.exit(1)"]),
    });
    expect(rejected.body.outcome).toBe("rejected");
    const after = await fx.agent.get(`/projects/${projectId}/runbook`);
    expect(after.body.activeDigest).toBe(digest);
    expect(after.body.revisions.some((revision: { status: string }) => revision.status === "rejected")).toBe(
      true
    );
    const order = await fx.agent.get(`/projects/${projectId}/order`);
    expect(order.body.items.some((item: { title: string }) => item.title === "Runbook probe failed")).toBe(
      true
    );

    pushReadme(remote, "remote-change\n");
    const conflict = await fx.agent.post(`/projects/${projectId}/order`).send({
      title: "Conflict",
      body: "CONFLICT",
    });
    await fx.engine.whenIdle();
    const held = await fx.agent.get(`/projects/${projectId}/order/${conflict.body.item.id}`);
    expect(held.body.item.status).toBe("held");
    expect(held.body.item.shipCommit).toBeNull();
    expect(fs.existsSync(worktree(fx, projectId))).toBe(true);
  });

  it("completes a durable assignment after the server is gone", async () => {
    const fx = boot();
    const remote = seedRepo(fx.root, "node");
    await fx.agent.post("/session/register").send(person("ada"));
    const team = await fx.agent.post("/teams").send({ name: "Forge" });
    const created = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
      name: "Node",
      remoteUrl: remote,
      baseBranch: "main",
      agentRuntime: { argv: ["node", fx.runtime], timeoutSec: 60 },
      credential: { type: "none" },
    });
    const projectId = created.body.project.id as string;
    await fx.agent.post(`/projects/${projectId}/runbook/discover`).send({});
    const item = await fx.agent.post(`/projects/${projectId}/order`).send({ title: "Recover", body: "WAIT" });
    await waitFor(() => fs.existsSync(echoPath(fx, projectId, 1)));
    const run = fx.store.runsByProject(projectId).find((entry) => entry.role === "worker");
    if (!run?.pid || !run.assignmentPath) throw new Error("assignment was not durable before the crash");
    const resultPath = path.join(path.dirname(run.assignmentPath), "result.json");
    const runId = run.id;
    fx.engine.abandon();
    try {
      process.kill(run.pid, "SIGKILL");
    } catch {
      // The worker had already exited.
    }
    fs.writeFileSync(path.join(worktree(fx, projectId), "CHANGELOG"), "shipped\n");
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        status: "succeeded",
        summary: "recovered",
        evidence: [{ command: "work", exitCode: 0, excerpt: "ok" }],
        questions: [],
      })
    );
    fx.engine.abandon();
    const second = createForgeApp({
      dataDir: fx.dataDir,
      tokenEncryptionKey: fx.key,
      sessionSecret: "test-session",
      ownerKey: "owner-test-key",
      timer: false,
    });
    second.store.updateRun(runId, {
      heartbeatAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      pid: null,
    });
    await second.engine.tick();
    await second.engine.whenIdle();
    const agent = request.agent(second.app);
    await agent.post("/session").send({ email: "ada@example.com", password: "password1" });
    const room = await agent.get(`/projects/${projectId}/order/${item.body.item.id}`);
    expect(room.body.item.status).toBe("done");
    expect(show(remote, "CHANGELOG")).toContain("shipped");
    second.close();
  });

  it("lets the owner evolve a rule and refuses to waive a gate", async () => {
    const fx = boot(completeRunner);
    const remote = seedRepo(fx.root, "node");
    await fx.agent.post("/session/register").send(person("ada"));
    const team = await fx.agent.post("/teams").send({ name: "Forge" });
    const created = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
      name: "Node",
      remoteUrl: remote,
      baseBranch: "main",
      agentRuntime: { argv: ["node", fx.runtime], timeoutSec: 60 },
      credential: { type: "none" },
    });
    const projectId = created.body.project.id as string;
    await fx.agent.post(`/projects/${projectId}/runbook/discover`).send({});
    expect(
      (await fx.agent.post(`/projects/${projectId}/governance`).send({ ownerKey: "nope", mode: "enforced" })).status
    ).toBe(403);
    expect(
      (
        await fx.agent
          .post(`/projects/${projectId}/governance`)
          .send({ ownerKey: "owner-test-key", mode: "enforced" })
      ).status
    ).toBe(409);
    await fx.agent.post(`/projects/${projectId}/governance`).send({ ownerKey: "owner-test-key", mode: "shadow" });
    const clean = await fx.agent.post(`/projects/${projectId}/order`).send({ title: "Clean", body: "ship" });
    await fx.engine.whenIdle();
    expect((await fx.agent.get(`/projects/${projectId}/order/${clean.body.item.id}`)).body.item.status).toBe(
      "done"
    );
    await fx.agent.post(`/projects/${projectId}/governance`).send({ ownerKey: "owner-test-key", mode: "enforced" });

    const userId = (await fx.agent.get("/session")).body.user.id as string;
    for (const decision of ["reject", "allow_once"] as const) {
      const item = await fx.agent.post(`/projects/${projectId}/order`).send({
        title: decision,
        body: "TOUCH_OAUTH",
        scopePaths: ["routes/oauth/token.ts"],
      });
      await fx.agent.post(`/projects/${projectId}/scope-grants`).send({
        ownerKey: "owner-test-key",
        workItemId: item.body.item.id,
        paths: ["routes/oauth/token.ts"],
      });
      await fx.engine.tick();
      await fx.engine.whenIdle();
      const gate = await fx.agent.get(`/projects/${projectId}/gate`);
      const review = gate.body.cases.find(
        (entry: { workItemId: string; status: string; title: string; summary: string }) =>
          entry.workItemId === item.body.item.id &&
          entry.status === "open" &&
          entry.title === "governance" &&
          entry.summary.includes("ruleKey")
      );
      const resolved = await fx.agent.post(`/projects/${projectId}/gate/cases/${review.id}/resolve`).send({
        ownerKey: "owner-test-key",
        decision,
        rationale: decision,
      });
      expect(resolved.status).toBe(200);
      expect((await fx.agent.get(`/projects/${projectId}/order/${item.body.item.id}`)).body.item.status).not.toBe(
        "done"
      );
    }
    expect(userId).toMatch(/^os-/);
    const failing = (await fx.agent.get(`/projects/${projectId}/gate`)).body.cases.find(
      (entry: { title: string }) => entry.title === "failing_gate"
    );
    if (failing) {
      const waived = await fx.agent.post(`/projects/${projectId}/gate/cases/${failing.id}/resolve`).send({
        ownerKey: "owner-test-key",
        decision: "allow_once",
        rationale: "no",
      });
      expect(waived.status).toBe(409);
    }
    await fx.agent.post(`/projects/${projectId}/evolve/mine`).send({});
    const evolve = await fx.agent.get(`/projects/${projectId}/evolve`);
    const nomination = evolve.body.nominations[0];
    expect(nomination.supportingEvidence.length).toBeGreaterThan(0);
    expect(nomination.contraryEvidence.length).toBeGreaterThan(0);
    const proposed = await fx.agent
      .post(`/projects/${projectId}/evolve/nominations/${nomination.id}/proposals`)
      .send({
        text: "Keep KEEP_OUT.txt unchanged.",
        detector: "protected-path",
        paths: ["KEEP_OUT.txt", "**/routes/oauth/**"],
        authorKind: "person",
      });
    const before = evolve.body.releases.find((release: { status: string }) => release.status === "active").version;
    const evaluated = await fx.agent
      .post(`/projects/${projectId}/evolve/proposals/${proposed.body.id}/evaluate`)
      .send({});
    expect(evaluated.body.status).toBe("complete");
    const still = await fx.agent.get(`/projects/${projectId}/evolve`);
    expect(still.body.releases.find((release: { status: string }) => release.status === "active").version).toBe(
      before
    );
    const activated = await fx.agent
      .post(`/projects/${projectId}/evolve/proposals/${proposed.body.id}/activate`)
      .send({ ownerKey: "owner-test-key" });
    expect(activated.status).toBe(200);
    const kept = await fx.agent.post(`/projects/${projectId}/order`).send({
      title: "Keep out",
      body: "TOUCH_KEEP",
    });
    await fx.engine.tick();
    await fx.engine.whenIdle();
    expect((await fx.agent.get(`/projects/${projectId}/order/${kept.body.item.id}`)).body.item.status).toBe(
      "held"
    );
    expect(show(remote, "KEEP_OUT.txt")).toBe("");
  });

  it("starts from scratch and rejects a project with no runtime argv", async () => {
    const fx = boot();
    await fx.agent.post("/session/register").send(person("ada"));
    const team = await fx.agent.post("/teams").send({ name: "Forge" });
    const missing = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
      name: "Bare",
      remoteUrl: path.join(fx.root, "missing.git"),
      baseBranch: "main",
      agentRuntime: { timeoutSec: 600 },
      credential: { type: "none" },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_runtime");

    const created = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
      origin: "scratch",
      name: "Scratch",
      baseBranch: "main",
      agentRuntime: { argv: ["node", fx.runtime], timeoutSec: 600 },
      credential: { type: "none" },
    });
    expect(created.status).toBe(201);
    expect(created.body.project.baseBranch).toBe("main");
    expect(created.body.project.credentialKind).toBe("none");
    expect(created.body.project.hasCredential).toBe(false);
    const remote = created.body.project.remoteUrl as string;
    expect(path.isAbsolute(remote)).toBe(true);
    expect(remote.startsWith(fx.dataDir)).toBe(true);
    const env = gitEnv(fx.root);
    expect(execFileSync("git", ["-C", remote, "rev-list", "--count", "main"], { encoding: "utf8", env }).trim()).toBe(
      "1"
    );
    expect(execFileSync("git", ["-C", remote, "log", "-1", "--format=%s", "main"], { encoding: "utf8", env }).trim()).toBe(
      "Start"
    );
    expect(
      execFileSync("git", ["-C", remote, "log", "-1", "--format=%an", "main"], { encoding: "utf8", env }).trim()
    ).toBe("Open Sprint");
    expect(
      execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8", env }).trim()
    ).toBe("");
    expect(
      execFileSync("git", ["-C", remote, "rev-parse", "--is-bare-repository"], { encoding: "utf8", env }).trim()
    ).toBe("true");
    const checkout = path.join(fx.dataDir, "checkouts", created.body.project.id as string);
    expect(fs.existsSync(path.join(checkout, ".git"))).toBe(true);
    fs.writeFileSync(path.join(checkout, "NOTE"), "from the checkout\n");
    execFileSync("git", ["add", "NOTE"], { cwd: checkout, env });
    execFileSync("git", ["commit", "-m", "from checkout"], { cwd: checkout, env });
    const pushed = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: checkout, env, encoding: "utf8" });
    expect(pushed.status).toBe(0);
    expect(execFileSync("git", ["-C", remote, "log", "-1", "--format=%s", "main"], { encoding: "utf8", env }).trim()).toBe(
      "from checkout"
    );
  });

  it("keeps a verification runbook only after a zero exit and refuses to lock before one exists", async () => {
    const fx = boot();
    const remote = seedRepo(fx.root, "node");
    await fx.agent.post("/session/register").send(person("ada"));
    const team = await fx.agent.post("/teams").send({ name: "Forge" });
    const created = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
      origin: "import",
      name: "Node",
      remoteUrl: remote,
      baseBranch: "main",
      agentRuntime: { argv: ["node", fx.runtime], timeoutSec: 60 },
      credential: { type: "none" },
    });
    const projectId = created.body.project.id as string;
    const locked = await fx.agent.post(`/projects/${projectId}/runbook/lock`).send({ locked: true });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("no_runbook");
    expect(locked.body.error.message).toBe("Discover or probe a runbook before locking.");

    const shell = await fx.agent
      .post(`/projects/${projectId}/runbook/verification`)
      .send({ command: "node verify.mjs | cat" });
    expect(shell.status).toBe(400);
    expect(shell.body.error.message).toBe(
      "Enter the program and arguments separated by spaces, without shell syntax."
    );

    const rejected = await fx.agent
      .post(`/projects/${projectId}/runbook/verification`)
      .send({ command: "node -e process.exit(1)" });
    expect(rejected.body.outcome).toBe("rejected");
    const afterReject = await fx.agent.get(`/projects/${projectId}/runbook`);
    expect(afterReject.body.activeDigest).toBeNull();
    expect(afterReject.body.revisions.some((revision: { status: string }) => revision.status === "rejected")).toBe(
      true
    );
    const order = await fx.agent.get(`/projects/${projectId}/order`);
    expect(order.body.items.some((item: { title: string }) => item.title === "Runbook probe failed")).toBe(true);

    const active = await fx.agent
      .post(`/projects/${projectId}/runbook/verification`)
      .send({ command: "node verify.mjs" });
    expect(active.body.outcome).toBe("active");
    const after = await fx.agent.get(`/projects/${projectId}/runbook`);
    expect(after.body.activeDigest).toBeTruthy();
    const verifyGate = after.body.active.gates.find((gate: { id: string }) => gate.id === "verify");
    expect(verifyGate.argv).toEqual(["node", "verify.mjs"]);
    expect(verifyGate.cwd).toBe(".");
    expect(verifyGate.timeoutSec).toBe(60);
    expect(verifyGate.required).toBe(true);
    expect(after.body.active.install).toBeNull();
    expect(after.body.active.health).toBeNull();
    expect(after.body.active.ship).toBeNull();
    expect(after.body.active.runtimeTools).toEqual(["node"]);
    expect(after.body.active.dependencyPaths).toEqual([]);
    expect(after.body.active.blockedPaths).toEqual([".env"]);
  });

  it("closes discovery questions when a verification probe becomes active", async () => {
    const fx = boot();
    await fx.agent.post("/session/register").send(person("ada"));
    const team = await fx.agent.post("/teams").send({ name: "Forge" });
    const created = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
      origin: "scratch",
      name: "Ask",
      baseBranch: "main",
      agentRuntime: { argv: ["node", fx.runtime], timeoutSec: 60 },
      credential: { type: "none" },
    });
    const projectId = created.body.project.id as string;
    const discovered = await fx.agent.post(`/projects/${projectId}/runbook/discover`).send({});
    expect(discovered.body.outcome).toBe("needs_human");
    expect(discovered.body.questions.length).toBeGreaterThan(0);
    const gate = await fx.agent.get(`/projects/${projectId}/gate`);
    expect(gate.body.questions[0].role).toBe("discovery");
    expect(gate.body.questions[0].prompt).toBe(discovered.body.questions[0]);

    const checkout = path.join(fx.dataDir, "checkouts", projectId);
    fs.writeFileSync(path.join(checkout, "verify.mjs"), "process.exit(0);\n");
    const env = gitEnv(fx.root);
    execFileSync("git", ["add", "verify.mjs"], { cwd: checkout, env });
    execFileSync("git", ["commit", "-m", "verify"], { cwd: checkout, env });
    const probed = await fx.agent
      .post(`/projects/${projectId}/runbook/verification`)
      .send({ command: "node verify.mjs" });
    expect(probed.body.outcome).toBe("active");
    const runs = fx.store.runsByProject(projectId).filter((run) => run.role === "discovery");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("done");
    expect(runs[0]?.attempt).toBe(1);
    expect(runs[0]?.answers).toEqual([]);
    expect(
      fx.store.casesByProject(projectId).some((item) => item.kind === "question" && item.status === "open")
    ).toBe(false);
    expect(
      fx.store.casesByProject(projectId).some((item) => item.kind === "question" && item.status === "resolved")
    ).toBe(true);
    expect((await fx.agent.get(`/projects/${projectId}/gate`)).body.questions).toEqual([]);
  });
});

function boot(runner?: ReplayRunner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skel-"));
  const dataDir = path.join(root, "data");
  const runtime = path.join(root, "runtime.mjs");
  fs.writeFileSync(runtime, RUNTIME);
  const tokenEncryptionKey = randomBytes(32);
  const handle = createForgeApp({
    dataDir,
    tokenEncryptionKey,
    sessionSecret: "test-session",
    ownerKey: "owner-test-key",
    replayImage: "sha256:test",
    timer: false,
    replayRunner: runner,
  });
  cleanups.push(() => {
    handle.close();
    chmodWritable(dataDir);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dataDir,
    runtime,
    key: tokenEncryptionKey,
    app: handle.app,
    engine: handle.engine,
    store: handle.store,
    agent: request.agent(handle.app),
  };
}

async function shipFixture(kind: "node" | "make") {
  const fx = boot();
  const remote = seedRepo(fx.root, kind);
  await fx.agent.post("/session/register").send(person("ada"));
  const team = await fx.agent.post("/teams").send({ name: "Forge" });
  const created = await fx.agent.post(`/teams/${team.body.team.id}/projects`).send({
    name: kind,
    remoteUrl: remote,
    baseBranch: "main",
    agentRuntime: { argv: ["node", fx.runtime], timeoutSec: 60 },
    credential: { type: "none" },
  });
  const projectId = created.body.project.id as string;
  const discovered = await fx.agent.post(`/projects/${projectId}/runbook/discover`).send({});
  expect(discovered.body.outcome).toBe("active");
  const item = await fx.agent.post(`/projects/${projectId}/order`).send({ title: "Ship", body: "ship the change" });
  await fx.engine.whenIdle();
  const room = await fx.agent.get(`/projects/${projectId}/order/${item.body.item.id}`);
  expect(room.body.item.status).toBe("done");
  expect(room.body.item.shipCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(room.body.diff).toContain("CHANGELOG");
  expect(show(remote, "CHANGELOG")).toContain("shipped");
  const probe = JSON.stringify((await fx.agent.get(`/projects/${projectId}/runbook`)).body.revisions.at(-1).probe);
  expect(probe).not.toContain("npm");
  if (kind === "make") expect(probe).toContain("make");
}

function seedRepo(root: string, kind: "node" | "make"): string {
  const remote = path.join(root, `${kind}.git`);
  const seed = path.join(root, `${kind}-seed`);
  const env = gitEnv(root);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { env });
  execFileSync("git", ["clone", remote, seed], { env });
  const files =
    kind === "node"
      ? {
          "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }),
          "verify.mjs": "process.exit(0);\n",
          "README.md": "base\n",
          "CHANGELOG": "",
        }
      : {
          Makefile:
            "deps:\n\tpython3 -c 'print(1)'\nhealth:\n\tpython3 -c 'print(1)'\nverify:\n\tpython3 -c 'print(1)'\n",
          "README.md": "base\n",
          "CHANGELOG": "",
        };
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true });
    fs.writeFileSync(path.join(seed, name), contents);
  }
  execFileSync("git", ["add", "."], { cwd: seed, env });
  execFileSync("git", ["commit", "-m", "init"], { cwd: seed, env });
  execFileSync("git", ["push", "origin", "main"], { cwd: seed, env });
  return remote;
}

function pushReadme(remote: string, contents: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-push-"));
  const env = gitEnv(dir);
  execFileSync("git", ["clone", remote, dir + "/repo"], { env });
  fs.writeFileSync(path.join(dir, "repo", "README.md"), contents);
  execFileSync("git", ["add", "README.md"], { cwd: path.join(dir, "repo"), env });
  execFileSync("git", ["commit", "-m", "remote"], { cwd: path.join(dir, "repo"), env });
  execFileSync("git", ["push", "origin", "main"], { cwd: path.join(dir, "repo"), env });
}

function show(remote: string, file: string): string {
  try {
    return execFileSync("git", ["--git-dir", remote, "show", `main:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function person(name: string) {
  return { email: `${name}@example.com`, name, password: "password1" };
}

function worktree(fx: { dataDir: string }, projectId: string): string {
  return fs.readdirSync(path.join(fx.dataDir, "worktrees", projectId))[0]
    ? path.join(fx.dataDir, "worktrees", projectId, fs.readdirSync(path.join(fx.dataDir, "worktrees", projectId))[0] ?? "")
    : "";
}

function echoPath(fx: { dataDir: string }, projectId: string, attempt: number): string {
  return path.join(worktree(fx, projectId), `echo-${attempt}.txt`);
}

function audit(fx: { dataDir: string }): Record<string, string | null> {
  const active = path.join(fx.dataDir, "active");
  for (const runId of fs.readdirSync(active)) {
    const file = path.join(active, runId, "env-audit.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string | null>;
  }
  return {};
}

async function waitFor(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 15000) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function chmodWritable(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      fs.chmodSync(full, entry.isDirectory() ? 0o755 : 0o644);
    } catch {
      // Continue walking what we can.
    }
    if (entry.isDirectory()) chmodWritable(full);
  }
}

function gitEnv(root: string): NodeJS.ProcessEnv {
  const config = path.join(root, "empty-gitconfig");
  if (!fs.existsSync(config)) fs.writeFileSync(config, "");
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function runbook(argv: string[]) {
  return {
    version: 1,
    install: null,
    health: null,
    gates: [{ id: "verify", argv, cwd: ".", timeoutSec: 30, required: true }],
    ship: null,
    runtimeTools: ["node"],
    dependencyPaths: [],
    blockedPaths: [".env"],
  };
}

const completeRunner: ReplayRunner = async ({ image, fixture }) => ({
  imageDigest: image,
  network: "none",
  isolation: "docker",
  originalInputsPresent: fixture.inputs != null && fixture.heldOut.length > 0,
  heldOut: fixture.heldOut.map((_, index) => ({ name: `held-${index}`, passed: true })),
  metrics: { replayAgreement: 1 },
  missing: [],
  note: "test",
});

const RUNTIME = `import fs from "node:fs";
const assignment = JSON.parse(fs.readFileSync(process.env.OPENSPRINT_ASSIGNMENT_PATH, "utf8"));
const resultPath = process.env.OPENSPRINT_RESULT_PATH;
const audit = {};
for (const key of ["TOKEN_ENCRYPTION_KEY", "OPENSPRINT_OWNER_KEY", "OPENSPRINT_SESSION_SECRET", "OPENSPRINT_REPLAY_IMAGE", "FORGE_ASKPASS_FILE"]) {
  audit[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
}
fs.writeFileSync(resultPath.replace(/result\\.json$/, "env-audit.json"), JSON.stringify(audit));
function finish(payload) { fs.writeFileSync(resultPath, JSON.stringify(payload)); }
if (assignment.role === "discovery") {
  if (fs.existsSync("Makefile")) {
    finish({ status: "succeeded", summary: "make", evidence: [], runbookProposal: {
      version: 1,
      install: { argv: ["make", "deps"], cwd: ".", timeoutSec: 60 },
      health: { argv: ["make", "health"], cwd: ".", timeoutSec: 60 },
      gates: [
        { id: "verify", argv: ["make", "verify"], cwd: ".", timeoutSec: 60, required: true },
        { id: "optional", argv: ["node", "-e", "process.exit(1)"], cwd: ".", timeoutSec: 30, required: false }
      ],
      ship: null, runtimeTools: ["make", "python3"], dependencyPaths: ["Makefile"], blockedPaths: [".env", "**/*.pem"]
    }});
  } else if (fs.existsSync("verify.mjs")) {
    finish({ status: "succeeded", summary: "node", evidence: [], runbookProposal: {
      version: 1, install: null,
      health: { argv: ["node", "verify.mjs"], cwd: ".", timeoutSec: 60 },
      gates: [{ id: "verify", argv: ["node", "verify.mjs"], cwd: ".", timeoutSec: 60, required: true }],
      ship: null, runtimeTools: ["node"], dependencyPaths: ["package.json"], blockedPaths: [".env", "**/*.pem"]
    }});
  } else {
    finish({ status: "needs_human", summary: "unknown", evidence: [], questions: ["How does this repository build?"] });
  }
  process.exit(0);
}
if (assignment.role === "planner") {
  finish({ status: "succeeded", summary: "planned", evidence: [], workItems: [
    { title: "First slice", body: "Ship the first slice", dependsOn: [] },
    { title: "Second slice", body: "Follows the first", dependsOn: ["First slice"] }
  ]});
  process.exit(0);
}
const body = assignment.workItem?.body ?? "";
fs.writeFileSync("echo-" + assignment.attempt + ".txt", JSON.stringify({ guidance: assignment.guidance, prompt: assignment.prompt }));
if (body.includes("WAIT") && assignment.attempt === 1) {
  const started = Date.now();
  while (!fs.existsSync("release") && Date.now() - started < 15000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  finish({ status: "failed", summary: "retry", evidence: [{ command: "wait", exitCode: 1, excerpt: "retry" }], questions: [] });
  process.exit(0);
}
if (body.includes("TOUCH_OAUTH")) {
  fs.mkdirSync("routes/oauth", { recursive: true });
  fs.writeFileSync("routes/oauth/token.ts", "export const token = 1;\\n");
}
if (body.includes("TOUCH_KEEP")) fs.writeFileSync("KEEP_OUT.txt", "nope\\n");
if (body.includes("CONFLICT")) fs.writeFileSync("README.md", "from-worker\\n");
else if (!body.includes("TOUCH_OAUTH") && !body.includes("TOUCH_KEEP")) fs.appendFileSync("CHANGELOG", "shipped\\n");
finish({ status: "succeeded", summary: "done", evidence: [{ command: "work", exitCode: 0, excerpt: "ok" }], questions: [] });
`;
