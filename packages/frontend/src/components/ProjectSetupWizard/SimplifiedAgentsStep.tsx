import { ModelSelect } from "../ModelSelect";
import type { AgentType } from "@opensprint/shared";
import type { AgentConfig, EnvKeys } from "./AgentsStep";

export interface SimplifiedAgentsStepProps {
  simpleComplexityAgent: AgentConfig;
  complexComplexityAgent: AgentConfig;
  onSimpleComplexityAgentChange: (config: AgentConfig) => void;
  onComplexComplexityAgentChange: (config: AgentConfig) => void;
  envKeys: EnvKeys | null;
  keyInput: { anthropic: string; cursor: string };
  onKeyInputChange: (key: "anthropic" | "cursor", value: string) => void;
  savingKey: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | null;
  onSaveKey: (key: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY") => void;
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
  const usesClaudeCli =
    simpleComplexityAgent.type === "claude-cli" || complexComplexityAgent.type === "claude-cli";
  const claudeCliMissing = envKeys && !envKeys.claudeCli && usesClaudeCli;

  return (
    <div className="space-y-6" data-testid="simplified-agents-step">
      {(needsAnthropic || needsCursor) && (
        <>
          <div className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border">
            <p className="text-sm text-theme-warning-text">
              <strong>API key required:</strong>{" "}
              {needsAnthropic && needsCursor ? (
                <>
                  Add your <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> and{" "}
                  <code className="font-mono text-xs">CURSOR_API_KEY</code> to continue.
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
              ) : (
                <>
                  Add your <code className="font-mono text-xs">CURSOR_API_KEY</code> to use Cursor.
                  Get one from{" "}
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
              )}
            </p>
          </div>
          <div className="space-y-3">
            {needsAnthropic && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-theme-muted mb-1">
                    ANTHROPIC_API_KEY (Claude API)
                  </label>
                  <input
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
                  <label className="block text-xs font-medium text-theme-muted mb-1">
                    CURSOR_API_KEY
                  </label>
                  <input
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
          </div>
        </>
      )}
      {claudeCliMissing && (
        <div className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border">
          <p className="text-sm text-theme-warning-text">
            <strong>Claude CLI not found.</strong> Install it from{" "}
            <a
              href="https://docs.anthropic.com/en/docs/claude-code/overview"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:opacity-80"
            >
              docs.anthropic.com
            </a>{" "}
            and run <code className="font-mono text-xs">claude login</code> to authenticate.
          </p>
        </div>
      )}
      {usesClaudeCli && !claudeCliMissing && (
        <div className="p-3 rounded-lg bg-theme-info-bg border border-theme-info-border">
          <p className="text-sm text-theme-info-text">
            Using locally-installed Claude CLI. Make sure you have authenticated with{" "}
            <code className="font-mono text-xs">claude login</code>.
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
              <label className="block text-sm font-medium text-theme-text mb-1">Provider</label>
              <select
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
                <option value="custom">Custom CLI</option>
              </select>
            </div>
            {simpleComplexityAgent.type !== "custom" ? (
              <div className="flex-1 min-w-[140px]">
                <label className="block text-sm font-medium text-theme-text mb-1">Agent</label>
                <ModelSelect
                  provider={simpleComplexityAgent.type}
                  value={simpleComplexityAgent.model || null}
                  onChange={(id) =>
                    onSimpleComplexityAgentChange({ ...simpleComplexityAgent, model: id ?? "" })
                  }
                  refreshTrigger={modelRefreshTrigger}
                />
              </div>
            ) : (
              <div className="flex-1 min-w-[200px]">
                <label className="block text-sm font-medium text-theme-text mb-1">CLI command</label>
                <input
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
              <label className="block text-sm font-medium text-theme-text mb-1">Provider</label>
              <select
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
                <option value="custom">Custom CLI</option>
              </select>
            </div>
            {complexComplexityAgent.type !== "custom" ? (
              <div className="flex-1 min-w-[140px]">
                <label className="block text-sm font-medium text-theme-text mb-1">Agent</label>
                <ModelSelect
                  provider={complexComplexityAgent.type}
                  value={complexComplexityAgent.model || null}
                  onChange={(id) =>
                    onComplexComplexityAgentChange({ ...complexComplexityAgent, model: id ?? "" })
                  }
                  refreshTrigger={modelRefreshTrigger}
                />
              </div>
            ) : (
              <div className="flex-1 min-w-[200px]">
                <label className="block text-sm font-medium text-theme-text mb-1">CLI command</label>
                <input
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
