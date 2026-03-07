import { z } from "zod";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";

/** Agent type: claude, cursor, openai, lmstudio, or custom CLI (PRD §6.3) */
const agentTypeSchema = z.enum([
  "claude",
  "claude-cli",
  "cursor",
  "custom",
  "openai",
  "google",
  "lmstudio",
]);

const httpOrHttps = /^https?:\/\/.+$/i;

/** Optional base URL: trimmed, http/https only, trailing slash removed (for /v1 suffix). */
const baseUrlSchema = z
  .string()
  .optional()
  .transform((s) => (s === undefined ? undefined : s.trim()))
  .refine(
    (s) => s === undefined || s === "" || httpOrHttps.test(s),
    { message: "baseUrl must be an http or https URL" }
  )
  .transform((s) =>
    s === undefined || s === "" ? s : s.replace(/\/+$/, "")
  );

/**
 * Agent configuration schema (PRD §6.3, §10.2).
 * simpleComplexityAgent and complexComplexityAgent: { type, model, cliCommand, baseUrl? }
 * - claude/cursor/openai/google/lmstudio: model used when invoking; cliCommand null
 * - lmstudio: optional baseUrl (default elsewhere); must be http/https, no trailing slash
 * - custom: cliCommand required; model null
 */
export const agentConfigSchema = z
  .object({
    type: agentTypeSchema,
    model: z.string().nullable(),
    cliCommand: z.string().nullable(),
    baseUrl: baseUrlSchema,
  })
  .superRefine((data, ctx) => {
    if (data.type === "lmstudio" && data.baseUrl === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "baseUrl cannot be empty when type is lmstudio",
        path: ["baseUrl"],
      });
    }
  })
  .transform((data) => ({
    ...data,
    baseUrl: data.baseUrl === "" ? undefined : data.baseUrl,
  }));

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
