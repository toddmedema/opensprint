import { TEST_FRAMEWORKS } from "@opensprint/shared";
import type { ProjectMetadataState } from "./ProjectMetadataStep";

export interface ConfirmStepProps {
  metadata: ProjectMetadataState;
  repoPath: string;
  planningAgent: { type: string; model: string; cliCommand: string };
  codingAgent: { type: string; model: string; cliCommand: string };
  deploymentMode: string;
  customDeployCommand: string;
  customDeployWebhook: string;
  testFramework: string;
}

export function ConfirmStep({
  metadata,
  repoPath,
  planningAgent,
  codingAgent,
  deploymentMode,
  customDeployCommand,
  customDeployWebhook,
  testFramework,
}: ConfirmStepProps) {
  const planningLabel =
    planningAgent.type === "custom"
      ? planningAgent.cliCommand.trim()
        ? `Custom: ${planningAgent.cliCommand.trim()}`
        : "Custom (not configured)"
      : `${planningAgent.type}${planningAgent.model ? ` (${planningAgent.model})` : ""}`;

  const codingLabel =
    codingAgent.type === "custom"
      ? codingAgent.cliCommand.trim()
        ? `Custom: ${codingAgent.cliCommand.trim()}`
        : "Custom (not configured)"
      : `${codingAgent.type}${codingAgent.model ? ` (${codingAgent.model})` : ""}`;

  const deploymentLabel =
    deploymentMode === "custom"
      ? customDeployCommand.trim()
        ? `Custom: ${customDeployCommand.trim()}`
        : customDeployWebhook.trim()
          ? `Webhook: ${customDeployWebhook.trim()}`
          : "Custom (not configured)"
      : "Expo";

  const testLabel =
    testFramework === "none"
      ? "None"
      : (TEST_FRAMEWORKS.find((f) => f.id === testFramework)?.label ?? testFramework);

  return (
    <div className="space-y-4" data-testid="confirm-step">
      <h3 className="text-sm font-semibold text-gray-900">Review your project setup</h3>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-gray-500">Name</dt>
          <dd className="font-medium">{metadata.name}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Repository</dt>
          <dd className="font-mono text-xs">{repoPath}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Planning Agent Slot</dt>
          <dd className="font-medium capitalize">{planningLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Coding Agent Slot</dt>
          <dd className="font-medium capitalize">{codingLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Deployment</dt>
          <dd className="font-medium">{deploymentLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Test Framework</dt>
          <dd className="font-medium">{testLabel}</dd>
        </div>
      </dl>
    </div>
  );
}
