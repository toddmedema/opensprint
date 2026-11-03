import type { AgentProviderValue } from "./agentProviders";

/** Local CLI tooling checked via GET /env/keys (Cursor, Claude). */
export type AgentCliCheckKind = "cursor" | "claude" | "codex";

const KEYS_FIELD: Record<AgentCliCheckKind, "cursorCli" | "claudeCli" | "codexCli"> = {
  cursor: "cursorCli",
  claude: "claudeCli",
  codex: "codexCli",
};

export type EnvKeysCliSlice = {
  cursorCli: boolean;
  claudeCli: boolean;
  codexCli?: boolean;
};

export type OnboardingCliRequirement = {
  kind: AgentCliCheckKind;
  /**
   * Cursor runs tasks via the `agent` CLI — block Continue until it is installed.
   * Claude onboarding uses the Anthropic API by default; the local `claude` CLI is optional
   * (needed only if you switch agents to Claude CLI later), so we only warn, not block.
   */
  blockContinueWhenMissing: boolean;
};

/**
 * Which onboarding provider should trigger a local CLI check once the user has entered a key.
 */
export function getOnboardingAgentCliRequirement(
  provider: AgentProviderValue
): OnboardingCliRequirement | null {
  if (provider === "cursor") return { kind: "cursor", blockContinueWhenMissing: true };
  if (provider === "codex") return { kind: "codex", blockContinueWhenMissing: true };
  if (provider === "claude-cli") return { kind: "claude", blockContinueWhenMissing: true };
  if (provider === "claude") return { kind: "claude", blockContinueWhenMissing: false };
  return null;
}

export function getKeysFieldForCliKind(kind: AgentCliCheckKind): keyof EnvKeysCliSlice {
  return KEYS_FIELD[kind];
}

export function isCliInstalledForKind(keys: EnvKeysCliSlice, kind: AgentCliCheckKind): boolean {
  return Boolean(keys[getKeysFieldForCliKind(kind)]);
}
