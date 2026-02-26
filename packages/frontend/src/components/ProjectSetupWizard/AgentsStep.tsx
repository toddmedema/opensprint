import { useState } from "react";
import { ModelSelect } from "../ModelSelect";
import { AgentReferenceModal } from "../AgentReferenceModal";
import type { AgentType, GitWorkingMode, UnknownScopeStrategy } from "@opensprint/shared";
import {
  AGENT_ROLE_CANONICAL_ORDER,
  AGENT_ROLE_LABELS,
  AGENT_ROLE_PHASES,
  AGENT_ROLE_DESCRIPTIONS,
} from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";

/** Base URL for public assets (Vite BASE_URL) */
const ASSET_BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/*$/, "/");

export interface AgentConfig {
  type: AgentType;
  model: string;
  cliCommand: string;
}

export interface EnvKeys {
  anthropic: boolean;
  cursor: boolean;
  claudeCli: boolean;
}

export interface AgentsStepProps {
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
  maxConcurrentCoders: number;
  onMaxConcurrentCodersChange: (value: number) => void;
  unknownScopeStrategy: UnknownScopeStrategy;
  onUnknownScopeStrategyChange: (value: UnknownScopeStrategy) => void;
  gitWorkingMode: GitWorkingMode;
  onGitWorkingModeChange: (value: GitWorkingMode) => void;
}

export function AgentsStep({
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
  maxConcurrentCoders,
  onMaxConcurrentCodersChange,
  unknownScopeStrategy,
  onUnknownScopeStrategyChange,
  gitWorkingMode,
  onGitWorkingModeChange,
}: AgentsStepProps) {
  const [agentReferenceOpen, setAgentReferenceOpen] = useState(false);

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
    <div className="space-y-6" data-testid="agents-step">
      <details
        className="rounded-lg border border-theme-border bg-theme-surface-muted"
        data-testid="about-agent-team-section"
      >
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-theme-text hover:bg-theme-surface-muted/50 rounded-t-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-inset">
          What do these agents do?
        </summary>
        <div className="px-4 pb-4 pt-0 border-t border-theme-border">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mt-3">
            {AGENT_ROLE_CANONICAL_ORDER.map((role) => (
              <CompactAgentCard key={role} role={role} />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAgentReferenceOpen(true)}
            className="mt-3 text-sm text-brand-600 hover:text-brand-700 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 rounded"
          >
            Learn more
          </button>
        </div>
      </details>

      {agentReferenceOpen && <AgentReferenceModal onClose={() => setAgentReferenceOpen(false)} />}

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
      <div>
        <h3 className="text-sm font-semibold text-theme-text mb-3">Simple Complexity Agent</h3>
        <p className="text-xs text-theme-muted mb-3">For routine and moderate tasks</p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-theme-text mb-1">Provider</label>
              <select
                className="input"
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
            {simpleComplexityAgent.type !== "custom" && (
              <div>
                <label className="block text-sm font-medium text-theme-text mb-1">Model</label>
                <ModelSelect
                  provider={simpleComplexityAgent.type}
                  value={simpleComplexityAgent.model || null}
                  onChange={(id) =>
                    onSimpleComplexityAgentChange({ ...simpleComplexityAgent, model: id ?? "" })
                  }
                  refreshTrigger={modelRefreshTrigger}
                />
              </div>
            )}
          </div>
          {simpleComplexityAgent.type === "custom" && (
            <div>
              <label className="block text-sm font-medium text-theme-text mb-1">CLI command</label>
              <input
                type="text"
                className="input w-full font-mono text-sm"
                placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                value={simpleComplexityAgent.cliCommand}
                onChange={(e) =>
                  onSimpleComplexityAgentChange({ ...simpleComplexityAgent, cliCommand: e.target.value })
                }
              />
              <p className="mt-1 text-xs text-theme-muted">
                Command invoked with prompt as argument. Must accept input and produce output.
              </p>
            </div>
          )}
        </div>
      </div>
      <hr />
      <div>
        <h3 className="text-sm font-semibold text-theme-text mb-3">Complex Complexity Agent</h3>
        <p className="text-xs text-theme-muted mb-3">For complex and cross-cutting tasks</p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-theme-text mb-1">Provider</label>
              <select
                className="input"
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
            {complexComplexityAgent.type !== "custom" && (
              <div>
                <label className="block text-sm font-medium text-theme-text mb-1">Model</label>
                <ModelSelect
                  provider={complexComplexityAgent.type}
                  value={complexComplexityAgent.model || null}
                  onChange={(id) =>
                    onComplexComplexityAgentChange({ ...complexComplexityAgent, model: id ?? "" })
                  }
                  refreshTrigger={modelRefreshTrigger}
                />
              </div>
            )}
          </div>
          {complexComplexityAgent.type === "custom" && (
            <div>
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
              <p className="mt-1 text-xs text-theme-muted">
                Command invoked with prompt as argument. Must accept input and produce output.
              </p>
            </div>
          )}
        </div>
      </div>
      <hr />
      <div>
        <h3 className="text-sm font-semibold text-theme-text mb-1">Git working mode</h3>
        <p className="text-xs text-theme-muted mb-3">
          Worktree creates isolated worktrees per task for parallel execution. Branches uses a
          single branch in the main repo (sequential only).
        </p>
        <select
          className="input"
          value={gitWorkingMode}
          onChange={(e) => onGitWorkingModeChange(e.target.value as GitWorkingMode)}
          data-testid="git-working-mode-select"
        >
          <option value="worktree">Worktree (default)</option>
          <option value="branches">Branches</option>
        </select>
      </div>
      {gitWorkingMode === "worktree" && (
        <>
          <hr />
          <div>
            <h3 className="text-sm font-semibold text-theme-text mb-1">Parallelism</h3>
            <p className="text-xs text-theme-muted mb-3">
              Run multiple coding agents simultaneously on independent tasks. Higher values speed up
              builds but use more resources.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-theme-text mb-2">
                  Max Concurrent Coders: <span className="font-bold">{maxConcurrentCoders}</span>
                </label>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={maxConcurrentCoders}
                  onChange={(e) => onMaxConcurrentCodersChange(Number(e.target.value))}
                  className="w-full accent-brand-600"
                  data-testid="max-concurrent-coders-slider"
                />
                <div className="flex justify-between text-xs text-theme-muted mt-1">
                  <span>1 (sequential)</span>
                  <span>10</span>
                </div>
              </div>
              {maxConcurrentCoders > 1 && (
                <div>
                  <label className="block text-sm font-medium text-theme-text mb-1">
                    Unknown Scope Strategy
                  </label>
                  <p className="text-xs text-theme-muted mb-2">
                    When file scope can&apos;t be predicted for a task, should the scheduler
                    serialize it or run it in parallel?
                  </p>
                  <select
                    className="input"
                    value={unknownScopeStrategy}
                    onChange={(e) =>
                      onUnknownScopeStrategyChange(e.target.value as UnknownScopeStrategy)
                    }
                    data-testid="unknown-scope-strategy-select"
                  >
                    <option value="optimistic">Optimistic (parallelize, rely on merger)</option>
                    <option value="conservative">Conservative (serialize)</option>
                  </select>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {gitWorkingMode === "branches" && (
        <div className="p-3 rounded-lg bg-theme-info-bg border border-theme-info-border">
          <p className="text-sm text-theme-info-text">
            Branches mode uses a single branch in the main repo. Only one coder runs at a time.
          </p>
        </div>
      )}
    </div>
  );
}

function CompactAgentCard({ role }: { role: AgentRole }) {
  const label = AGENT_ROLE_LABELS[role];
  const phases = AGENT_ROLE_PHASES[role];
  const description = AGENT_ROLE_DESCRIPTIONS[role];
  const iconSrc = `${ASSET_BASE}agent-icons/${role}.svg`;

  return (
    <article
      className="flex gap-2 rounded border border-theme-border bg-theme-surface p-3"
      role="listitem"
    >
      <img
        src={iconSrc}
        alt=""
        className="w-8 h-8 shrink-0 rounded object-contain"
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <h4 className="font-medium text-theme-text text-sm">{label}</h4>
        <div className="flex flex-wrap gap-1 mt-0.5">
          {phases.map((phase) => (
            <span
              key={phase}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-theme-border-subtle text-theme-muted"
            >
              {phase}
            </span>
          ))}
        </div>
        <p className="text-xs text-theme-muted mt-1 line-clamp-2">{description}</p>
      </div>
    </article>
  );
}
