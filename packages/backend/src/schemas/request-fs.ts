import { z } from "zod";

export const fsBrowseQuerySchema = z.object({
  path: z.string().optional(),
});

export const fsCreateFolderBodySchema = z.object({
  parentPath: z.string().min(1, { message: "parentPath is required" }),
  name: z.string().min(1, { message: "name is required" }),
});

export const fsDetectTestFrameworkQuerySchema = z.object({
  path: z.string().min(1, { message: "path is required" }),
});
