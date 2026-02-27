import { TEST_FRAMEWORKS, type AgentConfig, type UnknownScopeStrategy } from "@opensprint/shared";
import type { ProjectMetadataState } from "./ProjectMetadataStep";

export interface ConfirmStepProps {
  metadata: ProjectMetadataState;
  repoPath: string;
  simpleComplexityAgent: AgentConfig;
  complexComplexityAgent: AgentConfig;
  deploymentMode?: string;
  customDeployCommand?: string;
  customDeployWebhook?: string;
  testFramework: string;
  maxConcurrentCoders: number;
  /** Shown in summary when maxConcurrentCoders > 1 */
  unknownScopeStrategy?: UnknownScopeStrategy;
  /** Shown in summary when Branches selected */
  gitWorkingMode?: "worktree" | "branches";
  /** Hide Deliver row (e.g. Add Existing flow; configure later via project settings) */
  hideDeployment?: boolean;
}

export function ConfirmStep({
  metadata,
  repoPath,
  simpleComplexityAgent,
  complexComplexityAgent,
  deploymentMode = "custom",
  customDeployCommand = "",
  customDeployWebhook = "",
  testFramework,
  maxConcurrentCoders,
  unknownScopeStrategy,
  gitWorkingMode,
  hideDeployment = false,
}: ConfirmStepProps) {
  const providerDisplayName = (type: string) => {
    switch (type) {
      case "claude":
        return "Claude (API)";
      case "claude-cli":
        return "Claude (CLI)";
      case "cursor":
        return "Cursor";
      default:
        return type;
    }
  };

  const simpleComplexityLabel =
    simpleComplexityAgent.type === "custom"
      ? (simpleComplexityAgent.cliCommand ?? "").trim()
        ? `Custom: ${(simpleComplexityAgent.cliCommand ?? "").trim()}`
        : "Custom (not configured)"
      : `${providerDisplayName(simpleComplexityAgent.type)}${simpleComplexityAgent.model ? ` — ${simpleComplexityAgent.model}` : ""}`;

  const complexComplexityLabel =
    complexComplexityAgent.type === "custom"
      ? (complexComplexityAgent.cliCommand ?? "").trim()
        ? `Custom: ${(complexComplexityAgent.cliCommand ?? "").trim()}`
        : "Custom (not configured)"
      : `${providerDisplayName(complexComplexityAgent.type)}${complexComplexityAgent.model ? ` — ${complexComplexityAgent.model}` : ""}`;

  const deploymentLabel =
    deploymentMode === "custom"
      ? (customDeployCommand ?? "").trim()
        ? `Custom: ${(customDeployCommand ?? "").trim()}`
        : (customDeployWebhook ?? "").trim()
          ? `Webhook: ${(customDeployWebhook ?? "").trim()}`
          : "Custom (not configured)"
      : "Expo";

  const testLabel =
    testFramework === "none"
      ? "None"
      : (TEST_FRAMEWORKS.find((f) => f.id === testFramework)?.label ?? testFramework);

  return (
    <div className="space-y-4" data-testid="confirm-step">
      <h3 className="text-sm font-semibold text-theme-text">Review your project setup</h3>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-theme-muted">Name</dt>
          <dd className="font-medium">{metadata.name}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-theme-muted">Project folder</dt>
          <dd className="font-mono text-xs">{repoPath}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-theme-muted">Task Complexity — Simple</dt>
          <dd className="font-medium capitalize">{simpleComplexityLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-theme-muted">Task Complexity — Complex</dt>
          <dd className="font-medium capitalize">{complexComplexityLabel}</dd>
        </div>
        {!hideDeployment && (
          <div className="flex justify-between">
            <dt className="text-theme-muted">Deliver</dt>
            <dd className="font-medium">{deploymentLabel}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-theme-muted">Test Framework</dt>
          <dd className="font-medium">{testLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-theme-muted">Concurrent Coders</dt>
          <dd className="font-medium">
            {maxConcurrentCoders === 1 ? "1 (sequential)" : maxConcurrentCoders}
          </dd>
        </div>
        {gitWorkingMode === "branches" && (
          <div className="flex justify-between">
            <dt className="text-theme-muted">Git working mode</dt>
            <dd className="font-medium">Branches</dd>
          </div>
        )}
        {maxConcurrentCoders > 1 && unknownScopeStrategy != null && (
          <div className="flex justify-between">
            <dt className="text-theme-muted">Unknown scope strategy</dt>
            <dd className="font-medium capitalize">{unknownScopeStrategy}</dd>
          </div>
        )}
      </dl>
      <p className="text-xs text-theme-muted pt-2 border-t border-theme-border">
        On create: the task store will be initialized (orchestrator manages persistence).
        <code className="font-mono">.opensprint/orchestrator-state.json</code> and{" "}
        <code className="font-mono">.opensprint/worktrees/</code> will be added to .gitignore.
      </p>
    </div>
  );
}
