import { Router, Request } from "express";
import type {
  ApiResponse,
  HelpChatRequest,
  HelpChatResponse,
  HelpChatHistory,
  TaskAnalytics,
  AgentLogEntry,
} from "@opensprint/shared";
import { HelpChatService } from "../services/help-chat.service.js";
import { getTaskAnalytics } from "../services/help-analytics.service.js";
import { getAgentLog, getSessionLog } from "../services/help-agent-log.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("help-route");
export const helpChatService = new HelpChatService();

export const helpRouter = Router();

function queryProjectId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function paramString(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] ?? "") : "";
}

// GET /help/agent-log — Past agent runs from agent_stats (projectId query = per-project; omit = all projects)
helpRouter.get("/agent-log", async (req: Request, res, next) => {
  try {
    const projectId = queryProjectId(req.query.projectId);
    log.info("GET /help/agent-log", { projectId: projectId ?? "all" });
    const entries = await getAgentLog(projectId);
    const result: ApiResponse<AgentLogEntry[]> = { data: entries };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /help/session-log/:sessionId — Raw session output log for log viewer modal
helpRouter.get("/session-log/:sessionId", async (req: Request, res, next) => {
  try {
    const sessionId = parseInt(paramString(req.params.sessionId), 10);
    if (!Number.isFinite(sessionId) || sessionId < 1) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }
    log.info("GET /help/session-log/:sessionId", { sessionId });
    const content = await getSessionLog(sessionId);
    if (content === null) {
      res.status(404).json({ error: "Session log not found" });
      return;
    }
    const result: ApiResponse<{ content: string }> = { data: { content } };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /help/analytics — Task analytics by complexity (projectId query = per-project; omit = all projects)
helpRouter.get("/analytics", async (req: Request, res, next) => {
  try {
    const projectId = queryProjectId(req.query.projectId);
    log.info("GET /help/analytics", { projectId: projectId ?? "all" });
    const analytics = await getTaskAnalytics(projectId);
    const result: ApiResponse<TaskAnalytics> = { data: analytics };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /help/chat/history — Load persisted Help chat messages (projectId query = per-project; omit = homepage)
helpRouter.get("/chat/history", async (req: Request, res, next) => {
  try {
    const projectId = queryProjectId(req.query.projectId);
    log.info("GET /help/chat/history", { projectId: projectId ?? "homepage" });
    const history = await helpChatService.getHistory(projectId);
    const result: ApiResponse<HelpChatHistory> = { data: history };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

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
