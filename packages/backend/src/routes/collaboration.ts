import { Router, type Request } from "express";
import { z } from "zod";
import type { CollaborationOverview, CollaborationTaskContext } from "@opensprint/shared";
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

/**
 * Mount project-scoped collaboration APIs with per-request membership checks.
 * Every HTTP control transition requires a server-validated task and current attempt.
 */
export function createCollaborationRouter(options: {
  assertProjectExists: (projectId: string) => Promise<unknown>;
  service?: CollaborationService;
  access?: CollaborationAccess;
  handleGuidance?: (input: CollaborationGuidanceInput) => Promise<unknown>;
  getActiveRun?: (projectId: string, taskId: string) => unknown | Promise<unknown>;
  getGuidanceHistory?: (projectId: string, taskId: string) => unknown | Promise<unknown>;
  getOverview?: (projectId: string) => CollaborationOverview | Promise<CollaborationOverview>;
  getTaskContext?: (
    projectId: string,
    taskId: string
  ) => CollaborationTaskContext | Promise<CollaborationTaskContext>;
  assertTaskExists?: (projectId: string, taskId: string) => unknown | Promise<unknown>;
}) {
  const router = Router({ mergeParams: true });
  const service = options.service ?? new CollaborationService();
  const access = options.access ?? createCollaborationAccess();
  /** Resolve host, configured actor, or invitation authority before exposing project state. */
  const context = async (req: Request) => {
    const parsed = projectIdSchema.safeParse(req.params.projectId);
    if (!parsed.success) throw new AppError(400, "INVALID_PROJECT_ID", "Invalid project ID.");
    const projectId = parsed.data;
    let principal;
    try {
      principal = await access.resolve(req.headers.authorization, projectId);
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 401) throw error;
      const bearer = req.headers.authorization?.match(/^Bearer ([^\s]{1,4096})$/)?.[1];
      principal = bearer ? await service.resolveInvite(projectId, bearer) : null;
      if (!principal) throw error;
    }
    await options.assertProjectExists(projectId);
    return { projectId, principal };
  };

  /** Accept only task identifiers; path metadata never grants filesystem access. */
  const taskParam = (req: Request) => {
    const parsed = projectIdSchema.safeParse(req.params.taskId);
    if (!parsed.success) throw new AppError(400, "INVALID_TASK_ID", "Invalid task ID.");
    return parsed.data;
  };
  router.get(
    "/overview",
    wrapAsync(async (req, res) => {
      const { projectId } = await context(req);
      if (!options.getOverview)
        throw new AppError(503, "COLLABORATION_UNAVAILABLE", "Project overview is unavailable.");
      res.json({ data: await options.getOverview(projectId) });
    })
  );
  router.get(
    "/tasks/:taskId/context",
    wrapAsync(async (req, res) => {
      const { projectId } = await context(req);
      const taskId = taskParam(req);
      if (!options.getTaskContext)
        throw new AppError(503, "COLLABORATION_UNAVAILABLE", "Task context is unavailable.");
      const data = await options.getTaskContext(projectId, taskId);
      res.json({
        data: data.activeRun
          ? {
              ...data,
              activeRun: {
                ...data.activeRun,
                control: await service.getRunControl(projectId, data.activeRun.attemptId),
              },
            }
          : data,
      });
    })
  );
  router.get(
    "/invites",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      res.json({ data: await service.listInvites(projectId, principal) });
    })
  );
  router.post(
    "/invites",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      res.status(201).json({ data: await service.createInvite(projectId, principal, req.body) });
    })
  );
  router.delete(
    "/invites/:inviteId",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      const inviteId = projectIdSchema.safeParse(req.params.inviteId);
      if (!inviteId.success)
        throw new AppError(400, "INVALID_COLLABORATION_INVITE", "Invalid invitation ID.");
      await service.revokeInvite(projectId, principal, inviteId.data);
      res.status(204).end();
    })
  );
  router.get(
    "/presence",
    wrapAsync(async (req, res) => {
      const { projectId } = await context(req);
      res.json({ data: await service.presence(projectId) });
    })
  );
  router.post(
    "/presence",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      const input = z
        .object({ clientId: projectIdSchema, taskId: projectIdSchema.nullable() })
        .strict()
        .safeParse(req.body);
      if (!input.success)
        throw new AppError(400, "INVALID_COLLABORATION_PRESENCE", "Invalid browser presence.");
      if (input.data.taskId) await options.assertTaskExists?.(projectId, input.data.taskId);
      await service.heartbeat(projectId, principal, input.data.clientId, input.data.taskId);
      res.json({ data: await service.presence(projectId) });
    })
  );
  router.delete(
    "/presence/:clientId",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      const clientId = projectIdSchema.safeParse(req.params.clientId);
      if (!clientId.success)
        throw new AppError(400, "INVALID_COLLABORATION_PRESENCE", "Invalid browser ID.");
      await service.leave(projectId, principal, clientId.data);
      res.status(204).end();
    })
  );
  router.get(
    "/preferences",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      res.json({ data: await service.preferences(projectId, principal) });
    })
  );
  router.put(
    "/preferences",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      const input = z
        .object({
          seenCursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          subscribedTaskIds: z.array(projectIdSchema).max(200).optional(),
          markSeen: z.boolean().optional(),
          markSeenAt: z.iso.datetime().optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!input.success)
        throw new AppError(
          400,
          "INVALID_COLLABORATION_PREFERENCES",
          "Invalid notification preferences."
        );
      for (const taskId of input.data.subscribedTaskIds ?? [])
        await options.assertTaskExists?.(projectId, taskId);
      res.json({ data: await service.updatePreferences(projectId, principal, input.data) });
    })
  );
  router.get(
    "/notifications",
    wrapAsync(async (req, res) => {
      const { projectId, principal } = await context(req);
      res.json({
        data: await service.notifications(
          projectId,
          principal,
          options.getActiveRun
            ? async (taskId, runId) => {
                const active = await options.getActiveRun!(projectId, taskId);
                return Boolean(
                  active &&
                  typeof active === "object" &&
                  "attemptId" in active &&
                  active.attemptId === runId
                );
              }
            : undefined
        ),
      });
    })
  );

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
      await options.assertTaskExists?.(projectId, taskId.data);
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
      if (parsed.data.taskId) await options.assertTaskExists?.(projectId, parsed.data.taskId);
      if ("runId" in parsed.data) {
        if (!parsed.data.taskId)
          throw new AppError(
            400,
            "INVALID_TASK_ID",
            "A task ID is required for a control request."
          );
        if (!options.getActiveRun)
          throw new AppError(
            503,
            "GUIDANCE_UNAVAILABLE",
            "Active attempt validation is unavailable."
          );
        const active = await options.getActiveRun(projectId, parsed.data.taskId);
        if (
          !active ||
          typeof active !== "object" ||
          !("attemptId" in active) ||
          active.attemptId !== parsed.data.runId
        )
          throw new AppError(
            409,
            "AGENT_ATTEMPT_CHANGED",
            "The active attempt changed. Refresh before changing control."
          );
      }
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
      await options.assertTaskExists?.(projectId, taskId.data);
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
      await options.assertTaskExists?.(projectId, parsed.data.taskId);
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
