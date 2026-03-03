import { useState, useEffect, useRef } from "react";
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
import type { AgentType, Project, ScaffoldRecoveryInfo } from "@opensprint/shared";
import { api, ApiError } from "../api/client";
import { getPlatformFamily } from "../utils/platform";
import { getRunInstructions } from "../utils/runInstructions";

type Step = "basics" | "agents" | "scaffold";

const STEPS: { key: Step; label: string }[] = [
  { key: "basics", label: "Basics" },
  { key: "agents", label: "Agents" },
  { key: "scaffold", label: "Scaffold" },
];

const TEMPLATE_OPTIONS = [{ value: "web-app-expo-react", label: "Web App (Expo/React)" }] as const;

export function CreateNewProjectPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("basics");
  const [metadata, setMetadata] = useState<ProjectMetadataState>({ name: "" });
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState("");
  const [template, setTemplate] = useState<"web-app-expo-react">(TEMPLATE_OPTIONS[0].value);
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
    openai: boolean;
    claudeCli: boolean;
  } | null>(null);
  const [keyInput, setKeyInput] = useState<{ anthropic: string; cursor: string; openai: string }>({
    anthropic: "",
    cursor: "",
    openai: "",
  });
  const [savingKey, setSavingKey] = useState<
    "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY" | null
  >(null);
  const [modelRefreshTrigger, setModelRefreshTrigger] = useState(0);

  const [scaffolding, setScaffolding] = useState(false);
  const [scaffoldError, setScaffoldError] = useState<string | null>(null);
  const [scaffoldRecovery, setScaffoldRecovery] = useState<ScaffoldRecoveryInfo | null>(null);
  const [scaffoldedProject, setScaffoldedProject] = useState<Project | null>(null);

  const currentStepIndex = STEPS.findIndex((s) => s.key === step);
  const runInstructions = scaffoldedProject
    ? getRunInstructions(scaffoldedProject.repoPath, getPlatformFamily())
    : null;

  useEffect(() => {
    if (step !== "agents") return;
    Promise.all([api.globalSettings.get(), api.env.getKeys()])
      .then(([global, env]) => {
        const apiKeys = global.apiKeys;
        const anthropic = (apiKeys?.ANTHROPIC_API_KEY?.length ?? 0) > 0;
        const cursor = (apiKeys?.CURSOR_API_KEY?.length ?? 0) > 0;
        const openai = (apiKeys?.OPENAI_API_KEY?.length ?? 0) > 0;
        setEnvKeys({ anthropic, cursor, openai, claudeCli: env.claudeCli });
      })
      .catch(() => setEnvKeys(null));
  }, [step]);

  const handleSaveKey = async (
    envKey: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY"
  ) => {
    const keyToInput =
      envKey === "ANTHROPIC_API_KEY"
        ? "anthropic"
        : envKey === "CURSOR_API_KEY"
          ? "cursor"
          : "openai";
    const value = keyInput[keyToInput];
    if (!value.trim()) return;
    setSavingKey(envKey);
    try {
      await api.env.saveKey(envKey, value.trim());
      setEnvKeys((prev) => (prev ? { ...prev, [keyToInput]: true } : null));
      setKeyInput((prev) => ({
        ...prev,
        [keyToInput]: "",
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
    setScaffoldError(null);
    setScaffoldRecovery(null);
    setScaffoldedProject(null);
    setScaffolding(true);
    setStep("scaffold");
  };

  const scaffoldStepMountedRef = useRef(false);

  useEffect(() => {
    if (step !== "scaffold") {
      scaffoldStepMountedRef.current = false;
      return;
    }
    scaffoldStepMountedRef.current = true;
    setScaffoldError(null);

    const runScaffold = async () => {
      try {
        const result = await api.projects.scaffold({
          name: metadata.name.trim(),
          parentPath: parentPath.trim(),
          template,
          simpleComplexityAgent: {
            type: simpleComplexityAgent.type,
            model:
              simpleComplexityAgent.type === "custom" ? null : simpleComplexityAgent.model || null,
            cliCommand:
              simpleComplexityAgent.type === "custom" && simpleComplexityAgent.cliCommand.trim()
                ? simpleComplexityAgent.cliCommand.trim()
                : null,
          },
          complexComplexityAgent: {
            type: complexComplexityAgent.type,
            model:
              complexComplexityAgent.type === "custom"
                ? null
                : complexComplexityAgent.model || null,
            cliCommand:
              complexComplexityAgent.type === "custom" && complexComplexityAgent.cliCommand.trim()
                ? complexComplexityAgent.cliCommand.trim()
                : null,
          },
        });
        if (scaffoldStepMountedRef.current) {
          setScaffoldedProject(result.project);
          if (result.recovery) {
            setScaffoldRecovery(result.recovery);
          }
        }
      } catch (err) {
        if (scaffoldStepMountedRef.current) {
          setScaffoldError(err instanceof Error ? err.message : "Failed to scaffold project");
          if (err instanceof ApiError && err.details) {
            const details = err.details as { recovery?: ScaffoldRecoveryInfo };
            if (details.recovery) {
              setScaffoldRecovery(details.recovery);
            }
          }
        }
      } finally {
        if (scaffoldStepMountedRef.current) {
          setScaffolding(false);
        }
      }
    };

    runScaffold();
  }, [
    step,
    metadata.name,
    parentPath,
    template,
    simpleComplexityAgent.type,
    simpleComplexityAgent.model,
    simpleComplexityAgent.cliCommand,
    complexComplexityAgent.type,
    complexComplexityAgent.model,
    complexComplexityAgent.cliCommand,
  ]);

  const handleScaffoldRetry = () => {
    setScaffoldError(null);
    setScaffoldRecovery(null);
    setScaffoldedProject(null);
    setScaffolding(true);
    api.projects
      .scaffold({
        name: metadata.name.trim(),
        parentPath: parentPath.trim(),
        template,
        simpleComplexityAgent: {
          type: simpleComplexityAgent.type,
          model:
            simpleComplexityAgent.type === "custom" ? null : simpleComplexityAgent.model || null,
          cliCommand:
            simpleComplexityAgent.type === "custom" && simpleComplexityAgent.cliCommand.trim()
              ? simpleComplexityAgent.cliCommand.trim()
              : null,
        },
        complexComplexityAgent: {
          type: complexComplexityAgent.type,
          model:
            complexComplexityAgent.type === "custom" ? null : complexComplexityAgent.model || null,
          cliCommand:
            complexComplexityAgent.type === "custom" && complexComplexityAgent.cliCommand.trim()
              ? complexComplexityAgent.cliCommand.trim()
              : null,
        },
      })
      .then((result) => {
        if (scaffoldStepMountedRef.current) {
          setScaffoldedProject(result.project);
          if (result.recovery) {
            setScaffoldRecovery(result.recovery);
          }
        }
      })
      .catch((err) => {
        if (scaffoldStepMountedRef.current) {
          setScaffoldError(err instanceof Error ? err.message : "Failed to scaffold project");
          if (err instanceof ApiError && err.details) {
            const details = err.details as { recovery?: ScaffoldRecoveryInfo };
            if (details.recovery) {
              setScaffoldRecovery(details.recovery);
            }
          }
        }
      })
      .finally(() => {
        if (scaffoldStepMountedRef.current) {
          setScaffolding(false);
        }
      });
  };

  const handleScaffoldBack = () => {
    setScaffoldError(null);
    setScaffoldRecovery(null);
    setScaffoldedProject(null);
    setScaffolding(false);
    setStep("agents");
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
  const needsOpenai =
    envKeys &&
    !envKeys.openai &&
    (simpleComplexityAgent.type === "openai" || complexComplexityAgent.type === "openai");
  const usesClaudeCli =
    simpleComplexityAgent.type === "claude-cli" || complexComplexityAgent.type === "claude-cli";
  const claudeCliMissing = envKeys && !envKeys.claudeCli && usesClaudeCli;

  const canProceedFromAgents =
    envKeys !== null &&
    !needsAnthropic &&
    !needsCursor &&
    !needsOpenai &&
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
                  createNewMode
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
                    onChange={(e) => setTemplate(e.target.value as "web-app-expo-react")}
                    data-testid="template-select"
                  >
                    {TEMPLATE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-sm text-theme-text-secondary">
                    <a
                      href="https://github.com/toddmedema/opensprint/issues/new"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-theme-text"
                    >
                      Request a template
                    </a>
                  </p>
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
                      Creating scaffolding and installing dependencies. If an error is detected, an
                      agent will attempt to fix it automatically.
                    </p>
                  </div>
                )}
                {scaffoldError && !scaffolding && (
                  <div data-testid="scaffold-error-details" className="space-y-3">
                    <div className="p-3 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text">
                      <p className="font-medium mb-1">Initialization failed</p>
                      <p>{scaffoldError}</p>
                    </div>
                    {scaffoldRecovery && (
                      <div
                        className="p-3 bg-theme-surface-muted border border-theme-border rounded-lg text-sm"
                        data-testid="scaffold-recovery-info"
                      >
                        <p className="font-medium text-theme-text mb-1">
                          {scaffoldRecovery.attempted
                            ? "Agent recovery attempted"
                            : "Recovery not attempted"}
                        </p>
                        <p className="text-theme-muted">
                          <span className="font-medium">Error type:</span>{" "}
                          {scaffoldRecovery.errorSummary}
                        </p>
                        {scaffoldRecovery.attempted && (
                          <p className="text-theme-muted mt-1">
                            <span className="font-medium">Result:</span>{" "}
                            {scaffoldRecovery.success
                              ? "Agent fixed the issue but the command still failed on retry"
                              : "Agent could not resolve the issue"}
                          </p>
                        )}
                        {!scaffoldRecovery.attempted && (
                          <p className="text-theme-muted mt-1">
                            This error type requires manual intervention.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {runInstructions && !scaffolding && (
                  <div className="space-y-4">
                    <p className="text-theme-text font-medium">Your project is ready!</p>
                    {scaffoldRecovery?.attempted && scaffoldRecovery.success && (
                      <div
                        className="p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-800 dark:text-green-300"
                        data-testid="scaffold-recovery-success"
                      >
                        An initialization issue was automatically resolved:{" "}
                        {scaffoldRecovery.errorSummary}
                      </div>
                    )}
                    <p className="text-sm text-theme-muted">Run these commands in order:</p>
                    <pre className="p-3 bg-theme-surface-muted rounded-lg font-mono text-sm overflow-x-auto">
                      {runInstructions.join("\n")}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {scaffoldError && !scaffolding && (
            <div className="mt-4 p-3 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text flex justify-between items-center">
              <span>{scaffoldError}</span>
              <button
                type="button"
                onClick={() => {
                  setScaffoldError(null);
                  setScaffoldRecovery(null);
                }}
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
                  if (step === "scaffold") {
                    handleScaffoldBack();
                  } else {
                    setStep(STEPS[currentStepIndex - 1]?.key ?? "basics");
                  }
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
                {scaffoldedProject ? (
                  <button
                    onClick={handleImReady}
                    className="btn-primary"
                    data-testid="im-ready-button"
                  >
                    I&apos;m Ready
                  </button>
                ) : scaffoldError ? (
                  <button
                    onClick={handleScaffoldRetry}
                    className="btn-primary"
                    data-testid="scaffold-retry-button"
                  >
                    Retry
                  </button>
                ) : null}
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
