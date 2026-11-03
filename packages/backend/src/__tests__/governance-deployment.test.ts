import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectSettings } from "@opensprint/shared";
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  active: vi.fn(),
  published: vi.fn(),
  lease: vi.fn(),
  lock: vi.fn(),
  update: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../services/governance.service.js", () => ({
  governanceService: {
    isGovernanceInactive: async () =>
      (await mocks.config()).mode === "disabled" && !(await mocks.active()),
    withPublicationLock: mocks.lock,
  },
}));
vi.mock("../services/remote-publication-governance.service.js", () => ({
  remotePublicationGovernanceService: { getDeployableHead: mocks.published },
}));
vi.mock("../services/deploy-storage.service.js", () => ({
  deployStorageService: { updateRecord: mocks.update, appendLog: mocks.log },
}));
vi.mock("../services/orchestrator.service.js", () => ({ orchestratorService: {} }));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));
vi.mock("../services/deploy-fix-epic.service.js", () => ({ createFixEpicFromTestOutput: vi.fn() }));
import { withGovernedDeployment } from "../services/governance-deployment.service.js";
import { runDeployAsync } from "../routes/deliver.js";
const exec = promisify(execFile);
let repo: string, head: string;
const settings = {
  worktreeBaseBranch: "main",
  deployment: { mode: "custom", customCommand: "true" },
} as ProjectSettings;
beforeEach(async () => {
  vi.clearAllMocks();
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "governed-deploy-"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "QA"],
    ["config", "user.email", "qa@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await fs.writeFile(path.join(repo, "source.txt"), "reviewed");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "reviewed"], { cwd: repo });
  head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  mocks.config.mockResolvedValue({ mode: "enforced" });
  mocks.active.mockResolvedValue("release");
  mocks.published.mockResolvedValue(head);
  mocks.lease.mockResolvedValue(undefined);
  mocks.lock.mockImplementation(async (_project, run) => run(mocks.lease));
  mocks.update.mockResolvedValue(undefined);
  mocks.log.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(repo, { recursive: true, force: true });
});
describe("governed delivery publication authority", () => {
  it("blocks manual deployment while the remote candidate is awaiting review", async () => {
    mocks.published.mockResolvedValue(null);
    const external = vi.fn();
    await expect(withGovernedDeployment("p", repo, settings, external)).rejects.toMatchObject({
      code: "GOVERNANCE_DEPLOYMENT_HOLD",
    });
    expect(external).not.toHaveBeenCalled();
    expect(mocks.lock).toHaveBeenCalledOnce();
  });
  it("records a failed manual delivery without running its command for an unreviewed candidate", async () => {
    mocks.published.mockResolvedValue(null);
    await runDeployAsync("p", "manual-deploy", repo, {
      ...settings,
      deployment: { mode: "custom", customCommand: "touch published-without-review" },
    } as ProjectSettings);
    expect(
      await fs.access(path.join(repo, "published-without-review")).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(mocks.update).toHaveBeenCalledWith(
      "p",
      "manual-deploy",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("exact reviewed"),
      })
    );
  });
  it("rechecks working-tree changes and its lease immediately before external publication", async () => {
    const external = vi.fn();
    await expect(
      withGovernedDeployment("p", repo, settings, async (admit) => {
        await fs.writeFile(path.join(repo, "source.txt"), "changed during pre-deploy checks");
        await admit();
        external();
      })
    ).rejects.toMatchObject({ code: "GOVERNANCE_DEPLOYMENT_HOLD" });
    expect(external).not.toHaveBeenCalled();
    await fs.writeFile(path.join(repo, "source.txt"), "reviewed");
    await expect(
      withGovernedDeployment("p", repo, settings, async (admit) => {
        mocks.lease.mockRejectedValueOnce(new Error("publication lease lost"));
        await admit();
        external();
      })
    ).rejects.toThrow("publication lease lost");
    expect(external).not.toHaveBeenCalled();
  });
  it("requires a valid exact-head claim for a durable auto-deployment", async () => {
    const external = vi.fn();
    await expect(
      withGovernedDeployment("p", repo, settings, external, { claimedJob: true })
    ).rejects.toThrow("exact published revision");
    await expect(
      withGovernedDeployment("p", repo, settings, external, {
        claimedJob: true,
        expectedCommitHash: "b".repeat(40),
      })
    ).rejects.toMatchObject({ code: "GOVERNANCE_DEPLOYMENT_HOLD" });
    expect(external).not.toHaveBeenCalled();
  });
  it("runs a claimed auto-deployment without holding the publication lock", async () => {
    let locksHeld = 0;
    mocks.lock.mockImplementation(async (_project, run) => {
      locksHeld++;
      try {
        return await run(mocks.lease);
      } finally {
        locksHeld--;
      }
    });
    const heldDuringDeploy: number[] = [];
    await withGovernedDeployment(
      "p",
      repo,
      settings,
      async (admit) => {
        heldDuringDeploy.push(locksHeld);
        await admit();
        heldDuringDeploy.push(locksHeld);
      },
      { claimedJob: true, expectedCommitHash: head }
    );
    expect(heldDuringDeploy).toEqual([0, 0]);
    expect(mocks.lock).toHaveBeenCalledTimes(2);
  });
  it("preserves legacy delivery when governance has never been enabled", async () => {
    mocks.config.mockResolvedValue({ mode: "disabled" });
    mocks.active.mockResolvedValue(null);
    const external = vi.fn().mockResolvedValue("deployed");
    expect(await withGovernedDeployment("p", repo, settings, external)).toBe("deployed");
    expect(mocks.published).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it("strips server approval authority even when deployment env overrides try to restore it", async () => {
    mocks.config.mockResolvedValue({ mode: "disabled" });
    mocks.active.mockResolvedValue(null);
    vi.stubEnv("OPENSPRINT_GOVERNANCE_APPROVAL_SECRET", "server-private-capability");
    vi.stubEnv("OPENSPRINT_GOVERNANCE_OWNER", "Server Owner");
    await runDeployAsync("p", "deploy", repo, {
      ...settings,
      deployment: {
        mode: "custom",
        customCommand:
          'printf "CAP:%s|OWNER:%s" "$OPENSPRINT_GOVERNANCE_APPROVAL_SECRET" "$OPENSPRINT_GOVERNANCE_OWNER"',
        envVars: {
          OPENSPRINT_GOVERNANCE_APPROVAL_SECRET: "override-capability",
          OPENSPRINT_GOVERNANCE_OWNER: "Override Owner",
        },
      },
    } as ProjectSettings);
    expect(mocks.log.mock.calls.map((call) => call[2]).join("")).toContain("CAP:|OWNER:");
    expect(mocks.update).toHaveBeenCalledWith(
      "p",
      "deploy",
      expect.objectContaining({ status: "success" })
    );
  });
});
