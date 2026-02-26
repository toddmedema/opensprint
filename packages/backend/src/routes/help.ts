import { Router, Request } from "express";
import type { ApiResponse, HelpChatRequest, HelpChatResponse } from "@opensprint/shared";
import { HelpChatService } from "../services/help-chat.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("help-route");
const helpChatService = new HelpChatService();

export const helpRouter = Router();

// POST /help/chat — Ask a Question (ask-only agent, no state changes)
helpRouter.post("/chat", async (req: Request, res, next) => {
  try {
    const body = req.body as HelpChatRequest;
    log.info("POST /help/chat", {
      projectId: body.projectId ?? "homepage",
      messageLen: body.message?.length ?? 0,
    });
    const response = await helpChatService.sendMessage(body);
    const result: ApiResponse<HelpChatResponse> = { data: response };
    res.json(result);
  } catch (err) {
    next(err);
  }
});
