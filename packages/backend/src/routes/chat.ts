import { Router, Request } from "express";
import { ChatService } from "../services/chat.service.js";
import type { ApiResponse, ChatRequest, ChatResponse, Conversation } from "@opensprint/shared";

const chatService = new ChatService();

/** Normalize context: accept "spec" as alias for "sketch" (backwards compatibility). */
function normalizeContext(context: string | undefined): string {
  const raw = context ?? "sketch";
  return raw === "spec" ? "sketch" : raw;
}

export const chatRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };

// POST /projects/:projectId/chat — Send a message to the planning agent
chatRouter.post("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const body = req.body as ChatRequest;
    const context = normalizeContext(body.context);
    console.log("[chat] POST received", {
      projectId: req.params.projectId,
      context,
      messageLen: body.message?.length ?? 0,
    });
    const response = await chatService.sendMessage(req.params.projectId, { ...body, context });
    console.log("[chat] POST completed", { projectId: req.params.projectId });
    const result: ApiResponse<ChatResponse> = { data: response };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/chat/history — Get conversation history
chatRouter.get("/history", async (req: Request<ProjectParams>, res, next) => {
  try {
    const context = normalizeContext(req.query.context as string);
    const conversation = await chatService.getHistory(req.params.projectId, context);
    const result: ApiResponse<Conversation> = { data: conversation };
    res.json(result);
  } catch (err) {
    next(err);
  }
});
