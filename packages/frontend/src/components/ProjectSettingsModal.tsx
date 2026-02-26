import { useState, useEffect } from "react";
import { FolderBrowser } from "./FolderBrowser";
import { CloseButton } from "./CloseButton";
import { ModelSelect } from "./ModelSelect";
import { ApiKeysSection } from "./ApiKeysSection";
import { useTheme } from "../contexts/ThemeContext";
import { useDisplayPreferences } from "../contexts/DisplayPreferencesContext";
import type { RunningAgentsDisplayMode } from "../lib/displayPrefs";
import { api } from "../api/client";
import type {
  Project,
  ProjectSettings,
  AgentType,
  DeploymentMode,
  GitWorkingMode,
  HilNotificationMode,
  ReviewMode,
  UnknownScopeStrategy,
} from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG, DEFAULT_REVIEW_MODE } from "@opensprint/shared";

interface ProjectSettingsModalProps {
  project: Project;
  onClose: () => void;
  onSaved?: () => void;
}

type Tab = "basics" | "agents" | "deployment" | "hil" | "display";

const TABS: { key: Tab; label: string }[] = [
  { key: "basics", label: "Project Info" },
  { key: "agents", label: "Agent Config" },
  { key: "deployment", label: "Deliver" },
  { key: "hil", label: "Autonomy" },
  { key: "display", label: "Display" },
];

const THEME_OPTIONS: { value: "light" | "dark" | "system"; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const RUNNING_AGENTS_DISPLAY_OPTIONS: { value: RunningAgentsDisplayMode; label: string }[] = [
  { value: "count", label: "Count" },
  { value: "icons", label: "Icons" },
  { value: "both", label: "Both" },
];

export function ProjectSettingsModal({ project, onClose, onSaved }: ProjectSettingsModalProps) {
  const { preference: themePreference, setTheme } = useTheme();
  const { runningAgentsDisplayMode, setRunningAgentsDisplayMode } = useDisplayPreferences();
  const [activeTab, setActiveTab] = useState<Tab>("basics");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  // Project basics
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);

  // Settings
  const [settings, setSettings] = useState<ProjectSettings | null>(null);

  // API key status (for agents tab)
  const [envKeys, setEnvKeys] = useState<{
    anthropic: boolean;
    cursor: boolean;
    claudeCli: boolean;
  } | null>(null);
  const [savingKey, setSavingKey] = useState<"ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | null>(null);
  const [keyInput, setKeyInput] = useState<{ anthropic: string; cursor: string }>({
    anthropic: "",
    cursor: "",
  });
  const [modelRefreshTrigger, setModelRefreshTrigger] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.projects
      .getSettings(project.id)
      .then((data) => {
        if (!cancelled) {
          setSettings(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load settings");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Fetch env key status when agents tab is active
  useEffect(() => {
    if (activeTab !== "agents") return;
    api.env
      .getKeys()
      .then(setEnvKeys)
      .catch(() => setEnvKeys(null));
  }, [activeTab]);

  const simpleComplexityAgent = settings?.simpleComplexityAgent ?? settings?.simpleComplexityAgent ?? {
    type: "cursor" as AgentType,
    model: null,
    cliCommand: null,
  };
  const complexComplexityAgent = settings?.complexComplexityAgent ?? settings?.complexComplexityAgent ?? {
    type: "cursor" as AgentType,
    model: null,
    cliCommand: null,
  };
  const deployment = settings?.deployment ?? { mode: "custom" as DeploymentMode };
  const hilConfig = settings?.hilConfig ?? DEFAULT_HIL_CONFIG;
  const gitWorkingMode = settings?.gitWorkingMode ?? "worktree";

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await Promise.all([
        api.projects.update(project.id, {
          name,
          repoPath,
        }),
        api.projects.updateSettings(project.id, {
          simpleComplexityAgent: {
            type: simpleComplexityAgent.type,
            model: simpleComplexityAgent.model || null,
            cliCommand: simpleComplexityAgent.cliCommand || null,
          },
          complexComplexityAgent: {
            type: complexComplexityAgent.type,
            model: complexComplexityAgent.model || null,
            cliCommand: complexComplexityAgent.cliCommand || null,
          },
          deployment: {
            mode: deployment.mode,
            expoConfig:
              deployment.mode === "expo"
                ? { channel: deployment.expoConfig?.channel ?? "preview" }
                : undefined,
            customCommand: deployment.customCommand ?? undefined,
            webhookUrl: deployment.webhookUrl ?? undefined,
            rollbackCommand: deployment.rollbackCommand ?? undefined,
            targets: deployment.targets,
            envVars: deployment.envVars,
            autoDeployOnEpicCompletion: deployment.autoDeployOnEpicCompletion ?? false,
            autoDeployOnEvalResolution: deployment.autoDeployOnEvalResolution ?? false,
            autoResolveFeedbackOnTaskCompletion:
              deployment.autoResolveFeedbackOnTaskCompletion ?? false,
          },
          hilConfig,
          testCommand: settings?.testCommand ?? undefined,
          reviewMode: settings?.reviewMode ?? DEFAULT_REVIEW_MODE,
          maxConcurrentCoders:
            gitWorkingMode === "branches" ? 1 : (settings?.maxConcurrentCoders ?? 1),
          unknownScopeStrategy: settings?.unknownScopeStrategy ?? "optimistic",
          gitWorkingMode,
          apiKeys: settings?.apiKeys,
        }),
      ]);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const defaultAgent = { type: "cursor" as AgentType, model: null, cliCommand: null };

  const updateSimpleComplexityAgent = (updates: Partial<typeof simpleComplexityAgent>) => {
    setSettings((s) =>
      s
        ? {
            ...s,
            simpleComplexityAgent: {
              ...(s.simpleComplexityAgent ?? s.simpleComplexityAgent ?? defaultAgent),
              ...updates,
            },
          }
        : null
    );
  };

  const updateComplexComplexityAgent = (updates: Partial<typeof complexComplexityAgent>) => {
    setSettings((s) =>
      s
        ? {
            ...s,
            complexComplexityAgent: {
              ...(s.complexComplexityAgent ?? s.complexComplexityAgent ?? defaultAgent),
              ...updates,
            },
          }
        : null
    );
  };

  const updateDeployment = (updates: Partial<typeof deployment>) => {
    setSettings((s) => (s ? { ...s, deployment: { ...s.deployment, ...updates } } : null));
  };

  const updateHilConfig = (key: keyof typeof hilConfig, value: HilNotificationMode) => {
    setSettings((s) => (s ? { ...s, hilConfig: { ...s.hilConfig, [key]: value } } : null));
  };

  const handleSaveKey = async (envKey: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY") => {
    const value = envKey === "ANTHROPIC_API_KEY" ? keyInput.anthropic : keyInput.cursor;
    if (!value.trim()) return;
    setSavingKey(envKey);
    try {
      await api.env.saveKey(envKey, value.trim());
      setEnvKeys((prev) =>
        prev ? { ...prev, [envKey === "ANTHROPIC_API_KEY" ? "anthropic" : "cursor"]: true } : null
      );
      setKeyInput((prev) => ({
        ...prev,
        [envKey === "ANTHROPIC_API_KEY" ? "anthropic" : "cursor"]: "",
      }));
      setModelRefreshTrigger((n) => n + 1);
    } catch {
      // Error handled by api client
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-theme-overlay backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative bg-theme-surface rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[85vh] overflow-hidden"
        data-testid="settings-modal"
      >
        {/* Header */}
        <div
          className="flex-shrink-0 flex items-center justify-between px-5 py-4 border-b border-theme-border"
          data-testid="settings-modal-header"
        >
          <h2 className="text-lg font-semibold text-theme-text">Project Settings</h2>
          <CloseButton onClick={onClose} ariaLabel="Close settings modal" />
        </div>

        {/* Tabs */}
        <div
          className="flex-shrink-0 flex flex-nowrap gap-1 px-5 pt-3 pb-2 border-b border-theme-border overflow-x-auto overflow-y-hidden"
          data-testid="settings-modal-tabs"
        >
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
                activeTab === tab.key
                  ? "bg-brand-600 text-white"
                  : "text-theme-muted hover:text-theme-text hover:bg-theme-border-subtle"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div
          className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-5 py-4 overscroll-contain"
          data-testid="settings-modal-content"
        >
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {activeTab === "basics" && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-theme-text mb-1">
                      Project Name
                    </label>
                    <input
                      type="text"
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="My Awesome App"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-text mb-1">
                      Project folder
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="input font-mono text-sm flex-1"
                        value={repoPath}
                        onChange={(e) => setRepoPath(e.target.value)}
                        placeholder="/Users/you/projects/my-app"
                      />
                      <button
                        type="button"
                        onClick={() => setShowFolderBrowser(true)}
                        className="btn-secondary text-sm px-3 whitespace-nowrap flex items-center gap-1.5"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                          />
                        </svg>
                        Browse
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-theme-muted">
                      Absolute path to the project repository
                    </p>
                  </div>
                </div>
              )}

              {activeTab === "agents" && (
                <div className="space-y-6">
                  {(() => {
                    const selectedTypes = new Set([
                      simpleComplexityAgent.type,
                      complexComplexityAgent.type,
                    ]);
                    const needsAnthropic =
                      envKeys && !envKeys.anthropic && selectedTypes.has("claude");
                    const needsCursor = envKeys && !envKeys.cursor && selectedTypes.has("cursor");
                    const claudeCliMissing =
                      envKeys && !envKeys.claudeCli && selectedTypes.has("claude-cli");
                    return (
                      <>
                        {(needsAnthropic || needsCursor) && (
                          <>
                            <div className="p-3 rounded-lg bg-theme-warning-bg border border-theme-warning-border">
                              <p className="text-sm text-theme-warning-text">
                                <strong>API key required:</strong>{" "}
                                {needsAnthropic && needsCursor ? (
                                  <>
                                    Add your{" "}
                                    <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> and{" "}
                                    <code className="font-mono text-xs">CURSOR_API_KEY</code> to
                                    continue.
                                  </>
                                ) : needsAnthropic ? (
                                  <>
                                    Add your{" "}
                                    <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> to
                                    use Claude (API). Get one from{" "}
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
                                    Add your{" "}
                                    <code className="font-mono text-xs">CURSOR_API_KEY</code> to use
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
                                      onChange={(e) =>
                                        setKeyInput((p) => ({ ...p, anthropic: e.target.value }))
                                      }
                                      autoComplete="off"
                                    />
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleSaveKey("ANTHROPIC_API_KEY")}
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
                                      onChange={(e) =>
                                        setKeyInput((p) => ({ ...p, cursor: e.target.value }))
                                      }
                                      autoComplete="off"
                                    />
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleSaveKey("CURSOR_API_KEY")}
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
                              and run <code className="font-mono text-xs">claude login</code> to
                              authenticate.
                            </p>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <div data-testid="task-complexity-section">
                    <h3 className="text-sm font-semibold text-theme-text mb-3">Task Complexity</h3>
                    <p className="text-xs text-theme-muted mb-3">
                      Simple: routine tasks. Complex: challenging tasks. Each row configures provider
                      and agent.
                    </p>
                    <div className="space-y-4">
                      {/* Row 1: Simple */}
                      <div className="flex flex-wrap items-end gap-3">
                        <span className="w-16 text-sm font-medium text-theme-text shrink-0">
                          Simple
                        </span>
                        <div className="flex-1 min-w-[140px]">
                          <label className="block text-xs font-medium text-theme-muted mb-1">
                            Provider
                          </label>
                          <select
                            className="input w-full"
                            value={simpleComplexityAgent.type}
                            onChange={(e) =>
                              updateSimpleComplexityAgent({
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
                            <label className="block text-xs font-medium text-theme-muted mb-1">
                              Agent
                            </label>
                            <ModelSelect
                              provider={simpleComplexityAgent.type}
                              value={simpleComplexityAgent.model}
                              onChange={(id) => updateSimpleComplexityAgent({ model: id })}
                              projectId={project.id}
                              refreshTrigger={modelRefreshTrigger}
                            />
                          </div>
                        ) : (
                          <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs font-medium text-theme-muted mb-1">
                              CLI command
                            </label>
                            <input
                              type="text"
                              className="input w-full font-mono text-sm"
                              placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                              value={simpleComplexityAgent.cliCommand ?? ""}
                              onChange={(e) =>
                                updateSimpleComplexityAgent({ cliCommand: e.target.value || null })
                              }
                            />
                          </div>
                        )}
                      </div>
                      {/* Row 2: Complex */}
                      <div className="flex flex-wrap items-end gap-3">
                        <span className="w-16 text-sm font-medium text-theme-text shrink-0">
                          Complex
                        </span>
                        <div className="flex-1 min-w-[140px]">
                          <label className="block text-xs font-medium text-theme-muted mb-1">
                            Provider
                          </label>
                          <select
                            className="input w-full"
                            value={complexComplexityAgent.type}
                            onChange={(e) =>
                              updateComplexComplexityAgent({ type: e.target.value as AgentType })
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
                            <label className="block text-xs font-medium text-theme-muted mb-1">
                              Agent
                            </label>
                            <ModelSelect
                              provider={complexComplexityAgent.type}
                              value={complexComplexityAgent.model}
                              onChange={(id) => updateComplexComplexityAgent({ model: id })}
                              projectId={project.id}
                              refreshTrigger={modelRefreshTrigger}
                            />
                          </div>
                        ) : (
                          <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs font-medium text-theme-muted mb-1">
                              CLI command
                            </label>
                            <input
                              type="text"
                              className="input w-full font-mono text-sm"
                              placeholder="e.g. my-agent or /usr/local/bin/my-agent --model gpt-4"
                              value={complexComplexityAgent.cliCommand ?? ""}
                              onChange={(e) =>
                                updateComplexComplexityAgent({ cliCommand: e.target.value || null })
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <hr />
                  <div>
                    <h3 className="text-sm font-semibold text-theme-text mb-1">Test Command</h3>
                    <p className="text-xs text-theme-muted mb-3">
                      Override the test command (auto-detected from package.json). Leave empty to
                      use detection.
                    </p>
                    <input
                      type="text"
                      className="input w-full font-mono text-sm"
                      placeholder="e.g. npm test or npx vitest run"
                      value={settings?.testCommand ?? ""}
                      onChange={(e) =>
                        setSettings((s) =>
                          s ? { ...s, testCommand: e.target.value.trim() || null } : null
                        )
                      }
                    />
                  </div>
                  <hr />
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-theme-text">Code Review</h3>
                      <p className="text-xs text-theme-muted">
                        After the coding agent completes a task, a review agent can validate the
                        implementation against the ticket specification, verify tests pass and cover
                        the scope, and check code quality. Rejected work is sent back to the coding
                        agent with feedback for improvement.
                      </p>
                    </div>
                    <select
                      data-testid="review-mode-select"
                      className="input w-48 shrink-0"
                      value={settings?.reviewMode ?? DEFAULT_REVIEW_MODE}
                      onChange={(e) =>
                        setSettings((s) =>
                          s ? { ...s, reviewMode: e.target.value as ReviewMode } : null
                        )
                      }
                    >
                      <option value="never">Never</option>
                      <option value="always">Always</option>
                      <option value="on-failure-only">On Failure Only</option>
                    </select>
                  </div>
                  <hr />
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-theme-text">Git working mode</h3>
                      <p className="text-xs text-theme-muted">
                        {gitWorkingMode === "worktree"
                          ? "Worktree: isolated directories per task, supports parallel agents."
                          : "Branches: agents work in main repo on task branches, one at a time."}
                      </p>
                    </div>
                    <select
                      className="input w-48 shrink-0"
                      value={gitWorkingMode}
                      onChange={(e) =>
                        setSettings((s) =>
                          s ? { ...s, gitWorkingMode: e.target.value as GitWorkingMode } : null
                        )
                      }
                      data-testid="git-working-mode-select"
                    >
                      <option value="worktree">Worktree</option>
                      <option value="branches">Branches</option>
                    </select>
                  </div>
                  <hr />
                  {gitWorkingMode === "branches" ? (
                    <div className="p-3 rounded-lg bg-theme-bg-elevated border border-theme-border">
                      <p className="text-sm text-theme-muted">Branches mode uses a single coder.</p>
                    </div>
                  ) : (
                    <div>
                      <h3 className="text-sm font-semibold text-theme-text mb-1">Parallelism</h3>
                      <p className="text-xs text-theme-muted mb-3">
                        Run multiple coding agents simultaneously on independent tasks. Higher
                        values speed up builds but use more resources.
                      </p>
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-theme-text mb-2">
                            Max Concurrent Coders:{" "}
                            <span className="font-bold">{settings?.maxConcurrentCoders ?? 1}</span>
                          </label>
                          <input
                            type="range"
                            min={1}
                            max={10}
                            step={1}
                            value={settings?.maxConcurrentCoders ?? 1}
                            onChange={(e) =>
                              setSettings((s) =>
                                s ? { ...s, maxConcurrentCoders: Number(e.target.value) } : null
                              )
                            }
                            className="w-full accent-brand-600"
                            data-testid="max-concurrent-coders-slider"
                          />
                          <div className="flex justify-between text-xs text-theme-muted mt-1">
                            <span>1 (sequential)</span>
                            <span>10</span>
                          </div>
                        </div>
                        {(settings?.maxConcurrentCoders ?? 1) > 1 && (
                          <div>
                            <label className="block text-sm font-medium text-theme-text mb-1">
                              Unknown Scope Strategy
                            </label>
                            <p className="text-xs text-theme-muted mb-2">
                              When file scope can&apos;t be predicted for a task, should the
                              scheduler serialize it or run it in parallel?
                            </p>
                            <select
                              className="input"
                              value={settings?.unknownScopeStrategy ?? "optimistic"}
                              onChange={(e) =>
                                setSettings((s) =>
                                  s
                                    ? {
                                        ...s,
                                        unknownScopeStrategy: e.target
                                          .value as UnknownScopeStrategy,
                                      }
                                    : null
                                )
                              }
                              data-testid="unknown-scope-strategy-select"
                            >
                              <option value="optimistic">
                                Optimistic (parallelize, rely on merger)
                              </option>
                              <option value="conservative">Conservative (serialize)</option>
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <ApiKeysSection
                    settings={settings}
                    onApiKeysChange={(apiKeys) =>
                      setSettings((s) =>
                        s ? { ...s, apiKeys: { ...s.apiKeys, ...apiKeys } } : null
                      )
                    }
                  />
                </div>
              )}

              {activeTab === "deployment" && (
                <div className="space-y-4">
                  <div className="space-y-3 p-3 rounded-lg bg-theme-bg-elevated border border-theme-border">
                    <h3 className="text-sm font-semibold text-theme-text">Auto-deploy triggers</h3>
                    <p className="text-xs text-theme-muted">
                      Both off by default. Enable to auto-trigger deployment.
                    </p>
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <span className="text-sm text-theme-text">
                        Auto-deploy on epic completion
                      </span>
                      <input
                        type="checkbox"
                        checked={deployment.autoDeployOnEpicCompletion ?? false}
                        onChange={(e) =>
                          updateDeployment({ autoDeployOnEpicCompletion: e.target.checked })
                        }
                        className="rounded"
                        data-testid="auto-deploy-epic-toggle"
                      />
                    </label>
                    <p className="text-xs text-theme-muted ml-1">
                      When all tasks in an epic reach Done, trigger deployment automatically.
                    </p>
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <span className="text-sm text-theme-text">
                        Auto-deploy on Evaluate resolution
                      </span>
                      <input
                        type="checkbox"
                        checked={deployment.autoDeployOnEvalResolution ?? false}
                        onChange={(e) =>
                          updateDeployment({ autoDeployOnEvalResolution: e.target.checked })
                        }
                        className="rounded"
                        data-testid="auto-deploy-eval-toggle"
                      />
                    </label>
                    <p className="text-xs text-theme-muted ml-1">
                      When all critical (bug) feedback is resolved, trigger deployment
                      automatically.
                    </p>
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <span className="text-sm text-theme-text">
                        Auto-resolve feedback when tasks done
                      </span>
                      <input
                        type="checkbox"
                        checked={deployment.autoResolveFeedbackOnTaskCompletion ?? false}
                        onChange={(e) =>
                          updateDeployment({
                            autoResolveFeedbackOnTaskCompletion: e.target.checked,
                          })
                        }
                        className="rounded"
                        data-testid="auto-resolve-feedback-toggle"
                      />
                    </label>
                    <p className="text-xs text-theme-muted ml-1">
                      When all tasks created from feedback reach Done, mark the feedback as
                      resolved.
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme-text mb-3">
                      Delivery Mode
                    </label>
                    <div className="space-y-3">
                      <label className="flex items-start gap-3 p-3 rounded-lg border border-theme-border hover:border-theme-info-border cursor-pointer transition-colors">
                        <input
                          type="radio"
                          name="deployment"
                          value="expo"
                          checked={deployment.mode === "expo"}
                          onChange={() =>
                            updateDeployment({ mode: "expo", expoConfig: { channel: "preview" } })
                          }
                          className="mt-0.5"
                        />
                        <div>
                          <p className="text-sm font-medium text-theme-text">Expo.dev</p>
                          <p className="text-xs text-theme-muted">
                            Automatic delivery for React Native and web projects
                          </p>
                        </div>
                      </label>
                      <label className="flex items-start gap-3 p-3 rounded-lg border border-theme-border hover:border-theme-info-border cursor-pointer transition-colors">
                        <input
                          type="radio"
                          name="deployment"
                          value="custom"
                          checked={deployment.mode === "custom"}
                          onChange={() => updateDeployment({ mode: "custom" })}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="text-sm font-medium text-theme-text">Custom Pipeline</p>
                          <p className="text-xs text-theme-muted">
                            Command or webhook triggered after Execute completion
                          </p>
                        </div>
                      </label>
                    </div>
                  </div>
                  {deployment.mode === "custom" && (
                    <div className="space-y-3 pt-2 border-t border-theme-border">
                      <div>
                        <h4 className="text-sm font-medium text-theme-text mb-2">
                          Delivery targets
                        </h4>
                        <p className="text-xs text-theme-muted mb-2">
                          Define staging/production targets with per-target command or webhook.
                        </p>
                        {(deployment.targets ?? []).map((t, i) => (
                          <div
                            key={i}
                            className="mb-3 p-3 rounded-lg border border-theme-border bg-theme-surface"
                          >
                            <div className="flex justify-between items-center mb-2">
                              <input
                                type="text"
                                className="input flex-1 mr-2 font-mono text-sm"
                                placeholder="Target name (e.g. staging, production)"
                                value={t.name}
                                onChange={(e) => {
                                  const next = [...(deployment.targets ?? [])];
                                  next[i] = { ...t, name: e.target.value };
                                  updateDeployment({ targets: next });
                                }}
                              />
                              <label className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={t.isDefault ?? false}
                                  onChange={(e) => {
                                    const next = (deployment.targets ?? []).map((x, j) =>
                                      j === i
                                        ? { ...x, isDefault: e.target.checked }
                                        : { ...x, isDefault: false }
                                    );
                                    updateDeployment({ targets: next });
                                  }}
                                />
                                default
                              </label>
                              <button
                                type="button"
                                onClick={() => {
                                  const next = (deployment.targets ?? []).filter((_, j) => j !== i);
                                  updateDeployment({ targets: next.length ? next : undefined });
                                }}
                                className="text-theme-error-text hover:opacity-80 text-xs ml-1"
                              >
                                Remove
                              </button>
                            </div>
                            <input
                              type="text"
                              className="input w-full font-mono text-xs mb-1"
                              placeholder="Command (e.g. ./deploy-staging.sh)"
                              value={t.command ?? ""}
                              onChange={(e) => {
                                const next = [...(deployment.targets ?? [])];
                                next[i] = { ...t, command: e.target.value || undefined };
                                updateDeployment({ targets: next });
                              }}
                            />
                            <input
                              type="url"
                              className="input w-full font-mono text-xs mb-1"
                              placeholder="Webhook URL (alternative to command)"
                              value={t.webhookUrl ?? ""}
                              onChange={(e) => {
                                const next = [...(deployment.targets ?? [])];
                                next[i] = { ...t, webhookUrl: e.target.value || undefined };
                                updateDeployment({ targets: next });
                              }}
                            />
                            <input
                              type="text"
                              className="input w-full font-mono text-xs"
                              placeholder="Rollback command (e.g. ./rollback.sh)"
                              value={t.rollbackCommand ?? ""}
                              onChange={(e) => {
                                const next = [...(deployment.targets ?? [])];
                                next[i] = { ...t, rollbackCommand: e.target.value || undefined };
                                updateDeployment({ targets: next });
                              }}
                            />
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            const next = [
                              ...(deployment.targets ?? []),
                              { name: "", isDefault: (deployment.targets ?? []).length === 0 },
                            ];
                            updateDeployment({ targets: next });
                          }}
                          className="btn-secondary text-sm"
                        >
                          + Add target
                        </button>
                      </div>
                      <div className="pt-3 border-t border-theme-border">
                        <h4 className="text-sm font-medium text-theme-text mb-2">
                          Environment variables
                        </h4>
                        <p className="text-xs text-theme-muted mb-2">
                          Key-value pairs passed to deployment commands and webhooks.
                        </p>
                        {Object.entries(deployment.envVars ?? {}).map(([k, v], i) => (
                          <div key={i} className="flex gap-2 mb-2">
                            <input
                              type="text"
                              className="input flex-1 font-mono text-xs"
                              placeholder="KEY"
                              value={k}
                              onChange={(e) => {
                                const next = { ...(deployment.envVars ?? {}) };
                                delete next[k];
                                if (e.target.value) next[e.target.value] = v;
                                updateDeployment({
                                  envVars: Object.keys(next).length ? next : undefined,
                                });
                              }}
                            />
                            <input
                              type="text"
                              className="input flex-1 font-mono text-xs"
                              placeholder="value"
                              value={v}
                              onChange={(e) => {
                                const next = { ...(deployment.envVars ?? {}), [k]: e.target.value };
                                updateDeployment({ envVars: next });
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...(deployment.envVars ?? {}) };
                                delete next[k];
                                updateDeployment({
                                  envVars: Object.keys(next).length ? next : undefined,
                                });
                              }}
                              className="text-theme-error-text hover:opacity-80 text-xs"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            const key = prompt("Environment variable name:");
                            if (key && !(deployment.envVars ?? {})[key]) {
                              updateDeployment({
                                envVars: { ...(deployment.envVars ?? {}), [key]: "" },
                              });
                            }
                          }}
                          className="btn-secondary text-sm"
                        >
                          + Add env var
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "hil" && (
                <div className="space-y-4">
                  <p className="text-sm text-theme-muted mb-4">
                    Configure when Open Sprint should pause for your input vs. proceed autonomously.
                  </p>
                  {(
                    [
                      {
                        key: "scopeChanges" as const,
                        label: "Scope Changes",
                        desc: "Adds, removes, or alters features",
                      },
                      {
                        key: "architectureDecisions" as const,
                        label: "Architecture Decisions",
                        desc: "Tech stack, integrations, schema changes",
                      },
                      {
                        key: "dependencyModifications" as const,
                        label: "Dependency Modifications",
                        desc: "Task reordering and re-prioritization",
                      },
                    ] as const
                  ).map((cat) => (
                    <div
                      key={cat.key}
                      className="flex items-center justify-between p-3 rounded-lg bg-theme-bg-elevated"
                    >
                      <div>
                        <p className="text-sm font-medium text-theme-text">{cat.label}</p>
                        <p className="text-xs text-theme-muted">{cat.desc}</p>
                      </div>
                      <select
                        className="input w-48"
                        value={hilConfig[cat.key]}
                        onChange={(e) =>
                          updateHilConfig(cat.key, e.target.value as HilNotificationMode)
                        }
                      >
                        <option value="requires_approval">Requires Approval</option>
                        <option value="notify_and_proceed">Notify & Proceed</option>
                        <option value="automated">Automated</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "display" && (
                <div className="space-y-4" data-testid="display-section">
                  <h3 className="text-sm font-semibold text-theme-text">Theme</h3>
                  <p className="text-xs text-theme-muted mb-3">
                    Choose how Open Sprint looks. System follows your operating system preference.
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    {THEME_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setTheme(opt.value)}
                        data-testid={`theme-option-${opt.value}`}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          themePreference === opt.value
                            ? "bg-brand-600 text-white"
                            : "bg-theme-border-subtle text-theme-text hover:bg-theme-bg-elevated"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <h3 className="text-sm font-semibold text-theme-text mt-6">
                    Running agents display mode
                  </h3>
                  <p className="text-xs text-theme-muted mb-3">
                    How to show running agents in the navbar and execute view: count only, icons
                    only, or both.
                  </p>
                  <select
                    value={runningAgentsDisplayMode}
                    onChange={(e) =>
                      setRunningAgentsDisplayMode(e.target.value as RunningAgentsDisplayMode)
                    }
                    data-testid="running-agents-display-mode"
                    className="rounded-lg border border-theme-border bg-theme-bg pl-3 pr-10 py-2 text-sm text-theme-text focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  >
                    {RUNNING_AGENTS_DISPLAY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 mb-3 p-3 bg-theme-error-bg border border-theme-error-border rounded-lg">
            <p className="text-sm text-theme-error-text">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex-shrink-0 flex justify-end gap-2 px-5 py-4 border-t border-theme-border bg-theme-bg rounded-b-xl">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={
              saving ||
              loading ||
              (simpleComplexityAgent.type === "custom" &&
                !(simpleComplexityAgent.cliCommand ?? "").trim()) ||
              (complexComplexityAgent.type === "custom" &&
                !(complexComplexityAgent.cliCommand ?? "").trim())
            }
            className="btn-primary disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>

      {showFolderBrowser && (
        <FolderBrowser
          initialPath={repoPath || undefined}
          onSelect={(path) => {
            setRepoPath(path);
            setShowFolderBrowser(false);
          }}
          onCancel={() => setShowFolderBrowser(false)}
        />
      )}
    </div>
  );
}
