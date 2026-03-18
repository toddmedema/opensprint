import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateParams, validateBody } from "../middleware/validate.js";
import {
  projectIdParamSchema,
  notificationParamsSchema,
  notificationResolveBodySchema,
} from "../schemas/request-common.js";
import { notificationService } from "../services/notification.service.js";
import { hilService } from "../services/hil-service.js";
import { taskStore } from "../services/task-store.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { getProvidersRequiringApiKeys } from "@opensprint/shared";
import { ProjectService } from "../services/project.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { getNextKey } from "../services/api-key-resolver.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import type { ApiResponse } from "@opensprint/shared";
import type { Notification } from "../services/notification.service.js";

const projectServiceInstance = new ProjectService();
const projectNotificationsRouter = Router({ mergeParams: true });
const globalNotificationsRouter = Router();

type ProjectParams = { projectId: string };
type NotificationParams = { projectId: string; notificationId: string };
type ResolveBody = {
  approved?: boolean;
  /** Agent-question responses: persisted when resolving open_question with answer. */
  responses?: Array<{ questionId: string; answer: string }>;
};

// POST /projects/:projectId/notifications/:notificationId/retry-rate-limit — Check keys available, resolve rate-limit notifications, nudge orchestrator
projectNotificationsRouter.post(
  "/:notificationId/retry-rate-limit",
  validateParams(notificationParamsSchema),
  wrapAsync(async (req: Request<NotificationParams>, res) => {
    const { projectId, notificationId } = req.params;
    const notifications = await notificationService.listByProject(projectId);
    const notification = notifications.find((n) => n.id === notificationId);
    if (!notification) {
      throw new AppError(
        404,
        ErrorCodes.NOTIFICATION_NOT_FOUND,
        `Notification '${notificationId}' not found`,
        { notificationId, projectId }
      );
    }
    if (notification.kind !== "api_blocked" || notification.errorCode !== "rate_limit") {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "Retry is only available for rate limit notifications"
      );
    }
    const settings = await projectServiceInstance.getSettings(projectId);
    const providers = getProvidersRequiringApiKeys([
      settings.simpleComplexityAgent,
      settings.complexComplexityAgent,
    ]);
    let hasAvailableKey = false;
    for (const provider of providers) {
      const resolved = await getNextKey(projectId, provider);
      if (resolved) {
        hasAvailableKey = true;
        break;
      }
    }
    if (providers.length > 0 && !hasAvailableKey) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "No API keys available. Add more keys in Settings or wait 24h for rate-limited keys to reset."
      );
    }
    const resolved = await notificationService.resolveRateLimitNotifications(projectId);
    for (const r of resolved) {
      broadcastToProject(projectId, {
        type: "notification.resolved",
        notificationId: r.id,
        projectId,
        source: r.source,
        sourceId: r.sourceId,
      });
    }
    orchestratorService.nudge(projectId);
    res.json({
      data: { ok: true, resolvedCount: resolved.length },
    } as ApiResponse<{ ok: boolean; resolvedCount: number }>);
  })
);

// DELETE /projects/:projectId/notifications — Clear all notifications for project
projectNotificationsRouter.delete(
  "/",
  validateParams(projectIdParamSchema),
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const deletedCount = await notificationService.deleteByProject(req.params.projectId);
    res.json({
      data: { deletedCount },
    } as ApiResponse<{ deletedCount: number }>);
  })
);

// GET /projects/:projectId/notifications — List unresolved notifications for project
projectNotificationsRouter.get(
  "/",
  validateParams(projectIdParamSchema),
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const notifications = await notificationService.listByProject(req.params.projectId);
    const body: ApiResponse<Notification[]> = { data: notifications };
    res.json(body);
  })
);

// PATCH /projects/:projectId/notifications/:notificationId — Resolve notification
// Body: { approved?: boolean } for hil_approval; { responses?: [{ questionId, answer }] } for open_question
projectNotificationsRouter.patch(
  "/:notificationId",
  validateParams(notificationParamsSchema),
  validateBody(notificationResolveBodySchema),
  wrapAsync(async (req: Request<NotificationParams, unknown, ResolveBody>, res) => {
    const { projectId, notificationId } = req.params;
    const approved = req.body.approved;
    const responses = req.body.responses;
    const notification = await notificationService.resolve(projectId, notificationId, {
      approved,
      responses,
    });

    // HIL approval: notify waiting workflow of user's choice
    if (notification.kind === "hil_approval") {
      hilService.notifyResolved(notificationId, approved === true);
    }

    broadcastToProject(projectId, {
      type: "notification.resolved",
      notificationId,
      projectId,
      source: notification.source,
      sourceId: notification.sourceId,
    });

    // When source=execute, unblock the task and nudge orchestrator so agent picks up the response promptly
    if (notification.source === "execute" && notification.sourceId) {
      const taskId = notification.sourceId;
      try {
        await taskStore.update(projectId, taskId, {
          status: "open",
          block_reason: null,
        });
      } catch {
        // Task may not exist or already unblocked
      }
      orchestratorService.nudge(projectId);
    }

    const body: ApiResponse<Notification> = { data: notification };
    res.json(body);
  })
);

// DELETE /notifications — Clear all notifications across all projects (global)
globalNotificationsRouter.delete(
  "/",
  wrapAsync(async (_req, res) => {
    const deletedCount = await notificationService.deleteAll();
    res.json({
      data: { deletedCount },
    } as ApiResponse<{ deletedCount: number }>);
  })
);

// GET /notifications/pending-count — Count of pending human notifications (for desktop tray badge)
globalNotificationsRouter.get(
  "/pending-count",
  wrapAsync(async (_req, res) => {
    const list = await notificationService.listGlobal();
    res.json({ data: { count: list.length } } as ApiResponse<{ count: number }>);
  })
);

// GET /notifications — List unresolved notifications across all projects (global)
globalNotificationsRouter.get(
  "/",
  wrapAsync(async (_req, res) => {
    const notifications = await notificationService.listGlobal();
    const body: ApiResponse<Notification[]> = { data: notifications };
    res.json(body);
  })
);

export { projectNotificationsRouter, globalNotificationsRouter };
