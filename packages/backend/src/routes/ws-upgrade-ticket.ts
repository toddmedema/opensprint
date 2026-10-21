import { Router } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import {
  issueWebSocketUpgradeTicket,
  issueScopedWebSocketTicket,
} from "../services/websocket-upgrade-ticket.service.js";
import { getRequestContext } from "../services/request-context.js";
import { AppError } from "../middleware/error-handler.js";

export const wsUpgradeTicketRouter = Router();

wsUpgradeTicketRouter.post(
  "/",
  wrapAsync(async (req, res) => {
    const principal = getRequestContext()?.principal;
    if (
      principal &&
      !principal.local &&
      (typeof req.body?.projectId !== "string" || !principal.credentialHash)
    )
      throw new AppError(400, "PROJECT_REQUIRED", "A project is required for a WebSocket ticket.");
    const ticket =
      principal && !principal.local
        ? await issueScopedWebSocketTicket({
            projectId: req.body.projectId,
            credentialHash: principal.credentialHash!,
          })
        : issueWebSocketUpgradeTicket();
    res.json({ data: { ticket } });
  })
);
