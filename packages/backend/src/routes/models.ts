import { Router, Request } from "express";
import Anthropic from "@anthropic-ai/sdk";
import type { ApiResponse } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import * as modelListCache from "../services/model-list-cache.js";

export interface ModelOption {
  id: string;
  displayName: string;
}

export const modelsRouter = Router();

const CURSOR_MODELS_URL = "https://api.cursor.com/v0/models";

async function fetchClaudeModels(apiKey: string): Promise<ModelOption[]> {
  const client = new Anthropic({ apiKey });
  const models: ModelOption[] = [];
  for await (const model of client.models.list({ limit: 100 })) {
    models.push({
      id: model.id,
      displayName: model.display_name,
    });
  }
  return models;
}

async function fetchCursorModels(apiKey: string): Promise<ModelOption[]> {
  const response = await fetch(CURSOR_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const hint =
      response.status === 401
        ? " Check that CURSOR_API_KEY in .env is valid. Get a key from Cursor → Settings → Integrations → User API Keys."
        : response.status === 403
          ? " Your API key may not have access to models."
          : "";
    throw new AppError(response.status >= 500 ? 502 : response.status, ErrorCodes.CURSOR_API_ERROR, `Cursor API error ${response.status}: ${text}${hint}`, {
      status: response.status,
      responsePreview: text.slice(0, 200),
    });
  }

  const body = (await response.json()) as { models?: string[] };
  return (body.models ?? []).map((id) => ({
    id,
    displayName: id,
  }));
}

// GET /models?provider=claude|cursor — List available models for the given provider
modelsRouter.get("/", async (req: Request, res, next) => {
  try {
    const provider = (req.query.provider as string) || "claude";

    if (provider === "claude") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const cached = modelListCache.get<ModelOption[]>("claude");
      if (cached !== undefined) {
        res.json({ data: cached } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await fetchClaudeModels(apiKey);
      modelListCache.set("claude", models);
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    if (provider === "cursor") {
      const apiKey = process.env.CURSOR_API_KEY;
      if (!apiKey) {
        res.json({ data: [] } as ApiResponse<ModelOption[]>);
        return;
      }

      const cached = modelListCache.get<ModelOption[]>("cursor");
      if (cached !== undefined) {
        res.json({ data: cached } as ApiResponse<ModelOption[]>);
        return;
      }

      const models = await fetchCursorModels(apiKey);
      modelListCache.set("cursor", models);
      res.json({ data: models } as ApiResponse<ModelOption[]>);
      return;
    }

    res.json({ data: [] } as ApiResponse<ModelOption[]>);
  } catch (err) {
    next(err);
  }
});
