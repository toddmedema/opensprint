import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCommandExecutable, runCommand } from "../utils/command-runner.js";

describe.skipIf(process.platform === "win32")("project Node runtime", () => {
  let root: string;
  let repo: string;
  let compatibleBin: string;
  let incompatibleBin: string;
  let env: NodeJS.ProcessEnv;
  const major = Number(process.versions.node.split(".")[0]);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "project-node-runtime-"));
    repo = path.join(root, "repo");
    compatibleBin = path.join(root, ".nvm", "versions", "node", `v${process.versions.node}`, "bin");
    incompatibleBin = path.join(root, ".nvm", "versions", "node", `v${major + 2}.0.0`, "bin");
    await Promise.all(
      [repo, compatibleBin, incompatibleBin].map((dir) => fs.mkdir(dir, { recursive: true }))
    );
    await fs.writeFile(path.join(repo, ".git"), "gitdir: unused-test-worktree");
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ engines: { node: `${major}.x` } })
    );
    await fs.symlink(process.execPath, path.join(compatibleBin, "node"));
    await fs.writeFile(
      path.join(incompatibleBin, "node"),
      `#!/bin/sh\nprintf 'v${major + 2}.0.0\\n'\n`,
      { mode: 0o755 }
    );
    env = { PATH: [incompatibleBin, compatibleBin, "/usr/bin", "/bin"].join(path.delimiter) };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("honors engines.node even when PATH normalization prefers a newer NVM runtime", async () => {
    const result = await runCommand({ command: "node", args: ["--version"] }, { cwd: repo, env });
    expect(result.stdout.trim()).toBe(process.version);
    expect(result.executable).toBe(path.join(compatibleBin, "node"));
  });

  it("keeps npm's shebang and nested node commands on the selected runtime", async () => {
    await fs.writeFile(
      path.join(compatibleBin, "npm"),
      '#!/usr/bin/env node\nconst { execFileSync } = require("node:child_process"); process.stdout.write(JSON.stringify({ version: process.version, child: execFileSync("node", ["--version"], { encoding: "utf8" }).trim() }));\n',
      { mode: 0o755 }
    );
    const result = await runCommand({ command: "npm", args: ["run", "test"] }, { cwd: repo, env });
    expect(JSON.parse(result.stdout)).toEqual({ version: process.version, child: process.version });
    expect(result.executable).toBe(path.join(compatibleBin, "npm"));
  });

  it("inherits the root engine requirement from a workspace package", async () => {
    const workspace = path.join(repo, "packages", "backend");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "backend" }));
    const result = await runCommand(
      { command: "node", args: ["--version"] },
      { cwd: workspace, env }
    );
    expect(result.stdout.trim()).toBe(process.version);
  });

  it("uses the same runtime when resolving the executable for merge-gate prechecks", () => {
    expect(resolveCommandExecutable("node", env, repo)).toBe(path.join(compatibleBin, "node"));
  });

  it("supports semver engine ranges and preserves an already compatible PATH runtime", async () => {
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ engines: { node: `>=${major} <${major + 3}` } })
    );
    const result = await runCommand({ command: "node", args: ["--version"] }, { cwd: repo, env });
    expect(result.stdout.trim()).toBe(`v${major + 2}.0.0`);
    expect(result.executable).toBe(path.join(incompatibleBin, "node"));
  });

  it("discovers a compatible NVM installation omitted from a GUI application's PATH", async () => {
    const nvmDir = path.join(root, "custom-nvm");
    const bin = path.join(nvmDir, "versions", "node", "v0.1.2", "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "node"), "#!/bin/sh\nprintf 'v0.1.2\\n'\n", { mode: 0o755 });
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ engines: { node: "0.1.x" } })
    );
    const result = await runCommand(
      { command: "node", args: ["--version"] },
      { cwd: repo, env: { ...env, NVM_DIR: nvmDir } }
    );
    expect(result.stdout.trim()).toBe("v0.1.2");
    expect(result.executable).toBe(path.join(bin, "node"));
  });

  it("reports a missing compatible runtime instead of running gates with an incompatible Node", async () => {
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ engines: { node: "0.0.0" } })
    );
    await expect(runCommand({ command: "node" }, { cwd: repo, env })).rejects.toThrow(
      'EBADENGINE: no installed Node.js satisfies engines.node "0.0.0"'
    );
  });

  it("reports an invalid engine range", async () => {
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ engines: { node: "invalid" } })
    );
    await expect(runCommand({ command: "node" }, { cwd: repo, env })).rejects.toThrow(
      "EBADENGINE: invalid engines.node range: invalid"
    );
  });

  it("preserves runtime selection for a project without engines.node", async () => {
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "unconstrained" }));
    const result = await runCommand({ command: "node", args: ["--version"] }, { cwd: repo, env });
    expect(result.executable).toBe(path.join(incompatibleBin, "node"));
  });

  it("does not inherit an engine requirement from outside the repository", async () => {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ engines: { node: "0.0.0" } })
    );
    await fs.writeFile(path.join(repo, "package.json"), "{}");
    const result = await runCommand({ command: "node", args: ["--version"] }, { cwd: repo, env });
    expect(result.executable).toBe(path.join(incompatibleBin, "node"));
  });

  it("leaves explicit executables on the caller-selected runtime", async () => {
    const result = await runCommand(
      { command: path.join(incompatibleBin, "node"), args: ["--version"] },
      { cwd: repo, env }
    );
    expect(result.stdout.trim()).toBe(`v${major + 2}.0.0`);
  });

  it("strips governance approval credentials from runtime probes and project commands", async () => {
    const executable = path.join(compatibleBin, "node");
    await fs.unlink(executable);
    const quotedNode = `'${process.execPath.replace(/'/g, "'\\''")}'`;
    await fs.writeFile(
      executable,
      `#!/bin/sh\nif [ -n "\${OPENSPRINT_GOVERNANCE_APPROVAL_TOKEN:-}" ]; then exit 1; fi\nexec ${quotedNode} "$@"\n`,
      { mode: 0o755 }
    );
    const restrictedEnv = { ...env, OPENSPRINT_GOVERNANCE_APPROVAL_TOKEN: "test-only" };
    expect(resolveCommandExecutable("node", restrictedEnv, repo)).toBe(executable);
    const result = await runCommand(
      { command: "node", args: ["--version"] },
      { cwd: repo, env: restrictedEnv }
    );
    expect(result.executable).toBe(executable);
    expect(result.stdout.trim()).toBe(process.version);
  });

  it("probes version-manager shims from the project's working directory", async () => {
    const executable = path.join(compatibleBin, "node");
    await fs.unlink(executable);
    await fs.writeFile(
      executable,
      '#!/bin/sh\nIFS= read -r version < .runtime-version || exit 1\nprintf "%s\\n" "$version"\n',
      { mode: 0o755 }
    );
    // A shim can resolve a different runtime when its cwd changes. Do not cache
    // its version based only on the shim file's path or modification time.
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, ".git"), "gitdir: unused");
    await fs.writeFile(
      path.join(outside, "package.json"),
      JSON.stringify({ engines: { node: `${major + 2}.x` } })
    );
    await fs.writeFile(path.join(outside, ".runtime-version"), `v${major + 2}.0.0\n`);
    await fs.writeFile(path.join(repo, ".runtime-version"), `${process.version}\n`);
    const shimEnv = { PATH: [compatibleBin, "/usr/bin", "/bin"].join(path.delimiter) };
    expect(resolveCommandExecutable("node", shimEnv, outside)).toBe(executable);
    expect(resolveCommandExecutable("node", shimEnv, repo)).toBe(executable);
  });
});
