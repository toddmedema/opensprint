import { z } from "zod";

export const projectIdParamSchema = z.object({
  projectId: z.string().min(1),
});

export const taskIdParamSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});

export const taskDependencyParamsSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  parentTaskId: z.string().min(1),
});

export const sessionParamsSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  attempt: z.string().min(1),
});

export const unblockBodySchema = z
  .object({
    resetAttempts: z.boolean().optional(),
  })
  .optional()
  .default({});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const executePrepareBodySchema = z
  .object({
    phase: z.enum(["coding", "review"]).optional(),
    createBranch: z.boolean().optional(),
    attempt: z.number().int().positive().optional(),
  })
  .optional()
  .default({});

export const executeEventsQuerySchema = z.object({
  since: z.string().optional(),
  taskId: z.string().optional(),
  count: z.coerce.number().int().positive().optional(),
});

export const executeFailureMetricsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(90).optional(),
});

export const notificationParamsSchema = z.object({
  projectId: z.string().min(1),
  notificationId: z.string().min(1),
});

export const notificationResolveBodySchema = z
  .object({
    approved: z.boolean().optional(),
    responses: z.array(z.object({ questionId: z.string(), answer: z.string() })).optional(),
  })
  .optional()
  .default({});

export const feedbackParamsSchema = z.object({
  projectId: z.string().min(1),
  feedbackId: z.string().min(1),
});

export const feedbackSubmitBodySchema = z.object({
  text: z.string().min(1, { message: "text is required" }),
  images: z.array(z.string()).optional(),
  parent_id: z.union([z.string(), z.null()]).optional(),
  priority: z.number().min(0).max(4).optional(),
  planId: z.string().optional(),
  planVersionNumber: z.number().int().min(1).optional(),
});

export const feedbackRecategorizeBodySchema = z
  .object({ answer: z.string().optional() })
  .optional()
  .default({});

export const chatRequestBodySchema = z
  .object({
    message: z.string().min(1, { message: "message is required" }),
    context: z.string().optional(),
    prdSectionFocus: z.string().optional(),
  })
  .passthrough();

export const chatHistoryQuerySchema = z.object({
  context: z.string().optional(),
});

export const agentRoleParamsSchema = z.object({
  projectId: z.string().min(1),
  role: z.enum([
    "dreamer",
    "planner",
    "harmonizer",
    "analyst",
    "summarizer",
    "auditor",
    "coder",
    "reviewer",
    "merger",
  ]),
});

export const agentKillParamsSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
});

export const agentInstructionsBodySchema = z.object({
  content: z.string(),
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
    assignee: z.union([z.string().trim(), z.null()]).optional(),
  })
  .refine(
    (data) =>
      data.priority !== undefined || data.complexity !== undefined || data.assignee !== undefined,
    {
      message: "At least one of priority, complexity, or assignee is required",
    }
  );

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
