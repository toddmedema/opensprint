import { Router } from "express";
import { z } from "zod";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  specPublicationService,
  type SpecPublicationService,
} from "../services/spec-publication.service.js";

const params = z.object({ projectId: z.string().min(1).max(128) });
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Local-authority endpoints: pilot collaboration credentials cannot publish Git content. */
export function createSpecPublicationRouter(
  service: SpecPublicationService = specPublicationService
): Router {
  const router = Router({ mergeParams: true });
  router.use(validateParams(params));
  router.get(
    "/published",
    wrapAsync(async (req, res) => {
      res.json({
        data: { content: await service.getPublishedContent(String(req.params.projectId)) },
      });
    })
  );
  router.post(
    "/import",
    validateBody(z.object({ expectedRevision: z.number().int().min(0) }).strict()),
    wrapAsync(async (req, res) => {
      res.json({
        data: await service.importWorkingCopy(
          String(req.params.projectId),
          req.body.expectedRevision
        ),
      });
    })
  );
  router.get(
    "/draft",
    wrapAsync(async (req, res) => {
      res.json({ data: await service.getDraft(String(req.params.projectId)) });
    })
  );
  router.put(
    "/draft",
    validateBody(
      z
        .object({
          content: z
            .string()
            .max(2 * 1024 * 1024)
            .refine((v) => !v.includes("\u0000")),
          expectedRevision: z
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER - 1),
        })
        .strict()
    ),
    wrapAsync(async (req, res) => {
      res.json({
        data: await service.saveDraft(
          String(req.params.projectId),
          req.body.content,
          req.body.expectedRevision
        ),
      });
    })
  );
  router.post(
    "/approve",
    validateBody(z.object({ revision, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
    wrapAsync(async (req, res) => {
      await service.approve(String(req.params.projectId), req.body.revision, req.body.contentHash);
      res.json({ data: { approved: true } });
    })
  );
  router.post(
    "/publish",
    validateBody(
      z
        .object({
          revision,
          operationId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[a-zA-Z0-9_.:-]+$/),
        })
        .strict()
    ),
    wrapAsync(async (req, res) => {
      res.json({
        data: await service.publish(
          String(req.params.projectId),
          req.body.operationId,
          req.body.revision
        ),
      });
    })
  );
  router.get(
    "/operations",
    wrapAsync(async (req, res) => {
      res.json({ data: await service.listOperations(String(req.params.projectId)) });
    })
  );
  router.get(
    "/operations/:operationId",
    wrapAsync(async (req, res) => {
      res.json({
        data: await service.reconcile(String(req.params.projectId), String(req.params.operationId)),
      });
    })
  );
  return router;
}
