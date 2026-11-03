import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../utils/command-runner.js";
import { shellExec } from "../utils/shell-exec.js";
import { TestRunner } from "../services/test-runner.js";
import { DeploymentService } from "../services/deployment-service.js";
import { AgentClient } from "../services/agent-client.js";

const fixture = vi.hoisted(() => ({ repoPath: "", command: "" }));
vi.mock("../services/project.service.js", () => ({
  ProjectService: class {
    getProject() {
      return Promise.resolve({ repoPath: fixture.repoPath, name: "Probe" });
    }
    getSettings() {
      return Promise.resolve({ deployment: { mode: "custom", customCommand: fixture.command } });
    }
  },
}));

const approvalNames = [
  "OPENSPRINT_GOVERNANCE_APPROVAL_SECRET",
  "OPENSPRINT_GOVERNANCE_OWNER",
  "OPENSPRINT_GOVERNANCE_APPROVAL_TOKEN",
  "OPENSPRINT_GOVERNANCE_OWNER_TOKEN",
  "OPENSPRINT_GOVERNANCE_REVIEWERS_JSON",
  "OPENSPRINT_GOVERNANCE_CAPABILITY",
  "opensprint_governance_approval_lowercase",
];
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const expected = { capabilities: [], unrelated: "preserved", mode: "enforced" };

describe("repository subprocess authority isolation", () => {
  let repoPath: string;
  let script: string;
  let command: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-repo-env-"));
    script = path.join(repoPath, "probe.cjs");
    await fs.writeFile(
      script,
      `
const fs = require('node:fs');
const result = {
  capabilities: Object.keys(process.env).filter(key => /^OPENSPRINT_GOVERNANCE_(APPROVAL|OWNER|REVIEWERS|CAPABILITY)/i.test(key)),
  unrelated: process.env.OPENSPRINT_SUBPROCESS_UNRELATED,
  mode: process.env.OPENSPRINT_GOVERNANCE_MODE,
};
fs.writeFileSync('probe-output.json', JSON.stringify(result));
process.stdout.write(JSON.stringify(result));
`
    );
    command = `${quote(process.execPath)} ${quote(script)}`;
    fixture.repoPath = repoPath;
    fixture.command = command;
    for (const name of approvalNames) vi.stubEnv(name, "fake-secret-must-not-reach-child");
    vi.stubEnv("OPENSPRINT_SUBPROCESS_UNRELATED", "preserved");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_MODE", "enforced");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(repoPath, { force: true, recursive: true });
  });

  it("strips inherited and explicitly re-added capabilities after command env merging", async () => {
    const env = Object.fromEntries(approvalNames.map((name) => [name, "override-secret"]));
    const result = await runCommand(
      { command: process.execPath, args: [script] },
      { cwd: repoPath, env }
    );
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(process.env.OPENSPRINT_GOVERNANCE_APPROVAL_TOKEN).toBe(
      "fake-secret-must-not-reach-child"
    );
  });

  it("strips capabilities from shell commands with default and caller supplied environments", async () => {
    for (const options of [
      { cwd: repoPath },
      { cwd: repoPath, env: { ...process.env, OPENSPRINT_GOVERNANCE_OWNER_TOKEN: "re-added" } },
    ]) {
      const result = await shellExec(command, options);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    }
  });

  it("isolates the dedicated test process group", async () => {
    const result = await new TestRunner().runTestsWithOutput(repoPath, command);
    expect(JSON.parse(result.rawOutput)).toEqual(expected);
  });

  it("isolates direct deployment commands without invoking any network service", async () => {
    expect(await new DeploymentService().deploy("probe")).toMatchObject({ success: true });
    expect(JSON.parse(await fs.readFile(path.join(repoPath, "probe-output.json"), "utf8"))).toEqual(
      expected
    );
  });

  it("isolates a custom agent CLI's direct execFile path", async () => {
    const result = await new AgentClient().invoke({
      config: { type: "custom", model: null, cliCommand: command },
      prompt: "local probe",
      cwd: repoPath,
    });
    expect(JSON.parse(result.content)).toEqual(expected);
  });
});
