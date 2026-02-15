import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Layout } from "../components/layout/Layout";
import { FolderBrowser } from "../components/FolderBrowser";
import { ModelSelect } from "../components/ModelSelect";
import type { AgentType, DeploymentMode, HilNotificationMode } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG, TEST_FRAMEWORKS } from "@opensprint/shared";
import { api } from "../api/client";

type Step = "basics" | "agents" | "deployment" | "testing" | "hil" | "confirm";

const STEPS: { key: Step; label: string }[] = [
  { key: "basics", label: "Project Info" },
  { key: "agents", label: "Agent Config" },
  { key: "deployment", label: "Deployment" },
  { key: "testing", label: "Testing" },
  { key: "hil", label: "Autonomy" },
  { key: "confirm", label: "Confirm" },
];

export function ProjectSetup() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("basics");
  const [creating, setCreating] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [planningAgentType, setPlanningAgentType] = useState<AgentType>("claude");
  const [planningModel, setPlanningModel] = useState("");
  const [codingAgentType, setCodingAgentType] = useState<AgentType>("claude");
  const [codingModel, setCodingModel] = useState("");
  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode>("custom");
  const [customDeployCommand, setCustomDeployCommand] = useState("");
  const [customDeployWebhook, setCustomDeployWebhook] = useState("");
  const [testFramework, setTestFramework] = useState<string>("none");
  const [hilConfig, setHilConfig] = useState(DEFAULT_HIL_CONFIG);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  // Test framework detection
  const [detectedFramework, setDetectedFramework] = useState<string | null>(null);
  const [detectingFramework, setDetectingFramework] = useState(false);

  // API key status (for agents step)
  const [envKeys, setEnvKeys] = useState<{ anthropic: boolean; cursor: boolean } | null>(null);
  const [savingKey, setSavingKey] = useState<"ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | null>(null);
  const [keyInput, setKeyInput] = useState<{ anthropic: string; cursor: string }>({ anthropic: "", cursor: "" });
  const [modelRefreshTrigger, setModelRefreshTrigger] = useState(0);
  const [createError, setCreateError] = useState<string | null>(null);

  const currentStepIndex = STEPS.findIndex((s) => s.key === step);

  useEffect(() => {
    if (step !== "agents") return;
    api.env
      .getKeys()
      .then(setEnvKeys)
      .catch(() => setEnvKeys(null));
  }, [step]);

  // Detect test framework when entering testing step with a repo path
  useEffect(() => {
    if (step !== "testing" || !repoPath.trim()) return;
    setDetectingFramework(true);
    setDetectedFramework(null);
    api.filesystem
      .detectTestFramework(repoPath.trim())
      .then((result) => {
        if (result) {
          setDetectedFramework(result.framework);
          setTestFramework(result.framework);
        } else {
          setDetectedFramework(null);
        }
      })
      .catch(() => setDetectedFramework(null))
      .finally(() => setDetectingFramework(false));
  }, [step, repoPath]);

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

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const project = await api.projects.create({
        name,
        description,
        repoPath,
        planningAgent: { type: planningAgentType, model: planningModel || null, cliCommand: null },
        codingAgent: { type: codingAgentType, model: codingModel || null, cliCommand: null },
        deployment: {
          mode: deploymentMode,
          expoConfig: deploymentMode === "expo" ? { channel: "preview" } : undefined,
          customCommand: deploymentMode === "custom" && customDeployCommand.trim() ? customDeployCommand.trim() : undefined,
          webhookUrl: deploymentMode === "custom" && customDeployWebhook.trim() ? customDeployWebhook.trim() : undefined,
        },
        hilConfig,
        testFramework: testFramework === "none" ? null : testFramework,
      });
      navigate(`/projects/${(project as { id: string }).id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create project";
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-8">Create New Project</h1>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  i <= currentStepIndex ? "bg-brand-600 text-white" : "bg-gray-100 text-gray-400"
                }`}
              >
                {i + 1}
              </div>
              <span className={`text-sm ${i <= currentStepIndex ? "text-gray-900" : "text-gray-400"}`}>{s.label}</span>
              {i < STEPS.length - 1 && (
                <div className={`w-8 h-0.5 ${i < currentStepIndex ? "bg-brand-600" : "bg-gray-200"}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="card p-6">
          {step === "basics" && (
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
                <p className="mt-1 text-xs text-gray-400">Absolute path where the project repo will be created</p>
              </div>
            </div>
          )}

          {step === "agents" && (
            <div className="space-y-6">
              {envKeys && (!envKeys.anthropic || !envKeys.cursor) && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <p className="text-sm text-amber-800">
                    <strong>API keys required:</strong> Add <code className="font-mono text-xs">ANTHROPIC_API_KEY</code>{" "}
                    and/or <code className="font-mono text-xs">CURSOR_API_KEY</code> to your project&apos;s{" "}
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
                      value={planningAgentType}
                      onChange={(e) => setPlanningAgentType(e.target.value as AgentType)}
                    >
                      <option value="claude">Claude</option>
                      <option value="cursor">Cursor</option>
                      <option value="custom">Custom CLI</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                    <ModelSelect
                      provider={planningAgentType}
                      value={planningModel || null}
                      onChange={(id) => setPlanningModel(id ?? "")}
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
                      value={codingAgentType}
                      onChange={(e) => setCodingAgentType(e.target.value as AgentType)}
                    >
                      <option value="claude">Claude</option>
                      <option value="cursor">Cursor</option>
                      <option value="custom">Custom CLI</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                    <ModelSelect
                      provider={codingAgentType}
                      value={codingModel || null}
                      onChange={(id) => setCodingModel(id ?? "")}
                      refreshTrigger={modelRefreshTrigger}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === "deployment" && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">Deployment Mode</label>
                <div className="space-y-3">
                  <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:border-brand-300 cursor-pointer transition-colors">
                    <input
                      type="radio"
                      name="deployment"
                      value="expo"
                      checked={deploymentMode === "expo"}
                      onChange={() => setDeploymentMode("expo")}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-900">Expo.dev</p>
                      <p className="text-xs text-gray-500">Automatic deployment for React Native and web projects</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:border-brand-300 cursor-pointer transition-colors">
                    <input
                      type="radio"
                      name="deployment"
                      value="custom"
                      checked={deploymentMode === "custom"}
                      onChange={() => setDeploymentMode("custom")}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-900">Custom Pipeline</p>
                      <p className="text-xs text-gray-500">Command or webhook triggered after Build completion</p>
                    </div>
                  </label>
                </div>
              </div>
              {deploymentMode === "custom" && (
                <div className="space-y-3 pt-2 border-t border-gray-200">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Deployment command</label>
                    <input
                      type="text"
                      className="input w-full font-mono text-sm"
                      placeholder="e.g. ./deploy.sh or vercel deploy --prod"
                      value={customDeployCommand}
                      onChange={(e) => setCustomDeployCommand(e.target.value)}
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
                      value={customDeployWebhook}
                      onChange={(e) => setCustomDeployWebhook(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-gray-500">HTTP POST sent after each task completion (GitHub Actions, Vercel, etc.)</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "testing" && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">Test Framework</label>
                <p className="text-xs text-gray-500 mb-3">
                  OpenSprint uses this to run tests during the Build phase. We detect from your project when possible.
                </p>
                {detectingFramework && (
                  <p className="text-sm text-gray-500 mb-2">Detecting from project...</p>
                )}
                {!detectingFramework && detectedFramework && (
                  <p className="text-sm text-green-600 mb-2">
                    Detected: <strong>{TEST_FRAMEWORKS.find((f) => f.id === detectedFramework)?.label ?? detectedFramework}</strong>
                  </p>
                )}
                <select
                  className="input w-full"
                  value={testFramework}
                  onChange={(e) => setTestFramework(e.target.value)}
                >
                  {TEST_FRAMEWORKS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {step === "hil" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 mb-4">
                Configure when OpenSprint should pause for your input vs. proceed autonomously.
              </p>
              {(
                [
                  { key: "scopeChanges", label: "Scope Changes", desc: "Adds, removes, or alters features" },
                  {
                    key: "architectureDecisions",
                    label: "Architecture Decisions",
                    desc: "Tech stack, integrations, schema changes",
                  },
                  {
                    key: "dependencyModifications",
                    label: "Dependency Modifications",
                    desc: "Task reordering and re-prioritization",
                  },
                  {
                    key: "testFailuresAndRetries",
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
                    onChange={(e) => setHilConfig({ ...hilConfig, [cat.key]: e.target.value as HilNotificationMode })}
                  >
                    <option value="requires_approval">Requires Approval</option>
                    <option value="notify_and_proceed">Notify & Proceed</option>
                    <option value="automated">Automated</option>
                  </select>
                </div>
              ))}
            </div>
          )}

          {step === "confirm" && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-gray-900">Review your project setup</h3>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Name</dt>
                  <dd className="font-medium">{name}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Repository</dt>
                  <dd className="font-mono text-xs">{repoPath}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Planning Agent</dt>
                  <dd className="font-medium capitalize">
                    {planningAgentType} {planningModel && `(${planningModel})`}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Coding Agent</dt>
                  <dd className="font-medium capitalize">
                    {codingAgentType} {codingModel && `(${codingModel})`}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Deployment</dt>
                  <dd className="font-medium">
                    {deploymentMode === "custom"
                      ? customDeployCommand.trim()
                        ? `Custom: ${customDeployCommand.trim()}`
                        : customDeployWebhook.trim()
                          ? `Webhook: ${customDeployWebhook.trim()}`
                          : "Custom (not configured)"
                      : "Expo"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Test Framework</dt>
                  <dd className="font-medium">
                    {testFramework === "none"
                      ? "None"
                      : TEST_FRAMEWORKS.find((f) => f.id === testFramework)?.label ?? testFramework}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        {createError && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center">
            <span>{createError}</span>
            <button
              type="button"
              onClick={() => setCreateError(null)}
              className="text-red-500 hover:text-red-700 underline"
            >
              Dismiss
            </button>
          </div>
        )}
        {/* Navigation */}
        <div className="flex justify-between mt-6">
          <button
            onClick={() => setStep(STEPS[currentStepIndex - 1]?.key ?? "basics")}
            disabled={currentStepIndex === 0}
            className="btn-secondary disabled:opacity-50"
          >
            Back
          </button>
          {step === "confirm" ? (
            <button onClick={handleCreate} disabled={creating} className="btn-primary">
              {creating ? "Creating..." : "Create Project"}
            </button>
          ) : (
            <button onClick={() => setStep(STEPS[currentStepIndex + 1]?.key ?? "confirm")} className="btn-primary">
              Next
            </button>
          )}
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
    </Layout>
  );
}
