import { Router } from "express";
import { z } from "zod";
import { wrapAsync } from "../middleware/wrap-async.js";
import { requireGovernanceHuman, getGovernanceActor } from "../middleware/governance-auth.js";
import { governanceError } from "../services/policy-context.js";
import {
  promptTimeChangedPaths,
  replayFixtureService,
  REPLAY_LABELS,
} from "../services/replay-fixture.service.js";
import { governanceService } from "../services/governance.service.js";
import {
  evaluatePolicyProposal,
  policyReplayInstructions,
} from "../services/policy-evaluation.service.js";
import { ProjectService } from "../services/project.service.js";
import { validateBody } from "../middleware/validate.js";
import type { GovernanceReplayInput } from "../services/governance-replay-input.js";
import { taskStore } from "../services/task-store.service.js";
const projects = new ProjectService();
const fixtureSchema = z
  .object({
    sessionId: z.number().int().positive(),
    taskId: z.string().min(1),
    toolchain: z.string().min(1),
    label: z.enum(REPLAY_LABELS),
    holdout: z.boolean(),
    rubric: z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      checks: z
        .array(
          z.object({
            name: z.string().min(1),
            command: z.string().min(1),
            args: z.array(z.string()),
          })
        )
        .min(1),
    }),
  })
  .strict();
export function createGovernanceReplayRouter(): Router {
  const router = Router({ mergeParams: true });
  const projectId = (params: Record<string, unknown>) =>
    String(params.id ?? params.projectId ?? "");
  router.get(
    "/sources",
    wrapAsync(async (req, res) => {
      const pid = projectId(req.params);
      await projects.getProject(pid);
      const db = await taskStore.getDb();
      const sessions = await db.query(
        "SELECT session_id,task_id,attempt,status FROM governance_replay_inputs WHERE project_id=$1 ORDER BY session_id DESC LIMIT 500",
        [pid]
      );
      res.json({
        data: sessions.map((s) => ({
          sessionId: Number(s.session_id),
          taskId: String(s.task_id),
          attempt: s.attempt === null ? undefined : Number(s.attempt),
          status: s.status === null ? undefined : String(s.status),
        })),
      });
    })
  );
  router.get(
    "/fixtures",
    wrapAsync(async (req, res) => {
      const pid = projectId(req.params);
      await projects.getProject(pid);
      const fixtures = await replayFixtureService.list(pid);
      res.json({
        data: fixtures.map(({ fixture, hash }) => ({
          sessionId: fixture.sessionId,
          label: fixture.label,
          holdout: fixture.holdout,
          policyReleaseId: fixture.policyReleaseId,
          rubricId: fixture.rubric.id,
          hash,
        })),
      });
    })
  );
  router.post(
    "/fixtures",
    requireGovernanceHuman,
    validateBody(fixtureSchema),
    wrapAsync(async (req, res) => {
      const pid = projectId(req.params);
      const project = await projects.getProject(pid);
      const body = fixtureSchema.parse(req.body);
      const row = await (
        await taskStore.getDb()
      ).queryOne(
        "SELECT payload FROM governance_replay_inputs WHERE project_id=$1 AND task_id=$2 AND session_id=$3",
        [pid, body.taskId, body.sessionId]
      );
      if (!row)
        governanceError(
          "Exact original session inputs were not retained; evaluation is unavailable."
        );
      const source = JSON.parse(String(row.payload)) as GovernanceReplayInput;
      if (
        source.sessionId !== body.sessionId ||
        source.taskId !== body.taskId ||
        !source.taskPrompt?.trim() ||
        !source.invocationId ||
        !source.originalPrompt
      )
        governanceError("Retained session provenance is incomplete.");
      const release = source.release;
      const promptChangedPaths = promptTimeChangedPaths(source.contextArtifacts);
      const stored = await replayFixtureService.capture(
        {
          version: 1,
          ...body,
          taskPrompt: source.taskPrompt,
          originalPrompt: source.originalPrompt,
          projectId: pid,
          baseCommitSha: source.baseSha,
          instructions: policyReplayInstructions(release, source.changedPaths, promptChangedPaths),
          policyReleaseId: source.pin.releaseId,
          changedPaths: source.changedPaths,
          promptChangedPaths,
          taskId: source.taskId,
          originalWorkspaceRoot: source.pin.worktreePath,
          contextArtifacts: source.contextArtifacts,
          policyRelease: release,
          humanActor: getGovernanceActor(req),
          createdAt: new Date().toISOString(),
        },
        project.repoPath
      );
      await governanceService.recordReplayFixture(pid, {
        sessionId: stored.fixture.sessionId,
        taskId: source.taskId,
        releaseId: source.pin.releaseId,
        hash: stored.hash,
      });
      res.status(201).json({ data: { sessionId: stored.fixture.sessionId, hash: stored.hash } });
    })
  );
  router.delete(
    "/evidence",
    requireGovernanceHuman,
    validateBody(z.object({ confirm: z.literal(true) }).strict()),
    wrapAsync(async (req, res) => {
      const pid = projectId(req.params);
      await projects.getProject(pid);
      await governanceService.purgeReplayFixtureBindings(pid, getGovernanceActor(req));
      await replayFixtureService.purge(pid);
      res.status(204).end();
    })
  );
  router.post(
    "/proposals/:proposalId/evaluate",
    requireGovernanceHuman,
    validateBody(z.object({ expectedVersion: z.number().int().positive() }).strict()),
    wrapAsync(async (req, res) => {
      const pid = projectId(req.params);
      const project = await projects.getProject(pid);
      const proposal = await evaluatePolicyProposal(
        pid,
        String(req.params.proposalId),
        req.body.expectedVersion,
        project.repoPath
      );
      res.json({ data: proposal });
    })
  );
  return router;
}
