import { agentProcessEnvironment } from "../utils/agent-process-env.js";
import { Router, type Request } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { AGENT_ROLE_CANONICAL_ORDER } from "@opensprint/shared";
import type {
  AgentRole,
  GovernanceSummary,
  GovernanceTaskPin,
  PolicyProposal,
  PolicyRelease,
} from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import { wrapAsync } from "../middleware/wrap-async.js";
import {
  getGovernanceActor,
  governanceAuthorityConfigured,
  requireGovernanceHuman,
} from "../middleware/governance-auth.js";
import { governanceService } from "../services/governance.service.js";
import { governanceError } from "../services/policy-context.js";
import { ProjectService } from "../services/project.service.js";
import { getCombinedInstructions } from "../services/agent-instructions.service.js";
import { broadcastToProject } from "../websocket/index.js";
import {
  readGovernanceSourceHashes,
  governanceSourceDrift,
  resolveGovernanceSensitiveSourcePaths,
} from "../services/governance-source-hashes.js";
const run = promisify(execFile);
/** Verify code/policy compatibility in trusted code before any active pointer swap. */
export async function assertGovernanceEnforcementRevision(
  repoPath: string,
  revision: string
): Promise<void> {
  if (!/^[a-f0-9]{40}$/i.test(revision))
    governanceError("A complete immutable enforcement commit SHA is required.");
  try {
    await run("git", ["merge-base", "--is-ancestor", revision, "HEAD"], {
      env: agentProcessEnvironment(),
      cwd: repoPath,
    });
  } catch {
    governanceError(
      "Required enforcement revision has not landed; create a scoped implementation task before activation."
    );
  }
}
export function createGovernanceRouter(
  projectService: Pick<ProjectService, "getProject" | "getSettings"> = new ProjectService()
): Router {
  const router = Router({ mergeParams: true });
  const projectId = (req: Request): string => String(req.params.projectId);
  const sourceCodeSnapshot = async (pin: GovernanceTaskPin) => {
    const { governanceCodeSnapshot } = await import("../services/governance-execution.service.js");
    const approval = await governanceService.getReviewApproval(pin.projectId, pin.taskId);
    const headSha = (
      await run("git", ["rev-parse", "HEAD^{commit}"], {
        env: agentProcessEnvironment(),
        cwd: pin.worktreePath,
        timeout: 10_000,
      })
    ).stdout.trim();
    const scopeBaseSha =
      approval?.headSha === headSha
        ? approval.scopeBaseSha
        : pin.baseBranch
          ? (
              await run("git", ["rev-parse", `${pin.baseBranch}^{commit}`], {
                env: agentProcessEnvironment(),
                cwd: pin.worktreePath,
                timeout: 10_000,
              })
            ).stdout.trim()
          : undefined;
    const code = await governanceCodeSnapshot(
      pin.worktreePath,
      pin.baseSha,
      "HEAD",
      false,
      scopeBaseSha
    );
    return { ...code, scopeBaseSha };
  };
  const verifySourceSnapshot =
    (p: string, repoPath: string) =>
    async (release: PolicyRelease, db: DbClient): Promise<void> => {
      await assertGovernanceEnforcementRevision(repoPath, release.enforcementRevision);
      const drift = governanceSourceDrift(
        release.sourceHashes,
        await readGovernanceSourceHashes(p, repoPath, db)
      );
      if (drift.length)
        governanceError(
          `Policy sources changed after the approved/evaluated snapshot: ${drift.join(", ")}. Create and evaluate an exact reconciliation proposal.`,
          "GOVERNANCE_POLICY_DRIFT"
        );
    };
  router.use(
    wrapAsync(async (req, _res, next) => {
      await projectService.getProject(projectId(req));
      next();
    })
  );
  router.get(
    "/",
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      await governanceService.deliverOutbox(p);
      const [config, activeReleaseId, releases, cases, decisions, proposals, events] =
        await Promise.all([
          governanceService.getConfig(p),
          governanceService.getActiveReleaseId(p),
          governanceService.listReleases(p),
          governanceService.listCases(p),
          governanceService.listDecisions(p),
          governanceService.listProposals(p),
          governanceService.listAuditEvents(p),
        ]);
      const data: GovernanceSummary = {
        config,
        activeReleaseId,
        rules: releases.find((r) => r.id === activeReleaseId)?.rules ?? [],
        releases,
        cases,
        decisions,
        proposals,
        events,
        authority: {
          configured: governanceAuthorityConfigured(),
          ...(governanceAuthorityConfigured() ? { owner: getGovernanceActor(req) } : {}),
        },
      };
      res.json({ data });
    })
  );
  router.get(
    "/cases/:caseId",
    wrapAsync(async (req, res) =>
      res.json({ data: await governanceService.getCase(projectId(req), String(req.params.caseId)) })
    )
  );
  router.get(
    "/tasks/:taskId/context",
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const pin = await governanceService.getTaskPin(p, String(req.params.taskId));
      if (!pin) governanceError("Task has no pinned policy.", "GOVERNANCE_NOT_FOUND", 404);
      const role = String(req.query.role ?? "coder") as AgentRole;
      if (!AGENT_ROLE_CANONICAL_ORDER.includes(role))
        governanceError("Unknown policy role.", "GOVERNANCE_INVALID_INPUT", 400);
      let paths: unknown;
      try {
        paths = JSON.parse(String(req.query.paths ?? "[]"));
      } catch {
        governanceError(
          "paths must be a JSON array of repository-relative paths.",
          "GOVERNANCE_INVALID_INPUT",
          400
        );
      }
      if (
        !Array.isArray(paths) ||
        paths.length > 500 ||
        paths.some(
          (value) =>
            typeof value !== "string" ||
            value.startsWith("/") ||
            value.split(/[\\/]/).includes("..")
        )
      )
        governanceError("Invalid additional-rule path request.", "GOVERNANCE_INVALID_INPUT", 400);
      const context = await governanceService.refreshContext(pin, role, paths as string[]);
      await governanceService.recordContextRetrieval(p, pin.taskId, context.receipt);
      res.json({ data: context });
    })
  );
  router.post(
    "/tasks/:taskId/revalidate-policy",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req),
        taskId = String(req.params.taskId);
      if (typeof req.body.expectedReleaseId !== "string" || typeof req.body.rationale !== "string")
        governanceError("Replacement release and rationale are required.");
      const project = await projectService.getProject(p);
      const { orchestratorService } = await import("../services/orchestrator.service.js");
      if (orchestratorService.hasActiveTask(p, taskId))
        governanceError(
          "The old-policy agent is still stopping. Retry policy revalidation after its slot is released."
        );
      const previous = await governanceService.getTaskCases(p, taskId);
      const pin = await governanceService.revalidateTaskPolicy(
        p,
        taskId,
        req.body,
        getGovernanceActor(req),
        verifySourceSnapshot(p, project.repoPath)
      );
      for (const c of previous)
        broadcastToProject(p, {
          type: "notification.resolved",
          notificationId: `gov-${c.id}`,
          projectId: p,
          source: "execute",
          sourceId: taskId,
        });
      res.json({ data: pin });
    })
  );
  router.post(
    "/tasks/:taskId/authorize-scope",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      if (typeof req.body.scope !== "string" || typeof req.body.rationale !== "string")
        governanceError("Scope and rationale are required.");
      await governanceService.authorizeTaskScope(
        projectId(req),
        String(req.params.taskId),
        req.body.scope,
        req.body.rationale,
        getGovernanceActor(req)
      );
      res.json({ data: { ok: true } });
    })
  );
  router.patch(
    "/config",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      if (
        req.body.mode !== "disabled" &&
        (await projectService.getSettings(p)).reviewMode !== "always"
      )
        governanceError(
          "Policy governance requires reviewMode: always; update review settings first."
        );
      res.json({ data: await governanceService.configure(p, req.body, getGovernanceActor(req)) });
    })
  );
  router.post(
    "/releases",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const project = await projectService.getProject(p);
      const { stdout } = await run("git", ["rev-parse", "HEAD"], {
        env: agentProcessEnvironment(),
        cwd: project.repoPath,
      });
      const enforcementRevision = req.body.enforcementRevision?.trim() || stdout.trim();
      await assertGovernanceEnforcementRevision(project.repoPath, enforcementRevision);
      const instructions = { ...req.body.instructions };
      for (const role of AGENT_ROLE_CANONICAL_ORDER) {
        const source = await getCombinedInstructions(project.repoPath, role);
        if (instructions[role] === undefined) instructions[role] = source;
      }
      const sourceHashes = await readGovernanceSourceHashes(p, project.repoPath);
      const data = await governanceService.createRelease(
        p,
        { rules: req.body.rules, instructions, sourceHashes, enforcementRevision },
        getGovernanceActor(req)
      );
      res.status(201).json({ data });
    })
  );
  router.post(
    "/releases/:releaseId/revoke",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      if (typeof req.body.rationale !== "string")
        governanceError("A human revocation rationale is required.");
      await governanceService.revokeRelease(
        projectId(req),
        String(req.params.releaseId),
        req.body.rationale,
        getGovernanceActor(req)
      );
      const p = projectId(req);
      const project = await projectService.getProject(p);
      const { orchestratorService } = await import("../services/orchestrator.service.js");
      const affected = (await governanceService.listCases(p)).filter(
        (c) => c.releaseId === String(req.params.releaseId) && c.state === "stale"
      );
      for (const taskId of new Set(affected.map((c) => c.taskId)))
        if (orchestratorService.hasActiveTask(p, taskId))
          await orchestratorService.pauseForGovernance(p, project.repoPath, taskId);
      res.json({ data: { ok: true } });
    })
  );
  router.post(
    "/releases/:releaseId/activate",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const project = await projectService.getProject(p);
      const release = await governanceService.getRelease(p, String(req.params.releaseId));
      await assertGovernanceEnforcementRevision(project.repoPath, release.enforcementRevision);
      const data = await governanceService.activateRelease(
        p,
        release.id,
        req.body,
        getGovernanceActor(req),
        verifySourceSnapshot(p, project.repoPath)
      );
      res.json({ data });
    })
  );
  router.post(
    "/cases/:caseId/resolve",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const data = await governanceService.resolveCase(
        p,
        String(req.params.caseId),
        req.body,
        getGovernanceActor(req)
      );
      if (data.action !== "request_evidence" && data.action !== "cancel")
        broadcastToProject(p, {
          type: "notification.resolved",
          notificationId: `gov-${req.params.caseId}`,
          projectId: p,
          source: "execute",
          sourceId: data.taskId,
        });
      res.json({ data });
    })
  );
  router.get(
    "/source-changes/:taskId",
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const pin = await governanceService.getTaskPin(p, String(req.params.taskId));
      if (!pin)
        governanceError("A retained governed assignment is required for source-change approval.");
      const code = await sourceCodeSnapshot(pin);
      const changedPaths = await resolveGovernanceSensitiveSourcePaths({
        repoPath: pin.worktreePath,
        ...code,
      });
      res.json({
        data: {
          taskId: pin.taskId,
          releaseId: pin.releaseId,
          headSha: code.headSha,
          diffHash: code.diffHash,
          changedPaths,
          diff: code.diff,
        },
      });
    })
  );
  router.post(
    "/source-changes/approve",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const input = req.body as {
        taskId?: unknown;
        headSha?: unknown;
        diffHash?: unknown;
        rationale?: unknown;
      };
      if (
        typeof input.taskId !== "string" ||
        typeof input.headSha !== "string" ||
        typeof input.diffHash !== "string" ||
        typeof input.rationale !== "string" ||
        !input.rationale.trim()
      )
        governanceError("Task, reviewed code binding, and approval rationale are required.");
      const taskId = input.taskId,
        headSha = input.headSha,
        diffHash = input.diffHash,
        rationale = input.rationale;
      const data = await governanceService.withPublicationLock(p, async (assertLease) => {
        const pin = await governanceService.getTaskPin(p, taskId);
        if (!pin)
          governanceError("A retained governed assignment is required for source-change approval.");
        const code = await sourceCodeSnapshot(pin);
        if (headSha !== code.headSha || diffHash !== code.diffHash)
          governanceError(
            "Source-change approval is stale; inspect the current complete diff and try again.",
            "GOVERNANCE_STALE_CODE"
          );
        const changedPaths = await resolveGovernanceSensitiveSourcePaths({
          repoPath: pin.worktreePath,
          ...code,
        });
        if (!changedPaths.length)
          governanceError("This revision has no policy-sensitive source changes to authorize.");
        await assertLease();
        await governanceService.audit(p, "policy_source_change_approved", getGovernanceActor(req), {
          taskId: pin.taskId,
          releaseId: pin.releaseId,
          headSha: code.headSha,
          diffHash: code.diffHash,
          changedPaths,
          rationale,
        });
        return {
          taskId: pin.taskId,
          releaseId: pin.releaseId,
          headSha: code.headSha,
          diffHash: code.diffHash,
          changedPaths,
        };
      });
      res.json({ data });
    })
  );
  router.post(
    "/cases/:caseId/evidence",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const data = await governanceService.appendCaseEvidence(
        projectId(req),
        String(req.params.caseId),
        req.body.expectedVersion,
        req.body.evidence,
        getGovernanceActor(req)
      );
      await governanceService.deliverOutbox(projectId(req));
      res.json({ data });
    })
  );
  router.post(
    "/decisions/:decisionId/revoke",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      await governanceService.revokeDecision(
        projectId(req),
        String(req.params.decisionId),
        req.body.rationale,
        getGovernanceActor(req)
      );
      res.json({ data: { ok: true } });
    })
  );
  router.post(
    "/mine",
    requireGovernanceHuman,
    wrapAsync(async (req, res) =>
      res.json({ data: await governanceService.mineDecisions(projectId(req)) })
    )
  );
  router.post(
    "/proposals",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const project = await projectService.getProject(p);
      // Source hashes are server-derived and part of the evaluated immutable candidate manifest.
      const sourceHashes = await readGovernanceSourceHashes(p, project.repoPath);
      return res.status(201).json({
        data: await governanceService.createProposal(
          p,
          { ...req.body, sourceHashes } as Omit<
            PolicyProposal,
            "id" | "state" | "version" | "createdAt" | "projectId"
          >,
          getGovernanceActor(req)
        ),
      });
    })
  );
  router.post(
    "/proposals/:proposalId/activate",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const project = await projectService.getProject(p);
      const candidate = await governanceService.previewProposalRelease(
        p,
        String(req.params.proposalId)
      );
      await assertGovernanceEnforcementRevision(project.repoPath, candidate.enforcementRevision);
      res.json({
        data: await governanceService.activateProposal(
          p,
          String(req.params.proposalId),
          req.body,
          getGovernanceActor(req),
          verifySourceSnapshot(p, project.repoPath)
        ),
      });
    })
  );
  router.post(
    "/proposals/:proposalId/reject",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      await governanceService.rejectProposal(
        projectId(req),
        String(req.params.proposalId),
        req.body.expectedVersion,
        req.body.rationale,
        getGovernanceActor(req)
      );
      res.json({ data: { ok: true } });
    })
  );
  router.post(
    "/rollback",
    requireGovernanceHuman,
    wrapAsync(async (req, res) => {
      const p = projectId(req);
      const project = await projectService.getProject(p);
      const release = await governanceService.getRelease(p, req.body.releaseId);
      await assertGovernanceEnforcementRevision(project.repoPath, release.enforcementRevision);
      res.json({
        data: await governanceService.rollback(
          p,
          release.id,
          req.body.expectedActiveReleaseId,
          req.body.rationale,
          getGovernanceActor(req),
          verifySourceSnapshot(p, project.repoPath)
        ),
      });
    })
  );
  return router;
}
