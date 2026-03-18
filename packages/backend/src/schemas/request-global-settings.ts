import { z } from "zod";

export const apiKeyProviderParamSchema = z.object({
  provider: z.enum([
    "ANTHROPIC_API_KEY",
    "CURSOR_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
  ]),
  id: z.string().min(1),
});

export const migrateToPostgresBodySchema = z.object({
  databaseUrl: z.string().min(1, { message: "databaseUrl is required" }),
});

export const setupTablesBodySchema = z.object({
  databaseUrl: z.string().min(1, { message: "databaseUrl is required" }),
});

/** PUT /global-settings — partial updates */
export const globalSettingsPutBodySchema = z.record(z.string(), z.unknown()).optional().default({});
