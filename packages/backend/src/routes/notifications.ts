import { Router, Request } from "express";
import { notificationService } from "../services/notification.service.js";
import { taskStore } from "../services/task-store.service.js";
import { broadcastToProject } from "../websocket/index.js";
import type { ApiResponse } from "@opensprint/shared";
import type { Notification } from "../services/notification.service.js";

const projectNotificationsRouter = Router({ mergeParams: true });
const globalNotificationsRouter = Router();

type ProjectParams = { projectId: string };
type NotificationParams = { projectId: string; notificationId: string };

// GET /projects/:projectId/notifications — List unresolved notifications for project
projectNotificationsRouter.get("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const notifications = await notificationService.listByProject(req.params.projectId);
    const body: ApiResponse<Notification[]> = { data: notifications };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PATCH /projects/:projectId/notifications/:notificationId — Resolve notification
projectNotificationsRouter.patch(
  "/:notificationId",
  async (req: Request<NotificationParams>, res, next) => {
    try {
      const { projectId, notificationId } = req.params;
      const notification = await notificationService.resolve(projectId, notificationId);

      broadcastToProject(projectId, {
        type: "notification.resolved",
        notificationId,
        projectId,
        source: notification.source,
        sourceId: notification.sourceId,
      });

      // When source=execute, unblock the task so orchestrator can re-pick it
      if (notification.source === "execute" && notification.sourceId) {
        const taskId = notification.sourceId;
        try {
          await taskStore.update(projectId, taskId, {
            status: "open",
            block_reason: null,
          });
          broadcastToProject(projectId, {
            type: "task.updated",
            taskId,
            status: "open",
            blockReason: null,
          });
        } catch {
          // Task may not exist or already unblocked
        }
      }

      const body: ApiResponse<Notification> = { data: notification };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

// GET /notifications — List unresolved notifications across all projects (global)
globalNotificationsRouter.get("/", async (_req, res, next) => {
  try {
    const notifications = await notificationService.listGlobal();
    const body: ApiResponse<Notification[]> = { data: notifications };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export { projectNotificationsRouter, globalNotificationsRouter };
