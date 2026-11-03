import { z } from "zod";
import { AGENT_EFFORT_LEVELS, getClaudeCliEffortCapabilities } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";

/** Agent type: claude, cursor, openai, google, lmstudio, ollama, or custom CLI (PRD §6.3) */
const agentTypeSchema = z.enum([
  "claude",
  "claude-cli",
  "codex",
  "cursor",
  "custom",
  "openai",
  "google",
  "lmstudio",
  "ollama",
]);

const httpOrHttps = /^https?:\/\/.+$/i;

/** Optional base URL: trimmed, http/https only, trailing slash removed (for /v1 suffix). */
const baseUrlSchema = z
  .string()
  .optional()
  .transform((s) => (s === undefined ? undefined : s.trim()))
  .refine((s) => s === undefined || s === "" || httpOrHttps.test(s), {
    message: "baseUrl must be an http or https URL",
  })
  .transform((s) => (s === undefined || s === "" ? s : s.replace(/\/+$/, "")));

const timeoutMsSchema = z
  .union([
    z.literal(5 * 60 * 1000),
    z.literal(15 * 60 * 1000),
    z.literal(30 * 60 * 1000),
    z.literal(60 * 60 * 1000),
    z.null(),
  ])
  .optional();

/**
 * Agent configuration schema (PRD §6.3, §10.2).
 * simpleComplexityAgent and complexComplexityAgent: { type, model, cliCommand, baseUrl? }
 * - claude/cursor/openai/google/lmstudio/ollama: model used when invoking; cliCommand null
 * - lmstudio/ollama: optional baseUrl (default elsewhere); must be http/https, no trailing slash
 * - custom: cliCommand required; model null
 */
export const agentConfigSchema = z
  .object({
    type: agentTypeSchema,
    model: z.string().nullable(),
    cliCommand: z.string().nullable(),
    timeoutMs: timeoutMsSchema,
    effort: z.enum(AGENT_EFFORT_LEVELS).optional(),
    baseUrl: baseUrlSchema,
  })
  .superRefine((data, ctx) => {
    if (
      data.effort &&
      ((data.type !== "codex" && data.type !== "claude-cli") ||
        !data.model ||
        data.model === "default" ||
        (data.type === "claude-cli" &&
          !getClaudeCliEffortCapabilities(data.model).supportedEfforts?.some(
            (level) => level.effort === data.effort
          )))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "effort must be supported by an explicitly selected native CLI model",
        path: ["effort"],
      });
    }
    if ((data.type === "lmstudio" || data.type === "ollama") && data.baseUrl === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `baseUrl cannot be empty when type is ${data.type}`,
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
