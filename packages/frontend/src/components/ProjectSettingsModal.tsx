import { useState, useEffect } from "react";
import { FolderBrowser } from "./FolderBrowser";
import { ModelSelect } from "./ModelSelect";
import { api } from "../api/client";
import type { Project, ProjectSettings, AgentType, DeploymentMode, HilNotificationMode } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

interface ProjectSettingsModalProps {
  project: Project;
  onClose: () => void;
  onSaved?: () => void;
}

type Tab = "basics" | "agents" | "deployment" | "hil";

const TABS: { key: Tab; label: string }[] = [
  { key: "basics", label: "Project Info" },
  { key: "agents", label: "Agent Config" },
  { key: "deployment", label: "Deployment" },
  { key: "hil", label: "Autonomy" },
];

export function ProjectSettingsModal({ project, onClose, onSaved }: ProjectSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("basics");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  // Project basics
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [repoPath, setRepoPath] = useState(project.repoPath);

  // Settings
  const [settings, setSettings] = useState<ProjectSettings | null>(null);

  // API key status (for agents tab)
  const [envKeys, setEnvKeys] = useState<{ anthropic: boolean; cursor: boolean } | null>(null);
  const [savingKey, setSavingKey] = useState<"ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | null>(null);
  const [keyInput, setKeyInput] = useState<{ anthropic: string; cursor: string }>({ anthropic: "", cursor: "" });
  const [modelRefreshTrigger, setModelRefreshTrigger] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.projects
      .getSettings(project.id)
      .then((data) => {
        if (!cancelled) {
          setSettings(data as ProjectSettings);
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

  const planningAgent = settings?.planningAgent ?? {
    type: "claude" as AgentType,
    model: null,
    cliCommand: null,
  };
  const codingAgent = settings?.codingAgent ?? {
    type: "claude" as AgentType,
    model: null,
    cliCommand: null,
  };
  const deployment = settings?.deployment ?? { mode: "custom" as DeploymentMode };
  const hilConfig = settings?.hilConfig ?? DEFAULT_HIL_CONFIG;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await Promise.all([
        api.projects.update(project.id, {
          name,
          description,
          repoPath,
        }),
        api.projects.updateSettings(project.id, {
          planningAgent: {
            type: planningAgent.type,
            model: planningAgent.model || null,
            cliCommand: planningAgent.cliCommand || null,
          },
          codingAgent: {
            type: codingAgent.type,
            model: codingAgent.model || null,
            cliCommand: codingAgent.cliCommand || null,
          },
          deployment: {
            mode: deployment.mode,
            expoConfig: deployment.mode === "expo" ? { channel: deployment.expoConfig?.channel ?? "preview" } : undefined,
            customCommand: deployment.customCommand ?? undefined,
            webhookUrl: deployment.webhookUrl ?? undefined,
          },
          hilConfig,
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

  const updatePlanningAgent = (updates: Partial<typeof planningAgent>) => {
    setSettings((s) =>
      s
        ? {
            ...s,
            planningAgent: { ...s.planningAgent, ...updates },
          }
        : null,
    );
  };

  const updateCodingAgent = (updates: Partial<typeof codingAgent>) => {
    setSettings((s) =>
      s
        ? {
            ...s,
            codingAgent: { ...s.codingAgent, ...updates },
          }
        : null,
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
        prev ? { ...prev, [envKey === "ANTHROPIC_API_KEY" ? "anthropic" : "cursor"]: true } : null,
      );
      setKeyInput((prev) => ({ ...prev, [envKey === "ANTHROPIC_API_KEY" ? "anthropic" : "cursor"]: "" }));
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
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Project Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-3 pb-2 border-b border-gray-200 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
                activeTab === tab.key
                  ? "bg-brand-600 text-white"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-[280px]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {activeTab === "basics" && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Project Name</label>
                    <input
                      type="text"
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="My Awesome App"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <textarea
                      className="input min-h-[80px]"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="A brief description of what you're building"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Repository Path</label>
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
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                          />
                        </svg>
                        Browse
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-gray-400">Absolute path to the project repository</p>
                  </div>
                </div>
              )}

              {activeTab === "agents" && (
                <div className="space-y-6">
                  {envKeys && (!envKeys.anthropic || !envKeys.cursor) && (
                    <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                      <p className="text-sm text-amber-800">
                        <strong>API keys required:</strong> Add{" "}
                        <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> and/or{" "}
                        <code className="font-mono text-xs">CURSOR_API_KEY</code> to your project&apos;s{" "}
                        <code className="font-mono text-xs">.env</code> file to use Claude and Cursor. Get keys from{" "}
                        <a
                          href="https://console.anthropic.com/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-amber-900"
                        >
                          Anthropic Console
                        </a>{" "}
                        and{" "}
                        <a
                          href="https://cursor.com/settings"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-amber-900"
                        >
                          Cursor → Integrations → User API Keys
                        </a>
                        .
                      </p>
                    </div>
                  )}
                  {envKeys && (
                    <div className="space-y-3">
                      {!envKeys.anthropic && (
                        <div className="flex gap-2 items-end">
                          <div className="flex-1">
                            <label className="block text-xs font-medium text-gray-500 mb-1">
                              ANTHROPIC_API_KEY (Claude)
                            </label>
                            <input
                              type="password"
                              className="input font-mono text-sm"
                              placeholder="sk-ant-..."
                              value={keyInput.anthropic}
                              onChange={(e) => setKeyInput((p) => ({ ...p, anthropic: e.target.value }))}
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
                      {!envKeys.cursor && (
                        <div className="flex gap-2 items-end">
                          <div className="flex-1">
                            <label className="block text-xs font-medium text-gray-500 mb-1">CURSOR_API_KEY</label>
                            <input
                              type="password"
                              className="input font-mono text-sm"
                              placeholder="key_..."
                              value={keyInput.cursor}
                              onChange={(e) => setKeyInput((p) => ({ ...p, cursor: e.target.value }))}
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
                      {(envKeys.anthropic || envKeys.cursor) && (
                        <p className="text-xs text-green-600">
                          {envKeys.anthropic && envKeys.cursor
                            ? "Both API keys configured."
                            : envKeys.anthropic
                              ? "Claude API key configured."
                              : "Cursor API key configured."}
                        </p>
                      )}
                    </div>
                  )}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">Planning Agent</h3>
                    <p className="text-xs text-gray-500 mb-3">Used for Design conversations and Plan decomposition</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                        <select
                          className="input"
                          value={planningAgent.type}
                          onChange={(e) =>
                            updatePlanningAgent({
                              type: e.target.value as AgentType,
                            })
                          }
                        >
                          <option value="claude">Claude</option>
                          <option value="cursor">Cursor</option>
                          <option value="custom">Custom CLI</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                        <ModelSelect
                          provider={planningAgent.type}
                          value={planningAgent.model}
                          onChange={(id) => updatePlanningAgent({ model: id })}
                          refreshTrigger={modelRefreshTrigger}
                        />
                      </div>
                    </div>
                  </div>
                  <hr />
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">Coding Agent</h3>
                    <p className="text-xs text-gray-500 mb-3">Used for Build phase implementation and review</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                        <select
                          className="input"
                          value={codingAgent.type}
                          onChange={(e) => updateCodingAgent({ type: e.target.value as AgentType })}
                        >
                          <option value="claude">Claude</option>
                          <option value="cursor">Cursor</option>
                          <option value="custom">Custom CLI</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                        <ModelSelect
                          provider={codingAgent.type}
                          value={codingAgent.model}
                          onChange={(id) => updateCodingAgent({ model: id })}
                          refreshTrigger={modelRefreshTrigger}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "deployment" && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-3">Deployment Mode</label>
                    <div className="space-y-3">
                      <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:border-brand-300 cursor-pointer transition-colors">
                        <input
                          type="radio"
                          name="deployment"
                          value="expo"
                          checked={deployment.mode === "expo"}
                          onChange={() => updateDeployment({ mode: "expo", expoConfig: { channel: "preview" } })}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="text-sm font-medium text-gray-900">Expo.dev</p>
                          <p className="text-xs text-gray-500">
                            Automatic deployment for React Native and web projects
                          </p>
                        </div>
                      </label>
                      <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:border-brand-300 cursor-pointer transition-colors">
                        <input
                          type="radio"
                          name="deployment"
                          value="custom"
                          checked={deployment.mode === "custom"}
                          onChange={() => updateDeployment({ mode: "custom" })}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="text-sm font-medium text-gray-900">Custom Pipeline</p>
                          <p className="text-xs text-gray-500">Command or webhook triggered after Build completion</p>
                        </div>
                      </label>
                    </div>
                  </div>
                  {deployment.mode === "custom" && (
                    <div className="space-y-3 pt-2 border-t border-gray-200">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Deployment command</label>
                        <input
                          type="text"
                          className="input w-full font-mono text-sm"
                          placeholder="e.g. ./deploy.sh or vercel deploy --prod"
                          value={deployment.customCommand ?? ""}
                          onChange={(e) => updateDeployment({ customCommand: e.target.value || undefined })}
                        />
                        <p className="mt-1 text-xs text-gray-500">Shell command run from project root after each task completion</p>
                      </div>
                      <div className="text-sm text-gray-500 text-center">— or —</div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Webhook URL</label>
                        <input
                          type="url"
                          className="input w-full font-mono text-sm"
                          placeholder="https://api.example.com/deploy"
                          value={deployment.webhookUrl ?? ""}
                          onChange={(e) => updateDeployment({ webhookUrl: e.target.value || undefined })}
                        />
                        <p className="mt-1 text-xs text-gray-500">HTTP POST sent after each task completion (GitHub Actions, Vercel, etc.)</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "hil" && (
                <div className="space-y-4">
                  <p className="text-sm text-gray-500 mb-4">
                    Configure when OpenSprint should pause for your input vs. proceed autonomously.
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
                      {
                        key: "testFailuresAndRetries" as const,
                        label: "Test Failures & Retries",
                        desc: "How to handle failing tests",
                      },
                    ] as const
                  ).map((cat) => (
                    <div key={cat.key} className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{cat.label}</p>
                        <p className="text-xs text-gray-500">{cat.desc}</p>
                      </div>
                      <select
                        className="input w-48"
                        value={hilConfig[cat.key]}
                        onChange={(e) => updateHilConfig(cat.key, e.target.value as HilNotificationMode)}
                      >
                        <option value="requires_approval">Requires Approval</option>
                        <option value="notify_and_proceed">Notify & Proceed</option>
                        <option value="automated">Automated</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || loading} className="btn-primary disabled:opacity-50">
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
