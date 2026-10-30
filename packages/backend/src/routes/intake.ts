/**
 * Intake item routes.
 *
 * GET    /                  — list/filter intake items
 * GET    /:itemId           — get single intake item
 * POST   /:itemId/triage    — recompute triage suggestion
 * POST   /:itemId/convert   — convert intake item (to feedback, task, etc.)
 * POST   /:itemId/ignore    — ignore intake item
 * POST   /bulk              — bulk convert/ignore
 */

import { Router } from "express";
import { z } from "zod";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { projectIdParamSchema } from "../schemas/request-common.js";
import { intakeStore } from "../services/intake-store.service.js";
import type {
  IntakeConvertAction,
  IntakeTriageStatus,
  IntegrationProvider,
} from "@opensprint/shared";

const itemIdParamSchema = z.object({
  projectId: z.string().min(1),
  itemId: z.string().min(1),
});

const listQuerySchema = z.object({
  provider: z.string().optional(),
  triageStatus: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const convertBodySchema = z.object({
  action: z.enum(["to_feedback", "to_task_draft", "link_existing", "ignore"]),
  linkTaskId: z.string().optional(),
});

const bulkBodySchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(["to_feedback", "to_task_draft", "link_existing", "ignore"]),
  dryRun: z.boolean().optional(),
});

export function createIntakeRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get(
    "/",
    validateParams(projectIdParamSchema),
    validateQuery(listQuerySchema),
    wrapAsync(async (req, res) => {
      const projectId = req.params.projectId as string;
      const filters = {
        provider: req.query.provider as string | undefined as IntegrationProvider | undefined,
        triageStatus: req.query.triageStatus as string | undefined as
          | IntakeTriageStatus
          | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      };
      const result = await intakeStore.listItems(projectId, filters);
      res.json({ data: result });
    })
  );

  router.get(
    "/:itemId",
    validateParams(itemIdParamSchema),
    wrapAsync(async (req, res) => {
      const itemId = req.params.itemId as string;
      const item = await intakeStore.getItemForProject(req.params.projectId as string, itemId);
      if (!item) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Intake item not found" } });
        return;
      }
      res.json({ data: item });
    })
  );

  router.post(
    "/:itemId/convert",
    validateParams(itemIdParamSchema),
    validateBody(convertBodySchema),
    wrapAsync(async (req, res) => {
      const itemId = req.params.itemId as string;
      const { action } = req.body as { action: IntakeConvertAction; linkTaskId?: string };

      const item = await intakeStore.getItemForProject(req.params.projectId as string, itemId);
      if (!item) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Intake item not found" } });
        return;
      }

      const newStatus: IntakeTriageStatus = action === "ignore" ? "ignored" : "converted";
      const updated = await intakeStore.updateTriageStatusForProject(
        req.params.projectId as string,
        itemId,
        newStatus
      );

      res.json({
        data: {
          intakeItemId: itemId,
          action,
          item: updated,
        },
      });
    })
  );

  router.post(
    "/:itemId/ignore",
    validateParams(itemIdParamSchema),
    wrapAsync(async (req, res) => {
      const itemId = req.params.itemId as string;
      const item = await intakeStore.getItemForProject(req.params.projectId as string, itemId);
      if (!item) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Intake item not found" } });
        return;
      }

      const updated = await intakeStore.updateTriageStatusForProject(
        req.params.projectId as string,
        itemId,
        "ignored"
      );
      res.json({ data: updated });
    })
  );

  router.post(
    "/bulk",
    validateParams(projectIdParamSchema),
    validateBody(bulkBodySchema),
    wrapAsync(async (req, res) => {
      const { itemIds, action, dryRun } = req.body as {
        itemIds: string[];
        action: IntakeConvertAction;
        dryRun?: boolean;
      };

      if (dryRun) {
        const items = [];
        for (const id of itemIds) {
          const item = await intakeStore.getItemForProject(req.params.projectId as string, id);
          if (item) items.push({ intakeItemId: id, action, title: item.title });
        }
        res.json({ data: { dryRun: true, processed: items.length, errors: 0, results: items } });
        return;
      }

      const results = [];
      let errors = 0;
      for (const id of itemIds) {
        try {
          const newStatus: IntakeTriageStatus = action === "ignore" ? "ignored" : "converted";
          const updated = await intakeStore.updateTriageStatusForProject(
            req.params.projectId as string,
            id,
            newStatus
          );
          if (!updated) {
            errors++;
            continue;
          }
          results.push({ intakeItemId: id, action });
        } catch {
          errors++;
        }
      }

      res.json({ data: { processed: results.length, errors, results } });
    })
  );

  return router;
}
