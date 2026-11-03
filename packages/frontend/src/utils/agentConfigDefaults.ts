import type { AgentConfig, AgentType, ApiKeyProvider } from "@opensprint/shared";
import { DEFAULT_LMSTUDIO_BASE_URL, DEFAULT_OLLAMA_BASE_URL } from "../lib/localModelProviders";

export interface EnvKeysForDefaults {
  anthropic: boolean;
  cursor: boolean;
  openai: boolean;
  google?: boolean;
  claudeCli?: boolean;
  codexCli?: boolean;
}

export type ApiKeyBackedProvider = "claude" | "cursor" | "openai" | "google";
export type ApiKeyInputKey = "anthropic" | "cursor" | "openai" | "google";

export interface ApiKeyRequirement {
  agentType: ApiKeyBackedProvider;
  availabilityKey: ApiKeyInputKey;
  envKey: ApiKeyProvider;
  label: string;
  placeholder: string;
  helpUrl: string;
  helpLabel: string;
}

const API_KEY_REQUIREMENTS_BY_PROVIDER: Record<ApiKeyBackedProvider, ApiKeyRequirement> = {
  claude: {
    agentType: "claude",
    availabilityKey: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    label: "ANTHROPIC_API_KEY (Claude API)",
    placeholder: "sk-ant-...",
    helpUrl: "https://console.anthropic.com/",
    helpLabel: "Anthropic Console",
  },
  cursor: {
    agentType: "cursor",
    availabilityKey: "cursor",
    envKey: "CURSOR_API_KEY",
    label: "CURSOR_API_KEY",
    placeholder: "key_...",
    helpUrl: "https://cursor.com/settings",
    helpLabel: "Cursor → Integrations → User API Keys",
  },
  openai: {
    agentType: "openai",
    availabilityKey: "openai",
    envKey: "OPENAI_API_KEY",
    label: "OPENAI_API_KEY (OpenAI API)",
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
    helpLabel: "OpenAI Platform",
  },
  google: {
    agentType: "google",
    availabilityKey: "google",
    envKey: "GOOGLE_API_KEY",
    label: "GOOGLE_API_KEY (Google/Gemini API)",
    placeholder: "AIza...",
    helpUrl: "https://aistudio.google.com/app/apikey",
    helpLabel: "Google AI Studio",
  },
};

const API_KEY_REQUIREMENTS_BY_ENV_KEY: Record<ApiKeyProvider, ApiKeyRequirement> = {
  ANTHROPIC_API_KEY: API_KEY_REQUIREMENTS_BY_PROVIDER.claude,
  CURSOR_API_KEY: API_KEY_REQUIREMENTS_BY_PROVIDER.cursor,
  OPENAI_API_KEY: API_KEY_REQUIREMENTS_BY_PROVIDER.openai,
  GOOGLE_API_KEY: API_KEY_REQUIREMENTS_BY_PROVIDER.google,
};

export function isApiKeyBackedProvider(provider: string): provider is ApiKeyBackedProvider {
  return provider in API_KEY_REQUIREMENTS_BY_PROVIDER;
}

export function getApiKeyRequirementForProvider(provider: ApiKeyBackedProvider): ApiKeyRequirement {
  return API_KEY_REQUIREMENTS_BY_PROVIDER[provider];
}

export function getApiKeyRequirementForEnvKey(envKey: ApiKeyProvider): ApiKeyRequirement {
  return API_KEY_REQUIREMENTS_BY_ENV_KEY[envKey];
}

export function getApiKeyRequirementForAgentType(agentType: AgentType): ApiKeyRequirement | null {
  switch (agentType) {
    case "claude":
      return API_KEY_REQUIREMENTS_BY_PROVIDER.claude;
    case "cursor":
      return API_KEY_REQUIREMENTS_BY_PROVIDER.cursor;
    case "openai":
      return API_KEY_REQUIREMENTS_BY_PROVIDER.openai;
    case "google":
      return API_KEY_REQUIREMENTS_BY_PROVIDER.google;
    default:
      return null;
  }
}

export function getMissingApiKeyRequirements(
  envKeys: EnvKeysForDefaults | null,
  agentTypes: AgentType[]
): ApiKeyRequirement[] {
  if (!envKeys) return [];

  const seen = new Set<ApiKeyProvider>();
  const missing: ApiKeyRequirement[] = [];

  for (const agentType of agentTypes) {
    const requirement = getApiKeyRequirementForAgentType(agentType);
    if (!requirement) continue;
    if (envKeys[requirement.availabilityKey] ?? false) continue;
    if (seen.has(requirement.envKey)) continue;
    seen.add(requirement.envKey);
    missing.push(requirement);
  }

  return missing;
}

/**
 * Returns the first provider for which the user has an API key, in deterministic order:
 * Claude first, then OpenAI, then Google, then Cursor. When no keys are configured,
 * returns "claude" (first in order) so the user sees a consistent default.
 */
export function getDefaultProviderFromEnvKeys(envKeys: EnvKeysForDefaults | null): AgentType {
  if (!envKeys) return "claude";
  if (envKeys.anthropic) return "claude";
  if (envKeys.openai) return "openai";
  if (envKeys.google) return "google";
  if (envKeys.cursor) return "cursor";
  if (envKeys.codexCli) return "codex";
  if (envKeys.claudeCli) return "claude-cli";
  return "claude";
}

/** Setup wizards inherit the saved global tier, including its CLI command and model. */
export function getInitialAgentConfig(agent: AgentConfig | undefined, envKeys: EnvKeysForDefaults) {
  const type = agent?.type ?? getDefaultProviderFromEnvKeys(envKeys);
  return {
    type,
    model: agent?.model ?? "",
    cliCommand: agent?.cliCommand ?? "",
    timeoutMs: agent?.timeoutMs,
    effort: agent?.effort,
    baseUrl:
      agent?.baseUrl ?? (type === "ollama" ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL),
  };
}

/**
 * True when the user has no API keys configured.
 */
export function hasNoApiKeys(envKeys: EnvKeysForDefaults | null): boolean {
  if (!envKeys) return false;
  return !envKeys.anthropic && !envKeys.cursor && !envKeys.openai && !envKeys.google;
}
