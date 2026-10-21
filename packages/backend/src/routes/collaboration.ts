import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../middleware/error-handler.js";
import { wrapAsync } from "../middleware/wrap-async.js";
import {
  CollaborationService,
  collaborationCommandSchema,
} from "../services/collaboration.service.js";
import {
  createCollaborationAccess,
  type CollaborationAccess,
} from "../services/collaboration-access.service.js";

const projectIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const pageSchema = z
  .object({
    after: z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(200))
      .optional(),
  })
  .strict();
const guidanceSchema = z
  .object({
    taskId: projectIdSchema,
    attemptId: projectIdSchema,
    clientMessageId: projectIdSchema,
    content: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .refine((value) => !value.includes("\u0000")),
  })
  .strict();

export interface CollaborationGuidanceInput {
  projectId: string;
  actorId: string;
  displayName: string;
  taskId: string;
  attemptId: string;
  clientMessageId: string;
  content: string;
  controlRevision: number;
}

export function createCollaborationRouter(options: {
  assertProjectExists: (projectId: string) => Promise<unknown>;
  service?: CollaborationService;
  access?: CollaborationAccess;
  handleGuidance?: (input: CollaborationGuidanceInput) => Promise<unknown>;
  getActiveRun?: (projectId: string, taskId: string) => unknown | Promise<unknown>;
  getGuidanceHistory?: (projectId: string, taskId: string) => unknown | Promise<unknown>;
}) {
  const router = Router({ mergeParams: true });
  const service = options.service ?? new CollaborationService();
  const access = options.access ?? createCollaborationAccess();
  const context = async (req: Request) => {
    const parsed = projectIdSchema.safeParse(req.params.projectId);
    if (!parsed.success) throw new AppError(400, "INVALID_PROJECT_ID", "Invalid project ID.");
    const projectId = parsed.data;
    const principal = access.resolve(req.headers.authorization, projectId);
    await options.assertProjectExists(projectId);
    return { projectId, principal };
  };

  router.get(
    "/snapshot",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      res.json({ data: await service.snapshot(projectId, principal) });
    })
  );
  router.get(
    "/events",
    wrapAsync(async (req, res) => {
      const { projectId } = await context(req);
      const query = pageSchema.safeParse(req.query);
      if (!query.success)
        throw new AppError(400, "INVALID_COLLABORATION_CURSOR", "Invalid event pagination.");
      res.json({ data: await service.replay(projectId, query.data.after, query.data.limit) });
    })
  );
  router.get(
    "/runs/:taskId",
    wrapAsync(async (req, res) => {
      const { projectId } = await context(req);
      const taskId = projectIdSchema.safeParse(req.params.taskId);
      if (!taskId.success) throw new AppError(400, "INVALID_TASK_ID", "Invalid task ID.");
      if (!options.getActiveRun)
        throw new AppError(503, "GUIDANCE_UNAVAILABLE", "Run guidance is unavailable.");
      const active = await options.getActiveRun(projectId, taskId.data);
      if (
        active &&
        typeof active === "object" &&
        "attemptId" in active &&
        typeof active.attemptId === "string"
      ) {
        res.json({
          data: { ...active, control: await service.getRunControl(projectId, active.attemptId) },
        });
      } else {
        res.json({ data: active });
      }
    })
  );
  router.post(
    "/commands",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      const parsed = collaborationCommandSchema.safeParse(req.body);
      if (!parsed.success)
        throw new AppError(
          400,
          "INVALID_COLLABORATION_COMMAND",
          "Invalid collaboration command.",
          parsed.error.issues
        );
      const result = await service.command(projectId, principal, parsed.data, (actorId) =>
        access.canControlActor(projectId, actorId)
      );
      res.json({ data: result });
    })
  );
  router.get(
    "/guidance/:taskId",
    wrapAsync(async (req, res) => {
      const { projectId } = await context(req);
      const taskId = projectIdSchema.safeParse(req.params.taskId);
      if (!taskId.success) throw new AppError(400, "INVALID_TASK_ID", "Invalid task ID.");
      if (!options.getGuidanceHistory)
        throw new AppError(503, "GUIDANCE_UNAVAILABLE", "Guidance history is unavailable.");
      res.json({ data: await options.getGuidanceHistory(projectId, taskId.data) });
    })
  );
  router.post(
    "/guidance",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      const parsed = guidanceSchema.safeParse(req.body);
      if (!parsed.success)
        throw new AppError(400, "INVALID_COLLABORATION_GUIDANCE", "Invalid run guidance.");
      const handleGuidance = options.handleGuidance;
      if (!handleGuidance)
        throw new AppError(503, "GUIDANCE_UNAVAILABLE", "Run guidance is unavailable.");
      const result = await service.withControl(
        projectId,
        principal,
        parsed.data.attemptId,
        (controlRevision) =>
          handleGuidance({
            ...parsed.data,
            projectId,
            actorId: principal.actorId,
            displayName: principal.displayName,
            controlRevision,
          })
      );
      res.json({ data: result });
    })
  );
  return router;
}
