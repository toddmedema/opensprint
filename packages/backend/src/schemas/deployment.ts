import { z } from "zod";

const targetSchema = z
  .object({
    name: z.string().refine((value) => value.trim().length > 0, "Target name is required"),
    command: z.string().optional(),
    webhookUrl: z.string().optional(),
    rollbackCommand: z.string().optional(),
    isDefault: z.boolean().optional(),
    autoDeployTrigger: z
      .enum(["each_task", "each_epic", "eval_resolution", "nightly", "none"])
      .optional(),
    envVars: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

/** Validate target structure without changing other established deployment patch fields. */
export const partialDeploymentSchema = z
  .object({ targets: z.array(targetSchema).optional() })
  .passthrough();
