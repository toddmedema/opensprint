import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { Layout } from "../components/layout/Layout";
import { FolderBrowser } from "../components/FolderBrowser";
import {
  ProjectMetadataStep,
  isValidProjectMetadata,
  RepositoryStep,
  AgentsStep,
  DeploymentStep,
  TestingStep,
  HilStep,
  ConfirmStep,
} from "../components/ProjectSetupWizard";
import type { ProjectMetadataState } from "../components/ProjectSetupWizard";
import type {
  AgentType,
  DeploymentMode,
  GitWorkingMode,
  HilConfig,
  UnknownScopeStrategy,
} from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import { api, isApiError } from "../api/client";

type Step = "basics" | "agents" | "deployment" | "testing" | "hil" | "confirm";

const STEPS: { key: Step; label: string }[] = [
  { key: "basics", label: "Project Info" },
  { key: "agents", label: "Agent Config" },
  { key: "testing", label: "Execute" },
  { key: "deployment", label: "Deliver" },
  { key: "hil", label: "Autonomy" },
  { key: "confirm", label: "Confirm" },
];

export function ProjectSetup() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("basics");
  const [creating, setCreating] = useState(false);

  const [metadata, setMetadata] = useState<ProjectMetadataState>({ name: "" });
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState("");
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
  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode>("custom");
  const [customDeployCommand, setCustomDeployCommand] = useState("");
  const [customDeployWebhook, setCustomDeployWebhook] = useState("");
  const [testFramework, setTestFramework] = useState<string>("none");
  const [hilConfig, setHilConfig] = useState<HilConfig>(DEFAULT_HIL_CONFIG);
  const [maxConcurrentCoders, setMaxConcurrentCoders] = useState(1);
  const [unknownScopeStrategy, setUnknownScopeStrategy] =
    useState<UnknownScopeStrategy>("optimistic");
  const [gitWorkingMode, setGitWorkingMode] = useState<GitWorkingMode>("worktree");
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  const [detectedFramework, setDetectedFramework] = useState<string | null>(null);
  const [detectingFramework, setDetectingFramework] = useState(false);

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
  const [createError, setCreateError] = useState<string | null>(null);
  const [checkingExisting, setCheckingExisting] = useState(false);

  const currentStepIndex = STEPS.findIndex((s) => s.key === step);

  /** Normalize path for comparison (trim, trailing slash optional). */
  const normalizeRepoPath = (p: string) => p.trim().replace(/\/+$/, "") || "";

  const handleBasicsNext = async () => {
    if (!isValidProjectMetadata(metadata)) {
      setMetadataError("Project name is required");
      return;
    }
    setMetadataError(null);
    const pathToUse = normalizeRepoPath(repoPath);
    if (!pathToUse) return;

    setCheckingExisting(true);
    try {
      const projects = await api.projects.list();
      const existing = projects.find((proj) => normalizeRepoPath(proj.repoPath) === pathToUse);
      if (existing) {
        navigate(getProjectPhasePath(existing.id, existing.currentPhase || "sketch"));
        return;
      }
    } catch {
      // Proceed to wizard on list error (e.g. offline)
    } finally {
      setCheckingExisting(false);
    }
    setStep("agents");
  };

  useEffect(() => {
    if (step !== "agents") return;
    api.env
      .getKeys()
      .then(setEnvKeys)
      .catch(() => setEnvKeys(null));
  }, [step]);

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

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const project = await api.projects.create({
        name: metadata.name.trim(),
        repoPath,
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
        deployment: {
          mode: deploymentMode,
          expoConfig: deploymentMode === "expo" ? { channel: "preview" } : undefined,
          customCommand:
            deploymentMode === "custom" && customDeployCommand.trim()
              ? customDeployCommand.trim()
              : undefined,
          webhookUrl:
            deploymentMode === "custom" && customDeployWebhook.trim()
              ? customDeployWebhook.trim()
              : undefined,
        },
        hilConfig,
        testFramework: testFramework === "none" ? null : testFramework,
        maxConcurrentCoders: gitWorkingMode === "branches" ? 1 : maxConcurrentCoders,
        unknownScopeStrategy,
        gitWorkingMode,
      });
      navigate(getProjectPhasePath((project as { id: string }).id, "sketch"));
    } catch (err) {
      if (isApiError(err) && err.code === "ALREADY_OPENSPRINT_PROJECT") {
        try {
          const projects = await api.projects.list();
          const pathToUse = normalizeRepoPath(repoPath);
          const existing = projects.find((proj) => normalizeRepoPath(proj.repoPath) === pathToUse);
          if (existing) {
            navigate(getProjectPhasePath(existing.id, existing.currentPhase || "sketch"));
            return;
          }
        } catch {
          // fall through to show error
        }
      }
      const msg = err instanceof Error ? err.message : "Failed to create project";
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Layout>
      <div className="h-full overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10">
          <h1 className="text-2xl font-bold text-theme-text mb-2">
            Create New Project
            <span className="text-theme-muted font-normal text-lg ml-2">
              — {STEPS[currentStepIndex]?.label ?? step}
            </span>
          </h1>

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
              <div className="space-y-4">
                <ProjectMetadataStep
                  value={metadata}
                  onChange={(v) => {
                    setMetadata(v);
                    setMetadataError(null);
                  }}
                  error={metadataError}
                />
                <RepositoryStep
                  value={repoPath}
                  onChange={setRepoPath}
                  onBrowse={() => setShowFolderBrowser(true)}
                />
              </div>
            )}

            {step === "agents" && (
              <AgentsStep
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
                maxConcurrentCoders={maxConcurrentCoders}
                onMaxConcurrentCodersChange={setMaxConcurrentCoders}
                unknownScopeStrategy={unknownScopeStrategy}
                onUnknownScopeStrategyChange={setUnknownScopeStrategy}
                gitWorkingMode={gitWorkingMode}
                onGitWorkingModeChange={(v) => {
                  setGitWorkingMode(v);
                  if (v === "branches") setMaxConcurrentCoders(1);
                }}
              />
            )}

            {step === "testing" && (
              <TestingStep
                value={testFramework}
                onChange={setTestFramework}
                detectingFramework={detectingFramework}
                detectedFramework={detectedFramework}
              />
            )}

            {step === "deployment" && (
              <DeploymentStep
                mode={deploymentMode}
                customCommand={customDeployCommand}
                customWebhook={customDeployWebhook}
                onModeChange={setDeploymentMode}
                onCustomCommandChange={setCustomDeployCommand}
                onCustomWebhookChange={setCustomDeployWebhook}
              />
            )}

            {step === "hil" && <HilStep value={hilConfig} onChange={setHilConfig} />}

            {step === "confirm" && (
              <ConfirmStep
                metadata={metadata}
                repoPath={repoPath}
                simpleComplexityAgent={simpleComplexityAgent}
                complexComplexityAgent={complexComplexityAgent}
                deploymentMode={deploymentMode}
                customDeployCommand={customDeployCommand}
                customDeployWebhook={customDeployWebhook}
                testFramework={testFramework}
                maxConcurrentCoders={maxConcurrentCoders}
                unknownScopeStrategy={unknownScopeStrategy}
                gitWorkingMode={gitWorkingMode}
              />
            )}
          </div>

          {createError && (
            <div className="mt-4 p-3 bg-theme-error-bg border border-theme-error-border rounded-lg text-sm text-theme-error-text flex justify-between items-center">
              <span>{createError}</span>
              <button
                type="button"
                onClick={() => setCreateError(null)}
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
              >
                Back
              </button>
            ) : (
              <span aria-hidden="true" />
            )}
            {step === "confirm" ? (
              <button
                onClick={handleCreate}
                disabled={
                  creating ||
                  (simpleComplexityAgent.type === "custom" && !simpleComplexityAgent.cliCommand.trim()) ||
                  (complexComplexityAgent.type === "custom" && !complexComplexityAgent.cliCommand.trim())
                }
                className="btn-primary disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create Project"}
              </button>
            ) : step === "basics" ? (
              <button
                onClick={handleBasicsNext}
                disabled={!repoPath.trim() || checkingExisting}
                className="btn-primary disabled:opacity-50"
              >
                {checkingExisting ? "Opening project…" : "Next"}
              </button>
            ) : (
              <button
                onClick={() => setStep(STEPS[currentStepIndex + 1]?.key ?? "confirm")}
                disabled={
                  step === "agents" &&
                  ((simpleComplexityAgent.type === "custom" &&
                    !simpleComplexityAgent.cliCommand.trim()) ||
                    (complexComplexityAgent.type === "custom" &&
                      !complexComplexityAgent.cliCommand.trim()))
                }
                className="btn-primary disabled:opacity-50"
              >
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
      </div>
    </Layout>
  );
}
