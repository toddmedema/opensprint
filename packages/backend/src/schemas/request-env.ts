import { z } from "zod";

export const envGlobalSettingsBodySchema = z
  .object({
    useCustomCli: z.boolean().optional(),
  })
  .optional()
  .default({});

export const envKeysValidateBodySchema = z.object({
  provider: z.enum(["claude", "cursor", "openai", "google"]),
  value: z.string().min(1, { message: "value is required" }),
});

export const envKeysPostBodySchema = z.object({
  key: z.enum(["ANTHROPIC_API_KEY", "CURSOR_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"]),
  value: z.string().min(1, { message: "value is required" }),
});
