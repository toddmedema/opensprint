/** Native CLI reasoning settings. Omitted effort preserves the CLI's configuration. */
export const AGENT_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type AgentEffort = (typeof AGENT_EFFORT_LEVELS)[number];
export interface AgentModelOption {
  id: string;
  displayName: string;
  /** undefined means unavailable metadata; [] means no explicit effort is supported. */
  supportedEfforts?: Array<{ effort: AgentEffort; description?: string }>;
  defaultEffort?: AgentEffort;
}
export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && AGENT_EFFORT_LEVELS.includes(value as AgentEffort);
}
/** Subscription aliases resolve to current Anthropic models, not third-party deployments.
 * https://code.claude.com/docs/en/model-config#adjust-effort-level
 */
export function getClaudeCliEffortCapabilities(
  model: string | null
): Pick<AgentModelOption, "supportedEfforts" | "defaultEffort"> {
  if (!model || model === "default") return { supportedEfforts: [] };
  const latest = ["sonnet", "opus", "haiku", "fable"].includes(model);
  const modern =
    /^claude-(?:fable-5(?:-1)?|(?:opus|sonnet|haiku)-5-5|(?:opus|sonnet)-5|opus-4-[78])$/.test(
      model
    );
  const older = /^claude-(?:opus|sonnet)-4-6$/.test(model);
  if (!latest && !modern && !older) return { supportedEfforts: [] };
  const efforts: AgentEffort[] = older
    ? ["low", "medium", "high", "max"]
    : ["low", "medium", "high", "xhigh", "max"];
  const mediumDefault =
    ["sonnet", "opus", "haiku"].includes(model) || /^claude-(opus|sonnet|haiku)-5-5$/.test(model);
  return {
    supportedEfforts: efforts.map((effort) => ({ effort })),
    defaultEffort: mediumDefault ? "medium" : model === "claude-opus-4-7" ? "xhigh" : "high",
  };
}
