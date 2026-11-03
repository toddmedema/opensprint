import { agentProcessEnvironment } from "./agent-process-env.js";
/**
 * Pre-deploy validation for Expo/EAS: identifies missing auth (login or API key)
 * and returns explicit, actionable prompts for the user.
 */

import { getGlobalSettings } from "../services/global-settings.service.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type ExpoAuthMissing = "login" | "api_key" | "both";

export interface ExpoAuthCheckResult {
  ok: true;
  /** Effective EXPO_TOKEN to use (from env or global settings) */
  expoToken?: string;
}

export interface ExpoAuthCheckFailure {
  ok: false;
  /** What is missing */
  missing: ExpoAuthMissing;
  /** Short error code for API responses */
  code: "EXPO_LOGIN_REQUIRED" | "EXPO_TOKEN_REQUIRED" | "EXPO_AUTH_REQUIRED";
  /** User-facing message */
  message: string;
  /** Detailed guidance on how to obtain and provide the missing info */
  prompt: string;
}

export type ExpoAuthCheck = ExpoAuthCheckResult | ExpoAuthCheckFailure;

export type CheckExpoAuthOptions = {
  /** Expo access token from this project's delivery settings (after EXPO_TOKEN env). */
  projectExpoToken?: string;
};

/** URL for creating Expo access tokens */
export const EXPO_ACCESS_TOKEN_URL = "https://expo.dev/settings/access-tokens";

/**
 * Check if Expo deployment can proceed (auth present).
 * Checks: EXPO_TOKEN env, project delivery expoToken, legacy global-settings expoToken, or eas whoami.
 * Returns explicit prompts when something is missing.
 */
export async function checkExpoAuth(
  repoPath: string,
  options?: CheckExpoAuthOptions
): Promise<ExpoAuthCheck> {
  const fromEnv = process.env.EXPO_TOKEN;
  if (fromEnv && typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return { ok: true, expoToken: fromEnv.trim() };
  }

  const fromProject = options?.projectExpoToken;
  if (fromProject && typeof fromProject === "string" && fromProject.trim().length > 0) {
    return { ok: true, expoToken: fromProject.trim() };
  }

  const settings = await getGlobalSettings();
  const fromSettings = settings.expoToken;
  if (fromSettings && typeof fromSettings === "string" && fromSettings.trim().length > 0) {
    return { ok: true, expoToken: fromSettings.trim() };
  }

  // No token in env or settings. Check if user has run `eas login` (interactive session).
  try {
    const { stdout } = await execAsync("npx eas-cli whoami", {
      cwd: repoPath,
      timeout: 10000,
      env: agentProcessEnvironment({ ...process.env }),
    });
    if (stdout?.trim()) {
      return { ok: true };
    }
  } catch {
    // eas whoami failed — not logged in
  }

  // Not authenticated. Provide explicit prompts.
  return {
    ok: false,
    missing: "api_key",
    code: "EXPO_TOKEN_REQUIRED",
    message:
      "Expo deployment requires authentication. Provide an Expo access token (EXPO_TOKEN) to deploy.",
    prompt: [
      "Expo deployment requires authentication. You need to provide an Expo access token.",
      "",
      "How to obtain:",
      `  1. Go to ${EXPO_ACCESS_TOKEN_URL}`,
      "  2. Sign in to your Expo account",
      "  3. Create a new Personal Access Token",
      "",
      "How to provide:",
      "  • Add the token in Project settings → Delivery → Expo access token (Expo delivery mode), or",
      "  • Set the EXPO_TOKEN environment variable when running Open Sprint",
      "",
      "Alternatively, run `npx eas login` in your project directory to authenticate interactively (session stored locally).",
    ].join("\n"),
  };
}
