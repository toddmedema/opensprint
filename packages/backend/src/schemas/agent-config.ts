import { z } from "zod";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";

/** Agent type: claude, cursor, or custom CLI (PRD §6.3) */
const agentTypeSchema = z.enum(["claude", "claude-cli", "cursor", "custom"]);

/**
 * Agent configuration schema (PRD §6.3, §10.2).
 * simpleComplexityAgent and complexComplexityAgent: { type, model, cliCommand }
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
  field: "simpleComplexityAgent" | "complexComplexityAgent"
): AgentConfigInput {
  const result = agentConfigSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const pathStr = first.path.length ? `${field}.${first.path.join(".")}` : field;
    throw new AppError(
      400,
      ErrorCodes.INVALID_AGENT_CONFIG,
      `Invalid ${pathStr}: ${first.message}`,
      {
        field,
        validationError: first.message,
      }
    );
  }
  return result.data;
}
