import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../utils/git-command.js";
import { runCommand } from "../utils/command-runner.js";
import { publishPlanPullRequest } from "../services/plan-pull-request.service.js";

vi.mock("../utils/git-command.js", () => ({ runGit: vi.fn() }));
vi.mock("../utils/command-runner.js", () => ({ runCommand: vi.fn() }));

const input = {
  repoPath: "/tmp/repo",
  branchName: "opensprint/epic_os-abc",
  baseBranch: "master",
  title: "Plan",
  taskIds: ["os-abc.1"],
};
const url = "https://github.com/test/repo/pull/1";
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runGit).mockResolvedValue({ stdout: "git@github.com:test/repo.git\n", stderr: "" });
  vi.mocked(runCommand).mockImplementation(async (spec) => ({
    stdout: spec.args?.[1] === "list" ? "[]" : spec.args?.[1] === "create" ? url : "{}",
    stderr: "",
    executable: "gh",
    cwd: input.repoPath,
    exitCode: 0,
    signal: null,
  }));
});

describe("plan PR publication", () => {
  it("pushes only the plan branch and creates a PR targeting the configured base", async () => {
    await expect(publishPlanPullRequest(input)).resolves.toBe(url);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      { command: "gh", args: ["repo", "view", "test/repo", "--json", "nameWithOwner"] },
      expect.any(Object)
    );
    expect(runGit).toHaveBeenCalledWith(
      ["push", "origin", "refs/heads/opensprint/epic_os-abc:refs/heads/opensprint/epic_os-abc"],
      expect.any(Object)
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "gh",
        args: expect.arrayContaining(["create", "--base", "master", "--repo", "test/repo"]),
      }),
      expect.any(Object)
    );
    expect(vi.mocked(runGit).mock.calls.map(([args]) => args[0])).toEqual(["remote", "push"]);
  });
  it("reuses an existing PR on retry", async () => {
    vi.mocked(runCommand).mockResolvedValue({
      stdout: JSON.stringify([{ url }]),
      stderr: "",
      executable: "gh",
      cwd: input.repoPath,
      exitCode: 0,
      signal: null,
    });
    await expect(publishPlanPullRequest(input)).resolves.toBe(url);
    expect(vi.mocked(runCommand).mock.calls.some(([spec]) => spec.args?.includes("create"))).toBe(
      false
    );
  });
  it("fails before pushing when GitHub sign-in fails", async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error("Run gh auth login"));
    await expect(publishPlanPullRequest(input)).rejects.toThrow("gh auth login");
    expect(runGit).toHaveBeenCalledTimes(1);
  });
  it("requires GitHub origin and never publishes the base branch", async () => {
    await expect(publishPlanPullRequest({ ...input, branchName: "master" })).rejects.toThrow(
      "base branch"
    );
    vi.mocked(runGit).mockResolvedValue({
      stdout: "https://example.com/test/repo.git",
      stderr: "",
    });
    await expect(publishPlanPullRequest(input)).rejects.toThrow("GitHub origin");
    expect(runCommand).not.toHaveBeenCalled();
  });
});
