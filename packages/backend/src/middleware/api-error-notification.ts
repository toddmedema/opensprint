/**
 * Middleware: when an API-related agent error occurs (rate limit, auth, out of credit),
 * create a human-blocked notification and broadcast so the UI shows it in the notification bell.
 * Runs before the final error handler.
 */

import type { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler.js";
import { classifyAgentApiError, getAgentApiFailureDetails } from "../utils/error-utils.js";
import { notificationService } from "../services/notification.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("api-error-notification");

/** Error codes that may indicate API/auth failures worth surfacing as notifications */
const API_ERROR_CODES = new Set([
  "AGENT_INVOKE_FAILED",
  "ANTHROPIC_API_KEY_MISSING",
  "CURSOR_API_ERROR",
  "AGENT_CLI_REQUIRED",
  "OPENAI_API_ERROR",
  "GOOGLE_API_ERROR",
]);

export function apiErrorNotificationMiddleware(
  err: Error,
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const projectId = req.params?.projectId as string | undefined;
  if (!projectId) {
    next(err);
    return;
  }

  if (!(err instanceof AppError)) {
    next(err);
    return;
  }

  if (!API_ERROR_CODES.has(err.code)) {
    next(err);
    return;
  }

  const structured = getAgentApiFailureDetails(err.details);
  const apiErrorKind = structured?.kind ?? classifyAgentApiError(err);
  if (!apiErrorKind) {
    next(err);
    return;
  }

  notificationService
    .createApiBlocked({
      projectId,
      source: inferSourceFromPath(req.path),
      sourceId: inferSourceIdFromPath(req.path, projectId),
      message: (structured?.notificationMessage ?? err.message).slice(0, 500),
      errorCode: apiErrorKind,
    })
    .then((notification) => {
      broadcastToProject(projectId, {
        type: "notification.added",
        notification: {
          id: notification.id,
          projectId: notification.projectId,
          source: notification.source,
          sourceId: notification.sourceId,
          questions: notification.questions.map((q) => ({
            id: q.id,
            text: q.text,
            createdAt: q.createdAt,
          })),
          status: "open",
          createdAt: notification.createdAt,
          resolvedAt: null,
          kind: "api_blocked",
          errorCode: notification.errorCode,
        },
      });
    })
    .catch((notifErr) => {
      log.warn("Failed to create API-blocked notification", { err: notifErr });
    })
    .finally(() => {
      next(err);
    });
}

function inferSourceFromPath(path: string): "plan" | "prd" | "execute" | "eval" {
  if (path.includes("/chat")) return "prd";
  if (path.includes("/plans")) return "plan";
  if (path.includes("/execute") || path.includes("/tasks")) return "execute";
  if (path.includes("/feedback")) return "eval";
  return "prd";
}

function inferSourceIdFromPath(path: string, _projectId: string): string {
  // Extract planId, taskId, feedbackId from path if present; otherwise use generic
  const planMatch = path.match(/plans\/([^/]+)/);
  if (planMatch) return planMatch[1];
  const taskMatch = path.match(/tasks\/([^/]+)/);
  if (taskMatch) return taskMatch[1];
  const feedbackMatch = path.match(/feedback\/([^/]+)/);
  if (feedbackMatch) return feedbackMatch[1];
  return "global";
}
