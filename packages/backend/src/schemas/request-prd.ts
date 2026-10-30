import { z } from "zod";
import { PRD_DIFF_DEFAULT_LINE_LIMIT, PRD_DIFF_MAX_LINE_LIMIT } from "@opensprint/shared";

const includeContentSchema = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === undefined || v === "true" || v === "1");

const lineOffsetSchema = z.coerce.number().int().min(0).default(0);
const lineLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(PRD_DIFF_MAX_LINE_LIMIT)
  .default(PRD_DIFF_DEFAULT_LINE_LIMIT);

export const prdDiffQuerySchema = z.object({
  fromVersion: z.coerce.number().int().nonnegative(),
  toVersion: z.string().optional(),
  includeContent: includeContentSchema,
  lineOffset: lineOffsetSchema,
  lineLimit: lineLimitSchema,
});

export const prdProposedDiffQuerySchema = z.object({
  requestId: z.string().min(1, { message: "requestId is required" }),
  includeContent: includeContentSchema,
  lineOffset: lineOffsetSchema,
  lineLimit: lineLimitSchema,
});

export const prdSectionParamsSchema = z.object({
  projectId: z.string().min(1),
  section: z.string().min(1),
});

export const prdSectionPutBodySchema = z.object({
  content: z.string(),
  source: z.string().optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
});
