import type { AgentConfig, ProjectSettings, TaskSize } from "@opensprint/shared";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_TASK_SIZE } from "@opensprint/shared";

export type PlanningTaskSettings = Pick<Partial<ProjectSettings>, "taskSize"> & {
  /** Dedicated task-type configuration takes precedence over legacy complexity tiers. */
  codingAgent?: AgentConfig;
  simpleComplexityAgent?: AgentConfig;
  complexComplexityAgent?: AgentConfig;
};

const SIZE_GUIDANCE: Record<TaskSize, string> = {
  larger:
    "Prefer a few substantial tasks covering complete outcomes. Batch related pages, content records, and repeated changes into one task. Strongly prefer a flat plan; create sub-plans only for substantial independent workstreams that cannot reasonably fit in one task batch.",
  balanced:
    "Split at meaningful implementation boundaries. Keep closely related changes together and batch repetitive work when it shares one implementation pattern. Use sub-plans only for substantial independent workstreams.",
  smaller:
    "Use narrower, independently verifiable scopes and more checkpoints. Split complicated outcomes into smaller coding sessions where useful. Still batch straightforward repetitive work and keep implementation with its tests. Use sub-plans when the workstreams warrant separate planning.",
};

/** Describe coding capacity without exposing commands, URLs, or credentials. */
function codingAgentContext(config: AgentConfig | undefined): string {
  if (!config) return "Not specified; do not assume a particular model capability.";
  return JSON.stringify({
    provider: config.type,
    model: config.model ?? "provider default (capability unknown)",
    effort: config.effort ?? "provider default",
    timeoutMs:
      config.timeoutMs === null ? "unlimited" : (config.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS),
  });
}

/** Shared by decomposition, task generation, and their repair turns. Never includes credentials. */
export function buildPlanningTaskPolicy(settings: PlanningTaskSettings = {}): string {
  const size = settings.taskSize ?? DEFAULT_TASK_SIZE;
  const codingContext = settings.codingAgent
    ? `Coding: ${codingAgentContext(settings.codingAgent)}`
    : `Simple tier: ${codingAgentContext(settings.simpleComplexityAgent)}\nComplex tier: ${codingAgentContext(settings.complexComplexityAgent)}`;
  return `## Project task size: ${size}

${SIZE_GUIDANCE[size]}

- A task is one coherent, independently verifiable outcome achievable in one coding session. It may span multiple files, components, endpoints, and their tests.
- Choose the fewest tasks that reliably cover the complete scope at the selected size. There is no minimum task count: a simple change can be one task with any setting. Never pad a plan to meet a quota.
- Include implementation, focused tests, and verification in the same task. Reserve separate verification tasks for substantial independent integration work.
- Split on risk, uncertainty, dependency boundaries, and useful independent execution, not the number of files, pages, records, or plan headings.
- Preserve every requirement and acceptance criterion when consolidating. Never drop scope to meet a count limit. Apply this policy throughout the plan tree; do not multiply repetitive work into child plans.

## Coding agents available for execution

${codingContext}

Size work for the coding agents above, not your own planning model. Consider their configured model, effort, and session time limit when judging a feasible session. Unknown/default models are not evidence of capability. The user's explicit task size takes precedence over model-based suggestions; do not change it or switch models automatically.`;
}
