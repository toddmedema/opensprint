/**
 * Expo installation detection and auto-install for first-time deploy.
 * Detects if Expo/EAS CLI is available; if not, installs before deploy.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { join } from "path";

const execAsync = promisify(exec);

export interface ExpoInstallResult {
  installed: boolean;
  error?: string;
}

/**
 * Check if Expo is installed in the project (expo package in package.json)
 * or if eas-cli is available (npx eas-cli --version succeeds).
 */
export async function isExpoInstalled(repoPath: string): Promise<boolean> {
  try {
    // Check package.json for expo or eas-cli
    const pkgPath = join(repoPath, "package.json");
    const pkgContent = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["expo"] || deps["eas-cli"]) {
      return true;
    }

    // Check if eas-cli runs (npx will fetch if needed, but project may lack expo)
    const { stdout } = await execAsync("npx eas-cli --version", {
      cwd: repoPath,
      timeout: 15000,
      env: { ...process.env },
    });
    return !!stdout?.trim();
  } catch {
    return false;
  }
}

/**
 * Install Expo when not present. Uses npm install expo (most reliable when expo
 * is not yet installed; npx expo requires expo to already exist).
 * Ensures install completes before proceeding.
 */
export async function installExpo(repoPath: string): Promise<ExpoInstallResult> {
  try {
    const { stdout, stderr } = await execAsync("npm install expo --save", {
      cwd: repoPath,
      timeout: 120000, // 2 min
      env: { ...process.env },
    });
    const out = (stdout || "") + (stderr || "");
    if (out.toLowerCase().includes("error") && !out.toLowerCase().includes("0 error")) {
      return { installed: false, error: out || "Expo install reported errors" };
    }
    return { installed: true };
  } catch (error: unknown) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const msg = err.stderr || err.stdout || err.message || String(error);
    return {
      installed: false,
      error: `Expo installation failed: ${msg}`,
    };
  }
}

/**
 * Ensure Expo is installed before deploy. If missing, install it.
 * Returns error message on failure for clear user feedback.
 * @param repoPath — Project root
 * @param emit — Optional callback to stream status messages (e.g. "Installing Expo...")
 */
export async function ensureExpoInstalled(
  repoPath: string,
  emit?: (chunk: string) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await isExpoInstalled(repoPath)) {
    return { ok: true };
  }

  emit?.("Expo not found. Installing Expo (this may take a minute)...\n");
  const result = await installExpo(repoPath);
  if (result.installed) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      result.error ??
      "Expo installation failed. Please install Expo manually (e.g. npx expo install expo) and try again.",
  };
}
