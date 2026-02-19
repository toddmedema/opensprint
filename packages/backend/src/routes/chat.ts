import { Router, Request } from "express";
import { ChatService } from "../services/chat.service.js";
import type { ApiResponse, ChatRequest, ChatResponse, Conversation } from "@opensprint/shared";

const chatService = new ChatService();

export const chatRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };

// POST /projects/:projectId/chat — Send a message to the planning agent
chatRouter.post("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const body = req.body as ChatRequest;
    const context = body.context ?? "sketch";
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
    const context = (req.query.context as string) ?? "sketch";
    const conversation = await chatService.getHistory(req.params.projectId, context);
    const result: ApiResponse<Conversation> = { data: conversation };
    res.json(result);
  } catch (err) {
    next(err);
  }
});
