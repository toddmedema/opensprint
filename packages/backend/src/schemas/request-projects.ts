import { z } from "zod";
import { partialDeploymentSchema } from "./deployment.js";

export const projectIdParamSchema = z.object({
  id: z.string().min(1),
});

export const createProjectBodySchema = z
  .object({
    name: z.string().min(1, { message: "name is required" }),
    repoPath: z.string().min(1, { message: "repoPath is required" }),
    deployment: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const scaffoldProjectBodySchema = z
  .object({
    name: z.string().min(1, { message: "name is required" }),
    parentPath: z.string().min(1, { message: "parentPath is required" }),
    template: z.enum(["web-app-expo-react", "empty"]),
  })
  .passthrough();

export const updateProjectBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    repoPath: z.string().min(1).optional(),
  })
  .optional()
  .default({});

export const selfImprovementHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

export const selfImprovementApproveRejectBodySchema = z
  .object({
    candidateId: z.string().min(1).optional(),
  })
  .optional()
  .default({});

export const selfImprovementRollbackBodySchema = z.object({
  behaviorVersionId: z.string().min(1),
});

/** PUT /projects/:id/settings — accepts partial project settings (apiKeys stripped by route) */
export const updateSettingsBodySchema = z
  .object({ deployment: partialDeploymentSchema.optional() })
  .passthrough()
  .optional()
  .default({});
