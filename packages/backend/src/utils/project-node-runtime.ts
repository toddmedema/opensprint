import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { satisfies, valid, validRange } from "semver";

function projectNodeEngine(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (typeof manifest.engines?.node === "string") return manifest.engines.node;
    } catch {
      // Missing/invalid manifests are reported by the command's own prechecks.
    }
    const parent = path.dirname(dir);
    if (parent === dir || fs.existsSync(path.join(dir, ".git"))) return null;
    dir = parent;
  }
}

function childDirectories(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function installedNodeBins(env: NodeJS.ProcessEnv): string[] {
  const homeDir = os.homedir();
  const nvmDir = env.NVM_DIR || path.join(homeDir, ".nvm");
  const nvmVersions = path.join(nvmDir, "versions", "node");
  const bins = childDirectories(nvmVersions).map((version) =>
    path.join(nvmVersions, version, "bin")
  );
  if (env.NVM_HOME) {
    bins.push(
      ...childDirectories(env.NVM_HOME).map((version) => path.join(env.NVM_HOME!, version))
    );
  }
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    bins.push(
      ...childDirectories(prefix)
        .filter((name) => /^node(?:@\d+)?$/.test(name))
        .map((name) => path.join(prefix, name, "bin"))
    );
  }
  return bins;
}

function nodeVersion(bin: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const executable = path.join(bin, process.platform === "win32" ? "node.exe" : "node");
  try {
    fs.accessSync(executable);
    const version = execFileSync(executable, ["--version"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!valid(version)) return null;
    return version;
  } catch {
    return null;
  }
}

/** Pin project tools and their children to an installed Node satisfying engines.node. */
export function projectNodeEnvironment(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  // Absolute executables and unrelated tools retain their caller-selected runtime.
  if (!["node", "npm", "npx"].includes(command)) return env;
  const engine = projectNodeEngine(cwd);
  if (!engine) return env;
  if (!validRange(engine)) throw new Error(`EBADENGINE: invalid engines.node range: ${engine}`);

  const pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathEntries,
    // Electron's executable is not an external Node installation.
    ...(!process.versions.electron ? [path.dirname(process.execPath)] : []),
    ...installedNodeBins(env),
  ];
  for (const bin of new Set(candidates)) {
    const version = nodeVersion(bin, cwd, env);
    if (!version || !satisfies(version, engine)) continue;
    return {
      ...env,
      PATH: [bin, ...pathEntries.filter((entry) => entry !== bin)].join(path.delimiter),
    };
  }
  throw new Error(
    `EBADENGINE: no installed Node.js satisfies engines.node "${engine}" in ${cwd}. ` +
      "Install a compatible Node.js version and make it available on PATH, in NVM, or in Homebrew."
  );
}
