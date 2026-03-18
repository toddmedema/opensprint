import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateParams, validateBody, validateQuery } from "../middleware/validate.js";
import {
  projectIdParamSchema,
  feedbackParamsSchema,
  paginationQuerySchema,
  feedbackSubmitBodySchema,
  feedbackRecategorizeBodySchema,
} from "../schemas/request-common.js";
import { FeedbackService } from "../services/feedback.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import type { ApiResponse, FeedbackItem } from "@opensprint/shared";

const feedbackService = new FeedbackService();

export const feedbackRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type FeedbackParams = { projectId: string; feedbackId: string };

// GET /projects/:projectId/feedback — List all feedback items (supports ?limit=&offset= for pagination)
feedbackRouter.get(
  "/",
  validateParams(projectIdParamSchema),
  validateQuery(paginationQuerySchema),
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const { limit, offset } = req.query as { limit?: number; offset?: number };
    const options = limit != null && offset != null ? { limit, offset } : undefined;

    const result = await feedbackService.listFeedback(req.params.projectId, options);
    const body: ApiResponse<FeedbackItem[] | { items: FeedbackItem[]; total: number }> = {
      data: result,
    };
    res.json(body);
  })
);

// POST /projects/:projectId/feedback — Submit new feedback
feedbackRouter.post(
  "/",
  validateParams(projectIdParamSchema),
  validateBody(feedbackSubmitBodySchema),
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const item = await feedbackService.submitFeedback(req.params.projectId, req.body);
    // Nudge orchestrator — feedback may create new tasks (PRDv2 §5.7 event-driven dispatch)
    orchestratorService.nudge(req.params.projectId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.status(201).json(body);
  })
);

// GET /projects/:projectId/feedback/:feedbackId — Get feedback details
feedbackRouter.get(
  "/:feedbackId",
  validateParams(feedbackParamsSchema),
  wrapAsync(async (req: Request<FeedbackParams>, res) => {
    const item = await feedbackService.getFeedback(req.params.projectId, req.params.feedbackId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.json(body);
  })
);

// POST /projects/:projectId/feedback/:feedbackId/recategorize — Re-trigger AI categorization
feedbackRouter.post(
  "/:feedbackId/recategorize",
  validateParams(feedbackParamsSchema),
  validateBody(feedbackRecategorizeBodySchema),
  wrapAsync(async (req: Request<FeedbackParams>, res) => {
    const { answer } = req.body as { answer?: string };
    const item = await feedbackService.recategorizeFeedback(
      req.params.projectId,
      req.params.feedbackId,
      answer ? { answer } : undefined
    );
    orchestratorService.nudge(req.params.projectId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.json(body);
  })
);

// POST /projects/:projectId/feedback/:feedbackId/resolve — Mark feedback as resolved (PRD §10.2)
feedbackRouter.post(
  "/:feedbackId/resolve",
  validateParams(feedbackParamsSchema),
  wrapAsync(async (req: Request<FeedbackParams>, res) => {
    const item = await feedbackService.resolveFeedback(req.params.projectId, req.params.feedbackId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.json(body);
  })
);

// POST /projects/:projectId/feedback/:feedbackId/cancel — Mark feedback as cancelled, delete associated tasks
feedbackRouter.post(
  "/:feedbackId/cancel",
  validateParams(feedbackParamsSchema),
  wrapAsync(async (req: Request<FeedbackParams>, res) => {
    const item = await feedbackService.cancelFeedback(req.params.projectId, req.params.feedbackId);
    const body: ApiResponse<FeedbackItem> = { data: item };
    res.json(body);
  })
);
