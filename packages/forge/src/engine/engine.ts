import fs from "node:fs";
import path from "node:path";
import {
  WALL_CLOCK_MS,
  type CredentialSecret,
  type EvidenceItem,
  type ProjectRecord,
  type ResultFile,
  type RunbookDocument,
  type RunRecord,
  type WorkItemRecord,
} from "../domain.js";
import { ForgeError } from "../errors.js";
import { seedRelease } from "../gate/gate.js";
import { missingScopeGrant, GateService } from "../gate/gate.js";
import { isBlockedPath } from "../integrate/blocked.js";
import { pidAlive, writeDurable } from "../lock.js";
import { NotifyHub } from "../notify/hub.js";
import { buildPrompt } from "../run/prompt.js";
import {
  classifyVerifyEvidence,
  decidePatrol,
  decideVerifyFailure,
  failureSignature,
  heartbeatFresh,
  rebindArgv,
} from "../run/run-policy.js";
import { parseResult } from "../run/result.js";
import { agentEnv, type ProcessSpawner, type RunningProcess } from "../run/spawn.js";
import {
  digestDocument,
  executionContractHash,
  gradeCommands,
  probeCommands,
  validateRunbook,
  type LabeledCommand,
} from "../runbook/runbook.js";
import { sha256 } from "../runbook/runbook.js";
import type { ForgeStore } from "../store/store.js";
import { redactText } from "../redact.js";
import { resolveTool, runArgv } from "../verify/exec.js";
import type { GitWorkspace } from "../workspace/git.js";

export interface DiscoverOutcome {
  outcome: "active" | "rejected" | "needs_human" | "stored";
  digest: string | null;
  questions: string[];
  summary?: string;
}

export class Engine {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly owned = new Map<string, RunningProcess>();
  private readonly discoveryWaiters = new Map<string, (outcome: DiscoverOutcome) => void>();
  private readonly plannerWaiters = new Map<string, (outcome: DiscoverOutcome) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private abandoned = false;
  private closed = false;

  constructor(
    private readonly deps: {
      store: ForgeStore;
      workspace: GitWorkspace;
      gate: GateService;
      notify: NotifyHub;
      spawn: ProcessSpawner;
      dataDir: string;
      readCredential: (project: ProjectRecord) => CredentialSecret;
    }
  ) {}

  startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
    this.timer.unref?.();
  }

  stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(): Promise<void> {
    return this.enqueue(() => this.runTick());
  }

  whenIdle(): Promise<void> {
    return this.waitUntilQuiet();
  }

  discover(projectId: string): Promise<DiscoverOutcome> {
    return this.detachRole((settle) => this.launchDiscovery(projectId, settle));
  }

  propose(projectId: string, document: unknown): Promise<DiscoverOutcome> {
    return this.enqueue(async () => {
      const project = this.mustProject(projectId);
      return this.activateProposal(project, validateRunbook(document));
    });
  }

  plan(projectId: string, instruction: string): Promise<DiscoverOutcome> {
    return this.detachRole((settle) => this.launchPlanner(projectId, instruction, settle));
  }

  answer(runId: string, text: string): Promise<void> {
    return this.enqueue(() => this.resumeFromAnswer(runId, text));
  }

  resume(runId: string): Promise<void> {
    return this.enqueue(async () => {
      const run = this.deps.store.runById(runId);
      if (!run || run.state !== "held") return;
      if (run.policyRule === "blocked_path" || run.policyRule === "merge_conflict" || run.policyRule === "same_failure") {
        return;
      }
      this.deps.store.updateRun(run.id, { state: "gating", gateEvaluated: false });
      if (run.workItemId) {
        this.deps.store.updateWorkItem(run.workItemId, { status: "running", blockedReason: null });
      }
      await this.gateAndShip(this.deps.store.runById(run.id) ?? run);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abandoned = true;
    this.stopTimer();
    for (const proc of this.owned.values()) proc.kill();
    this.owned.clear();
    try {
      this.deps.store.close();
    } catch {
      // The database may already be closed.
    }
  }

  abandon(): void {
    if (this.closed) return;
    this.closed = true;
    this.abandoned = true;
    this.stopTimer();
    for (const proc of this.owned.values()) proc.detach();
    this.owned.clear();
    try {
      this.deps.store.close();
    } catch {
      // The database may already be closed.
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async waitUntilQuiet(): Promise<void> {
    for (let guard = 0; guard < 40; guard += 1) {
      const inflight = [...this.owned.values()];
      await this.tail;
      if (inflight.length === 0 && this.owned.size === 0) return;
      await Promise.all(inflight.map((proc) => proc.exited.catch(() => null)));
      await this.tail;
      if (this.owned.size === 0) return;
    }
  }

  private async runTick(): Promise<void> {
    if (this.abandoned) return;
    await this.patrol();
    await this.admit();
  }

  private async patrol(): Promise<void> {
    for (const listed of this.deps.store.activeRuns()) {
      const run = this.deps.store.runById(listed.id);
      if (!run) continue;
      const item = run.workItemId ? this.deps.store.workItem(run.workItemId) : null;
      const action = decidePatrol({
        humanOwned: Boolean(item?.ownerUserId),
        heartbeatFresh: heartbeatFresh(run.heartbeatAt, Date.now()),
        pidAlive: run.pid != null && pidAlive(run.pid),
        ownsProcess: this.owned.has(run.id),
        resultPresent: this.resultExists(run),
        retryCount: run.retryCount,
        state: run.state,
      });
      if (action.type === "leave") {
        if (this.owned.has(run.id)) {
          this.deps.store.updateRun(run.id, { heartbeatAt: new Date().toISOString() });
        }
        continue;
      }
      if (action.type === "complete_from_result") await this.completeFromResult(run);
      else if (action.type === "retry_once") await this.retrySpawn(run);
      else if (action.type === "resume_verify") await this.verify(run);
      else if (action.type === "resume_gate") await this.gateAndShip(run);
      else if (action.type === "resume_integrate") await this.integrate(run);
      else await this.hold(run, action.reason, action.reason);
    }
  }

  private async admit(): Promise<void> {
    for (const project of this.deps.store.allProjects()) {
      const current = this.deps.store.projectById(project.id);
      if (!current) continue;
      const items = this.deps.store.workItemsByProject(current.id);
      const dependencies = this.deps.store.dependenciesByProject(current.id);
      for (const item of items) {
        if (item.ownerUserId) continue;
        const scopeHeld = item.status === "held" && (item.blockedReason ?? "").startsWith("scope_grant:");
        if (
          !scopeHeld &&
          (item.status === "held" || item.status === "done" || item.status === "needs_human" || item.status === "running")
        ) {
          continue;
        }
        const blocked = dependencies
          .filter((edge) => edge.workItemId === item.id)
          .some((edge) => items.find((candidate) => candidate.id === edge.dependsOnId)?.status !== "done");
        if (blocked) {
          if (item.status !== "queued") this.deps.store.updateWorkItem(item.id, { status: "queued" });
          continue;
        }
        if (item.status === "queued") this.deps.store.updateWorkItem(item.id, { status: "ready" });
        if (!current.activeRunbookDigest) continue;
        if (this.deps.store.openRunForItem(item.id)) continue;
        await this.startWorker(current, { ...item, status: "ready" });
      }
    }
  }

  private async startWorker(project: ProjectRecord, item: WorkItemRecord): Promise<void> {
    const current = this.mustProject(project.id);
    const grant = this.deps.store.grantsForItem(item.id)[0];
    const missing = missingScopeGrant(item.scopePaths, grant?.paths ?? null, current.governanceMode);
    if (missing) {
      if (!(item.blockedReason ?? "").startsWith("scope_grant:")) {
        this.deps.store.updateWorkItem(item.id, {
          status: "held",
          blockedReason: `scope_grant: ${missing.join(", ")}`,
        });
        this.deps.store.insertCase({
          projectId: current.id,
          findingId: null,
          workItemId: item.id,
          runId: null,
          kind: "governance",
          status: "open",
          payload: { missingScope: missing },
        });
        this.deps.notify.publish(current.id, "work_item.updated");
      }
      return;
    }
    const revision = this.deps.store.revisionByDigest(current.id, current.activeRunbookDigest ?? "");
    if (!revision) return;
    const checkout = await this.deps.workspace.ensureCheckout(current, this.credential(current));
    const baseRevision = await this.deps.workspace.revParse(checkout, current.baseBranch);
    const frame = this.deps.store.latestFrame(current.id);
    const run = this.deps.store.insertRun({
      projectId: current.id,
      workItemId: item.id,
      role: "worker",
      state: "assigned",
      runbookDigest: revision.digest,
      executionContractHash: executionContractHash(revision.digest, revision.document, current.runtime.argv),
      baseRevision,
      frameVersion: frame?.version ?? null,
      runtimeArgv: current.runtime.argv,
    });
    if (current.governanceMode !== "disabled") {
      seedRelease(this.deps.store, current.id);
      const release = this.deps.store.activeRelease(current.id);
      if (release) {
        const rules = this.deps.store.rulesForRelease(release.id);
        const pin = this.deps.store.insertPin({
          runId: run.id,
          releaseId: release.id,
          instructionSnapshot: rules.map((rule) => `${rule.ruleKey}@${rule.revision}\n${rule.text}`).join("\n\n"),
          originalScope: JSON.stringify(item.scopePaths),
          baseRevision,
        });
        this.deps.store.updateRun(run.id, { policyPinId: pin.id });
      }
    }
    const worktree = await this.deps.workspace.ensureWorktree(current, item.id, baseRevision, this.credential(current));
    this.deps.store.updateRun(run.id, { worktreePath: worktree });
    this.deps.store.updateWorkItem(item.id, { status: "running", blockedReason: null, frameVersion: frame?.version ?? null });
    this.deps.notify.publish(current.id, "work_item.updated");
    await this.spawnChild(this.deps.store.runById(run.id) ?? run, worktree);
  }

  private detachRole(
    launch: (settle: (outcome: DiscoverOutcome) => void) => Promise<void>
  ): Promise<DiscoverOutcome> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (outcome: DiscoverOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      void this.enqueue(() => launch(settle)).catch((error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  private async launchDiscovery(
    projectId: string,
    settle: (outcome: DiscoverOutcome) => void
  ): Promise<void> {
    const project = this.mustProject(projectId);
    const running = this.deps.store
      .runsByProject(project.id)
      .some((run) => run.role === "discovery" && (run.state === "assigned" || run.state === "running"));
    if (running) throw new ForgeError(409, "discovery_running", "Discovery is already running.");
    const mirror = await this.deps.workspace.prepareMirror(project, this.credential(project));
    const frame = this.deps.store.latestFrame(project.id);
    const run = this.deps.store.insertRun({
      projectId: project.id,
      workItemId: null,
      role: "discovery",
      state: "assigned",
      frameVersion: frame?.version ?? null,
      runtimeArgv: project.runtime.argv,
    });
    this.deps.store.updateRun(run.id, { worktreePath: mirror });
    this.discoveryWaiters.set(run.id, settle);
    await this.spawnChild(this.deps.store.runById(run.id) ?? run, mirror);
  }

  private async launchPlanner(
    projectId: string,
    instruction: string,
    settle: (outcome: DiscoverOutcome) => void
  ): Promise<void> {
    const project = this.mustProject(projectId);
    const mirror = await this.deps.workspace.prepareMirror(project, this.credential(project));
    const frame = this.deps.store.latestFrame(project.id);
    const run = this.deps.store.insertRun({
      projectId: project.id,
      workItemId: null,
      role: "planner",
      state: "assigned",
      frameVersion: frame?.version ?? null,
      runtimeArgv: project.runtime.argv,
    });
    this.deps.store.updateRun(run.id, { worktreePath: mirror, failureNote: instruction });
    this.plannerWaiters.set(run.id, settle);
    await this.spawnChild(this.deps.store.runById(run.id) ?? run, mirror, { instruction });
  }

  private async spawnChild(
    run: RunRecord,
    cwd: string,
    options: { instruction?: string } = {}
  ): Promise<void> {
    if (!this.withinBudget(run)) {
      await this.hold(run, "wall_clock", "The run exceeded its 60 minute budget.");
      this.settle(run, {
        outcome: "needs_human",
        digest: null,
        questions: ["The run exceeded its 60 minute budget."],
      });
      return;
    }
    const assignmentPath = this.writeAssignment(run, options.instruction);
    const resultPath = path.join(path.dirname(assignmentPath), "result.json");
    fs.rmSync(resultPath, { force: true });
    this.deps.store.updateRun(run.id, {
      assignmentPath,
      heartbeatAt: new Date().toISOString(),
      state: "assigned",
    });
    const project = this.mustProject(run.projectId);
    const argv = run.runtimeArgv.length > 0 ? run.runtimeArgv : project.runtime.argv;
    const env = agentEnv(this.secrets(project), {
      OPENSPRINT_ROLE: run.role,
      OPENSPRINT_RESULT_PATH: resultPath,
      OPENSPRINT_ASSIGNMENT_PATH: assignmentPath,
      OPENSPRINT_RUN_ID: run.id,
    });
    delete env.GIT_ASKPASS;
    delete env.FORGE_ASKPASS_FILE;
    let started: RunningProcess;
    try {
      started = this.deps.spawn({
        argv,
        cwd,
        timeoutSec: project.runtime.timeoutSec,
        env,
      });
    } catch (error) {
      await this.needsHuman(run, "The runtime could not be started.", [
        error instanceof Error ? error.message : "Sandbox refusal.",
      ]);
      this.settle(run, {
        outcome: "needs_human",
        digest: null,
        questions: ["The runtime could not be started."],
      });
      return;
    }
    this.owned.set(run.id, started);
    this.deps.store.updateRun(run.id, {
      pid: started.pid ?? null,
      state: "running",
      heartbeatAt: new Date().toISOString(),
    });
    this.deps.notify.publish(run.projectId, "run.updated");
    void started.exited.then((code) => {
      void this.enqueue(() => this.onExit(run.id, code, started.output(), started.failedToStart()));
    });
  }

  private async onExit(
    runId: string,
    code: number | null,
    output: string,
    failedToStart = false
  ): Promise<void> {
    if (this.abandoned) return;
    this.owned.delete(runId);
    const run = this.deps.store.runById(runId);
    if (!run || run.state === "done" || run.state === "held") return;
    try {
      if (run.role === "discovery") {
        await this.finishDiscovery(run);
        return;
      }
      if (run.role === "planner") {
        await this.finishPlanner(run);
        return;
      }
      if (failedToStart && !this.resultExists(run)) {
        await this.needsHuman(run, "The runtime refused to start.", ["Sandbox refusal."]);
        return;
      }
      if (this.resultExists(run)) {
        await this.completeFromResult(run);
        return;
      }
      if (run.retryCount === 0) {
        await this.retrySpawn(run);
        return;
      }
      await this.hold(run, "result_missing", output || "The worker exited without a result file.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Run failed.";
      const current = this.deps.store.runById(run.id);
      if (current && current.state !== "done" && current.state !== "held") {
        await this.hold(current, "internal_fault", message);
      }
      this.settle(run, { outcome: "needs_human", digest: null, questions: [message] });
    }
  }

  private async retrySpawn(run: RunRecord): Promise<void> {
    this.deps.store.updateRun(run.id, {
      retryCount: run.retryCount + 1,
      attempt: run.attempt + 1,
      controllerUserId: null,
      controlRevision: 0,
    });
    const next = this.deps.store.runById(run.id);
    if (!next) return;
    const cwd = await this.cwdFor(next);
    await this.spawnChild(next, cwd);
  }

  private async completeFromResult(run: RunRecord): Promise<void> {
    const raw = fs.readFileSync(this.resultPath(run), "utf8");
    const result = this.redactResult(parseResult(raw), run.projectId);
    this.deps.store.updateRun(run.id, {
      resultStatus: result.status,
      resultSummary: result.summary,
      evidence: result.evidence,
      questions: result.questions,
    });
    if (run.role === "discovery") {
      await this.finishDiscovery(run, result);
      return;
    }
    if (run.role === "planner") {
      await this.finishPlanner(run, result);
      return;
    }
    await this.finishWorker(run, result);
  }

  private async finishDiscovery(run: RunRecord, parsed?: ResultFile): Promise<void> {
    const result = parsed ?? this.readResult(run);
    const project = this.mustProject(run.projectId);
    let outcome: DiscoverOutcome;
    if (!result || result.status === "needs_human" || !result.runbookProposal) {
      outcome = {
        outcome: "needs_human",
        digest: project.activeRunbookDigest,
        questions: result?.questions.length ? result.questions : [result?.summary || "Discovery needs a person."],
        summary: result?.summary,
      };
      await this.needsHuman(run, outcome.summary || "Discovery needs a person.", outcome.questions);
    } else {
      outcome = await this.activateProposal(project, result.runbookProposal);
      this.deps.store.updateRun(run.id, { state: "done", resultStatus: result.status, resultSummary: result.summary });
    }
    this.discoveryWaiters.get(run.id)?.(outcome);
    this.discoveryWaiters.delete(run.id);
  }

  private async finishPlanner(run: RunRecord, parsed?: ResultFile): Promise<void> {
    const result = parsed ?? this.readResult(run);
    let outcome: DiscoverOutcome;
    if (!result || result.status !== "succeeded" || !result.workItems?.length) {
      outcome = {
        outcome: "needs_human",
        digest: null,
        questions: result?.questions.length ? result.questions : [result?.summary || "The planner needs a person."],
        summary: result?.summary,
      };
      this.deps.store.updateRun(run.id, { state: "needs_human", resultSummary: outcome.summary ?? null });
    } else {
      this.createPlannedItems(run.projectId, result.workItems);
      outcome = { outcome: "active", digest: null, questions: [], summary: result.summary };
      this.deps.store.updateRun(run.id, { state: "done", resultStatus: "succeeded", resultSummary: result.summary });
      this.deps.notify.publish(run.projectId, "work_item.updated");
    }
    this.plannerWaiters.get(run.id)?.(outcome);
    this.plannerWaiters.delete(run.id);
  }

  private createPlannedItems(projectId: string, items: NonNullable<ResultFile["workItems"]>): void {
    const ids = new Map<string, string>();
    for (const item of items) {
      const created = this.deps.store.insertWorkItem({
        projectId,
        title: item.title,
        body: item.body,
        status: "queued",
      });
      ids.set(item.title, created.id);
    }
    for (const item of items) {
      const id = ids.get(item.title);
      if (!id) continue;
      for (const title of item.dependsOn) {
        const dependsOnId = ids.get(title);
        if (dependsOnId) {
          this.deps.store.insertDependency({ projectId, workItemId: id, dependsOnId });
        }
      }
    }
  }

  private async finishWorker(run: RunRecord, result: ResultFile): Promise<void> {
    if (result.status === "needs_human") {
      await this.needsHuman(run, result.summary || "The worker needs a person.", result.questions);
      return;
    }
    if (result.status !== "succeeded") {
      await this.retryOrHold(run, result.evidence.length ? result.evidence : [{
        command: "worker",
        exitCode: 1,
        excerpt: result.summary,
      }], "code");
      return;
    }
    await this.verify(run);
  }

  private async verify(run: RunRecord): Promise<void> {
    const current = this.deps.store.runById(run.id) ?? run;
    const project = this.mustProject(current.projectId);
    const revision = current.runbookDigest
      ? this.deps.store.revisionByDigest(project.id, current.runbookDigest)
      : null;
    if (!revision) {
      await this.hold(current, "missing_runbook", "The pinned runbook is not available.");
      return;
    }
    const expected = executionContractHash(revision.digest, revision.document, current.runtimeArgv);
    if (current.executionContractHash && current.executionContractHash !== expected) {
      await this.hold(current, "contract_mismatch", "The pinned execution contract does not match the runbook.");
      return;
    }
    this.deps.store.updateRun(current.id, { state: "verifying" });
    const cwd = await this.cwdFor(current);
    const evidence: EvidenceItem[] = [];
    for (const command of gradeCommands(revision.document)) {
      const argv = rebindArgv(command.argv, current.toolBindings);
      const result = await this.exec(project, cwd, { ...command, argv });
      evidence.push(result);
      if (result.exitCode !== 0) {
        this.deps.store.updateRun(current.id, { evidence });
        await this.retryOrHold(this.deps.store.runById(current.id) ?? current, evidence);
        return;
      }
    }
    this.deps.store.updateRun(current.id, { evidence, state: "gating" });
    await this.gateAndShip(this.deps.store.runById(current.id) ?? current);
  }

  private async retryOrHold(run: RunRecord, evidence: EvidenceItem[], forced?: "code"): Promise<void> {
    const project = this.mustProject(run.projectId);
    const revision = run.runbookDigest ? this.deps.store.revisionByDigest(project.id, run.runbookDigest) : null;
    const kind = forced ?? classifyVerifyEvidence(evidence);
    const signature = failureSignature(evidence);
    const decision = decideVerifyFailure({
      kind,
      verifyHealCount: run.verifyHealCount,
      codeRetryCount: run.codeRetryCount,
      hasInstall: Boolean(revision?.document.install),
      hasTools: (revision?.document.runtimeTools.length ?? 0) > 0,
    });
    if (decision === "heal_install" && revision?.document.install) {
      this.deps.store.updateRun(run.id, { verifyHealCount: run.verifyHealCount + 1, failureSignature: signature });
      const cwd = await this.cwdFor(run);
      await this.exec(project, cwd, { label: "install", ...revision.document.install });
      await this.verify(this.deps.store.runById(run.id) ?? run);
      return;
    }
    if (decision === "rebind" && revision) {
      const bindings = { ...run.toolBindings };
      for (const tool of revision.document.runtimeTools) {
        const resolved = resolveTool(tool);
        if (resolved) bindings[tool] = resolved;
      }
      this.deps.store.updateRun(run.id, {
        verifyHealCount: run.verifyHealCount + 1,
        toolBindings: bindings,
        failureSignature: signature,
      });
      await this.verify(this.deps.store.runById(run.id) ?? run);
      return;
    }
    if (decision === "retry_worker" && run.workItemId) {
      const excerpt = evidence.map((item) => item.excerpt).join("\n").slice(0, 1500);
      this.deps.store.updateRun(run.id, {
        codeRetryCount: run.codeRetryCount + 1,
        attempt: run.attempt + 1,
        failureNote: excerpt,
        failureSignature: signature,
        controllerUserId: null,
        controlRevision: 0,
        state: "assigned",
      });
      const next = this.deps.store.runById(run.id);
      if (!next) return;
      await this.spawnChild(next, await this.cwdFor(next));
      return;
    }
    this.deps.store.insertCase({
      projectId: project.id,
      findingId: null,
      workItemId: run.workItemId,
      runId: run.id,
      kind: "failing_gate",
      status: "open",
      payload: { evidence, signature },
    });
    await this.hold(run, "same_failure", evidence.map((item) => item.excerpt).join("\n") || signature);
  }

  private async gateAndShip(run: RunRecord): Promise<void> {
    const current = this.deps.store.runById(run.id) ?? run;
    const project = this.mustProject(current.projectId);
    const revision = current.runbookDigest
      ? this.deps.store.revisionByDigest(project.id, current.runbookDigest)
      : null;
    if (!revision || !current.workItemId) {
      await this.hold(current, "missing_runbook", "The pinned runbook is not available.");
      return;
    }
    if (current.gateEvaluated) {
      const open = this.deps.store.openCasesForRun(current.id);
      if (open.some((item) => item.kind === "governance" || item.kind === "failing_gate")) {
        await this.hold(current, "governance", "An open case is still on the docket.");
        return;
      }
      await this.integrate(current);
      return;
    }
    const cwd = current.worktreePath ?? (await this.cwdFor(current));
    const files = await this.deps.workspace.changedFiles(cwd, project.baseBranch);
    const blocked = files.filter((file) => isBlockedPath(file, revision.document.blockedPaths));
    const patchHash = sha256(await this.deps.workspace.diffText(cwd, project.baseBranch));
    this.deps.store.updateRun(current.id, { patchHash, state: "gating" });
    const decision = this.deps.gate.evaluate({
      project,
      run: this.deps.store.runById(current.id) ?? current,
      files,
      patchHash,
    });
    if (blocked.length > 0) {
      await this.hold(current, "blocked_path", `Blocked paths: ${blocked.join(", ")}`);
      return;
    }
    if (decision.disposition === "held") {
      await this.hold(current, decision.reason ?? "governance", "Gate is holding this work.");
      return;
    }
    this.deps.store.updateRun(current.id, { gateEvaluated: true });
    await this.integrate(this.deps.store.runById(current.id) ?? current);
  }

  private async integrate(run: RunRecord): Promise<void> {
    const current = this.deps.store.runById(run.id) ?? run;
    const project = this.mustProject(current.projectId);
    const item = current.workItemId ? this.deps.store.workItem(current.workItemId) : null;
    if (!item || !current.worktreePath) {
      await this.hold(current, "integrate_interrupted", "The worktree is missing.");
      return;
    }
    this.deps.store.updateRun(current.id, { state: "integrating" });
    const revision = current.runbookDigest
      ? this.deps.store.revisionByDigest(project.id, current.runbookDigest)
      : null;
    const files = await this.deps.workspace.changedFiles(current.worktreePath, project.baseBranch);
    const blocked = files.filter((file) => isBlockedPath(file, revision?.document.blockedPaths ?? []));
    if (blocked.length > 0) {
      await this.hold(current, "blocked_path", `Blocked paths: ${blocked.join(", ")}`);
      return;
    }
    try {
      await this.deps.workspace.commitLeftovers(current.worktreePath, `Realize ${item.id}`);
      const checkout = await this.deps.workspace.ensureCheckout(project, this.credential(project));
      const shipped = await this.deps.workspace.ship({
        checkout,
        baseBranch: project.baseBranch,
        taskBranch: `forge/${item.id}`,
        message: `Ship ${item.id} ${item.title}`.slice(0, 120),
        credential: this.credential(project),
        remoteUrl: project.remoteUrl,
      });
      if (!shipped.ok) {
        await this.hold(current, shipped.reason === "conflict" ? "merge_conflict" : shipped.reason, shipped.detail);
        return;
      }
      this.deps.store.updateWorkItem(item.id, { status: "done", shipCommit: shipped.commit, blockedReason: null });
      this.deps.store.updateRun(current.id, { state: "done", slotReleased: true });
      this.deps.store.insertRunEvent(current.id, "shipped", { commit: shipped.commit });
      this.deps.notify.publish(project.id, "work_item.updated");
      this.deps.notify.publish(project.id, "run.updated");
    } catch (error) {
      await this.hold(current, "integrate_interrupted", error instanceof Error ? error.message : "Integrate failed.");
    }
  }

  private async activateProposal(project: ProjectRecord, document: RunbookDocument): Promise<DiscoverOutcome> {
    const probed = await this.probe(project, document);
    const digest = digestDocument(document);
    if (!probed.ok) {
      this.deps.store.insertRevision({
        projectId: project.id,
        digest,
        document,
        status: "rejected",
        probe: probed.evidence,
      });
      this.fileBlocker(project, digest, probed.evidence);
      this.deps.notify.publish(project.id, "runbook.updated");
      return { outcome: "rejected", digest: project.activeRunbookDigest, questions: [], summary: "Probe failed." };
    }
    if (project.runbookLocked) {
      this.deps.store.insertRevision({
        projectId: project.id,
        digest,
        document,
        status: "proposed",
        probe: probed.evidence,
      });
      this.deps.notify.publish(project.id, "runbook.updated");
      return { outcome: "stored", digest: project.activeRunbookDigest, questions: [], summary: "Lock kept the active digest." };
    }
    this.deps.store.archiveActive(project.id);
    this.deps.store.insertRevision({
      projectId: project.id,
      digest,
      document,
      status: "active",
      probe: probed.evidence,
    });
    this.deps.store.updateProject(project.id, { activeRunbookDigest: digest });
    this.deps.notify.publish(project.id, "runbook.updated");
    return { outcome: "active", digest, questions: [] };
  }

  private async probe(
    project: ProjectRecord,
    document: RunbookDocument
  ): Promise<{ ok: boolean; evidence: EvidenceItem[] }> {
    const checkout = await this.deps.workspace.ensureCheckout(project, this.credential(project));
    const sha = await this.deps.workspace.revParse(checkout, project.baseBranch);
    const created = await this.deps.workspace.addProbe(checkout, sha);
    const evidence: EvidenceItem[] = [];
    try {
      for (const command of probeCommands(document)) {
        const result = await this.exec(project, created.dir, command);
        evidence.push({ command: result.command, exitCode: result.exitCode, excerpt: result.excerpt });
        if (result.exitCode !== 0) return { ok: false, evidence };
      }
      return { ok: true, evidence };
    } finally {
      await created.cleanup();
    }
  }

  private fileBlocker(project: ProjectRecord, digest: string, evidence: EvidenceItem[]): void {
    const reason = `runbook_probe:${digest}`;
    const existing = this.deps.store.workItemsByProject(project.id).find((item) => item.blockedReason === reason);
    if (existing) return;
    this.deps.store.insertWorkItem({
      projectId: project.id,
      title: "Runbook probe failed",
      body: evidence.map((item) => `${item.command} exited ${item.exitCode}\n${item.excerpt}`).join("\n\n"),
      status: "held",
      blockedReason: reason,
    });
    this.deps.notify.publish(project.id, "work_item.updated");
  }

  private async resumeFromAnswer(runId: string, text: string): Promise<void> {
    const run = this.deps.store.runById(runId);
    if (!run || run.state !== "needs_human") {
      throw new ForgeError(409, "not_waiting", "That run is not waiting on a person.");
    }
    this.deps.store.updateRun(run.id, {
      answers: [...run.answers, text],
      attempt: run.attempt + 1,
      state: "assigned",
      controllerUserId: null,
      controlRevision: 0,
    });
    for (const item of this.deps.store.casesByProject(run.projectId)) {
      if (item.runId === run.id && item.kind === "question" && item.status === "open") {
        this.deps.store.updateCase(item.id, "resolved");
      }
    }
    if (run.workItemId) {
      this.deps.store.updateWorkItem(run.workItemId, { status: "running", blockedReason: null });
      this.deps.notify.publish(run.projectId, "work_item.updated");
    }
    const next = this.deps.store.runById(run.id);
    if (!next) return;
    await this.spawnChild(next, await this.cwdFor(next));
  }

  private async needsHuman(run: RunRecord, summary: string, questions: string[]): Promise<void> {
    this.deps.store.updateRun(run.id, {
      state: "needs_human",
      resultSummary: summary,
      questions,
      slotReleased: true,
    });
    if (run.workItemId) {
      this.deps.store.updateWorkItem(run.workItemId, { status: "needs_human", blockedReason: summary });
      this.deps.notify.publish(run.projectId, "work_item.updated");
    }
    this.deps.store.insertCase({
      projectId: run.projectId,
      findingId: null,
      workItemId: run.workItemId,
      runId: run.id,
      kind: "question",
      status: "open",
      payload: { questions },
    });
    this.deps.notify.publish(run.projectId, "run.updated");
  }

  private async hold(run: RunRecord, rule: string, reason: string): Promise<void> {
    const redacted = redactText(reason, this.secrets(this.mustProject(run.projectId))).slice(0, 500);
    this.deps.store.updateRun(run.id, {
      state: "held",
      policyRule: rule,
      slotReleased: true,
      resultSummary: redacted,
    });
    if (run.workItemId) {
      this.deps.store.updateWorkItem(run.workItemId, { status: "held", blockedReason: `${rule}: ${redacted}` });
      this.deps.notify.publish(run.projectId, "work_item.updated");
    }
    this.deps.store.insertRunEvent(run.id, "held", { rule, reason: redacted });
    this.deps.notify.publish(run.projectId, "run.updated");
  }

  private async exec(project: ProjectRecord, checkoutRoot: string, command: LabeledCommand) {
    const cwd = path.resolve(checkoutRoot, command.cwd || ".");
    const extra: Record<string, string> = {};
    if (command.label === "install") {
      const credential = this.credential(project);
      for (const name of command.env ?? []) {
        const value = credential.env?.[name];
        if (value) extra[name] = value;
      }
    }
    return runArgv({
      argv: command.argv,
      cwd,
      timeoutSec: command.timeoutSec,
      checkoutRoot,
      secrets: this.secrets(project),
      extraEnv: extra,
    });
  }

  private writeAssignment(run: RunRecord, instruction?: string): string {
    const item = run.workItemId ? this.deps.store.workItem(run.workItemId) : null;
    const frame =
      run.frameVersion != null
        ? this.deps.store.frameVersion(run.projectId, run.frameVersion)
        : this.deps.store.latestFrame(run.projectId);
    const prompt = buildPrompt({
      role: run.role,
      frame,
      item,
      guidance: run.guidance,
      answers: run.answers,
      failureNote: run.role === "planner" ? null : run.failureNote,
      instruction: instruction ?? (run.role === "planner" ? run.failureNote ?? undefined : undefined),
    });
    const assignment = {
      runId: run.id,
      workItemId: run.workItemId,
      projectId: run.projectId,
      attempt: run.attempt,
      role: run.role,
      runbookDigest: run.runbookDigest,
      baseRevision: run.baseRevision,
      frameVersion: frame?.version ?? null,
      executionContractHash: run.executionContractHash,
      guidance: run.guidance,
      answers: run.answers,
      prompt,
      workItem: item ? { title: item.title, body: item.body, scope: item.scopePaths } : null,
    };
    const file = path.join(this.deps.dataDir, "active", run.id, "assignment.json");
    writeDurable(file, JSON.stringify(assignment, null, 2));
    return file;
  }

  private async cwdFor(run: RunRecord): Promise<string> {
    if (run.worktreePath && fs.existsSync(run.worktreePath)) return run.worktreePath;
    const project = this.mustProject(run.projectId);
    if (run.role === "worker" && run.workItemId && run.baseRevision) {
      return this.deps.workspace.ensureWorktree(project, run.workItemId, run.baseRevision, this.credential(project));
    }
    return this.deps.workspace.prepareMirror(project, this.credential(project));
  }

  private resultPath(run: RunRecord): string {
    const assignment = run.assignmentPath ?? path.join(this.deps.dataDir, "active", run.id, "assignment.json");
    return path.join(path.dirname(assignment), "result.json");
  }

  private resultExists(run: RunRecord): boolean {
    return fs.existsSync(this.resultPath(run));
  }

  private readResult(run: RunRecord): ResultFile | null {
    if (!this.resultExists(run)) return null;
    return this.redactResult(parseResult(fs.readFileSync(this.resultPath(run), "utf8")), run.projectId);
  }

  private redactResult(result: ResultFile, projectId: string): ResultFile {
    const project = this.deps.store.projectById(projectId);
    const secrets = project ? this.secrets(project) : [];
    return {
      ...result,
      summary: redactText(result.summary, secrets),
      evidence: result.evidence.map((item) => ({ ...item, excerpt: redactText(item.excerpt, secrets) })),
      questions: result.questions.map((question) => redactText(question, secrets)),
    };
  }

  private credential(project: ProjectRecord): CredentialSecret {
    return this.deps.readCredential(project);
  }

  private secrets(project: ProjectRecord): string[] {
    const credential = this.credential(project);
    return [credential.token ?? "", ...Object.values(credential.env ?? {})].filter((value) => value.length > 0);
  }

  private withinBudget(run: RunRecord): boolean {
    return Date.now() - Date.parse(run.createdAt) < WALL_CLOCK_MS;
  }

  private settle(run: RunRecord, outcome: DiscoverOutcome): void {
    if (run.role === "discovery") {
      this.discoveryWaiters.get(run.id)?.(outcome);
      this.discoveryWaiters.delete(run.id);
    }
    if (run.role === "planner") {
      this.plannerWaiters.get(run.id)?.(outcome);
      this.plannerWaiters.delete(run.id);
    }
  }

  private mustProject(id: string): ProjectRecord {
    const project = this.deps.store.projectById(id);
    if (!project) throw new ForgeError(404, "not_found", "Project not found.");
    return project;
  }
}
