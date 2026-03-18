import { z } from "zod";

export const prdDiffQuerySchema = z.object({
  fromVersion: z.coerce.number().int().nonnegative(),
  toVersion: z.string().optional(),
});

export const prdProposedDiffQuerySchema = z.object({
  requestId: z.string().min(1, { message: "requestId is required" }),
});

export const prdSectionParamsSchema = z.object({
  projectId: z.string().min(1),
  section: z.string().min(1),
});

export const prdSectionPutBodySchema = z.object({
  content: z.string(),
  source: z.string().optional(),
});
