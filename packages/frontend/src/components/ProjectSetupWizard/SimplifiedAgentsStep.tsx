import { Link } from "react-router-dom";
import { ModelSelect } from "../ModelSelect";
import type { AgentType } from "@opensprint/shared";
import type { AgentConfig, EnvKeys } from "./AgentsStep";

const DEFAULT_LMSTUDIO_BASE_URL = "http://localhost:1234";
import { hasNoApiKeys } from "../../utils/agentConfigDefaults";

export interface SimplifiedAgentsStepProps {
  simpleComplexityAgent: AgentConfig;
  complexComplexityAgent: AgentConfig;
  onSimpleComplexityAgentChange: (config: AgentConfig) => void;
  onComplexComplexityAgentChange: (config: AgentConfig) => void;
  envKeys: EnvKeys | null;
  keyInput: { anthropic: string; cursor: string; openai: string };
  onKeyInputChange: (key: "anthropic" | "cursor" | "openai", value: string) => void;
  savingKey: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY" | null;
  onSaveKey: (key: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY") => void;
  modelRefreshTrigger: number;
}

export function SimplifiedAgentsStep({
  simpleComplexityAgent,
  complexComplexityAgent,
  onSimpleComplexityAgentChange,
  onComplexComplexityAgentChange,
  envKeys,
  keyInput,
  onKeyInputChange,
  savingKey,
  onSaveKey,
  modelRefreshTrigger,
}: SimplifiedAgentsStepProps) {
  const needsAnthropic =
    envKeys &&
    !envKeys.anthropic &&
    (simpleComplexityAgent.type === "claude" || complexComplexityAgent.type === "claude");
  const needsCursor =
    envKeys &&
    !envKeys.cursor &&
    (simpleComplexityAgent.type === "cursor" || complexComplexityAgent.type === "cursor");
  const needsOpenai =
    envKeys &&
    !envKeys.openai &&
    (simpleComplexityAgent.type === "openai" || complexComplexityAgent.type === "openai");
  const usesClaudeCli =
    simpleComplexityAgent.type === "claude-cli" || complexComplexityAgent.type === "claude-cli";
  const claudeCliMissing = envKeys && !envKeys.claudeCli && usesClaudeCli;

  return (
    <div className="space-y-6" data-testid="simplified-agents-step">
      {(needsAnthropic || needsCursor || needsOpenai) && (
        <>
          <div
            className={
              hasNoApiKeys(envKeys)
                ? "p-3 rounded-lg bg-theme-error-bg border border-theme-error-border"
                : "p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border"
            }
            data-testid="no-api-keys-warning"
          >
            <p
              className={
                hasNoApiKeys(envKeys)
                  ? "text-sm text-theme-error-text"
                  : "text-sm text-theme-warning-text"
              }
            >
              <strong>API key required:</strong>{" "}
              {hasNoApiKeys(envKeys) ? (
                <>
                  You must add at least one API key to continue.{" "}
                  <Link
                    to="/settings"
                    className="underline hover:opacity-80 font-medium"
                    data-testid="no-api-keys-settings-link"
                  >
                    Open Settings
                  </Link>{" "}
                  to add your keys.
                </>
              ) : (
                <>
                  {needsAnthropic && needsCursor && needsOpenai ? (
                    <>
                      Add your <code className="font-mono text-xs">ANTHROPIC_API_KEY</code>,{" "}
                      <code className="font-mono text-xs">CURSOR_API_KEY</code>, and{" "}
                      <code className="font-mono text-xs">OPENAI_API_KEY</code> to continue.
                    </>
                  ) : needsAnthropic && needsCursor ? (
                    <>
                      Add your <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> and{" "}
                      <code className="font-mono text-xs">CURSOR_API_KEY</code> to continue.
                    </>
                  ) : needsAnthropic && needsOpenai ? (
                    <>
                      Add your <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> and{" "}
                      <code className="font-mono text-xs">OPENAI_API_KEY</code> to continue.
                    </>
                  ) : needsCursor && needsOpenai ? (
                    <>
                      Add your <code className="font-mono text-xs">CURSOR_API_KEY</code> and{" "}
                      <code className="font-mono text-xs">OPENAI_API_KEY</code> to continue.
                    </>
                  ) : needsAnthropic ? (
                    <>
                      Add your <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> to use
                      Claude (API). Get one from{" "}
                      <a
                        href="https://console.anthropic.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:opacity-80"
                      >
                        Anthropic Console
                      </a>
                      .
                    </>
                  ) : needsOpenai ? (
                    <>
                      Add your <code className="font-mono text-xs">OPENAI_API_KEY</code> to use
                      OpenAI. Get one from{" "}
                      <a
                        href="https://platform.openai.com/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:opacity-80"
                      >
                        OpenAI Platform
                      </a>
                      .
                    </>
                  ) : (
                    <>
                      Add your <code className="font-mono text-xs">CURSOR_API_KEY</code> to use
                      Cursor. Get one from{" "}
                      <a
                        href="https://cursor.com/settings"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:opacity-80"
                      >
                        Cursor → Integrations → User API Keys
                      </a>
                      .
                    </>
                  )}{" "}
                  Or{" "}
                  <Link
                    to="/settings"
                    className="underline hover:opacity-80 font-medium"
                    data-testid="no-api-keys-settings-link"
                  >
                    open Settings
                  </Link>{" "}
                  to add keys.
                </>
              )}
            </p>
          </div>
          <div className="space-y-3">
            {needsAnthropic && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label htmlFor="simplified-anthropic-api-key" className="block text-xs font-medium text-theme-muted mb-1">
                    ANTHROPIC_API_KEY (Claude API)
                  </label>
                  <input
                    id="simplified-anthropic-api-key"
                    type="password"
                    className="input font-mono text-sm"
                    placeholder="sk-ant-..."
                    value={keyInput.anthropic}
                    onChange={(e) => onKeyInputChange("anthropic", e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onSaveKey("ANTHROPIC_API_KEY")}
                  disabled={!keyInput.anthropic.trim() || savingKey !== null}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {savingKey === "ANTHROPIC_API_KEY" ? "Saving…" : "Save"}
                </button>
              </div>
            )}
            {needsCursor && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label htmlFor="simplified-cursor-api-key" className="block text-xs font-medium text-theme-muted mb-1">
                    CURSOR_API_KEY
                  </label>
                  <input
                    id="simplified-cursor-api-key"
                    type="password"
                    className="input font-mono text-sm"
                    placeholder="key_..."
                    value={keyInput.cursor}
                    onChange={(e) => onKeyInputChange("cursor", e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onSaveKey("CURSOR_API_KEY")}
                  disabled={!keyInput.cursor.trim() || savingKey !== null}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {savingKey === "CURSOR_API_KEY" ? "Saving…" : "Save"}
                </button>
              </div>
            )}
            {needsOpenai && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label htmlFor="simplified-openai-api-key" className="block text-xs font-medium text-theme-muted mb-1">
                    OPENAI_API_KEY
                  </label>
                  <input
                    id="simplified-openai-api-key"
                    type="password"
                    className="input font-mono text-sm"
                    placeholder="sk-..."
                    value={keyInput.openai}
                    onChange={(e) => onKeyInputChange("openai", e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onSaveKey("OPENAI_API_KEY")}
                  disabled={!keyInput.openai.trim() || savingKey !== null}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {savingKey === "OPENAI_API_KEY" ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {claudeCliMissing && (
        <div className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border">
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
      )}
      {usesClaudeCli && !claudeCliMissing && (
        <div className="p-3 rounded-lg bg-theme-info-bg border border-theme-info-border">
          <p className="text-sm text-theme-info-text">
            Using locally-installed Claude CLI. Make sure you have authenticated by running{" "}
            <code className="font-mono text-xs">claude</code> at least once.
          </p>
        </div>
      )}
      <div data-testid="task-complexity-section">
        <h3 className="text-sm font-semibold text-theme-text mb-3">Task Complexity</h3>
        <p className="text-xs text-theme-muted mb-3">
          Simple: routine tasks. Complex: challenging tasks. Each row configures provider and agent.
        </p>
        <div className="space-y-4">
          {/* Row 1: Simple */}
          <div className="flex flex-wrap items-end gap-3">
            <span className="w-16 text-sm font-medium text-theme-text shrink-0">Simple</span>
            <div className="flex-1 min-w-[140px]">
              <label htmlFor="simplified-simple-provider-select" className="block text-sm font-medium text-theme-text mb-1">Provider</label>
              <select
                id="simplified-simple-provider-select"
                className="input w-full"
                value={simpleComplexityAgent.type}
                onChange={(e) =>
                  onSimpleComplexityAgentChange({
                    ...simpleComplexityAgent,
                    type: e.target.value as AgentType,
                  })
                }
              >
                <option value="claude">Claude (API)</option>
                <option value="claude-cli">Claude (CLI)</option>
                <option value="cursor">Cursor</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google (Gemini)</option>
                <option value="lmstudio">LM Studio (local)</option>
                <option value="custom">Custom CLI</option>
              </select>
            </div>
            {simpleComplexityAgent.type === "lmstudio" && (
              <div className="flex-1 min-w-[180px]">
                <label htmlFor="simplified-simple-base-url" className="block text-sm font-medium text-theme-text mb-1">Base URL</label>
                <input
                  id="simplified-simple-base-url"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder={DEFAULT_LMSTUDIO_BASE_URL}
                  value={simpleComplexityAgent.baseUrl ?? ""}
                  onChange={(e) =>
                    onSimpleComplexityAgentChange({
                      ...simpleComplexityAgent,
                      baseUrl: e.target.value.trim() || undefined,
                    })
                  }
                />
              </div>
            )}
            {simpleComplexityAgent.type !== "custom" ? (
              <div className="flex-1 min-w-[140px]">
                <label htmlFor="simplified-simple-agent-select" className="block text-sm font-medium text-theme-text mb-1">Agent</label>
                <ModelSelect
                  id="simplified-simple-agent-select"
                  provider={simpleComplexityAgent.type}
                  value={simpleComplexityAgent.model || null}
                  onChange={(id) =>
                    onSimpleComplexityAgentChange({ ...simpleComplexityAgent, model: id ?? "" })
                  }
                  refreshTrigger={modelRefreshTrigger}
                  baseUrl={
                    simpleComplexityAgent.type === "lmstudio"
                      ? simpleComplexityAgent.baseUrl || DEFAULT_LMSTUDIO_BASE_URL
                      : undefined
                  }
                />
              </div>
            ) : (
              <div className="flex-1 min-w-[200px]">
                <label htmlFor="simplified-simple-cli-command" className="block text-sm font-medium text-theme-text mb-1">
                  CLI command
                </label>
                <input
                  id="simplified-simple-cli-command"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                  value={simpleComplexityAgent.cliCommand}
                  onChange={(e) =>
                    onSimpleComplexityAgentChange({
                      ...simpleComplexityAgent,
                      cliCommand: e.target.value,
                    })
                  }
                />
              </div>
            )}
          </div>
          {/* Row 2: Complex */}
          <div className="flex flex-wrap items-end gap-3">
            <span className="w-16 text-sm font-medium text-theme-text shrink-0">Complex</span>
            <div className="flex-1 min-w-[140px]">
              <label htmlFor="simplified-complex-provider-select" className="block text-sm font-medium text-theme-text mb-1">Provider</label>
              <select
                id="simplified-complex-provider-select"
                className="input w-full"
                value={complexComplexityAgent.type}
                onChange={(e) =>
                  onComplexComplexityAgentChange({
                    ...complexComplexityAgent,
                    type: e.target.value as AgentType,
                  })
                }
              >
                <option value="claude">Claude (API)</option>
                <option value="claude-cli">Claude (CLI)</option>
                <option value="cursor">Cursor</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google (Gemini)</option>
                <option value="lmstudio">LM Studio (local)</option>
                <option value="custom">Custom CLI</option>
              </select>
            </div>
            {complexComplexityAgent.type === "lmstudio" && (
              <div className="flex-1 min-w-[180px]">
                <label htmlFor="simplified-complex-base-url" className="block text-sm font-medium text-theme-text mb-1">Base URL</label>
                <input
                  id="simplified-complex-base-url"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder={DEFAULT_LMSTUDIO_BASE_URL}
                  value={complexComplexityAgent.baseUrl ?? ""}
                  onChange={(e) =>
                    onComplexComplexityAgentChange({
                      ...complexComplexityAgent,
                      baseUrl: e.target.value.trim() || undefined,
                    })
                  }
                />
              </div>
            )}
            {complexComplexityAgent.type !== "custom" ? (
              <div className="flex-1 min-w-[140px]">
                <label htmlFor="simplified-complex-agent-select" className="block text-sm font-medium text-theme-text mb-1">Agent</label>
                <ModelSelect
                  id="simplified-complex-agent-select"
                  provider={complexComplexityAgent.type}
                  value={complexComplexityAgent.model || null}
                  onChange={(id) =>
                    onComplexComplexityAgentChange({ ...complexComplexityAgent, model: id ?? "" })
                  }
                  refreshTrigger={modelRefreshTrigger}
                  baseUrl={
                    complexComplexityAgent.type === "lmstudio"
                      ? complexComplexityAgent.baseUrl || DEFAULT_LMSTUDIO_BASE_URL
                      : undefined
                  }
                />
              </div>
            ) : (
              <div className="flex-1 min-w-[200px]">
                <label htmlFor="simplified-complex-cli-command" className="block text-sm font-medium text-theme-text mb-1">
                  CLI command
                </label>
                <input
                  id="simplified-complex-cli-command"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                  value={complexComplexityAgent.cliCommand}
                  onChange={(e) =>
                    onComplexComplexityAgentChange({
                      ...complexComplexityAgent,
                      cliCommand: e.target.value,
                    })
                  }
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
