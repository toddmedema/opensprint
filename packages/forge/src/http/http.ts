import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { hashToken, ownerMatches, signSession, readSession, hashPassword, verifyPassword } from "../crypto/crypto.js";
import type { CredentialSecret, GovernanceMode, Role, UserRecord } from "../domain.js";
import { ForgeError, isForgeError } from "../errors.js";
import { judgeAppeal, reconsider } from "../gate/judge.js";
import { changeGovernance } from "../gate/gate.js";
import { assertRole, hasRole, isRole } from "../identity/roles.js";
import type { Engine } from "../engine/engine.js";
import type { EvolveService } from "../evolve/evolve.js";
import { REPLAY_NOTE } from "../evolve/replay.js";
import type { NotifyHub } from "../notify/hub.js";
import { assertRemoteUrl, assertRuntimeArgv, isLocalRemote } from "../runbook/runbook.js";
import type { ForgeStore } from "../store/store.js";
import type { GitWorkspace } from "../workspace/git.js";

interface HttpDeps {
  store: ForgeStore;
  engine: Engine;
  evolve: EvolveService;
  notify: NotifyHub;
  workspace: GitWorkspace;
  sessionSecret: string;
  ownerKey: string | null;
  encrypt: (text: string) => string;
  clientDir: string | null;
}

export function createHttp(deps: HttpDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  for (const verb of ["get", "post", "put", "patch", "delete"] as const) {
    const original = app[verb].bind(app);
    app[verb] = ((...args: unknown[]) => {
      const wrapped = args.map((arg, index) => {
        if (index === 0 || typeof arg !== "function") return arg;
        return (req: Request, res: Response, next: NextFunction) => {
          try {
            const result = (arg as (req: Request, res: Response, next: NextFunction) => unknown)(
              req,
              res,
              next
            );
            Promise.resolve(result).catch(next);
          } catch (error) {
            next(error);
          }
        };
      });
      return original(...(wrapped as Parameters<typeof original>));
    }) as (typeof app)[typeof verb];
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/session/register", (req, res) => {
    const email = cleanEmail(req.body?.email);
    const name = stringField(req.body?.name, "name");
    const password = stringField(req.body?.password, "password");
    if (password.length < 8) throw new ForgeError(400, "invalid_password", "Use at least 8 characters.");
    if (deps.store.userByEmail(email)) throw new ForgeError(409, "email_taken", "That email is already registered.");
    const user = deps.store.insertUser({ email, name, passwordHash: hashPassword(password) });
    sendUser(res, deps.sessionSecret, user);
  });

  app.post("/session", (req, res) => {
    const email = cleanEmail(req.body?.email);
    const password = stringField(req.body?.password, "password");
    const user = deps.store.userByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new ForgeError(401, "invalid_login", "Email or password is wrong.");
    }
    sendUser(res, deps.sessionSecret, user);
  });

  app.delete("/session", (_req, res) => {
    res.setHeader("Set-Cookie", "forge_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  app.get("/session", (req, res) => {
    sendUser(res, deps.sessionSecret, requireUser(deps, req));
  });

  app.get("/home", (req, res) => {
    const user = requireUser(deps, req);
    const memberships = deps.store.membershipsForUser(user.id);
    const projects = deps.store.projectsByTeamIds(memberships.map((item) => item.teamId));
    res.json({
      health: { ok: true },
      teams: memberships.map((item) => ({ id: item.teamId, name: item.teamName, role: item.role })),
      projects: projects.map((project) => projectJson(deps, project)),
      recentShips: deps.store.recentShips(projects.map((item) => item.id)).map((item) => ({
        workItemId: item.id,
        projectId: item.projectId,
        title: item.title,
        shipCommit: item.shipCommit,
        updatedAt: item.updatedAt,
      })),
    });
  });

  app.post("/teams", (req, res) => {
    const user = requireUser(deps, req);
    const team = deps.store.insertTeam(stringField(req.body?.name, "name"));
    deps.store.insertMembership({ teamId: team.id, userId: user.id, role: "admin" });
    res.status(201).json({ team: { id: team.id, name: team.name } });
  });

  app.get("/teams/:teamId/members", (req, res) => {
    const user = requireUser(deps, req);
    requireTeam(deps, req.params.teamId, user.id, "view");
    res.json({
      members: deps.store.membersOfTeam(req.params.teamId).map((member) => ({
        userId: member.userId,
        name: member.name,
        email: member.email,
        role: member.role,
      })),
    });
  });

  app.patch("/teams/:teamId/members/:userId", (req, res) => {
    const user = requireUser(deps, req);
    requireTeam(deps, req.params.teamId, user.id, "admin");
    if (!isRole(String(req.body?.role ?? ""))) throw new ForgeError(400, "invalid_role", "Unknown role.");
    deps.store.updateMembershipRole(req.params.teamId, req.params.userId, req.body.role);
    publishMembership(deps, req.params.teamId);
    res.json({ ok: true });
  });

  app.post("/teams/:teamId/invites", (req, res) => {
    const user = requireUser(deps, req);
    requireTeam(deps, req.params.teamId, user.id, "admin");
    if (!isRole(String(req.body?.role ?? ""))) throw new ForgeError(400, "invalid_role", "Unknown role.");
    const token = randomBytes(32).toString("base64url");
    deps.store.insertInvite({
      teamId: req.params.teamId,
      role: req.body.role,
      tokenHash: hashToken(token),
      createdBy: user.id,
    });
    res.status(201).json({ invite: { token, role: req.body.role } });
  });

  app.post("/invites/:token/accept", (req, res) => {
    const user = requireUser(deps, req);
    const invite = deps.store.inviteByHash(hashToken(req.params.token));
    if (!invite || invite.acceptedAt) throw new ForgeError(404, "not_found", "Invite not found.");
    if (deps.store.membership(invite.teamId, user.id)) {
      throw new ForgeError(409, "already_member", "You are already on that team.");
    }
    const membership = deps.store.insertMembership({
      teamId: invite.teamId,
      userId: user.id,
      role: invite.role,
    });
    deps.store.markInviteAccepted(invite.id, user.id);
    publishMembership(deps, invite.teamId);
    res.json({ membership: { teamId: membership.teamId, role: membership.role } });
  });

  app.post("/teams/:teamId/projects", async (req, res) => {
    const user = requireUser(deps, req);
    requireTeam(deps, req.params.teamId, user.id, "admin");
    const runtime = req.body?.agentRuntime as { argv?: string[]; timeoutSec?: number } | undefined;
    if (!runtime || !Array.isArray(runtime.argv) || typeof runtime.timeoutSec !== "number") {
      throw new ForgeError(400, "invalid_runtime", "agentRuntime needs argv and timeoutSec.");
    }
    assertRuntimeArgv(runtime.argv, runtime.timeoutSec);
    const origin = req.body?.origin === "scratch" ? "scratch" : "import";
    const name = stringField(req.body?.name, "name");
    const baseBranch = origin === "scratch" ? "main" : stringField(req.body?.baseBranch, "baseBranch");
    const remoteInput = origin === "scratch" ? null : stringField(req.body?.remoteUrl, "remoteUrl");
    if (remoteInput) assertRemoteUrl(remoteInput);
    const credential = parseCredential(req.body?.credential, remoteInput ?? "/");
    const remoteUrl = remoteInput ?? (await deps.workspace.createScratchRepository());
    const project = deps.store.insertProject({
      teamId: req.params.teamId,
      name,
      remoteUrl,
      baseBranch,
      runtime: { argv: runtime.argv, timeoutSec: runtime.timeoutSec },
    });
    const credentialId = deps.store.insertCredential(
      project.id,
      credential.type,
      deps.encrypt(JSON.stringify(credential))
    );
    deps.store.updateProject(project.id, { credentialId });
    try {
      await deps.workspace.ensureCheckout(
        { ...project, credentialId },
        credential
      );
    } catch (error) {
      deps.store.deleteProject(project.id);
      throw error;
    }
    res.status(201).json({ project: projectJson(deps, { ...project, credentialId }) });
  });

  app.get("/projects/:projectId", (req, res) => {
    const { project } = access(deps, req, "view");
    const frame = deps.store.latestFrame(project.id);
    const active = deps.store.activeRevision(project.id);
    res.json({
      project: projectJson(deps, project),
      frame: frame ? { version: frame.version, markdown: frame.markdown } : null,
      runbook: {
        locked: project.runbookLocked,
        activeDigest: project.activeRunbookDigest,
        document: active?.document ?? null,
      },
    });
  });

  app.get("/projects/:projectId/frame", (req, res) => {
    const { project } = access(deps, req, "view");
    const latest = deps.store.latestFrame(project.id);
    res.json({
      version: latest?.version ?? 0,
      markdown: latest?.markdown ?? "",
      versions: deps.store.listFrames(project.id).map((frame) => ({
        version: frame.version,
        createdAt: frame.createdAt,
      })),
    });
  });

  app.put("/projects/:projectId/frame", (req, res) => {
    const { project, user } = access(deps, req, "steer");
    const frame = deps.store.insertFrame({
      projectId: project.id,
      markdown: typeof req.body?.markdown === "string" ? req.body.markdown : "",
      createdBy: user.id,
    });
    res.json({ version: frame.version, markdown: frame.markdown });
  });

  app.get("/projects/:projectId/runbook", (req, res) => {
    const { project } = access(deps, req, "view");
    const active = deps.store.activeRevision(project.id);
    res.json({
      locked: project.runbookLocked,
      activeDigest: project.activeRunbookDigest,
      active: active?.document ?? null,
      revisions: deps.store.revisionsByProject(project.id).map((revision) => ({
        id: revision.id,
        digest: revision.digest,
        status: revision.status,
        createdAt: revision.createdAt,
        probe: revision.probe,
      })),
    });
  });

  app.post("/projects/:projectId/runbook/discover", async (req, res) => {
    access(deps, req, "admin");
    res.json(await deps.engine.discover(req.params.projectId));
  });

  app.post("/projects/:projectId/runbook/proposals", async (req, res) => {
    access(deps, req, "admin");
    res.json(await deps.engine.propose(req.params.projectId, req.body?.document));
  });

  app.post("/projects/:projectId/runbook/verification", async (req, res) => {
    access(deps, req, "admin");
    const argv = verificationArgv(req.body?.command);
    const outcome = await deps.engine.propose(req.params.projectId, verificationDocument(argv));
    if (outcome.outcome === "active") finishDiscoveryQuestions(deps, req.params.projectId);
    res.json(outcome);
  });

  app.post("/projects/:projectId/runbook/lock", (req, res) => {
    const { project } = access(deps, req, "admin");
    if (typeof req.body?.locked !== "boolean") {
      throw new ForgeError(400, "invalid_lock", "locked must be true or false.");
    }
    if (req.body.locked && !project.activeRunbookDigest) {
      throw new ForgeError(409, "no_runbook", "Discover or probe a runbook before locking.");
    }
    deps.store.updateProject(project.id, { runbookLocked: req.body.locked });
    deps.notify.publish(project.id, "runbook.updated");
    res.json({ locked: req.body.locked });
  });

  app.get("/projects/:projectId/order", (req, res) => {
    const { project } = access(deps, req, "view");
    res.json({
      items: deps.store.workItemsByProject(project.id).map(workItemJson),
      dependencies: deps.store.dependenciesByProject(project.id),
    });
  });

  app.post("/projects/:projectId/order", async (req, res) => {
    const { project, user } = access(deps, req, "steer");
    const ownerUserId = optionalString(req.body?.ownerUserId);
    const item = deps.store.insertWorkItem({
      projectId: project.id,
      parentId: optionalString(req.body?.parentId),
      title: stringField(req.body?.title, "title"),
      body: typeof req.body?.body === "string" ? req.body.body : "",
      status: "queued",
      ownerUserId,
      scopePaths: stringArray(req.body?.scopePaths),
      frameVersion: deps.store.latestFrame(project.id)?.version ?? null,
    });
    for (const dependsOnId of stringArray(req.body?.dependsOnIds)) {
      deps.store.insertDependency({ projectId: project.id, workItemId: item.id, dependsOnId });
    }
    deps.notify.publish(project.id, "work_item.updated");
    if (!ownerUserId) await deps.engine.tick();
    res.status(201).json({ item: workItemJson(item), createdBy: user.id });
  });

  app.post("/projects/:projectId/order/plan", async (req, res) => {
    access(deps, req, "steer");
    const outcome = await deps.engine.plan(req.params.projectId, stringField(req.body?.instruction, "instruction"));
    await deps.engine.tick();
    res.json(outcome);
  });

  app.get("/projects/:projectId/order/:workItemId", async (req, res) => {
    const { project } = access(deps, req, "view");
    const item = requireItem(deps, project.id, req.params.workItemId);
    const run = deps.store.openRunForItem(item.id) ?? latestDoneRun(deps, item.id);
    const thread = deps.store.ensureThread(project.id, item.id);
    let diff = "";
    if (item.shipCommit) {
      diff = await deps.workspace.shipDiff(deps.workspace.checkoutPath(project.id), item.shipCommit);
    } else if (run?.worktreePath && fs.existsSync(run.worktreePath)) {
      if (item.status === "held") {
        const unpushed = await deps.workspace.unpushedDiff(run.worktreePath, project.baseBranch);
        diff = unpushed.trim()
          ? unpushed
          : await deps.workspace.diffText(run.worktreePath, project.baseBranch);
      } else {
        diff = await deps.workspace.diffText(run.worktreePath, project.baseBranch);
      }
    }
    const controller = run?.controllerUserId ? deps.store.userById(run.controllerUserId) : null;
    const pin = run ? deps.store.pinByRun(run.id) : null;
    res.json({
      item: workItemJson(item),
      dependencies: deps.store.dependenciesByProject(project.id).filter((edge) => edge.workItemId === item.id),
      diff,
      evidence: run?.evidence ?? [],
      thread: {
        cursor: thread.cursor,
        entries: deps.store.entries(thread.id).map((entry) => ({
          ...entry,
          authorName: deps.store.userById(entry.authorId)?.name ?? "Unknown",
        })),
      },
      run: run
        ? {
            id: run.id,
            attempt: run.attempt,
            state: run.state,
            runbookDigest: run.runbookDigest,
            frameVersion: run.frameVersion,
            controllerUserId: run.controllerUserId,
            controlRevision: run.controlRevision,
            policyRule: run.policyRule,
            midTurn: run.midTurn,
            questions: run.questions,
            resultStatus: run.resultStatus,
            resultSummary: run.resultSummary,
            policyPin: pin,
          }
        : null,
      controller: controller
        ? { userId: controller.id, name: controller.name, revision: run?.controlRevision ?? 0 }
        : null,
    });
  });

  app.post("/projects/:projectId/order/:workItemId/thread", (req, res) => {
    const { project, user } = access(deps, req, "discuss");
    const item = requireItem(deps, project.id, req.params.workItemId);
    const thread = deps.store.ensureThread(project.id, item.id);
    const appended = deps.store.appendEntry({
      threadId: thread.id,
      authorId: user.id,
      kind: "post",
      body: stringField(req.body?.body, "body"),
      idempotencyKey: optionalString(req.body?.idempotencyKey),
    });
    if (appended.created) deps.notify.publish(project.id, "thread.appended");
    res.status(appended.created ? 201 : 200).json({ entry: appended.entry });
  });

  app.post("/projects/:projectId/order/:workItemId/steer/claim", (req, res) => {
    const { project, user, membership } = access(deps, req, "steer");
    const run = requireOpenRun(deps, project.id, req.params.workItemId);
    assertRevision(run.controlRevision, req.body?.revision);
    if (run.controllerUserId && run.controllerUserId !== user.id && membership.role !== "admin") {
      throw new ForgeError(409, "controller_held", "Someone else is guiding this run.");
    }
    deps.store.updateRun(run.id, { controllerUserId: user.id, controlRevision: run.controlRevision + 1 });
    deps.notify.publish(project.id, "run.updated");
    res.json({ revision: run.controlRevision + 1 });
  });

  app.post("/projects/:projectId/order/:workItemId/steer/handoff", (req, res) => {
    const { project, user, membership } = access(deps, req, "steer");
    const run = requireOpenRun(deps, project.id, req.params.workItemId);
    assertRevision(run.controlRevision, req.body?.revision);
    const toUserId = stringField(req.body?.toUserId, "toUserId");
    if (run.controllerUserId !== user.id && membership.role !== "admin") {
      throw new ForgeError(403, "forbidden", "Only the current controller can hand off.");
    }
    const recipient = deps.store.membership(project.teamId, toUserId);
    if (!recipient || !hasRole(recipient.role, "steer")) {
      throw new ForgeError(400, "invalid_controller", "Hand off to a team member who can steer.");
    }
    deps.store.updateRun(run.id, { controllerUserId: toUserId, controlRevision: run.controlRevision + 1 });
    deps.notify.publish(project.id, "run.updated");
    res.json({ revision: run.controlRevision + 1 });
  });

  app.post("/projects/:projectId/order/:workItemId/steer/guidance", (req, res) => {
    const { project, user } = access(deps, req, "steer");
    const item = requireItem(deps, project.id, req.params.workItemId);
    const run = requireOpenRun(deps, project.id, item.id);
    assertRevision(run.controlRevision, req.body?.revision);
    if (run.controllerUserId !== user.id) {
      throw new ForgeError(403, "forbidden", "Claim the run before submitting guidance.");
    }
    const body = stringField(req.body?.body, "body");
    const thread = deps.store.ensureThread(project.id, item.id);
    deps.store.appendEntry({ threadId: thread.id, authorId: user.id, kind: "guidance", body });
    deps.store.updateRun(run.id, {
      guidance: [...run.guidance, body],
      midTurn: "next_attempt",
      controlRevision: run.controlRevision + 1,
    });
    deps.notify.publish(project.id, "thread.appended");
    deps.notify.publish(project.id, "run.updated");
    res.status(201).json({ midTurn: "next_attempt" });
  });

  app.get("/projects/:projectId/gate", (req, res) => {
    const { project } = access(deps, req, "view");
    const items = deps.store.workItemsByProject(project.id);
    const runs = deps.store.runsByProject(project.id);
    res.json({
      holds: items
        .filter((item) => item.status === "held")
        .map((item) => ({
          id: item.id,
          workItemId: item.id,
          title: item.title,
          status: "held",
          reason: item.blockedReason ?? "",
        })),
      questions: runs
        .filter((run) => run.state === "needs_human")
        .flatMap((run) =>
          run.questions.map((prompt, index) => ({
            id: `${run.id}:${index}`,
            runId: run.id,
            prompt,
            status: "open",
            role: run.role,
          }))
        ),
      cases: deps.store.casesByProject(project.id).map((item) => ({
        id: item.id,
        workItemId: item.workItemId,
        title: item.kind,
        status: item.status,
        summary: caseSummary(item.kind, item.payload),
        kind: item.kind,
      })),
      findings: deps.store.findingsByProject(project.id).map((finding) => ({
        id: finding.id,
        title: finding.ruleKey ?? finding.kind,
        summary: finding.evidence,
        status: finding.status,
        rule: finding.ruleKey,
      })),
    });
  });

  app.post("/projects/:projectId/gate/questions/:runId/answer", async (req, res) => {
    const { project } = access(deps, req, "steer");
    const run = deps.store.runById(req.params.runId);
    if (!run || run.projectId !== project.id) throw new ForgeError(404, "not_found", "Run not found.");
    await deps.engine.answer(run.id, stringField(req.body?.text, "text"));
    res.json({ ok: true });
  });

  app.post("/projects/:projectId/gate/findings/:findingId/appeal", (req, res) => {
    const { project } = access(deps, req, "steer");
    const finding = deps.store.findingById(req.params.findingId);
    if (!finding || finding.projectId !== project.id) throw new ForgeError(404, "not_found", "Finding not found.");
    if (finding.appeal) throw new ForgeError(409, "appeal_used", "This finding was already appealed.");
    if (deps.store.countAppeals(finding.workItemId) >= 3) {
      throw new ForgeError(409, "appeal_budget", "The appeal budget for this work item is spent.");
    }
    const appeal = {
      alternatives: stringField(req.body?.alternatives, "alternatives"),
      evidence: stringField(req.body?.evidence, "evidence"),
      risks: stringField(req.body?.risks, "risks"),
      limits: stringField(req.body?.limits, "limits"),
    };
    const reconsideration = reconsider(finding);
    const judgment = judgeAppeal(finding, appeal);
    const status = judgment.decision === "dismiss" && !finding.evidence.trim() ? "dismissed" : "upheld";
    deps.store.updateFinding(finding.id, { appeal, judge: judgment, status });
    res.json({ reconsideration, judgment, status });
  });

  app.post("/projects/:projectId/gate/cases/:caseId/resolve", async (req, res) => {
    const { project, user } = access(deps, req, "view");
    assertOwner(deps, req.body?.ownerKey);
    const review = deps.store.caseById(req.params.caseId);
    if (!review || review.projectId !== project.id) throw new ForgeError(404, "not_found", "Case not found.");
    if (review.status !== "open") {
      throw new ForgeError(409, "case_closed", "That case is already resolved.");
    }
    const decision = req.body?.decision === "allow_once" ? "allow_once" : req.body?.decision === "reject" ? "reject" : "";
    if (!decision) throw new ForgeError(400, "invalid_decision", "Decision must be reject or allow_once.");
    if (decision === "allow_once" && (review.kind === "failing_gate" || review.kind === "question")) {
      throw new ForgeError(409, "gates_cannot_be_waived", "A ruling cannot waive a runbook gate or a question.");
    }
    const run = review.runId ? deps.store.runById(review.runId) : null;
    const pin = run ? deps.store.pinByRun(run.id) : null;
    if (decision === "allow_once" && review.kind === "governance" && !run) {
      throw new ForgeError(
        409,
        "scope_grant_required",
        "This hold needs an exact scope grant before the run can start."
      );
    }
    deps.store.insertRuling({
      caseId: review.id,
      projectId: project.id,
      decision,
      rationale: stringField(req.body?.rationale, "rationale"),
      allowance: decision === "allow_once" ? { patchHash: run?.patchHash ?? null } : null,
      patchHash: run?.patchHash ?? null,
      ruleKey: typeof review.payload.ruleKey === "string" ? review.payload.ruleKey : "protected-path",
      createdBy: user.id,
    });
    deps.store.updateCase(review.id, "resolved");
    if (decision === "allow_once" && review.kind === "governance" && run && pin && run.patchHash) {
      deps.store.insertAllowance({
        projectId: project.id,
        releaseId: pin.releaseId,
        ruleKey: typeof review.payload.ruleKey === "string" ? review.payload.ruleKey : "protected-path",
        kind: "once",
        patchHash: run.patchHash,
        paths: [],
        expiresAt: null,
      });
      await deps.engine.resume(run.id);
    }
    res.json({ ok: true });
  });

  app.post("/projects/:projectId/governance", (req, res) => {
    const { project } = access(deps, req, "view");
    assertOwner(deps, req.body?.ownerKey);
    const mode = req.body?.mode;
    if (mode !== "disabled" && mode !== "shadow" && mode !== "enforced") {
      throw new ForgeError(400, "invalid_mode", "Mode must be disabled, shadow, or enforced.");
    }
    changeGovernance(deps.store, project, mode as GovernanceMode);
    res.json({ mode });
  });

  app.post("/projects/:projectId/scope-grants", (req, res) => {
    const { project } = access(deps, req, "view");
    assertOwner(deps, req.body?.ownerKey);
    const workItemId = stringField(req.body?.workItemId, "workItemId");
    requireItem(deps, project.id, workItemId);
    const grant = deps.store.insertScopeGrant({
      projectId: project.id,
      workItemId,
      paths: stringArray(req.body?.paths),
    });
    res.status(201).json({ id: grant.id, paths: grant.paths });
  });

  app.get("/projects/:projectId/evolve", (req, res) => {
    const { project } = access(deps, req, "view");
    const releases = deps.store.releases(project.id);
    const nominations = deps.store.nominationsByProject(project.id);
    const proposals = deps.store.proposalsByProject(project.id);
    const evaluations = deps.store.evaluationsByProject(project.id);
    res.json({
      replayNote: REPLAY_NOTE,
      releases: releases.map((release) => ({
        id: release.id,
        title: `Release ${release.version}`,
        version: release.version,
        createdAt: release.createdAt,
        status: release.status,
        rules: deps.store.rulesForRelease(release.id),
      })),
      nominations: nominations.map((nomination) => {
        const current = releases
          .filter((release) => release.status === "active")
          .flatMap((release) => deps.store.rulesForRelease(release.id))
          .find((rule) => rule.ruleKey === nomination.ruleKey);
        const proposal = proposals.find((item) => item.nominationId === nomination.id);
        return {
          id: nomination.id,
          title: nomination.ruleKey,
          status: nomination.status,
          beforeText: current?.text ?? "",
          afterText: proposal?.text ?? "",
          supportingEvidence: nomination.supporting.map((item) => JSON.stringify(item)),
          contraryEvidence: nomination.contrary.map((item) => JSON.stringify(item)),
          supporting: nomination.supporting,
          contrary: nomination.contrary,
        };
      }),
      proposals: proposals.map((proposal) => ({
        ...proposal,
        beforeText: "",
        afterText: proposal.text,
        supportingEvidence: [],
        contraryEvidence: [],
        evaluationStatus: evaluations.find((item) => item.proposalId === proposal.id)?.status ?? "not evaluated",
      })),
      evaluations: evaluations.map((evaluation) => ({
        id: evaluation.id,
        proposalId: evaluation.proposalId,
        status: evaluation.status,
        summary: JSON.stringify(evaluation.report.missing ?? evaluation.status),
        report: evaluation.report,
      })),
    });
  });

  app.post("/projects/:projectId/evolve/mine", (req, res) => {
    access(deps, req, "steer");
    res.json(deps.evolve.mine(req.params.projectId));
  });

  app.post("/projects/:projectId/evolve/nominations/:nominationId/proposals", (req, res) => {
    access(deps, req, "steer");
    const proposal = deps.evolve.propose({
      projectId: req.params.projectId,
      nominationId: req.params.nominationId,
      text: stringField(req.body?.text, "text"),
      detector: stringField(req.body?.detector, "detector"),
      paths: stringArray(req.body?.paths),
      authorKind: req.body?.authorKind === "drafter" ? "drafter" : "person",
    });
    res.status(201).json({ id: proposal.id });
  });

  app.post("/projects/:projectId/evolve/proposals/:proposalId/evaluate", async (req, res) => {
    access(deps, req, "steer");
    const evaluation = await deps.evolve.evaluate(req.params.projectId, req.params.proposalId);
    res.json({ outcome: evaluation.status, status: evaluation.status, summary: evaluation.status });
  });

  app.post("/projects/:projectId/evolve/proposals/:proposalId/activate", (req, res) => {
    access(deps, req, "view");
    const release = deps.evolve.activate(req.params.projectId, req.params.proposalId, req.body?.ownerKey);
    res.json({ id: release.id, version: release.version });
  });

  app.post("/projects/:projectId/evolve/rollback", (req, res) => {
    const { project } = access(deps, req, "view");
    deps.evolve.rollback(project, stringField(req.body?.releaseId, "releaseId"), req.body?.ownerKey);
    res.json({ ok: true });
  });

  app.get("/projects/:projectId/events", (req, res) => {
    const { project } = access(deps, req, "view");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders?.();
    deps.notify.subscribe(project.id, res);
    req.on("close", () => deps.notify.unsubscribe(project.id, res));
  });

  if (deps.clientDir && fs.existsSync(deps.clientDir)) {
    app.use(express.static(deps.clientDir));
    app.get(/^(?!\/(session|teams|invites|projects|health|home)\b).*/, (req, res, next) => {
      if (req.method !== "GET") return next();
      res.sendFile(path.join(deps.clientDir as string, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isForgeError(error)) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    const message = error instanceof Error ? error.message : "Request failed.";
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: { code: "invalid_json", message } });
      return;
    }
    console.error(message);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong." } });
  });

  return app;
}

function routeId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function publishMembership(deps: HttpDeps, teamId: string): void {
  for (const project of deps.store.projectsByTeamIds([teamId])) {
    deps.notify.publish(project.id, "membership.updated");
  }
}

function projectJson(
  deps: HttpDeps,
  project: {
    id: string;
    teamId: string;
    name: string;
    remoteUrl: string;
    baseBranch: string;
    governanceMode: string;
    runbookLocked: boolean;
    activeRunbookDigest: string | null;
    credentialId: string | null;
    runtime: { argv: string[]; timeoutSec: number };
  }
) {
  const credentialKind = credentialKindOf(deps, project.credentialId);
  return {
    id: project.id,
    teamId: project.teamId,
    name: project.name,
    remoteUrl: project.remoteUrl,
    baseBranch: project.baseBranch,
    governanceMode: project.governanceMode,
    runbookLocked: project.runbookLocked,
    activeRunbookDigest: project.activeRunbookDigest,
    credentialKind,
    hasCredential: credentialKind === "https_token",
    agentRuntime: project.runtime,
  };
}

function credentialKindOf(deps: HttpDeps, credentialId: string | null): "none" | "https_token" {
  if (!credentialId) return "none";
  return deps.store.credentialById(credentialId)?.kind === "https_token" ? "https_token" : "none";
}

const SHELL_SYNTAX = /[|&;<>`\n\r]|\$\(/;

function verificationArgv(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "" || SHELL_SYNTAX.test(value)) {
    throw new ForgeError(
      400,
      "invalid_command",
      "Enter the program and arguments separated by spaces, without shell syntax."
    );
  }
  const argv = value.trim().split(/ +/);
  if (argv.length === 0 || argv.some((part) => part.length === 0)) {
    throw new ForgeError(
      400,
      "invalid_command",
      "Enter the program and arguments separated by spaces, without shell syntax."
    );
  }
  return argv;
}

function verificationDocument(argv: string[]) {
  const program = path.posix.basename(argv[0]?.replaceAll("\\", "/") ?? "");
  return {
    version: 1 as const,
    install: null,
    health: null,
    ship: null,
    gates: [
      {
        id: "verify",
        required: true,
        argv,
        cwd: ".",
        timeoutSec: 60,
      },
    ],
    runtimeTools: [program],
    dependencyPaths: [] as string[],
    blockedPaths: [".env"],
  };
}

function finishDiscoveryQuestions(deps: HttpDeps, projectId: string): void {
  const runs = deps.store
    .runsByProject(projectId)
    .filter((run) => run.role === "discovery" && run.state === "needs_human");
  if (runs.length === 0) return;
  const runIds = new Set(runs.map((run) => run.id));
  for (const run of runs) {
    deps.store.updateRun(run.id, { state: "done", slotReleased: true });
  }
  for (const review of deps.store.casesByProject(projectId)) {
    if (review.runId && runIds.has(review.runId) && review.kind === "question" && review.status === "open") {
      deps.store.updateCase(review.id, "resolved");
    }
  }
  deps.notify.publish(projectId, "run.updated");
}

function caseSummary(kind: string, payload: Record<string, unknown>): string {
  if (kind === "question") {
    const questions = questionProse(payload.questions);
    if (questions.length > 0) return questions.join(" ");
  }
  return JSON.stringify(payload);
}

function questionProse(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function workItemJson(item: {
  id: string;
  title: string;
  body: string;
  status: string;
  ownerUserId: string | null;
  blockedReason: string | null;
  shipCommit: string | null;
  parentId: string | null;
  scopePaths: string[];
}) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    status: item.status,
    ownerUserId: item.ownerUserId,
    blockedReason: item.blockedReason,
    shipCommit: item.shipCommit,
    parentId: item.parentId,
    scopePaths: item.scopePaths,
  };
}

function access(deps: HttpDeps, req: Request, role: Role) {
  const user = requireUser(deps, req);
  const project = deps.store.projectById(routeId(req.params.projectId));
  if (!project) throw new ForgeError(404, "not_found", "Project not found.");
  const membership = deps.store.membership(project.teamId, user.id);
  if (!membership || !hasRole(membership.role, role)) {
    throw new ForgeError(404, "not_found", "Project not found.");
  }
  assertRole(membership.role, role);
  return { user, project, membership };
}

function requireTeam(deps: HttpDeps, teamId: string, userId: string, role: Role) {
  const membership = deps.store.membership(teamId, userId);
  if (!membership) throw new ForgeError(404, "not_found", "Team not found.");
  assertRole(membership.role, role);
  return membership;
}

function requireUser(deps: HttpDeps, req: Request): UserRecord {
  const token = readCookie(req.header("cookie"), "forge_session");
  const userId = token ? readSession(token, deps.sessionSecret) : null;
  const user = userId ? deps.store.userById(userId) : null;
  if (!user) throw new ForgeError(401, "unauthenticated", "Sign in to continue.");
  return user;
}

function requireItem(deps: HttpDeps, projectId: string, workItemId: string) {
  const item = deps.store.workItem(workItemId);
  if (!item || item.projectId !== projectId) throw new ForgeError(404, "not_found", "Work item not found.");
  return item;
}

function requireOpenRun(deps: HttpDeps, projectId: string, workItemId: string) {
  const run = deps.store.openRunForItem(workItemId);
  if (!run || run.projectId !== projectId) throw new ForgeError(404, "not_found", "Run not found.");
  return run;
}

function latestDoneRun(deps: HttpDeps, workItemId: string) {
  return deps.store.runsByProject(deps.store.workItem(workItemId)?.projectId ?? "").find((run) => run.workItemId === workItemId) ?? null;
}

function assertRevision(actual: number, presented: unknown): void {
  if (presented !== actual) throw new ForgeError(409, "stale_revision", "Control moved. Refresh and try again.");
}

function assertOwner(deps: HttpDeps, presented: unknown): void {
  if (!ownerMatches(typeof presented === "string" ? presented : undefined, deps.ownerKey)) {
    throw new ForgeError(403, "owner_required", "The owner capability is required for this action.");
  }
}

function sendUser(res: Response, secret: string, user: UserRecord): void {
  res.setHeader(
    "Set-Cookie",
    `forge_session=${encodeURIComponent(signSession(user.id, secret))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
  );
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function cleanEmail(value: unknown): string {
  const email = stringField(value, "email").toLowerCase();
  if (!email.includes("@")) throw new ForgeError(400, "invalid_email", "Enter an email address.");
  return email;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ForgeError(400, "invalid_input", `${name} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ForgeError(400, "invalid_input", "Expected a list of strings.");
  }
  return value;
}

function parseCredential(value: unknown, remoteUrl: string): CredentialSecret {
  if (!value || typeof value !== "object") throw new ForgeError(400, "invalid_credential", "Credential is required.");
  const record = value as Record<string, unknown>;
  if (record.type === "none") {
    if (!isLocalRemote(remoteUrl)) {
      throw new ForgeError(400, "invalid_credential", "An https remote needs a token credential.");
    }
    return { type: "none" };
  }
  if (record.type === "https_token") {
    const username = stringField(record.username, "username");
    const token = stringField(record.token, "token");
    const env =
      record.env && typeof record.env === "object" && !Array.isArray(record.env)
        ? Object.fromEntries(
            Object.entries(record.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : undefined;
    return { type: "https_token", username, token, env };
  }
  throw new ForgeError(400, "invalid_credential", "Credential type must be none or https_token.");
}
