import { z } from "zod";

export const helpProjectIdQuerySchema = z.object({
  projectId: z.string().optional(),
});

export const helpSessionIdParamsSchema = z.object({
  sessionId: z.string().min(1),
});

export const helpChatBodySchema = z.object({
  message: z.string().min(1, { message: "message is required" }),
  projectId: z.union([z.string(), z.null()]).optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional(),
});
