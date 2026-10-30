import { z } from "zod";
import { partialDeploymentSchema } from "./deployment.js";

export const deployIdParamsSchema = z.object({
  projectId: z.string().min(1),
  deployId: z.string().min(1),
});

export const deliverTriggerBodySchema = z
  .object({ target: z.string().optional() })
  .optional()
  .default({});

export const deliverHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/** PUT /deliver/settings — partial deployment config */
export const deliverSettingsBodySchema = partialDeploymentSchema.optional().default({});

export const expoDeployBodySchema = z.object({
  variant: z.enum(["beta", "prod"]),
});
