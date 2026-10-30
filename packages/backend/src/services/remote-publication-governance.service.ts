import { agentProcessEnvironment } from "../utils/agent-process-env.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { OPENSPRINT_PATHS, type GovernanceEvent, type GovernanceTaskPin } from "@opensprint/shared";
import { governanceService } from "./governance.service.js";
import {
  governanceExecutionService,
  governanceCodeSnapshot,
} from "./governance-execution.service.js";
import { governanceHash } from "./policy-context.js";
import { auditProtectedPaths } from "./protected-path-policy.js";
import {
  assertGovernanceSensitiveSourceApproval,
  resolveGovernanceSensitiveSourcePaths,
} from "./governance-source-hashes.js";
import { taskStore } from "./task-store.service.js";
import type { CreateOpts } from "./task-store.types.js";
import { worktreeLeaseService } from "./worktree-lease.service.js";
import { notificationService } from "./notification.service.js";

const run = promisify(execFile);
interface ReceiptOwner {
  taskId: string;
  branchName: string;
  scope: string;
  releaseId?: string;
  mode: "disabled" | "shadow" | "enforced";
  baseSha: string;
  headSha: string;
  diffHash: string;
  scopeBaseSha?: string;
  changedPaths: string[];
}
export interface RemotePublicationReceipt {
  id: string;
  sequence: number;
  taskId: string;
  branchName: string;
  baseBranch: string;
  baseSha: string;
  localHeadSha: string;
  files: Record<string, string | null>;
  owners: ReceiptOwner[];
  scopesByPath?: Record<string, string[]>;
  remoteExpected?: boolean;
}
export interface RemoteReviewRequest {
  taskId: string;
  receiptIds: string[];
  baseSha: string;
  candidateSha: string;
  baseBranch: string;
  branchName: string;
  worktreePath: string;
  reason: string;
}
export interface RemotePushBatch {
  receiptIds: string[];
  inputHeadSha: string;
  baseBranch: string;
}
interface Dependencies {
  governance: typeof governanceService;
  tasks: Pick<typeof taskStore, "create" | "update" | "show" | "runWrite">;
  authority: Pick<typeof governanceExecutionService, "assertPublicationAuthority">;
  lease: Pick<typeof worktreeLeaseService, "acquire">;
  notify: (projectId: string, taskId: string, text: string) => Promise<unknown>;
}
const defaults: Dependencies = {
  governance: governanceService,
  tasks: taskStore,
  authority: governanceExecutionService,
  lease: worktreeLeaseService,
  notify: (projectId, taskId, text) =>
    notificationService.create({
      projectId,
      source: "execute",
      sourceId: taskId,
      questions: [{ id: `remote-review-${taskId}`, text }],
    }),
};

/** Immutable receipts survive squash/rebase and disposable task branch cleanup. No method acquires the publication lock: callers serialize admission and push together. */
export class RemotePublicationGovernanceService {
  constructor(private deps: Dependencies = defaults) {}
  private async git(repoPath: string, args: string[]): Promise<string> {
    return (
      await run("git", args, {
        env: agentProcessEnvironment(),
        cwd: repoPath,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      })
    ).stdout;
  }
  private async rev(repoPath: string, ref: string): Promise<string | null> {
    try {
      return (await this.git(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    } catch {
      return null;
    }
  }
  private async ancestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }
  private async blob(repoPath: string, head: string, file: string): Promise<string | null> {
    const row = await this.git(repoPath, ["ls-tree", "-z", head, "--", file]);
    return row ? row.slice(0, row.indexOf("\t")) : null;
  }
  private async publicationEvents(projectId: string): Promise<GovernanceEvent[]> {
    // Full coder prompts are retained in the same audit journal; publication must not load them.
    const rows = await this.deps.tasks.runWrite((db) =>
      db.query(
        "SELECT payload FROM governance_events WHERE project_id=$1 AND kind IN ('local_publication_registered','remote_publication_attempt','remote_publication_prepared','remote_publication_completed','remote_publication_superseded','remote_publication_review_requested','remote_publication_review_prepared') ORDER BY created_at,id",
        [projectId]
      )
    );
    return rows.map((row) => JSON.parse(String(row.payload)) as GovernanceEvent);
  }
  private async receipts(
    projectId: string
  ): Promise<{ events: GovernanceEvent[]; receipts: RemotePublicationReceipt[] }> {
    const events = await this.publicationEvents(projectId);
    return {
      events,
      receipts: events
        .filter((e) => e.kind === "local_publication_registered")
        .map((e) => e.payload.receipt as unknown as RemotePublicationReceipt),
    };
  }
  private refs(projectId: string, id: string): string {
    return `refs/opensprint/remote-publication/${createHash("sha256").update(projectId).digest("hex").slice(0, 16)}/${id}`;
  }

  async registerLocalPublication(input: {
    projectId: string;
    taskId: string;
    repoPath: string;
    branchName: string;
    baseBranch: string;
    candidateHeadSha: string;
    baseSha: string;
  }): Promise<RemotePublicationReceipt> {
    const pins = await this.deps.governance.getTaskPinsForBranch(input.projectId, input.branchName);
    const id = governanceHash([
      input.projectId,
      input.taskId,
      input.branchName,
      input.baseBranch,
      input.baseSha,
      input.candidateHeadSha,
      pins.map((pin) => [pin.taskId, pin.releaseId]).sort((a, b) => a[0].localeCompare(b[0])),
    ]);
    const history = await this.receipts(input.projectId);
    const existing = history.receipts.find((r) => r.id === id);
    if (existing) return existing;
    const changed = (
      await this.git(input.repoPath, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        input.baseSha,
        input.candidateHeadSha,
        "--",
      ])
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    const files: Record<string, string | null> = {};
    for (const file of changed)
      files[file] = await this.blob(input.repoPath, input.candidateHeadSha, file);

    const owners: ReceiptOwner[] = [];
    for (const pin of pins) {
      const approval = await this.deps.governance.getReviewApproval(input.projectId, pin.taskId);
      const headSha = approval?.headSha ?? input.candidateHeadSha;
      const code = await governanceCodeSnapshot(
        input.repoPath,
        pin.baseSha,
        headSha,
        false,
        approval?.scopeBaseSha
      );
      owners.push({
        taskId: pin.taskId,
        branchName: pin.branchName,
        scope: (await this.deps.governance.getTrustedScope(input.projectId, pin.taskId)) ?? "",
        releaseId: pin.releaseId,
        mode: pin.mode,
        baseSha: pin.baseSha,
        headSha,
        diffHash: code.diffHash,
        scopeBaseSha: approval?.scopeBaseSha,
        changedPaths: code.changedPaths,
      });
    }
    if (!owners.length) {
      const code = await governanceCodeSnapshot(
        input.repoPath,
        input.baseSha,
        input.candidateHeadSha
      );
      owners.push({
        taskId: input.taskId,
        branchName: input.branchName,
        scope: (await this.deps.governance.getTrustedScope(input.projectId, input.taskId)) ?? "",
        mode: "disabled",
        baseSha: input.baseSha,
        headSha: input.candidateHeadSha,
        diffHash: code.diffHash,
        changedPaths: changed,
      });
    }
    const scopesByPath: Record<string, string[]> = {};
    const inherited = await this.getRemoteReviewRequest(input.projectId, input.taskId);
    const originalReceipts = inherited
      ? inherited.receiptIds
          .map((id) => history.receipts.find((r) => r.id === id))
          .filter((r): r is RemotePublicationReceipt => Boolean(r))
      : [];
    if (inherited && originalReceipts.length !== inherited.receiptIds.length)
      throw new Error("Remote review scope provenance is unavailable.");
    for (const file of changed)
      scopesByPath[file] = [
        ...new Set(
          inherited
            ? originalReceipts.flatMap(
                (r) =>
                  r.scopesByPath?.[file] ??
                  r.owners.filter((o) => o.changedPaths.includes(file)).map((o) => o.scope)
              )
            : owners.filter((o) => o.changedPaths.includes(file)).map((o) => o.scope)
        ),
      ];
    let remoteExpected = false;
    try {
      await this.git(input.repoPath, ["remote", "get-url", "origin"]);
      remoteExpected = true;
    } catch {
      /* Explicit local-only publication has no remote obligation. */
    }
    const receipt: RemotePublicationReceipt = {
      id,
      sequence: Math.max(0, ...history.receipts.map((r) => r.sequence)) + 1,
      taskId: input.taskId,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha,
      localHeadSha: input.candidateHeadSha,
      files,
      owners,
      scopesByPath,
      remoteExpected,
    };
    await this.git(input.repoPath, [
      "update-ref",
      `${this.refs(input.projectId, id)}/base`,
      input.baseSha,
    ]);
    await this.git(input.repoPath, [
      "update-ref",
      `${this.refs(input.projectId, id)}/candidate`,
      input.candidateHeadSha,
    ]);
    await this.deps.governance.audit(input.projectId, "local_publication_registered", "system", {
      receipt,
    });
    return receipt;
  }

  /** Fetch before selecting pending work, then persist the attempt before a SHA-rewriting rebase. */
  async beginPush(input: {
    projectId: string;
    repoPath: string;
    baseBranch: string;
  }): Promise<RemotePushBatch> {
    await this.git(input.repoPath, ["fetch", "--no-tags", "origin"]);
    const local = await this.rev(input.repoPath, input.baseBranch);
    if (!local) throw new Error("Remote publication has no local candidate revision.");
    const origin = await this.rev(input.repoPath, `refs/remotes/origin/${input.baseBranch}`);
    const history = await this.receipts(input.projectId);
    const completed = new Set(
      history.events
        .filter((e) => e.kind === "remote_publication_completed")
        .flatMap((e) => (e.payload.receiptIds as string[]) ?? [])
    );
    const recovered = new Set<string>();
    for (const e of history.events.filter((e) => e.kind === "remote_publication_prepared"))
      if (
        origin &&
        typeof e.payload.preparedHeadSha === "string" &&
        (await this.ancestor(input.repoPath, e.payload.preparedHeadSha, origin))
      )
        for (const id of (e.payload.receiptIds as string[]) ?? []) {
          if (!completed.has(id)) recovered.add(id);
          completed.add(id);
        }
    if (recovered.size)
      await this.deps.governance.audit(input.projectId, "remote_publication_completed", "system", {
        receiptIds: [...recovered],
        publishedHeadSha: origin,
        recoveredFromOrigin: true,
      });
    if (recovered.size && origin)
      await this.deps.governance.reconcilePublishedExpiryHolds(
        input.projectId,
        [...recovered],
        origin
      );
    const attempted = new Set(
      history.events
        .filter((e) => e.kind === "remote_publication_attempt")
        .flatMap((e) => (e.payload.receiptIds as string[]) ?? [])
    );
    for (const e of history.events.filter((e) => e.kind === "remote_publication_superseded")) {
      const replacement = history.receipts.find((r) => r.id === e.payload.replacementReceiptId);
      if (
        replacement &&
        (attempted.has(replacement.id) ||
          (await this.ancestor(input.repoPath, replacement.localHeadSha, local)) ||
          Boolean(
            origin && (await this.ancestor(input.repoPath, replacement.localHeadSha, origin))
          ))
      )
        for (const id of (e.payload.receiptIds as string[]) ?? []) completed.add(id);
    }
    const pending: RemotePublicationReceipt[] = [];
    for (const r of history.receipts.filter(
      (r) => r.baseBranch === input.baseBranch && !completed.has(r.id)
    )) {
      if (origin && (await this.ancestor(input.repoPath, r.localHeadSha, origin))) continue;
      if (attempted.has(r.id) || (await this.ancestor(input.repoPath, r.localHeadSha, local)))
        pending.push(r);
    }
    const batch = {
      receiptIds: pending.sort((a, b) => a.sequence - b.sequence).map((r) => r.id),
      inputHeadSha: local,
      baseBranch: input.baseBranch,
    };
    await this.deps.governance.audit(
      input.projectId,
      "remote_publication_attempt",
      "system",
      batch
    );
    return batch;
  }

  /** Exact changed blobs and current authority are checked after merger/gates and immediately before each push. */
  async assertPreparedPush(input: {
    projectId: string;
    repoPath: string;
    baseBranch: string;
    batch: RemotePushBatch;
  }): Promise<{ headSha: string; receiptIds: string[] }> {
    const history = await this.receipts(input.projectId);
    const pending = input.batch.receiptIds
      .map((id) => history.receipts.find((r) => r.id === id))
      .filter((r): r is RemotePublicationReceipt => Boolean(r));
    if (pending.length !== input.batch.receiptIds.length)
      throw new Error("Remote publication receipt evidence is unavailable.");
    const head = await this.rev(input.repoPath, input.baseBranch);
    if (!head) throw new Error("Remote candidate revision is unavailable.");
    await this.git(input.repoPath, ["diff", "--quiet", "HEAD", "--"]);
    await this.git(input.repoPath, ["diff", "--cached", "--quiet", "--"]);
    const origin = await this.rev(input.repoPath, `refs/remotes/origin/${input.baseBranch}`);
    const base = origin ?? pending[0]?.baseSha ?? head;
    const code = await governanceCodeSnapshot(input.repoPath, base, head);
    for (const r of pending)
      await this.deps.authority.assertPublicationAuthority({
        projectId: input.projectId,
        taskId: r.taskId,
        repoPath: input.repoPath,
        branchName: r.branchName,
      });
    const governed =
      (await this.deps.governance.getConfig(input.projectId)).mode === "enforced" ||
      pending.some((r) => r.owners.some((o) => o.mode === "enforced"));
    const latest = new Map<string, RemotePublicationReceipt>();
    for (const r of pending.sort((a, b) => a.sequence - b.sequence))
      for (const file of Object.keys(r.files)) latest.set(file, r);
    const changed: string[] = [];
    for (const file of code.changedPaths) {
      const r = latest.get(file);
      const blob = await this.blob(input.repoPath, head, file);
      const matching = r && r.files[file] === blob;
      const scopes = r
        ? (r.scopesByPath?.[file] ??
          r.owners.filter((o) => o.changedPaths.includes(file)).map((o) => o.scope))
        : [];
      if (!auditProtectedPaths([file], scopes.join("\n"), "").allowed) changed.push(file);
      if (governed && !matching) changed.push(file);
      const sensitive = await resolveGovernanceSensitiveSourcePaths({
        repoPath: input.repoPath,
        baseSha: base,
        headSha: head,
        changedPaths: [file],
      });
      if (sensitive.length && !matching) changed.push(file);
    }
    // Upstream changes to policy/checkers invalidate carried review authority even when task blobs are unchanged.
    if (governed && origin)
      for (const r of pending) {
        const upstream = (
          await this.git(input.repoPath, [
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            r.baseSha,
            origin,
            "--",
          ])
        )
          .split("\0")
          .filter(Boolean);
        if (
          (
            await resolveGovernanceSensitiveSourcePaths({
              repoPath: input.repoPath,
              baseSha: r.baseSha,
              headSha: origin,
              changedPaths: upstream,
            })
          ).length
        )
          changed.push("upstream policy or checker sources");
      }
    if (changed.length) {
      const request = await this.prepareReview(input, pending, base, head, [...new Set(changed)]);
      throw new RemotePublicationReviewRequiredError(request);
    }
    for (const r of pending) {
      await this.deps.authority.assertPublicationAuthority({
        projectId: input.projectId,
        taskId: r.taskId,
        repoPath: input.repoPath,
        branchName: r.branchName,
      });
      for (const owner of r.owners) {
        if (owner.releaseId)
          await assertGovernanceSensitiveSourceApproval({
            projectId: input.projectId,
            taskId: owner.taskId,
            releaseId: owner.releaseId,
            repoPath: input.repoPath,
            baseSha: owner.baseSha,
            headSha: owner.headSha,
            diffHash: owner.diffHash,
            changedPaths: owner.changedPaths,
            scopeBaseSha: owner.scopeBaseSha,
          });
      }
    }
    await this.deps.governance.audit(input.projectId, "remote_publication_prepared", "system", {
      receiptIds: input.batch.receiptIds,
      preparedHeadSha: head,
      baseBranch: input.baseBranch,
      originHeadSha: origin,
    });
    return { headSha: head, receiptIds: input.batch.receiptIds };
  }

  async getDeployableHead(
    projectId: string,
    repoPath: string,
    baseBranch: string
  ): Promise<string | null> {
    const head = await this.rev(repoPath, baseBranch);
    if (!head) return null;
    const history = await this.receipts(projectId);
    let hasOrigin = true;
    try {
      await this.git(repoPath, ["remote", "get-url", "origin"]);
    } catch {
      hasOrigin = false;
    }
    if (hasOrigin) {
      const origin = await this.rev(repoPath, `refs/remotes/origin/${baseBranch}`);
      if (!origin || !(await this.ancestor(repoPath, head, origin))) return null;
      if (
        !history.events.some(
          (event) =>
            event.kind === "remote_publication_prepared" &&
            event.payload.preparedHeadSha === head &&
            Array.isArray(event.payload.receiptIds) &&
            event.payload.receiptIds.length > 0
        )
      )
        return null;
    } else if (
      !history.receipts.some(
        (receipt) => receipt.localHeadSha === head && receipt.remoteExpected === false
      )
    )
      return null;
    return head;
  }

  async completePush(
    projectId: string,
    prepared: { headSha: string; receiptIds: string[] }
  ): Promise<void> {
    await this.deps.governance.audit(projectId, "remote_publication_completed", "system", {
      receiptIds: prepared.receiptIds,
      publishedHeadSha: prepared.headSha,
    });
  }

  /** The event, retained refs and pin are authoritative; mutable task extra is only a routing hint. */
  async getRemoteReviewRequest(
    projectId: string,
    taskId: string
  ): Promise<RemoteReviewRequest | null> {
    const events = await this.publicationEvents(projectId);
    const event = events.find(
      (e) => e.kind === "remote_publication_review_requested" && e.payload.taskId === taskId
    );
    return event ? (event.payload.request as unknown as RemoteReviewRequest) : null;
  }

  /** A shared review cannot replace contributions judged under different policy authority. */
  private async assertCompatibleReviewPolicies(
    projectId: string,
    originals: RemotePublicationReceipt[],
    target: GovernanceTaskPin
  ): Promise<void> {
    const signature = async (pin: GovernanceTaskPin): Promise<string> => {
      const release = await this.deps.governance.getRelease(projectId, pin.releaseId);
      return governanceHash({
        rules: [...release.rules].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
        instructions: release.instructions,
        sourceHashes: release.sourceHashes,
        enforcementRevision: release.enforcementRevision,
        pinnedInstructions: pin.instructionsByRole,
      });
    };
    const expected = await signature(target);
    for (const owner of originals.flatMap((receipt) => receipt.owners)) {
      const pin = await this.deps.governance.getTaskPin(projectId, owner.taskId);
      if (owner.releaseId && !pin)
        throw new Error("Remote review is missing an original task's governing policy pin.");
      if (pin && (await signature(pin)) !== expected)
        throw new Error(
          "Remote publication spans incompatible approved policies. Explicit human policy revalidation must reconcile the original tasks and this retained review to one compatible approved policy before a shared review can authorize publication."
        );
    }
  }

  private async prepareReview(
    input: { projectId: string; repoPath: string; baseBranch: string },
    pending: RemotePublicationReceipt[],
    baseSha: string,
    candidateSha: string,
    paths: string[]
  ): Promise<RemoteReviewRequest> {
    const key = governanceHash([input.baseBranch, baseSha, candidateSha, pending.map((r) => r.id)]);
    const events = await this.publicationEvents(input.projectId);
    const old = events.find(
      (e) => e.kind === "remote_publication_review_requested" && e.payload.key === key
    );
    if (old) {
      const request = old.payload.request as unknown as RemoteReviewRequest;
      const task = await this.deps.tasks.show(input.projectId, request.taskId);
      if (
        task.status === "blocked" &&
        !(await this.deps.governance.getTaskPin(input.projectId, request.taskId))
      )
        await this.prepareRemoteReview(input.projectId, request.taskId, input.repoPath);
      return request;
    }
    const scopes = [...new Set(pending.flatMap((r) => r.owners.map((o) => o.scope)))];
    const task = await this.deps.tasks.create(
      input.projectId,
      "Review changed remote publication candidate",
      {
        initialStatus: "blocked",
        priority: 0,
        description: `A remote rebase or merger changed code after its review. Review the exact retained candidate against the original approved policy and all hard checks.\nChanged paths: ${paths.join(", ")}\nOriginal scopes (evidence only):\n${scopes.join("\n\n")}`,
        extra: {
          source: "governance-remote-review",
          remotePublicationReview: {
            receiptIds: pending.map((r) => r.id),
            baseSha,
            candidateSha,
            baseBranch: input.baseBranch,
          },
          block_reason: "Preparing retained remote publication review",
        },
      } as CreateOpts
    );
    const branchName = `opensprint/${task.id}`;
    const worktreePath = path.join(input.repoPath, OPENSPRINT_PATHS.worktrees, task.id);
    const request: RemoteReviewRequest = {
      taskId: task.id,
      receiptIds: pending.map((r) => r.id),
      baseSha,
      candidateSha,
      baseBranch: input.baseBranch,
      branchName,
      worktreePath,
      reason: `Fresh review required for ${paths.join(", ")}`,
    };
    const refs = this.refs(input.projectId, `review-${key}`);
    await this.git(input.repoPath, ["update-ref", `${refs}/base`, baseSha]);
    await this.git(input.repoPath, ["update-ref", `${refs}/candidate`, candidateSha]);
    // Persist preparation before creating any worktree or exposing dispatchable state.
    await this.deps.governance.audit(
      input.projectId,
      "remote_publication_review_requested",
      "system",
      { key, taskId: task.id, request }
    );
    await this.prepareRemoteReview(input.projectId, task.id, input.repoPath);
    return request;
  }

  async prepareRemoteReview(
    projectId: string,
    taskId: string,
    repoPath: string
  ): Promise<RemoteReviewRequest | null> {
    const request = await this.getRemoteReviewRequest(projectId, taskId);
    if (!request) return null;
    const task = await this.deps.tasks.show(projectId, taskId);
    if (
      task.status === "closed" ||
      task.status === "in_progress" ||
      (await this.deps.governance.hasTaskHold(projectId, taskId))
    )
      return request;
    const history = await this.receipts(projectId);
    const pending = request.receiptIds
      .map((id) => history.receipts.find((r) => r.id === id))
      .filter((r): r is RemotePublicationReceipt => Boolean(r));
    if (pending.length !== request.receiptIds.length)
      throw new Error("Remote review lost its original receipt evidence.");
    const sourcePins: GovernanceTaskPin[] = [];
    for (const owner of pending.flatMap((r) => r.owners)) {
      const pin = await this.deps.governance.getTaskPin(projectId, owner.taskId);
      if (pin) sourcePins.push(pin);
    }
    let source =
      (await this.deps.governance.getTaskPin(projectId, taskId)) ??
      sourcePins.find((p) => p.mode === "enforced") ??
      sourcePins[0];
    if (!source) {
      const active = await this.deps.governance.getActiveRelease(projectId);
      if (active && !(await this.deps.governance.isReleaseRevoked(projectId, active.id)))
        source = {
          projectId,
          taskId,
          releaseId: active.id,
          mode: "enforced",
          baseSha: request.baseSha,
          trustedScope: "",
          instructionsByRole: active.instructions,
          worktreePath: request.worktreePath,
          branchName: request.branchName,
          createdAt: new Date().toISOString(),
        };
    }
    if (!source) {
      await this.deps.tasks.update(projectId, taskId, {
        status: "blocked",
        extra: {
          block_reason:
            "Human policy/source or protected-scope authorization is required before this remote candidate can be reviewed.",
        },
      });
      await this.deps.notify(
        projectId,
        taskId,
        `${request.reason}. Configure an approved policy and explicitly authorize any new protected/checker scope; no publication occurred.`
      );
      return request;
    }
    await fs.mkdir(path.dirname(request.worktreePath), { recursive: true });
    try {
      await fs.access(path.join(request.worktreePath, ".git"));
    } catch {
      const existingBranch = await this.rev(repoPath, request.branchName);
      if (existingBranch) {
        // The retained branch may contain a legitimate coder correction; retain it across restart.
        if (!(await this.ancestor(repoPath, request.candidateSha, existingBranch)))
          throw new Error("Remote review branch no longer descends from its retained candidate.");
        await this.git(repoPath, ["worktree", "prune"]);
        await this.git(repoPath, ["worktree", "add", request.worktreePath, request.branchName]);
      } else
        await this.git(repoPath, [
          "worktree",
          "add",
          "-b",
          request.branchName,
          request.worktreePath,
          request.candidateSha,
        ]);
    }
    const frozen: GovernanceTaskPin = {
      ...source,
      taskId,
      baseSha: request.baseSha,
      baseBranch: request.baseSha,
      mergeBaseSha: request.baseSha,
      branchName: request.branchName,
      worktreePath: request.worktreePath,
      trustedScope: pending.flatMap((r) => r.owners.map((o) => o.scope)).join("\n"),
      createdAt: new Date().toISOString(),
    };
    await this.deps.tasks.runWrite(async (db) => {
      const inserted = await db.execute(
        "INSERT INTO governance_task_pins(project_id,task_id,release_id,payload)VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [projectId, taskId, frozen.releaseId, JSON.stringify(frozen)]
      );
      if (inserted === 1)
        await db.execute(
          "UPDATE governance_task_scopes SET scope=$1 WHERE project_id=$2 AND task_id=$3",
          [frozen.trustedScope, projectId, taskId]
        );
    });
    try {
      await this.assertCompatibleReviewPolicies(projectId, pending, frozen);
    } catch (error) {
      await this.deps.tasks.update(projectId, taskId, {
        status: "blocked",
        extra: {
          block_reason: error instanceof Error ? error.message : String(error),
          governance_resume: true,
          useExistingBranch: true,
        },
      });
      await this.deps.notify(
        projectId,
        taskId,
        `${request.reason}. ${error instanceof Error ? error.message : String(error)} No publication or receipt supersession occurred; its exact worktree and policy pin are retained.`
      );
      return request;
    }
    if (await this.deps.governance.isReleaseRevoked(projectId, source.releaseId)) {
      await this.deps.notify(
        projectId,
        taskId,
        "The retained policy was revoked. Reconcile this remote review against an approved compatible policy before resuming."
      );
      return request;
    }
    await this.deps.lease.acquire({
      projectId,
      taskId,
      worktreeKey: taskId,
      worktreePath: request.worktreePath,
      branchName: request.branchName,
      leaseOwner: `remote-review:${taskId}`,
    });
    const preparedBefore = (await this.publicationEvents(projectId)).some(
      (e) => e.kind === "remote_publication_review_prepared" && e.payload.taskId === taskId
    );
    if (task.status !== "blocked" || preparedBefore) return request;
    await this.deps.governance.audit(projectId, "remote_publication_review_prepared", "system", {
      taskId,
      candidateSha: request.candidateSha,
      worktreePath: request.worktreePath,
    });
    await this.deps.tasks.update(projectId, taskId, {
      status: "open",
      assignee: "",
      extra: {
        governance_resume: true,
        useExistingBranch: true,
        remotePublicationReview: {
          receiptIds: request.receiptIds,
          baseSha: request.baseSha,
          candidateSha: request.candidateSha,
          baseBranch: request.baseBranch,
        },
        block_reason: null,
      },
    });
    await this.deps.notify(
      projectId,
      taskId,
      `${request.reason}. The candidate is retained in a dedicated worktree; hard checks and a fresh code review will run before publication.`
    );
    return request;
  }

  async acceptRemoteReview(input: {
    projectId: string;
    taskId: string;
    repoPath: string;
    cwd: string;
    branchName: string;
  }): Promise<void> {
    const request = await this.getRemoteReviewRequest(input.projectId, input.taskId);
    if (!request) throw new Error("Remote review has no server-owned request.");
    const approval = await this.deps.governance.getReviewApproval(input.projectId, input.taskId);
    const head = await this.rev(input.cwd, "HEAD");
    if (!approval || !head || approval.headSha !== head)
      throw new Error("Remote review approval is stale for the retained candidate.");
    const code = await governanceCodeSnapshot(input.cwd, request.baseSha, head);
    if (code.diffHash !== approval.diffHash)
      throw new Error("Remote review candidate changed after approval.");
    const history = await this.receipts(input.projectId);
    const originals = request.receiptIds
      .map((id) => history.receipts.find((r) => r.id === id))
      .filter((r): r is RemotePublicationReceipt => Boolean(r));
    if (originals.length !== request.receiptIds.length)
      throw new Error("Remote review has missing original publication receipts.");
    const target = await this.deps.governance.getTaskPin(input.projectId, input.taskId);
    if (!target) throw new Error("Remote review has no retained governing policy pin.");
    await this.assertCompatibleReviewPolicies(input.projectId, originals, target);
    for (const r of originals)
      await this.deps.authority.assertPublicationAuthority({
        projectId: input.projectId,
        taskId: r.taskId,
        repoPath: input.repoPath,
        branchName: r.branchName,
      });
    for (const file of code.changedPaths) {
      const scopes = originals.flatMap(
        (r) =>
          r.scopesByPath?.[file] ??
          r.owners.filter((o) => o.changedPaths.includes(file)).map((o) => o.scope)
      );
      if (!auditProtectedPaths([file], scopes.join("\n"), "").allowed)
        throw new Error(
          `Original task authority does not permit protected remote path ${file}. Explicit human scope authorization is required.`
        );
    }
    try {
      await assertGovernanceSensitiveSourceApproval({
        projectId: input.projectId,
        taskId: input.taskId,
        releaseId: approval.releaseId,
        repoPath: input.repoPath,
        baseSha: request.baseSha,
        headSha: head,
        diffHash: code.diffHash,
        changedPaths: code.changedPaths,
        scopeBaseSha: approval.scopeBaseSha ?? request.baseSha,
      });
    } catch (error) {
      await this.deps.notify(
        input.projectId,
        input.taskId,
        "Remote candidate code review completed, but changed policy/checker sources still require an explicit human implementation approval for this exact review task and code. Approve the source change through governance and retry the retained review; no publication or receipt supersession occurred."
      );
      throw error;
    }
    const receipt = await this.registerLocalPublication({
      projectId: input.projectId,
      taskId: input.taskId,
      repoPath: input.repoPath,
      branchName: input.branchName,
      baseBranch: request.baseBranch,
      candidateHeadSha: head,
      baseSha: request.baseSha,
    });
    await this.deps.governance.audit(input.projectId, "remote_publication_superseded", "system", {
      receiptIds: request.receiptIds,
      replacementReceiptId: receipt.id,
      taskId: input.taskId,
      reviewedHeadSha: head,
    });
  }
}
export class RemotePublicationReviewRequiredError extends Error {
  constructor(public readonly request: RemoteReviewRequest) {
    super(`Remote publication paused for fresh code review: ${request.taskId}. ${request.reason}`);
    this.name = "RemotePublicationReviewRequiredError";
  }
}
export const remotePublicationGovernanceService = new RemotePublicationGovernanceService();
