import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
let fixture: string;
let shallow: string;
let complete: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function select(cwd: string, mode: "github" | "explicit" | "local") {
  const env = { ...process.env };
  delete env.OPENSPRINT_AFFECTED_ALL;
  delete env.GITHUB_BASE_REF;
  delete env.GITHUB_EVENT_NAME;
  if (mode === "github") {
    env.GITHUB_BASE_REF = "main";
    env.GITHUB_EVENT_NAME = "pull_request";
  }
  return spawnSync(
    process.execPath,
    [
      "scripts/affected-workspaces.mjs",
      "--coverage-only",
      "--json",
      ...(mode === "explicit" ? ["--base", "origin/main"] : []),
    ],
    { cwd, env, encoding: "utf8", timeout: 15_000 }
  );
}

beforeAll(() => {
  fixture = mkdtempSync(path.join(tmpdir(), "opensprint-affected-history-"));
  const source = path.join(fixture, "source repo");
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  for (const name of ["affected-workspaces.mjs", "node-cli.mjs"])
    cpSync(path.join(repo, "scripts", name), path.join(source, "scripts", name));
  mkdirSync(path.join(source, "packages/frontend"), { recursive: true });
  writeFileSync(path.join(source, "packages/frontend/change.txt"), "base");
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Open Sprint Test");
  git(source, "config", "user.email", "test@opensprint.dev");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  git(source, "checkout", "-b", "feature");
  writeFileSync(path.join(source, "packages/frontend/change.txt"), "feature");
  git(source, "commit", "-am", "frontend change");
  git(source, "checkout", "main");
  writeFileSync(path.join(source, "base-only.txt"), "main advanced");
  git(source, "add", ".");
  git(source, "commit", "-m", "advance main");

  shallow = path.join(fixture, "shallow checkout");
  complete = path.join(fixture, "complete checkout");
  const sourceUrl = pathToFileURL(source).href;
  git(fixture, "clone", "--depth=1", "--branch", "feature", sourceUrl, shallow);
  git(shallow, "fetch", "--depth=1", "origin", "main:refs/remotes/origin/main");
  git(fixture, "clone", "--branch", "feature", sourceUrl, complete);
}, 30_000);

afterAll(() => {
  if (
    fixture &&
    path.dirname(path.resolve(fixture)) === path.resolve(tmpdir()) &&
    path.basename(fixture).startsWith("opensprint-affected-history-")
  ) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("affected workspace CLI with real Git history", () => {
  it("runs every workspace when existing shallow refs have no visible merge base", () => {
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(spawnSync("git", ["merge-base", "origin/main", "HEAD"], { cwd: shallow }).status).toBe(
      1
    );
    for (const mode of ["github", "explicit", "local"] as const) {
      const result = select(shallow, mode);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        reason: "no-base-ref",
        baseRef: null,
        workspaces: ["shared", "backend", "frontend", "electron"],
      });
    }
  });

  it("selects only changed workspaces when the comparison history is complete", () => {
    const result = select(complete, "github");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reason: "git-diff",
      changedFiles: ["packages/frontend/change.txt"],
      workspaces: ["frontend"],
    });
  });
});
