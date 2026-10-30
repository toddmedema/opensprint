/**
 * NL command routes.
 *
 * POST /interpret  — parse natural language into structured command intent
 * POST /preview    — generate dry-run preview for a command
 * POST /apply      — execute a confirmed command
 * GET  /history    — list past command runs
 * GET  /:runId     — get single command run
 */

import { Router } from "express";
import { z } from "zod";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { projectIdParamSchema } from "../schemas/request-common.js";
import { commandInterpreter } from "../services/command-interpreter.service.js";
import { commandPreview } from "../services/command-preview.service.js";
import { commandExecutor } from "../services/command-executor.service.js";
import { commandStore } from "../services/command-store.service.js";
import type { CommandStatus } from "@opensprint/shared";

const interpretBodySchema = z.object({
  input: z.string().min(1).max(1000),
});

const previewBodySchema = z.object({
  intent: z.object({
    commandType: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
});

const applyBodySchema = z.object({
  commandRunId: z.string().min(1),
  idempotencyKey: z.string().optional(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().optional(),
});

const runIdParamSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
});

export function createCommandsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.post(
    "/interpret",
    validateParams(projectIdParamSchema),
    validateBody(interpretBodySchema),
    wrapAsync(async (req, res) => {
      const projectId = req.params.projectId as string;
      const { input } = req.body as { input: string };

      const interpretation = commandInterpreter.interpret(input);

      const run = await commandStore.createRun({
        project_id: projectId,
        actor: "user",
        raw_input: input,
      });

      await commandStore.updateInterpretation(
        run.id,
        interpretation.intent,
        interpretation.riskLevel
      );

      res.json({
        data: {
          interpretation,
          commandRunId: run.id,
        },
      });
    })
  );

  router.post(
    "/preview",
    validateParams(projectIdParamSchema),
    validateBody(previewBodySchema),
    wrapAsync(async (req, res) => {
      const projectId = req.params.projectId as string;
      const { intent } = req.body;

      const interpretation = {
        intent: intent as import("@opensprint/shared").CommandIntent,
        confidence: 1,
        riskLevel: "safe" as import("@opensprint/shared").CommandRiskLevel,
      };

      const preview = await commandPreview.generatePreview(projectId, interpretation);

      const run = await commandStore.createRun({
        project_id: projectId,
        actor: "user",
        raw_input: JSON.stringify(intent),
        status: "previewing",
      });

      await commandStore.updateInterpretation(
        run.id,
        interpretation.intent,
        interpretation.riskLevel
      );
      await commandStore.updatePreview(run.id, preview);

      res.json({
        data: {
          preview,
          commandRunId: run.id,
        },
      });
    })
  );

  router.post(
    "/apply",
    validateParams(projectIdParamSchema),
    validateBody(applyBodySchema),
    wrapAsync(async (req, res) => {
      const { commandRunId, idempotencyKey } = req.body as {
        commandRunId: string;
        idempotencyKey?: string;
      };

      const run = await commandStore.getRun(commandRunId, req.params.projectId as string);
      if (!run) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Command run not found" } });
        return;
      }

      const result = await commandExecutor.execute(
        req.params.projectId as string,
        commandRunId,
        idempotencyKey
      );

      res.json({
        data: {
          result,
          commandRunId,
        },
      });
    })
  );

  router.get(
    "/history",
    validateParams(projectIdParamSchema),
    validateQuery(historyQuerySchema),
    wrapAsync(async (req, res) => {
      const projectId = req.params.projectId as string;
      const filters = {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        status: req.query.status as string | undefined as CommandStatus | undefined,
      };

      const result = await commandStore.listRuns(projectId, filters);
      res.json({ data: result });
    })
  );

  router.get(
    "/:runId",
    validateParams(runIdParamSchema),
    wrapAsync(async (req, res) => {
      const run = await commandStore.getRun(
        req.params.runId as string,
        req.params.projectId as string
      );
      if (!run) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Command run not found" } });
        return;
      }
      res.json({ data: run });
    })
  );

  return router;
}
