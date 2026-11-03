import { agentProcessEnvironment } from "./agent-process-env.js";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { createLogger } from "./logger.js";
import { getErrorMessage } from "./error-utils.js";

const execAsync = promisify(exec);
const log = createLogger("scaffold-expo-deps");

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Matches Expo SDK 53+ flat-config docs; `expo lint` expects `eslint-config-expo/flat` on disk. */
const DEFAULT_EXPO_FLAT_ESLINT_CONFIG = `const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", ".expo/*", "node_modules/"],
  },
]);
`;

async function hasFlatEslintConfigFile(repoPath: string): Promise<boolean> {
  for (const name of ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"] as const) {
    try {
      await fs.access(path.join(repoPath, name));
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

/**
 * Install ESLint + eslint-config-expo (Expo-pinned versions), add `lint` script, and write a
 * default flat eslint.config.js when none exists. Aligns new scaffolds with merge quality gates
 * (`npm run lint`) so the first agent does not have to wire ESLint by hand.
 */
export async function ensureExpoLintMergeGateTooling(repoPath: string): Promise<void> {
  log.info("Ensuring Expo ESLint tooling for merge quality gates", { repoPath });
  try {
    await execAsync("npx expo install eslint eslint-config-expo", {
      env: agentProcessEnvironment(),
      cwd: repoPath,
      timeout: 180_000,
    });
  } catch (err) {
    const msg = getErrorMessage(err, "expo install eslint eslint-config-expo failed");
    throw new Error(msg);
  }

  if (!(await hasFlatEslintConfigFile(repoPath))) {
    await fs.writeFile(
      path.join(repoPath, "eslint.config.js"),
      DEFAULT_EXPO_FLAT_ESLINT_CONFIG,
      "utf-8"
    );
  }

  const pkgPath = path.join(repoPath, "package.json");
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as PackageJson;
  } catch (err) {
    throw new Error(
      `package.json could not be read for lint script merge: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const scripts = { ...(pkg.scripts ?? {}) };
  if (!scripts.lint) {
    scripts.lint = "expo lint";
    pkg.scripts = scripts;
    await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  }
}

/**
 * Ensure @types/react and @types/react-dom are declared when the app depends on React.
 * Uses `expo install` so versions stay compatible with the Expo SDK.
 */
export async function ensureExpoReactTypeDevDependencies(repoPath: string): Promise<void> {
  const pkgPath = path.join(repoPath, "package.json");
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as PackageJson;
  } catch {
    return;
  }

  const hasReact = Boolean(pkg.dependencies?.react ?? pkg.devDependencies?.react);
  if (!hasReact) {
    return;
  }

  const dev = pkg.devDependencies ?? {};
  if (dev["@types/react"] && dev["@types/react-dom"]) {
    return;
  }

  log.info("Installing missing React TypeScript definitions for Expo scaffold", { repoPath });
  try {
    await execAsync("npx expo install @types/react @types/react-dom", {
      env: agentProcessEnvironment(),
      cwd: repoPath,
      timeout: 120_000,
    });
  } catch (err) {
    const msg = getErrorMessage(err, "expo install @types/react failed");
    throw new Error(msg);
  }
}
