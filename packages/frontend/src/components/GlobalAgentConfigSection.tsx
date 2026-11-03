import { AgentProviderCliBanner } from "./AgentProviderCliBanner";
import { useState } from "react";
import { ModelSelect } from "./ModelSelect";
import { api } from "../api/client";
import type { AgentConfig, AgentType, AgentTimeoutValue } from "@opensprint/shared";
import { AGENT_TIMEOUT_OPTIONS, normalizeAgentTimeoutMs } from "@opensprint/shared";
import { DEFAULT_LMSTUDIO_BASE_URL, DEFAULT_OLLAMA_BASE_URL } from "../lib/localModelProviders";

/** Env + API key flags for global agent prerequisite banners */
export type GlobalAgentEnvKeys = {
  anthropic: boolean;
  cursor: boolean;
  openai: boolean;
  google: boolean;
  claudeCli: boolean;
  codexCli?: boolean;
  cursorCli: boolean;
  ollamaCli: boolean;
};

export interface GlobalAgentConfigSectionProps {
  simpleAgent: AgentConfig;
  complexAgent: AgentConfig;
  onUpdateSimple: (updates: Partial<AgentConfig>, options?: { immediate?: boolean }) => void;
  onUpdateComplex: (updates: Partial<AgentConfig>, options?: { immediate?: boolean }) => void;
  scheduleSaveOnBlur: () => void;
  envKeys: GlobalAgentEnvKeys | null;
  /** Switch to the General tab (API keys live there). */
  onOpenGeneralTab: () => void;
  /** Refresh env/API prerequisite state after install actions succeed. */
  onRefreshEnvKeys: () => Promise<void>;
  modelRefreshTrigger: number;
}

export function GlobalAgentConfigSection({
  simpleAgent,
  complexAgent,
  onUpdateSimple,
  onUpdateComplex,
  scheduleSaveOnBlur,
  envKeys,
  onOpenGeneralTab,
  onRefreshEnvKeys: _onRefreshEnvKeys,
  modelRefreshTrigger,
}: GlobalAgentConfigSectionProps) {
  const [cursorCliLoading, setCursorCliLoading] = useState(false);
  const [cursorCliInstructions, setCursorCliInstructions] = useState<{
    installUrl: string;
    manualCommand: string;
  } | null>(null);
  const [cursorCliShowInstructions, setCursorCliShowInstructions] = useState(false);
  const [cursorCliError, setCursorCliError] = useState<string | null>(null);
  const [cursorCliCopied, setCursorCliCopied] = useState(false);

  const renderProviderPrerequisite = (rowKey: "simple" | "complex", provider: AgentType) => {
    if (!envKeys) return null;

    if (provider === "claude" && !envKeys.anthropic) {
      return (
        <div
          className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
          data-testid={`${rowKey}-provider-prerequisite`}
        >
          <p className="text-sm text-theme-warning-text">
            <strong>Anthropic API key required</strong> —{" "}
            <button
              type="button"
              className="underline hover:opacity-80"
              data-testid={`configure-api-keys-link-${rowKey}`}
              onClick={onOpenGeneralTab}
            >
              add API keys in the General tab
            </button>
          </p>
        </div>
      );
    }

    if (provider === "cursor" && !envKeys.cursor) {
      return (
        <div
          className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
          data-testid={`${rowKey}-provider-prerequisite`}
        >
          <p className="text-sm text-theme-warning-text">
            <strong>Cursor API key required</strong> —{" "}
            <button
              type="button"
              className="underline hover:opacity-80"
              data-testid={`configure-api-keys-link-${rowKey}`}
              onClick={onOpenGeneralTab}
            >
              add API keys in the General tab
            </button>
          </p>
        </div>
      );
    }

    if (provider === "cursor" && envKeys.cursor && !envKeys.cursorCli) {
      return (
        <div
          className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
          data-testid={`${rowKey}-provider-prerequisite`}
        >
          <p className="text-sm text-theme-warning-text mb-2">
            <strong>Cursor CLI not found.</strong> The{" "}
            <code className="font-mono text-xs">agent</code> command is required for Cursor. Install
            it, then restart your terminal or Open Sprint.
          </p>
          <button
            type="button"
            className="btn btn-primary text-sm"
            disabled={cursorCliLoading}
            onClick={async () => {
              if (cursorCliShowInstructions && cursorCliInstructions) {
                setCursorCliShowInstructions(false);
                return;
              }
              setCursorCliError(null);
              setCursorCliLoading(true);
              try {
                const data = await api.env.installCursorCli();
                setCursorCliInstructions({
                  installUrl: data.installUrl,
                  manualCommand: data.manualCommand,
                });
                setCursorCliShowInstructions(true);
              } catch (err) {
                setCursorCliError(
                  err instanceof Error ? err.message : "Failed to load install instructions."
                );
              } finally {
                setCursorCliLoading(false);
              }
            }}
            data-testid="install-cursor-cli-btn"
          >
            {cursorCliLoading
              ? "Loading…"
              : cursorCliShowInstructions
                ? "Hide Install Instructions"
                : "Show Install Instructions"}
          </button>
          {cursorCliError && <p className="text-sm mt-2 text-theme-error-text">{cursorCliError}</p>}
          {cursorCliShowInstructions && cursorCliInstructions && (
            <div className="mt-3 space-y-2" data-testid="cursor-cli-install-instructions">
              <p className="text-sm text-theme-warning-text">
                Run this command in your terminal after reviewing it:
              </p>
              <div className="flex items-center gap-2">
                <code className="block flex-1 p-2 rounded bg-theme-bg-secondary text-xs font-mono break-all select-all">
                  {cursorCliInstructions.manualCommand}
                </code>
                <button
                  type="button"
                  className="btn btn-secondary text-xs px-2 py-1 shrink-0"
                  data-testid="copy-cursor-cli-cmd-btn"
                  onClick={() => {
                    navigator.clipboard.writeText(cursorCliInstructions.manualCommand).then(() => {
                      setCursorCliCopied(true);
                      setTimeout(() => setCursorCliCopied(false), 2000);
                    });
                  }}
                >
                  {cursorCliCopied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-theme-text-secondary">
                Or visit{" "}
                <a
                  href={cursorCliInstructions.installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:opacity-80"
                  data-testid="cursor-cli-install-link"
                >
                  {cursorCliInstructions.installUrl}
                </a>{" "}
                for official install instructions.
              </p>
            </div>
          )}
        </div>
      );
    }

    if (provider === "openai" && !envKeys.openai) {
      return (
        <div
          className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
          data-testid={`${rowKey}-provider-prerequisite`}
        >
          <p className="text-sm text-theme-warning-text">
            <strong>OpenAI API key required</strong> —{" "}
            <button
              type="button"
              className="underline hover:opacity-80"
              data-testid={`configure-api-keys-link-${rowKey}`}
              onClick={onOpenGeneralTab}
            >
              add API keys in the General tab
            </button>
          </p>
        </div>
      );
    }

    if (provider === "google" && !envKeys.google) {
      return (
        <div
          className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
          data-testid={`${rowKey}-provider-prerequisite`}
        >
          <p className="text-sm text-theme-warning-text">
            <strong>Google API key required</strong> —{" "}
            <button
              type="button"
              className="underline hover:opacity-80"
              data-testid={`configure-api-keys-link-${rowKey}`}
              onClick={onOpenGeneralTab}
            >
              add API keys in the General tab
            </button>
          </p>
        </div>
      );
    }

    if (provider === "codex" && !envKeys.codexCli) {
      return (
        <div data-testid={`${rowKey}-provider-prerequisite`}>
          <AgentProviderCliBanner kind="codex" />
        </div>
      );
    }
    if (provider === "claude-cli" && !envKeys.claudeCli) {
      return (
        <div
          className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
          data-testid={`${rowKey}-provider-prerequisite`}
        >
          <p className="text-sm text-theme-warning-text">
            <strong>Claude CLI not found.</strong> Install it from{" "}
            <a
              href="https://docs.anthropic.com/en/docs/claude-code/getting-started"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:opacity-80"
            >
              docs.anthropic.com
            </a>{" "}
            and run <code className="font-mono text-xs">claude</code> to complete authentication.
          </p>
        </div>
      );
    }

    return null;
  };

  const timeoutToSelectValue = (raw: AgentConfig["timeoutMs"]): string => {
    const normalized = normalizeAgentTimeoutMs(raw);
    return normalized === null ? "never" : String(normalized);
  };

  const selectValueToTimeout = (value: string): AgentTimeoutValue =>
    value === "never" ? null : normalizeAgentTimeoutMs(Number(value));

  return (
    <div className="space-y-6" data-testid="global-agent-config-section">
      <div>
        <h3 className="text-sm font-semibold text-theme-text mb-1">Global agent defaults</h3>
        <p className="text-xs text-theme-muted">
          These defaults apply when a project does not override Simple or Complex tier agents. API
          keys are managed in the General tab.
        </p>
      </div>

      <div data-testid="task-complexity-section">
        <h3 className="text-sm font-semibold text-theme-text mb-3">Task Complexity</h3>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-16 text-sm font-medium text-theme-text shrink-0">Simple</span>
            <div className="flex-1 min-w-[140px]">
              <label
                htmlFor="global-simple-provider-select"
                className="block text-xs font-medium text-theme-muted mb-1"
              >
                Provider
              </label>
              <select
                id="global-simple-provider-select"
                className="input w-full"
                value={simpleAgent.type}
                onChange={(e) => {
                  const type = e.target.value as AgentType;
                  onUpdateSimple(
                    {
                      type,
                      model: null,
                      baseUrl:
                        type === "lmstudio"
                          ? DEFAULT_LMSTUDIO_BASE_URL
                          : type === "ollama"
                            ? DEFAULT_OLLAMA_BASE_URL
                            : simpleAgent.baseUrl,
                    },
                    { immediate: false }
                  );
                  scheduleSaveOnBlur();
                }}
              >
                <option value="claude">Claude (API)</option>
                <option value="claude-cli">Anthropic Claude Code (CLI)</option>
                <option value="codex">OpenAI Codex (CLI)</option>
                <option value="cursor">Cursor</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google (Gemini)</option>
                <option value="lmstudio">LM Studio (local)</option>
                <option value="ollama">Ollama (local)</option>
                <option value="custom">Custom CLI</option>
              </select>
            </div>
            {(simpleAgent.type === "lmstudio" || simpleAgent.type === "ollama") && (
              <div className="flex-1 min-w-[180px]">
                <label
                  htmlFor="global-simple-base-url"
                  className="block text-xs font-medium text-theme-muted mb-1"
                >
                  Base URL
                </label>
                <input
                  id="global-simple-base-url"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder={
                    simpleAgent.type === "ollama"
                      ? DEFAULT_OLLAMA_BASE_URL
                      : DEFAULT_LMSTUDIO_BASE_URL
                  }
                  value={simpleAgent.baseUrl ?? ""}
                  onChange={(e) => onUpdateSimple({ baseUrl: e.target.value.trim() || undefined })}
                  onBlur={scheduleSaveOnBlur}
                />
              </div>
            )}
            {simpleAgent.type !== "custom" ? (
              <div className="flex-1 min-w-[140px]">
                <label
                  htmlFor="global-simple-agent-select"
                  className="block text-xs font-medium text-theme-muted mb-1"
                >
                  Agent
                </label>
                <ModelSelect
                  id="global-simple-agent-select"
                  provider={simpleAgent.type}
                  value={simpleAgent.model}
                  onChange={(id) => onUpdateSimple({ model: id })}
                  onBlur={scheduleSaveOnBlur}
                  refreshTrigger={modelRefreshTrigger}
                  baseUrl={
                    simpleAgent.type === "lmstudio" || simpleAgent.type === "ollama"
                      ? simpleAgent.baseUrl ||
                        (simpleAgent.type === "ollama"
                          ? DEFAULT_OLLAMA_BASE_URL
                          : DEFAULT_LMSTUDIO_BASE_URL)
                      : undefined
                  }
                />
              </div>
            ) : (
              <div className="flex-1 min-w-[200px]">
                <label
                  htmlFor="global-simple-cli-command"
                  className="block text-xs font-medium text-theme-muted mb-1"
                >
                  CLI command
                </label>
                <input
                  id="global-simple-cli-command"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                  value={simpleAgent.cliCommand ?? ""}
                  onChange={(e) =>
                    onUpdateSimple({ cliCommand: e.target.value || null }, { immediate: false })
                  }
                  onBlur={scheduleSaveOnBlur}
                />
              </div>
            )}
            <div className="flex-1 min-w-[140px]">
              <label
                htmlFor="global-simple-timeout-select"
                className="block text-xs font-medium text-theme-muted mb-1"
              >
                Agent timeout
              </label>
              <select
                id="global-simple-timeout-select"
                className="input w-full"
                value={timeoutToSelectValue(simpleAgent.timeoutMs)}
                onChange={(e) =>
                  onUpdateSimple(
                    { timeoutMs: selectValueToTimeout(e.target.value) },
                    { immediate: false }
                  )
                }
                onBlur={scheduleSaveOnBlur}
              >
                {AGENT_TIMEOUT_OPTIONS.map((option) => (
                  <option
                    key={option.value === null ? "never" : String(option.value)}
                    value={option.value === null ? "never" : String(option.value)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {renderProviderPrerequisite("simple", simpleAgent.type)}

          <div className="flex flex-wrap items-center gap-3">
            <span className="w-16 text-sm font-medium text-theme-text shrink-0">Complex</span>
            <div className="flex-1 min-w-[140px]">
              <label
                htmlFor="global-complex-provider-select"
                className="block text-xs font-medium text-theme-muted mb-1"
              >
                Provider
              </label>
              <select
                id="global-complex-provider-select"
                className="input w-full"
                value={complexAgent.type}
                onChange={(e) => {
                  const type = e.target.value as AgentType;
                  onUpdateComplex(
                    {
                      type,
                      model: null,
                      baseUrl:
                        type === "lmstudio"
                          ? DEFAULT_LMSTUDIO_BASE_URL
                          : type === "ollama"
                            ? DEFAULT_OLLAMA_BASE_URL
                            : complexAgent.baseUrl,
                    },
                    { immediate: false }
                  );
                  scheduleSaveOnBlur();
                }}
              >
                <option value="claude">Claude (API)</option>
                <option value="claude-cli">Anthropic Claude Code (CLI)</option>
                <option value="codex">OpenAI Codex (CLI)</option>
                <option value="cursor">Cursor</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google (Gemini)</option>
                <option value="lmstudio">LM Studio (local)</option>
                <option value="ollama">Ollama (local)</option>
                <option value="custom">Custom CLI</option>
              </select>
            </div>
            {(complexAgent.type === "lmstudio" || complexAgent.type === "ollama") && (
              <div className="flex-1 min-w-[180px]">
                <label
                  htmlFor="global-complex-base-url"
                  className="block text-xs font-medium text-theme-muted mb-1"
                >
                  Base URL
                </label>
                <input
                  id="global-complex-base-url"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder={
                    complexAgent.type === "ollama"
                      ? DEFAULT_OLLAMA_BASE_URL
                      : DEFAULT_LMSTUDIO_BASE_URL
                  }
                  value={complexAgent.baseUrl ?? ""}
                  onChange={(e) => onUpdateComplex({ baseUrl: e.target.value.trim() || undefined })}
                  onBlur={scheduleSaveOnBlur}
                />
              </div>
            )}
            {complexAgent.type !== "custom" ? (
              <div className="flex-1 min-w-[140px]">
                <label
                  htmlFor="global-complex-agent-select"
                  className="block text-xs font-medium text-theme-muted mb-1"
                >
                  Agent
                </label>
                <ModelSelect
                  id="global-complex-agent-select"
                  provider={complexAgent.type}
                  value={complexAgent.model}
                  onChange={(id) => onUpdateComplex({ model: id })}
                  onBlur={scheduleSaveOnBlur}
                  refreshTrigger={modelRefreshTrigger}
                  baseUrl={
                    complexAgent.type === "lmstudio" || complexAgent.type === "ollama"
                      ? complexAgent.baseUrl ||
                        (complexAgent.type === "ollama"
                          ? DEFAULT_OLLAMA_BASE_URL
                          : DEFAULT_LMSTUDIO_BASE_URL)
                      : undefined
                  }
                />
              </div>
            ) : (
              <div className="flex-1 min-w-[200px]">
                <label
                  htmlFor="global-complex-cli-command"
                  className="block text-xs font-medium text-theme-muted mb-1"
                >
                  CLI command
                </label>
                <input
                  id="global-complex-cli-command"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                  value={complexAgent.cliCommand ?? ""}
                  onChange={(e) =>
                    onUpdateComplex({ cliCommand: e.target.value || null }, { immediate: false })
                  }
                  onBlur={scheduleSaveOnBlur}
                />
              </div>
            )}
            <div className="flex-1 min-w-[140px]">
              <label
                htmlFor="global-complex-timeout-select"
                className="block text-xs font-medium text-theme-muted mb-1"
              >
                Agent timeout
              </label>
              <select
                id="global-complex-timeout-select"
                className="input w-full"
                value={timeoutToSelectValue(complexAgent.timeoutMs)}
                onChange={(e) =>
                  onUpdateComplex(
                    { timeoutMs: selectValueToTimeout(e.target.value) },
                    { immediate: false }
                  )
                }
                onBlur={scheduleSaveOnBlur}
              >
                {AGENT_TIMEOUT_OPTIONS.map((option) => (
                  <option
                    key={option.value === null ? "never" : String(option.value)}
                    value={option.value === null ? "never" : String(option.value)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {renderProviderPrerequisite("complex", complexAgent.type)}
        </div>
      </div>
    </div>
  );
}
