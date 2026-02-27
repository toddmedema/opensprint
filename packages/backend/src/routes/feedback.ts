import { Router, Request } from "express";
import { FeedbackService } from "../services/feedback.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import type { ApiResponse, FeedbackItem, FeedbackSubmitRequest } from "@opensprint/shared";

const feedbackService = new FeedbackService();

export const feedbackRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type FeedbackParams = { projectId: string; feedbackId: string };

// GET /projects/:projectId/feedback — List all feedback items (supports ?limit=&offset= for pagination)
feedbackRouter.get("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const limit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
    const offset = req.query.offset != null ? parseInt(String(req.query.offset), 10) : undefined;
    const options =
      limit != null && offset != null && !Number.isNaN(limit) && !Number.isNaN(offset)
        ? { limit, offset }
        : undefined;

    const result = await feedbackService.listFeedback(req.params.projectId, options);
    const body: ApiResponse<FeedbackItem[] | { items: FeedbackItem[]; total: number }> = {
      data: result,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/feedback — Submit new feedback
feedbackRouter.post("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const item = await feedbackService.submitFeedback(
      req.params.projectId,
      req.body as FeedbackSubmitRequest
    );
    // Nudge orchestrator — feedback may create new tasks (PRDv2 §5.7 event-driven dispatch)
    orchestratorService.nudge(req.params.projectId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/feedback/:feedbackId — Get feedback details
feedbackRouter.get("/:feedbackId", async (req: Request<FeedbackParams>, res, next) => {
  try {
    const item = await feedbackService.getFeedback(req.params.projectId, req.params.feedbackId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/feedback/:feedbackId/recategorize — Re-trigger AI categorization
feedbackRouter.post(
  "/:feedbackId/recategorize",
  async (req: Request<FeedbackParams>, res, next) => {
    try {
      const answer = req.body?.answer as string | undefined;
      const item = await feedbackService.recategorizeFeedback(
        req.params.projectId,
        req.params.feedbackId,
        answer ? { answer } : undefined
      );
      orchestratorService.nudge(req.params.projectId);
      const body: ApiResponse<FeedbackItem> = { data: item };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

// POST /projects/:projectId/feedback/:feedbackId/resolve — Mark feedback as resolved (PRD §10.2)
feedbackRouter.post("/:feedbackId/resolve", async (req: Request<FeedbackParams>, res, next) => {
  try {
    const item = await feedbackService.resolveFeedback(req.params.projectId, req.params.feedbackId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/feedback/:feedbackId/cancel — Mark feedback as cancelled, delete associated tasks
feedbackRouter.post("/:feedbackId/cancel", async (req: Request<FeedbackParams>, res, next) => {
  try {
    const item = await feedbackService.cancelFeedback(req.params.projectId, req.params.feedbackId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
