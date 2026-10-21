import { Router } from "express";
import { z } from "zod";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateBody } from "../middleware/validate.js";
import { AppError } from "../middleware/error-handler.js";
import { executionOwnershipService } from "../services/execution-ownership.service.js";
import { executionOutputService } from "../services/execution-output.service.js";
import { operationService } from "../services/operation.service.js";
import { identityService } from "../services/identity.service.js";
import { getRequestContext } from "../services/request-context.js";
import { presenceService } from "../services/presence.service.js";
import { reconcileOperation } from "../services/operation-reconciliation.service.js";

export function createRuntimeRouter() {
  const router = Router({ mergeParams: true });
  router.get(
    "/operations",
    wrapAsync(async (req, res) => {
      res.json({ data: await operationService.listProject(String(req.params.projectId)) });
    })
  );
  router.get(
    "/operations/by-request/:requestId",
    wrapAsync(async (req, res) => {
      const operation = await operationService.getByRequestId(
        String(req.params.projectId),
        String(req.params.requestId)
      );
      if (!operation) throw new AppError(404, "OPERATION_NOT_FOUND", "Operation not found.");
      res.json({ data: operation });
    })
  );
  router.post(
    "/operations/:id/reconcile",
    validateBody(
      z
        .object({
          expectedGeneration: z.number().int().nonnegative(),
          outcome: z.enum(["completed", "failed"]),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
    ),
    wrapAsync(async (req, res) => {
      const context = getRequestContext()!;
      const projectId = String(req.params.projectId),
        id = String(req.params.id);
      const operation = await operationService.get(projectId, id);
      if (!operation) throw new AppError(404, "OPERATION_NOT_FOUND", "Operation not found.");
      identityService.require(
        context.principal,
        operation.kind.startsWith("deployment.") ? "deploy" : "control"
      );
      if (!context.requestId)
        throw new AppError(
          400,
          "REQUEST_ID_REQUIRED",
          "A stable Idempotency-Key is required for reconciliation."
        );
      res.json({
        data: await reconcileOperation(
          projectId,
          id,
          req.body,
          context.principal.actorId,
          context.requestId
        ),
      });
    })
  );
  router.get(
    "/attempts",
    wrapAsync(async (req, res) => {
      res.json({
        data: await executionOwnershipService.observe(
          String(req.params.projectId),
          typeof req.query.taskId === "string" ? req.query.taskId : undefined
        ),
      });
    })
  );
  router.get(
    "/attempts/:attemptId/output",
    wrapAsync(async (req, res) => {
      const offset = z.coerce
        .number()
        .int()
        .nonnegative()
        .safeParse(req.query.offset ?? 0);
      if (!offset.success)
        throw new AppError(400, "INVALID_OUTPUT_OFFSET", "Invalid output offset.");
      const page = await executionOutputService.read(
        String(req.params.projectId),
        String(req.params.attemptId),
        offset.data
      );
      res
        .status(
          page.status === "offset_expired" ? 410 : page.status === "unknown_attempt" ? 404 : 200
        )
        .json({ data: page });
    })
  );
  router.post(
    "/attempts/:attemptId/stop",
    wrapAsync(async (req, res) => {
      identityService.require(getRequestContext()!.principal, "control");
      res.status(202).json({
        data: {
          requested: await executionOwnershipService.requestStop(
            String(req.params.projectId),
            String(req.params.attemptId)
          ),
        },
      });
    })
  );
  router.get(
    "/operations/:id",
    wrapAsync(async (req, res) => {
      const operation = await operationService.get(
        String(req.params.projectId),
        String(req.params.id)
      );
      if (!operation) throw new AppError(404, "OPERATION_NOT_FOUND", "Operation not found.");
      res.json({ data: operation });
    })
  );
  router.post(
    "/operations/:id/cancel",
    wrapAsync(async (req, res) => {
      const existing = await operationService.get(
        String(req.params.projectId),
        String(req.params.id)
      );
      if (!existing) throw new AppError(404, "OPERATION_NOT_FOUND", "Operation not found.");
      identityService.require(
        getRequestContext()!.principal,
        existing.kind.startsWith("deployment.") ? "deploy" : "control"
      );
      const operation = await operationService.cancel(
        String(req.params.projectId),
        String(req.params.id)
      );
      if (!operation)
        throw new AppError(
          409,
          "OPERATION_NOT_QUEUED",
          "This operation has started. Request stop on its execution or reconcile its outcome."
        );
      res.json({ data: operation });
    })
  );
  router.get(
    "/presence",
    wrapAsync(async (req, res) => {
      res.json({ data: await presenceService.snapshot(String(req.params.projectId)) });
    })
  );
  router.post(
    "/presence",
    validateBody(
      z
        .object({
          connectionId: z.string().uuid(),
          typing: z.boolean(),
          focus: z.enum(["sketch", "plan", "execute", "evaluate", "deliver"]),
        })
        .strict()
    ),
    wrapAsync(async (req, res) => {
      await presenceService.heartbeat(
        String(req.params.projectId),
        getRequestContext()!.principal.actorId,
        req.body
      );
      res.status(204).send();
    })
  );
  router.put(
    "/presenter",
    validateBody(
      z
        .object({
          expectedRevision: z.number().int().nonnegative(),
          focus: z.enum(["sketch", "plan", "execute", "evaluate", "deliver"]).nullable(),
        })
        .strict()
    ),
    wrapAsync(async (req, res) => {
      const principal = getRequestContext()!.principal;
      identityService.require(principal, "discuss");
      res.json({
        data: await presenceService.present(
          String(req.params.projectId),
          principal.actorId,
          req.body
        ),
      });
    })
  );
  return router;
}
