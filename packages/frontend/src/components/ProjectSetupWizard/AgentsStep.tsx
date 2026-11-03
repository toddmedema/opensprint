import { AgentProviderCliBanner } from "../AgentProviderCliBanner";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ModelSelect } from "../ModelSelect";
import { AgentReferenceModal } from "../AgentReferenceModal";
import type {
  AgentTimeoutValue,
  AgentType,
  GitWorkingMode,
  UnknownScopeStrategy,
} from "@opensprint/shared";
import {
  AGENT_ROLE_CANONICAL_ORDER,
  AGENT_ROLE_LABELS,
  AGENT_ROLE_PHASES,
  AGENT_ROLE_DESCRIPTIONS,
  DEFAULT_MAX_TOTAL_CONCURRENT_AGENTS,
  MAX_TOTAL_CONCURRENT_AGENTS_CAP,
} from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";
import { ASSET_BASE } from "../../lib/constants";
import { getMissingApiKeyRequirements, hasNoApiKeys } from "../../utils/agentConfigDefaults";
import { api } from "../../api/client";
import { DEFAULT_LMSTUDIO_BASE_URL, DEFAULT_OLLAMA_BASE_URL } from "../../lib/localModelProviders";

export interface AgentConfig {
  type: AgentType;
  model: string;
  cliCommand: string;
  timeoutMs?: AgentTimeoutValue;
  baseUrl?: string;
}

export interface EnvKeys {
  anthropic: boolean;
  cursor: boolean;
  openai: boolean;
  google?: boolean;
  claudeCli: boolean;
  codexCli?: boolean;
  cursorCli: boolean;
  ollamaCli: boolean;
  useCustomCli?: boolean;
}

export interface AgentsStepProps {
  simpleComplexityAgent: AgentConfig;
  complexComplexityAgent: AgentConfig;
  onSimpleComplexityAgentChange: (config: AgentConfig) => void;
  onComplexComplexityAgentChange: (config: AgentConfig) => void;
  envKeys: EnvKeys | null;
  modelRefreshTrigger: number;
  maxConcurrentCoders: number;
  onMaxConcurrentCodersChange: (value: number) => void;
  maxTotalConcurrentAgents?: number;
  onMaxTotalConcurrentAgentsChange?: (value: number | undefined) => void;
  unknownScopeStrategy: UnknownScopeStrategy;
  onUnknownScopeStrategyChange: (value: UnknownScopeStrategy) => void;
  gitWorkingMode: GitWorkingMode;
  onGitWorkingModeChange: (value: GitWorkingMode) => void;
  worktreeBaseBranch?: string;
  onWorktreeBaseBranchChange?: (value: string) => void;
}

export function AgentsStep({
  simpleComplexityAgent,
  complexComplexityAgent,
  onSimpleComplexityAgentChange,
  onComplexComplexityAgentChange,
  envKeys,
  modelRefreshTrigger,
  maxConcurrentCoders,
  onMaxConcurrentCodersChange,
  maxTotalConcurrentAgents,
  onMaxTotalConcurrentAgentsChange,
  unknownScopeStrategy,
  onUnknownScopeStrategyChange,
  gitWorkingMode,
  onGitWorkingModeChange,
  worktreeBaseBranch = "",
  onWorktreeBaseBranchChange,
}: AgentsStepProps) {
  const [agentReferenceOpen, setAgentReferenceOpen] = useState(false);

  const missingApiKeyRequirements = getMissingApiKeyRequirements(envKeys, [
    simpleComplexityAgent.type,
    complexComplexityAgent.type,
  ]);
  const usesClaudeCli =
    simpleComplexityAgent.type === "claude-cli" || complexComplexityAgent.type === "claude-cli";
  const claudeCliMissing = envKeys && !envKeys.claudeCli && usesClaudeCli;
  const usesCodex =
    simpleComplexityAgent.type === "codex" || complexComplexityAgent.type === "codex";
  const codexCliMissing = envKeys && !envKeys.codexCli && usesCodex;
  const usesCursor =
    simpleComplexityAgent.type === "cursor" || complexComplexityAgent.type === "cursor";
  const cursorCliMissing = envKeys && !envKeys.cursorCli && usesCursor;

  const [cursorCliLoading, setCursorCliLoading] = useState(false);
  const [cursorCliInstructions, setCursorCliInstructions] = useState<{
    installUrl: string;
    manualCommand: string;
  } | null>(null);
  const [cursorCliShowInstructions, setCursorCliShowInstructions] = useState(false);
  const [cursorCliError, setCursorCliError] = useState<string | null>(null);
  const [cursorCliCopied, setCursorCliCopied] = useState(false);

  return (
    <div className="space-y-6" data-testid="agents-step">
      <details
        className="rounded-lg border border-theme-border bg-theme-surface-muted"
        data-testid="about-agent-team-section"
      >
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-theme-text hover:bg-theme-surface-muted/50 rounded-t-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset">
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
            className="mt-3 text-sm text-brand-600 hover:text-brand-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 rounded"
          >
            Learn more
          </button>
        </div>
      </details>

      {agentReferenceOpen && <AgentReferenceModal onClose={() => setAgentReferenceOpen(false)} />}

      {missingApiKeyRequirements.length > 0 && (
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
            {hasNoApiKeys(envKeys)
              ? "You must add at least one API key to continue. "
              : "Add at least one API key to continue. "}
            <Link
              to="/settings"
              className="underline hover:opacity-80 font-medium"
              data-testid="no-api-keys-settings-link"
            >
              Open Settings
            </Link>{" "}
            to add your keys.
          </p>
        </div>
      )}
      {cursorCliMissing && (
        <div className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border">
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
      )}
      {codexCliMissing && <AgentProviderCliBanner kind="codex" />}
      {usesCodex && !codexCliMissing && (
        <p className="text-sm text-theme-info-text">
          Using Codex CLI with your ChatGPT sign-in. Run <code>codex login</code> if authentication
          is needed. No API key is required.
        </p>
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
              <label
                htmlFor="simple-provider-select"
                className="block text-sm font-medium text-theme-text mb-1"
              >
                Provider
              </label>
              <select
                id="simple-provider-select"
                className="input w-full"
                value={simpleComplexityAgent.type}
                onChange={(e) => {
                  const type = e.target.value as AgentType;
                  onSimpleComplexityAgentChange({
                    ...simpleComplexityAgent,
                    type,
                    model: "",
                    baseUrl:
                      type === "lmstudio"
                        ? DEFAULT_LMSTUDIO_BASE_URL
                        : type === "ollama"
                          ? DEFAULT_OLLAMA_BASE_URL
                          : simpleComplexityAgent.baseUrl,
                  });
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
            {(simpleComplexityAgent.type === "lmstudio" ||
              simpleComplexityAgent.type === "ollama") && (
              <div className="flex-1 min-w-[180px]">
                <label
                  htmlFor="simple-base-url"
                  className="block text-sm font-medium text-theme-text mb-1"
                >
                  Base URL
                </label>
                <input
                  id="simple-base-url"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder={
                    simpleComplexityAgent.type === "ollama"
                      ? DEFAULT_OLLAMA_BASE_URL
                      : DEFAULT_LMSTUDIO_BASE_URL
                  }
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
                <label
                  htmlFor="simple-agent-select"
                  className="block text-sm font-medium text-theme-text mb-1"
                >
                  Agent
                </label>
                <ModelSelect
                  id="simple-agent-select"
                  provider={simpleComplexityAgent.type}
                  value={simpleComplexityAgent.model || null}
                  onChange={(id) =>
                    onSimpleComplexityAgentChange({ ...simpleComplexityAgent, model: id ?? "" })
                  }
                  refreshTrigger={modelRefreshTrigger}
                  baseUrl={
                    simpleComplexityAgent.type === "lmstudio" ||
                    simpleComplexityAgent.type === "ollama"
                      ? simpleComplexityAgent.baseUrl ||
                        (simpleComplexityAgent.type === "ollama"
                          ? DEFAULT_OLLAMA_BASE_URL
                          : DEFAULT_LMSTUDIO_BASE_URL)
                      : undefined
                  }
                />
              </div>
            ) : (
              <div className="flex-1 min-w-[200px]">
                <label
                  htmlFor="simple-cli-command"
                  className="block text-sm font-medium text-theme-text mb-1"
                >
                  CLI command
                </label>
                <input
                  id="simple-cli-command"
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
              <label
                htmlFor="complex-provider-select"
                className="block text-sm font-medium text-theme-text mb-1"
              >
                Provider
              </label>
              <select
                id="complex-provider-select"
                className="input w-full"
                value={complexComplexityAgent.type}
                onChange={(e) => {
                  const type = e.target.value as AgentType;
                  onComplexComplexityAgentChange({
                    ...complexComplexityAgent,
                    type,
                    model: "",
                    baseUrl:
                      type === "lmstudio"
                        ? DEFAULT_LMSTUDIO_BASE_URL
                        : type === "ollama"
                          ? DEFAULT_OLLAMA_BASE_URL
                          : complexComplexityAgent.baseUrl,
                  });
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
            {(complexComplexityAgent.type === "lmstudio" ||
              complexComplexityAgent.type === "ollama") && (
              <div className="flex-1 min-w-[180px]">
                <label
                  htmlFor="complex-base-url"
                  className="block text-sm font-medium text-theme-text mb-1"
                >
                  Base URL
                </label>
                <input
                  id="complex-base-url"
                  type="text"
                  className="input w-full font-mono text-sm"
                  placeholder={
                    complexComplexityAgent.type === "ollama"
                      ? DEFAULT_OLLAMA_BASE_URL
                      : DEFAULT_LMSTUDIO_BASE_URL
                  }
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
                <label
                  htmlFor="complex-agent-select"
                  className="block text-sm font-medium text-theme-text mb-1"
                >
                  Agent
                </label>
                <ModelSelect
                  id="complex-agent-select"
                  provider={complexComplexityAgent.type}
                  value={complexComplexityAgent.model || null}
                  onChange={(id) =>
                    onComplexComplexityAgentChange({ ...complexComplexityAgent, model: id ?? "" })
                  }
                  refreshTrigger={modelRefreshTrigger}
                  baseUrl={
                    complexComplexityAgent.type === "lmstudio" ||
                    complexComplexityAgent.type === "ollama"
                      ? complexComplexityAgent.baseUrl ||
                        (complexComplexityAgent.type === "ollama"
                          ? DEFAULT_OLLAMA_BASE_URL
                          : DEFAULT_LMSTUDIO_BASE_URL)
                      : undefined
                  }
                />
              </div>
            ) : (
              <div className="flex-1 min-w-[200px]">
                <label
                  htmlFor="complex-cli-command"
                  className="block text-sm font-medium text-theme-text mb-1"
                >
                  CLI command
                </label>
                <input
                  id="complex-cli-command"
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
      <hr />
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-theme-text">Git working mode</h3>
          <p className="text-xs text-theme-muted">
            Worktree creates isolated worktrees per task for parallel execution. Branches uses a
            single branch in the main repo (sequential only).
          </p>
        </div>
        <select
          className="input w-48 shrink-0"
          value={gitWorkingMode}
          onChange={(e) => onGitWorkingModeChange(e.target.value as GitWorkingMode)}
          data-testid="git-working-mode-select"
        >
          <option value="worktree">Worktree (default)</option>
          <option value="branches">Branches</option>
        </select>
      </div>
      {onWorktreeBaseBranchChange && (
        <>
          <hr />
          <div>
            <label
              htmlFor="worktree-base-branch-input"
              className="block text-sm font-medium text-theme-text mb-1"
            >
              Base branch
            </label>
            <p className="text-xs text-theme-muted mb-2">
              Task branches are created from and merged into this branch. Leave blank to auto-detect
              the repo&apos;s base branch during setup.
            </p>
            <input
              id="worktree-base-branch-input"
              type="text"
              className="input w-full max-w-xs"
              value={worktreeBaseBranch}
              onChange={(e) => onWorktreeBaseBranchChange(e.target.value)}
              placeholder="main"
              data-testid="worktree-base-branch-input"
            />
          </div>
        </>
      )}
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
                <label
                  htmlFor="max-concurrent-coders-slider"
                  className="block text-sm font-medium text-theme-text mb-2"
                >
                  Max Concurrent Coders: <span className="font-bold">{maxConcurrentCoders}</span>
                </label>
                <input
                  id="max-concurrent-coders-slider"
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
              {onMaxTotalConcurrentAgentsChange && (
                <div className="pt-4 border-t border-theme-border space-y-3">
                  <div className="flex items-start gap-2">
                    <input
                      id="wizard-max-total-agents-cap-enabled"
                      type="checkbox"
                      className="mt-1 rounded border-theme-border"
                      checked={maxTotalConcurrentAgents != null}
                      onChange={(e) => {
                        if (e.target.checked) {
                          onMaxTotalConcurrentAgentsChange(
                            Math.min(
                              MAX_TOTAL_CONCURRENT_AGENTS_CAP,
                              Math.max(DEFAULT_MAX_TOTAL_CONCURRENT_AGENTS, maxConcurrentCoders)
                            )
                          );
                        } else {
                          onMaxTotalConcurrentAgentsChange(undefined);
                        }
                      }}
                      data-testid="wizard-max-total-agents-cap-checkbox"
                    />
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor="wizard-max-total-agents-cap-enabled"
                        className="text-sm font-medium text-theme-text cursor-pointer"
                      >
                        Cap total concurrent agents (all phases)
                      </label>
                      <p className="text-xs text-theme-muted mt-1">
                        Optional limit on planning, coding, review, and merger agents together (e.g.
                        for API rate limits).
                      </p>
                    </div>
                  </div>
                  {maxTotalConcurrentAgents != null && (
                    <div>
                      <label
                        htmlFor="wizard-max-total-concurrent-agents-slider"
                        className="block text-sm font-medium text-theme-text mb-2"
                      >
                        Max total concurrent agents:{" "}
                        <span className="font-bold">{maxTotalConcurrentAgents}</span>
                      </label>
                      <input
                        id="wizard-max-total-concurrent-agents-slider"
                        type="range"
                        min={1}
                        max={MAX_TOTAL_CONCURRENT_AGENTS_CAP}
                        step={1}
                        value={maxTotalConcurrentAgents}
                        onChange={(e) => onMaxTotalConcurrentAgentsChange(Number(e.target.value))}
                        className="w-full accent-brand-600"
                        data-testid="wizard-max-total-concurrent-agents-slider"
                      />
                      <div className="flex justify-between text-xs text-theme-muted mt-1">
                        <span>1</span>
                        <span>{MAX_TOTAL_CONCURRENT_AGENTS_CAP}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {maxConcurrentCoders > 1 && (
                <div>
                  <label
                    htmlFor="unknown-scope-strategy-select"
                    className="block text-sm font-medium text-theme-text mb-1"
                  >
                    Unknown Scope Strategy
                  </label>
                  <p className="text-xs text-theme-muted mb-2">
                    Agents identify task scope based on the files they expect it to touch, and
                    parallel agents won&apos;t work on tasks with conflicting expected files. What
                    should agents do when the scope is unclear?
                  </p>
                  <select
                    id="unknown-scope-strategy-select"
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
