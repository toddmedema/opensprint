import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { GITHUB_REPO_URL } from "../lib/constants";
import { getPrereqInstallUrl } from "../lib/prerequisites";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { Layout } from "../components/layout/Layout";
import { FolderBrowser } from "../components/FolderBrowser";
import {
  ProjectMetadataStep,
  isValidProjectMetadata,
  RepositoryStep,
  SimplifiedAgentsStep,
} from "../components/ProjectSetupWizard";
import type {
  AgentConfig as WizardAgentConfig,
  ProjectMetadataState,
} from "../components/ProjectSetupWizard";
import type {
  AgentType,
  EnvRuntimeResponse,
  Project,
  ScaffoldRecoveryInfo,
  ScaffoldTemplate,
} from "@opensprint/shared";
import { isWindowsMountedWslPath, UNSUPPORTED_WSL_REPO_PATH_MESSAGE } from "@opensprint/shared";
import { api, ApiError } from "../api/client";
import {
  getApiKeyRequirementForEnvKey,
  getInitialAgentConfig,
  getMissingApiKeyRequirements,
  type ApiKeyInputKey,
} from "../utils/agentConfigDefaults";
import { getRunInstructions } from "../utils/runInstructions";
import {
  DEFAULT_LMSTUDIO_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  hasConfiguredLocalModel,
} from "../lib/localModelProviders";

type Step = "basics" | "agents" | "scaffold";
type ActionableError = {
  message: string;
  commands?: string[];
  code?: string;
  missing?: string[];
};
type EnvKeysState = Awaited<ReturnType<typeof api.env.getKeys>>;

const STEPS: { key: Step; label: string }[] = [
  { key: "basics", label: "Basics" },
  { key: "agents", label: "Agents" },
  { key: "scaffold", label: "Scaffold" },
];

const TEMPLATE_OPTIONS: readonly { value: ScaffoldTemplate; label: string }[] = [
  { value: "web-app-expo-react", label: "Web App (Expo/React)" },
  { value: "empty", label: "Empty" },
];
export function CreateNewProjectPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("basics");
  const [metadata, setMetadata] = useState<ProjectMetadataState>({ name: "" });
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState("");
  const [template, setTemplate] = useState<ScaffoldTemplate>(TEMPLATE_OPTIONS[0].value);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  const [simpleComplexityAgent, setSimpleComplexityAgent] = useState<WizardAgentConfig>({
    type: "cursor" as AgentType,
    model: "",
    cliCommand: "",
    baseUrl: DEFAULT_LMSTUDIO_BASE_URL,
  });
  const [complexComplexityAgent, setComplexComplexityAgent] = useState<WizardAgentConfig>({
    type: "cursor" as AgentType,
    model: "",
    cliCommand: "",
    baseUrl: DEFAULT_LMSTUDIO_BASE_URL,
  });
  const [envKeys, setEnvKeys] = useState<EnvKeysState | null>(null);
  const [keyInput, setKeyInput] = useState<Record<ApiKeyInputKey, string>>({
    anthropic: "",
    cursor: "",
    openai: "",
    google: "",
  });
  const [savingKey, setSavingKey] = useState<
    "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY" | null
  >(null);
  const [modelRefreshTrigger, setModelRefreshTrigger] = useState(0);
  const hasSetAgentDefaultRef = useRef(false);

  const [scaffolding, setScaffolding] = useState(false);
  const [scaffoldError, setScaffoldError] = useState<ActionableError | null>(null);
  const [scaffoldRecovery, setScaffoldRecovery] = useState<ScaffoldRecoveryInfo | null>(null);
  const [scaffoldedProject, setScaffoldedProject] = useState<Project | null>(null);
  const [backendRuntime, setBackendRuntime] = useState<EnvRuntimeResponse | null>(null);

  const currentStepIndex = STEPS.findIndex((s) => s.key === step);
  const repoPathValidationMessage =
    backendRuntime?.isWsl && isWindowsMountedWslPath(parentPath.trim())
      ? UNSUPPORTED_WSL_REPO_PATH_MESSAGE
      : null;
  const runInstructions =
    scaffoldedProject && backendRuntime
      ? getRunInstructions(scaffoldedProject.repoPath, backendRuntime, template)
      : null;

  useEffect(() => {
    api.env
      .getRuntime()
      .then((runtime) => setBackendRuntime(runtime))
      .catch(() => setBackendRuntime(null));
  }, []);

  useEffect(() => {
    if (step !== "agents") return;
    Promise.all([api.globalSettings.get(), api.env.getKeys()])
      .then(([global, keys]) => {
        setEnvKeys(keys);
        if (!hasSetAgentDefaultRef.current) {
          hasSetAgentDefaultRef.current = true;
          setSimpleComplexityAgent(getInitialAgentConfig(global.simpleComplexityAgent, keys));
          setComplexComplexityAgent(getInitialAgentConfig(global.complexComplexityAgent, keys));
        }
      })
      .catch(() => setEnvKeys(null));
  }, [step]);

  const handleSaveKey = async (
    envKey: "ANTHROPIC_API_KEY" | "CURSOR_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY"
  ) => {
    const keyToInput = getApiKeyRequirementForEnvKey(envKey).availabilityKey;
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
    if (!parentPath.trim() || repoPathValidationMessage) return;
    setStep("agents");
  };

  const handleAgentsNext = () => {
    if (repoPathValidationMessage) {
      return;
    }
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
            timeoutMs: simpleComplexityAgent.timeoutMs,
            effort: simpleComplexityAgent.effort,
            model:
              simpleComplexityAgent.type === "custom" ? null : simpleComplexityAgent.model || null,
            cliCommand:
              simpleComplexityAgent.type === "custom" && simpleComplexityAgent.cliCommand.trim()
                ? simpleComplexityAgent.cliCommand.trim()
                : null,
            ...((simpleComplexityAgent.type === "lmstudio" ||
              simpleComplexityAgent.type === "ollama") && {
              baseUrl:
                simpleComplexityAgent.baseUrl ||
                (simpleComplexityAgent.type === "ollama"
                  ? DEFAULT_OLLAMA_BASE_URL
                  : DEFAULT_LMSTUDIO_BASE_URL),
            }),
          },
          complexComplexityAgent: {
            type: complexComplexityAgent.type,
            timeoutMs: complexComplexityAgent.timeoutMs,
            effort: complexComplexityAgent.effort,
            model:
              complexComplexityAgent.type === "custom"
                ? null
                : complexComplexityAgent.model || null,
            cliCommand:
              complexComplexityAgent.type === "custom" && complexComplexityAgent.cliCommand.trim()
                ? complexComplexityAgent.cliCommand.trim()
                : null,
            ...((complexComplexityAgent.type === "lmstudio" ||
              complexComplexityAgent.type === "ollama") && {
              baseUrl:
                complexComplexityAgent.baseUrl ||
                (complexComplexityAgent.type === "ollama"
                  ? DEFAULT_OLLAMA_BASE_URL
                  : DEFAULT_LMSTUDIO_BASE_URL),
            }),
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
          const message = err instanceof Error ? err.message : "Failed to scaffold project";
          const commands =
            err instanceof ApiError &&
            err.details &&
            Array.isArray((err.details as { commands?: unknown }).commands)
              ? (((err.details as { commands?: string[] }).commands as string[]) ?? undefined)
              : undefined;
          const code = err instanceof ApiError ? err.code : undefined;
          const missing =
            err instanceof ApiError &&
            err.details &&
            Array.isArray((err.details as { missing?: unknown }).missing)
              ? ((err.details as { missing: string[] }).missing ?? undefined)
              : undefined;
          setScaffoldError({ message, commands, code, missing });
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
    simpleComplexityAgent.timeoutMs,
    simpleComplexityAgent.effort,
    simpleComplexityAgent.baseUrl,
    complexComplexityAgent.type,
    complexComplexityAgent.model,
    complexComplexityAgent.cliCommand,
    complexComplexityAgent.timeoutMs,
    complexComplexityAgent.effort,
    complexComplexityAgent.baseUrl,
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
          timeoutMs: simpleComplexityAgent.timeoutMs,
          effort: simpleComplexityAgent.effort,
          model:
            simpleComplexityAgent.type === "custom" ? null : simpleComplexityAgent.model || null,
          cliCommand:
            simpleComplexityAgent.type === "custom" && simpleComplexityAgent.cliCommand.trim()
              ? simpleComplexityAgent.cliCommand.trim()
              : null,
          ...((simpleComplexityAgent.type === "lmstudio" ||
            simpleComplexityAgent.type === "ollama") && {
            baseUrl:
              simpleComplexityAgent.baseUrl ||
              (simpleComplexityAgent.type === "ollama"
                ? DEFAULT_OLLAMA_BASE_URL
                : DEFAULT_LMSTUDIO_BASE_URL),
          }),
        },
        complexComplexityAgent: {
          type: complexComplexityAgent.type,
          timeoutMs: complexComplexityAgent.timeoutMs,
          effort: complexComplexityAgent.effort,
          model:
            complexComplexityAgent.type === "custom" ? null : complexComplexityAgent.model || null,
          cliCommand:
            complexComplexityAgent.type === "custom" && complexComplexityAgent.cliCommand.trim()
              ? complexComplexityAgent.cliCommand.trim()
              : null,
          ...((complexComplexityAgent.type === "lmstudio" ||
            complexComplexityAgent.type === "ollama") && {
            baseUrl:
              complexComplexityAgent.baseUrl ||
              (complexComplexityAgent.type === "ollama"
                ? DEFAULT_OLLAMA_BASE_URL
                : DEFAULT_LMSTUDIO_BASE_URL),
          }),
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
          const message = err instanceof Error ? err.message : "Failed to scaffold project";
          const commands =
            err instanceof ApiError &&
            err.details &&
            Array.isArray((err.details as { commands?: unknown }).commands)
              ? (((err.details as { commands?: string[] }).commands as string[]) ?? undefined)
              : undefined;
          const code = err instanceof ApiError ? err.code : undefined;
          const missing =
            err instanceof ApiError &&
            err.details &&
            Array.isArray((err.details as { missing?: unknown }).missing)
              ? ((err.details as { missing: string[] }).missing ?? undefined)
              : undefined;
          setScaffoldError({ message, commands, code, missing });
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

  const canProceedFromBasics = parentPath.trim().length > 0 && !repoPathValidationMessage;

  const missingApiKeyRequirements = getMissingApiKeyRequirements(envKeys, [
    simpleComplexityAgent.type,
    complexComplexityAgent.type,
  ]);
  const usesClaudeCli =
    simpleComplexityAgent.type === "claude-cli" || complexComplexityAgent.type === "claude-cli";
  const claudeCliMissing = envKeys && !envKeys.claudeCli && usesClaudeCli;
  const codexCliMissing =
    envKeys &&
    !envKeys.codexCli &&
    (simpleComplexityAgent.type === "codex" || complexComplexityAgent.type === "codex");

  const canProceedFromAgents =
    envKeys !== null &&
    !repoPathValidationMessage &&
    missingApiKeyRequirements.length === 0 &&
    !claudeCliMissing &&
    !codexCliMissing &&
    hasConfiguredLocalModel(simpleComplexityAgent) &&
    hasConfiguredLocalModel(complexComplexityAgent) &&
    (simpleComplexityAgent.type !== "custom" || simpleComplexityAgent.cliCommand.trim()) &&
    (complexComplexityAgent.type !== "custom" || complexComplexityAgent.cliCommand.trim());

  const showBackButton =
    currentStepIndex > 0 && !(step === "scaffold" && (scaffolding || scaffoldedProject !== null));

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
                  validationMessage={repoPathValidationMessage}
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
                    onChange={(e) => setTemplate(e.target.value as ScaffoldTemplate)}
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
                      href={`${GITHUB_REPO_URL}/issues/new`}
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
                onSimpleComplexityAgentChange={(config) =>
                  setSimpleComplexityAgent((prev) => ({
                    ...prev,
                    ...config,
                    baseUrl: config.baseUrl ?? prev.baseUrl ?? "",
                  }))
                }
                onComplexComplexityAgentChange={(config) =>
                  setComplexComplexityAgent((prev) => ({
                    ...prev,
                    ...config,
                    baseUrl: config.baseUrl ?? prev.baseUrl ?? "",
                  }))
                }
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
                    <p className="text-theme-text font-medium">
                      {template === "empty"
                        ? "Setting up your project..."
                        : "Building your project..."}
                    </p>
                    {template !== "empty" && (
                      <p className="text-sm text-theme-muted mt-1">
                        Creating scaffolding and installing dependencies. If an error is detected,
                        an agent will attempt to fix it automatically.
                      </p>
                    )}
                  </div>
                )}
                {scaffoldError && !scaffolding && (
                  <div data-testid="scaffold-error-details" className="space-y-3">
                    <div className="p-3 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text">
                      <p className="font-medium mb-1">Initialization failed</p>
                      <p>{scaffoldError.message}</p>
                      {scaffoldError.commands && scaffoldError.commands.length > 0 && (
                        <pre className="mt-3 p-3 bg-theme-surface-muted rounded-lg font-mono text-xs overflow-x-auto">
                          {scaffoldError.commands.join("\n")}
                        </pre>
                      )}
                      {scaffoldError.code === "SCAFFOLD_PREREQUISITES_MISSING" &&
                        scaffoldError.missing &&
                        scaffoldError.missing.length > 0 && (
                          <div
                            className="mt-3 flex flex-wrap gap-2"
                            data-testid="prereq-install-buttons"
                          >
                            {scaffoldError.missing.map((tool) => (
                              <a
                                key={tool}
                                href={getPrereqInstallUrl(tool, backendRuntime?.platform)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn-primary inline-flex items-center gap-1.5"
                                data-testid={`install-${tool.toLowerCase().replace(".", "")}-button`}
                              >
                                Install {tool}
                              </a>
                            ))}
                          </div>
                        )}
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
                    {backendRuntime?.isWsl && (
                      <p className="text-sm text-theme-muted">
                        Run these commands in your WSL terminal.
                      </p>
                    )}
                    <p className="text-sm text-theme-muted">
                      Run these commands{" "}
                      {backendRuntime?.isWsl && <span>in your WSL terminal</span>} in order:
                    </p>
                    <pre className="p-3 bg-theme-surface-muted rounded-lg font-mono text-sm overflow-x-auto">
                      {runInstructions.join("\n")}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {scaffoldError && !scaffolding && (
            <div className="mt-4 p-3 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text">
              <div className="flex justify-between items-start gap-4">
                <span>{scaffoldError.message}</span>
                <button
                  type="button"
                  onClick={() => {
                    setScaffoldError(null);
                    setScaffoldRecovery(null);
                  }}
                  className="text-theme-error-text hover:opacity-80 underline shrink-0"
                >
                  Dismiss
                </button>
              </div>
              {scaffoldError.commands && scaffoldError.commands.length > 0 && (
                <pre className="mt-3 p-3 bg-theme-surface-muted rounded-lg font-mono text-xs overflow-x-auto">
                  {scaffoldError.commands.join("\n")}
                </pre>
              )}
            </div>
          )}

          {repoPathValidationMessage && step !== "scaffold" && (
            <div className="mt-4 p-3 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text">
              {repoPathValidationMessage}
            </div>
          )}

          <div className="flex justify-between mt-6">
            {showBackButton ? (
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
