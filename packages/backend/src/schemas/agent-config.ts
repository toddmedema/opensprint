import { z } from "zod";

/** Agent type: claude, cursor, or custom CLI (PRD §6.3) */
const agentTypeSchema = z.enum(["claude", "cursor", "custom"]);

/**
 * Agent configuration schema (PRD §6.3, §10.2).
 * planning_agent and coding_agent: { type, model, cli_command }
 * - claude/cursor: model used when invoking; cliCommand null
 * - custom: cliCommand required; model null
 */
export const agentConfigSchema = z.object({
  type: agentTypeSchema,
  model: z.string().nullable(),
  cliCommand: z.string().nullable(),
});

export type AgentConfigInput = z.infer<typeof agentConfigSchema>;

/** Validate and parse agent config from request body */
export function parseAgentConfig(
  value: unknown,
  field: "planningAgent" | "codingAgent",
): AgentConfigInput {
  const result = agentConfigSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.length ? `${field}.${first.path.join(".")}` : field;
    throw new Error(`Invalid ${path}: ${first.message}`);
  }
  return result.data;
}
