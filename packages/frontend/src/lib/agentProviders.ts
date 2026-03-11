/**
 * Shared agent provider list for onboarding and API key setup (e.g. ApiKeySetupModal).
 * LM Studio and Custom/CLI do not require an API key (needsKeyInput: false).
 */

export type AgentProviderValue =
  | "claude"
  | "cursor"
  | "openai"
  | "google"
  | "lmstudio"
  | "custom";

export interface AgentProviderOption {
  value: AgentProviderValue;
  label: string;
  /** When false, no API key input is shown (e.g. LM Studio, Custom/CLI). */
  needsKeyInput: boolean;
}

export const AGENT_PROVIDER_OPTIONS: AgentProviderOption[] = [
  { value: "claude", label: "Claude", needsKeyInput: true },
  { value: "cursor", label: "Cursor", needsKeyInput: true },
  { value: "openai", label: "OpenAI", needsKeyInput: true },
  { value: "google", label: "Google", needsKeyInput: true },
  { value: "lmstudio", label: "LM Studio (local)", needsKeyInput: false },
  { value: "custom", label: "Custom/CLI", needsKeyInput: false },
];
