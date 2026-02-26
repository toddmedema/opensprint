import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { Layout } from "../components/layout/Layout";
import { FolderBrowser } from "../components/FolderBrowser";
import {
  ProjectMetadataStep,
  isValidProjectMetadata,
  RepositoryStep,
  SimplifiedAgentsStep,
} from "../components/ProjectSetupWizard";
import type { ProjectMetadataState } from "../components/ProjectSetupWizard";
import type { AgentType } from "@opensprint/shared";
import { api } from "../api/client";

type Step = "basics" | "agents" | "scaffold";

const STEPS: { key: Step; label: string }[] = [
  { key: "basics", label: "Basics" },
  { key: "agents", label: "Agents" },
  { key: "scaffold", label: "Scaffold" },
];

const TEMPLATE_OPTIONS = [
  { value: "web-app-expo-react", label: "Web App (Expo/React)" },
] as const;

export function CreateNewProjectPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("basics");
  const [metadata, setMetadata] = useState<ProjectMetadataState>({ name: "" });
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState("");
  const [template, setTemplate] = useState<string>(TEMPLATE_OPTIONS[0].value);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  const [simpleComplexityAgent, setSimpleComplexityAgent] = useState({
    type: "cursor" as AgentType,
    model: "",
    cliCommand: "",
  });
  const [complexComplexityAgent, setComplexComplexityAgent] = useState({
    type: "cursor" as AgentType,
    model: "",
    cliCommand: "",
  });
  const [envKeys, setEnvKeys] = useState<{
    anthropic: boolean;
    cursor: boolean;
    claudeCli: boolean;
  } | null>(null);
  const [keyInput, setKeyInput] = useState<{ anthropic: string; cursor: string }>({
    anthropic: "",
    cursor: "",
  });
  const [savingKey, setSavingKey] = useState<"ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | null>(null);
  const [modelRefreshTrigger, setModelRefreshTrigger] = useState(0);

  const [scaffolding, setScaffolding] = useState(false);
  const [scaffoldError, setScaffoldError] = useState<string | null>(null);
  const [runCommand, setRunCommand] = useState<string | null>(null);
  const [scaffoldedProject, setScaffoldedProject] = useState<{ id: string } | null>(null);

  const currentStepIndex = STEPS.findIndex((s) => s.key === step);

  useEffect(() => {
    if (step !== "agents") return;
    api.env
      .getKeys()
      .then(setEnvKeys)
      .catch(() => setEnvKeys(null));
  }, [step]);

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

  const handleBasicsNext = () => {
    if (!isValidProjectMetadata(metadata)) {
      setMetadataError("Project name is required");
      return;
    }
    setMetadataError(null);
    if (!parentPath.trim()) return;
    setStep("agents");
  };

  const handleAgentsNext = () => {
    setStep("scaffold");
  };

  const handleScaffold = async () => {
    setScaffolding(true);
    setScaffoldError(null);
    try {
      const result = await api.projects.scaffold({
        name: metadata.name.trim(),
        parentPath: parentPath.trim(),
        template,
        simpleComplexityAgent: {
          type: simpleComplexityAgent.type,
          model: simpleComplexityAgent.type === "custom" ? null : simpleComplexityAgent.model || null,
          cliCommand:
            simpleComplexityAgent.type === "custom" && simpleComplexityAgent.cliCommand.trim()
              ? simpleComplexityAgent.cliCommand.trim()
              : null,
        },
        complexComplexityAgent: {
          type: complexComplexityAgent.type,
          model: complexComplexityAgent.type === "custom" ? null : complexComplexityAgent.model || null,
          cliCommand:
            complexComplexityAgent.type === "custom" && complexComplexityAgent.cliCommand.trim()
              ? complexComplexityAgent.cliCommand.trim()
              : null,
        },
      });
      setRunCommand(result.runCommand);
      setScaffoldedProject(result.project);
    } catch (err) {
      setScaffoldError(err instanceof Error ? err.message : "Failed to scaffold project");
    } finally {
      setScaffolding(false);
    }
  };

  const handleImReady = () => {
    if (scaffoldedProject) {
      navigate(getProjectPhasePath(scaffoldedProject.id, "sketch"));
    }
  };

  const canProceedFromBasics = parentPath.trim().length > 0;

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

  const canProceedFromAgents =
    envKeys !== null &&
    !needsAnthropic &&
    !needsCursor &&
    !claudeCliMissing &&
    (simpleComplexityAgent.type !== "custom" || simpleComplexityAgent.cliCommand.trim()) &&
    (complexComplexityAgent.type !== "custom" || complexComplexityAgent.cliCommand.trim());

  return (
    <Layout>
      <div className="h-full overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10">
          <div className="flex justify-between items-start mb-2">
            <h1 className="text-2xl font-bold text-theme-text">
              Create New Project
              <span className="text-theme-muted font-normal text-lg ml-2">
                — {STEPS[currentStepIndex]?.label ?? step}
              </span>
            </h1>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="inline-flex items-center rounded px-2 py-1 text-sm text-theme-muted hover:bg-theme-border-subtle hover:text-theme-text transition-colors border-0"
              aria-label="Cancel"
              data-testid="cancel-button"
            >
              Cancel
            </button>
          </div>

          <div
            role="progressbar"
            aria-valuenow={currentStepIndex + 1}
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-label={`Step ${currentStepIndex + 1} of ${STEPS.length}`}
            className="mb-4"
          >
            <p className="text-sm text-theme-muted mb-1.5">
              Step {currentStepIndex + 1} of {STEPS.length}
            </p>
            <div className="h-1.5 w-full rounded-full bg-theme-border overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-600 transition-[width] duration-200 ease-out"
                style={{
                  width: `${((currentStepIndex + 1) / STEPS.length) * 100}%`,
                }}
              />
            </div>
          </div>

          <div className="card p-6">
            {step === "basics" && (
              <div className="space-y-4" data-testid="create-new-basics-step">
                <ProjectMetadataStep
                  value={metadata}
                  onChange={(v) => {
                    setMetadata(v);
                    setMetadataError(null);
                  }}
                  error={metadataError}
                />
                <RepositoryStep
                  value={parentPath}
                  onChange={setParentPath}
                  onBrowse={() => setShowFolderBrowser(true)}
                />
                <div>
                  <label
                    htmlFor="template-select"
                    className="block text-sm font-medium text-theme-text mb-1"
                  >
                    Template
                  </label>
                  <select
                    id="template-select"
                    className="input w-full"
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                    data-testid="template-select"
                  >
                    {TEMPLATE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {step === "agents" && (
              <SimplifiedAgentsStep
                simpleComplexityAgent={simpleComplexityAgent}
                complexComplexityAgent={complexComplexityAgent}
                onSimpleComplexityAgentChange={setSimpleComplexityAgent}
                onComplexComplexityAgentChange={setComplexComplexityAgent}
                envKeys={envKeys}
                keyInput={keyInput}
                onKeyInputChange={(key, value) => setKeyInput((p) => ({ ...p, [key]: value }))}
                savingKey={savingKey}
                onSaveKey={handleSaveKey}
                modelRefreshTrigger={modelRefreshTrigger}
              />
            )}

            {step === "scaffold" && (
              <div className="space-y-4" data-testid="create-new-scaffold-step">
                {scaffolding && (
                  <div className="flex flex-col items-center justify-center py-12">
                    <div
                      className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin mb-4"
                      aria-hidden
                    />
                    <p className="text-theme-text font-medium">Building your project...</p>
                    <p className="text-sm text-theme-muted mt-1">
                      Creating scaffolding and installing dependencies
                    </p>
                  </div>
                )}
                {scaffoldError && !scaffolding && (
                  <div className="p-3 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text">
                    {scaffoldError}
                  </div>
                )}
                {runCommand && !scaffolding && (
                  <div className="space-y-4">
                    <p className="text-theme-text font-medium">Your project is ready!</p>
                    <p className="text-sm text-theme-muted">Run your app:</p>
                    <pre className="p-3 bg-theme-surface-muted rounded-lg font-mono text-sm overflow-x-auto">
                      {runCommand}
                    </pre>
                  </div>
                )}
                {!scaffolding && !runCommand && !scaffoldError && (
                  <p className="text-theme-muted">Click &quot;Scaffold&quot; to build your project.</p>
                )}
              </div>
            )}
          </div>

          {scaffoldError && !scaffolding && (
            <div className="mt-4 p-3 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text flex justify-between items-center">
              <span>{scaffoldError}</span>
              <button
                type="button"
                onClick={() => setScaffoldError(null)}
                className="text-theme-error-text hover:opacity-80 underline"
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="flex justify-between mt-6">
            {currentStepIndex > 0 ? (
              <button
                onClick={() => {
                  setMetadataError(null);
                  setStep(STEPS[currentStepIndex - 1]?.key ?? "basics");
                }}
                className="btn-secondary"
                data-testid="back-button"
              >
                Back
              </button>
            ) : (
              <span aria-hidden="true" />
            )}
            {step === "basics" && (
              <button
                onClick={handleBasicsNext}
                disabled={!canProceedFromBasics}
                className="btn-primary disabled:opacity-50"
                data-testid="next-button"
              >
                Next
              </button>
            )}
            {step === "agents" && (
              <button
                onClick={handleAgentsNext}
                disabled={!canProceedFromAgents}
                className="btn-primary disabled:opacity-50"
                data-testid="next-button"
              >
                Next
              </button>
            )}
            {step === "scaffold" && (
              <>
                {!runCommand ? (
                  <button
                    onClick={handleScaffold}
                    disabled={scaffolding}
                    className="btn-primary disabled:opacity-50"
                    data-testid="scaffold-button"
                  >
                    {scaffolding ? "Building..." : "Scaffold"}
                  </button>
                ) : (
                  <button
                    onClick={handleImReady}
                    className="btn-primary"
                    data-testid="im-ready-button"
                  >
                    I&apos;m Ready
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {showFolderBrowser && (
          <FolderBrowser
            initialPath={parentPath || undefined}
            onSelect={(path) => {
              setParentPath(path);
              setShowFolderBrowser(false);
            }}
            onCancel={() => setShowFolderBrowser(false)}
          />
        )}
      </div>
    </Layout>
  );
}
