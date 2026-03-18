import { z } from "zod";

export const modelsListQuerySchema = z.object({
  provider: z.string().optional(),
  projectId: z.string().optional(),
  baseUrl: z.string().optional(),
});
