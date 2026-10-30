import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const run = (args: string[], cwd = repo, env = process.env) =>
  spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30_000 });

describe("verification script subprocesses", () => {
  it("prints installed Vitest help through the frontend wrapper and maps Jest file filters", () => {
    for (const args of [["--help"], ["--testPathPattern=one|two", "--help"]]) {
      const result = run(["packages/frontend/scripts/run-vitest.mjs", ...args]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("vitest/");
    }
  });

  it("executes the affected CLI and imports verification modules without invoking them", () => {
    const result = run(["scripts/affected-workspaces.mjs", "--all", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).workspaces).toEqual([
      "shared",
      "backend",
      "frontend",
      "electron",
    ]);
    const urls = ["affected-workspaces", "run-affected-tests", "test-timings"].map(
      (name) => pathToFileURL(path.join(repo, `scripts/${name}.mjs`)).href
    );
    const imported = run([
      "--input-type=module",
      "-e",
      `await Promise.all(${JSON.stringify(urls)}.map((url) => import(url)))`,
    ]);
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toBe("");
  });

  it("passes --help through npm's JavaScript CLI from a checkout path with spaces", () => {
    const checkout = mkdtempSync(path.join(tmpdir(), "opensprint cli spaces "));
    try {
      mkdirSync(path.join(checkout, "scripts"));
      for (const name of ["node-cli", "affected-workspaces", "run-affected-tests"]) {
        cpSync(path.join(repo, `scripts/${name}.mjs`), path.join(checkout, `scripts/${name}.mjs`));
      }
      writeFileSync(
        path.join(checkout, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"] })
      );
      for (const name of ["shared", "backend", "frontend", "electron"]) {
        const dir = path.join(checkout, "packages", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ name: `fixture-${name}`, scripts: { test: "node help.mjs" } })
        );
        writeFileSync(
          path.join(dir, "help.mjs"),
          `if (process.argv[2] !== "--help") process.exit(2); console.log("${name}:--help");`
        );
      }
      const env = { ...process.env, OPENSPRINT_AFFECTED_ALL: "1" };
      // Force standalone Node fallback rather than inheriting npm_execpath.
      delete env.npm_execpath;
      const affected = run(["scripts/affected-workspaces.mjs", "--all", "--json"], checkout, env);
      expect(affected.status, affected.stderr).toBe(0);
      expect(JSON.parse(affected.stdout).workspaces).toHaveLength(4);
      const result = run(["scripts/run-affected-tests.mjs", "test", "--", "--help"], checkout, env);
      expect(result.status, result.stderr).toBe(0);
      for (const name of ["shared", "backend", "frontend", "electron"])
        expect(result.stdout).toContain(`${name}:--help`);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("reports an asynchronous timing-runner spawn failure and resolves", async () => {
    const moduleUrl = pathToFileURL(path.join(repo, "scripts/test-timings.mjs")).href;
    const code = `const { runTimedCommand } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await runTimedCommand(null, {id:"missing", command:["opensprint-deliberately-missing-executable"]})));`;
    const result = run(["--input-type=module", "-e", code]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      exitCode: 1,
      error: expect.stringContaining("ENOENT"),
    });
    expect(result.stderr).toContain("[test-timings]");
  });
});
