import { z } from "zod";

export const projectIdParamSchema = z.object({
  projectId: z.string().min(1),
});

export const taskIdParamSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const taskPatchBodySchema = z
  .object({
    priority: z
      .number()
      .int()
      .min(0, { message: "priority must be 0–4" })
      .max(4, { message: "priority must be 0–4" })
      .optional(),
    complexity: z
      .number()
      .int()
      .min(1, { message: "complexity must be 1–10" })
      .max(10, { message: "complexity must be 1–10" })
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one of priority or complexity is required",
  });

export const dependencyBodySchema = z
  .object({
    parentTaskId: z.string().min(1).trim().optional(),
    type: z.enum(["blocks", "parent-child", "related"]).optional(),
  })
  .refine((data) => data.parentTaskId != null && String(data.parentTaskId).trim().length > 0, {
    message: "parentTaskId is required",
    path: ["parentTaskId"],
  })
  .transform((t) => ({
    parentTaskId: t.parentTaskId!,
    type: t.type ?? "blocks",
  }));
