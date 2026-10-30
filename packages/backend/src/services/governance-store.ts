import { randomUUID } from "crypto";
import type { DbClient } from "../db/client.js";
import type {
  AgentRole,
  Notification,
  GovernanceConfig,
  GovernanceTaskPin,
  PolicyRelease,
  PolicyRuleRevision,
  PolicyContext,
  ReviewCase,
  ReviewCaseState,
  ReviewAgentResult,
  PolicyDecision,
  ResolveGovernanceCaseInput,
  JudgeRecommendation,
  GovernanceEvent,
  PolicyProposal,
  PolicyEvaluation,
  PolicyContextReceipt,
} from "@opensprint/shared";
import {
  buildProposalRelease,
  canonicalJson,
  governanceError,
  governanceHash,
  matchesPolicyPath,
  resolvePolicyContext,
  validatePolicyRules,
} from "./policy-context.js";

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  mode: "disabled",
  version: 0,
  maxAppeals: 3,
  maxTokens: 100_000,
  maxCostUsd: 10,
  maxElapsedMs: 1_800_000,
  contextMaxChars: 100_000,
  recurrenceThreshold: 3,
};
const now = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}-${randomUUID()}`;
function unpack<T>(row: Record<string, unknown> | undefined): T | null {
  return row ? (JSON.parse(String(row.payload)) as T) : null;
}
const holdStates: ReviewCaseState[] = [
  "awaiting_reconsideration",
  "awaiting_judge",
  "awaiting_human",
  "evidence_requested",
  "stale",
];
const isHeldCase = (c: ReviewCase): boolean =>
  (!c.publishedRemediationOnly && holdStates.includes(c.state)) ||
  (c.humanCancelled === true && !c.supersededByReleaseId);
export interface GovernanceStoreDeps {
  getDb: () => Promise<DbClient>;
  runWrite: <T>(fn: (client: DbClient) => Promise<T>) => Promise<T>;
  onNotification?: (notification: Notification) => Promise<void> | void;
}
export type PolicyActivationVerifier = (release: PolicyRelease, db: DbClient) => Promise<void>;
/** Durable project-scoped authority. Agent recommendations never mutate human decisions. */
export class GovernanceService {
  private publicationLocks = new Map<string, Promise<unknown>>();
  private orphanedPublicationTokens = new Map<string, string>();
  constructor(private deps: GovernanceStoreDeps) {}
  async withPublicationLock<T>(
    projectId: string,
    fn: (assertLease: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const previous = this.publicationLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.publicationLocks.set(projectId, tail);
    await previous.catch(() => {});
    const token = id("publication");
    let acquired = false;
    let renewalTimer: ReturnType<typeof setInterval> | undefined;
    let renewal: Promise<void> = Promise.resolve();
    let leaseFailure: unknown;
    const leaseDurationMs = 3_600_000;
    // Renewal is serialized with itself; an unavailable DB or stolen lease fails publication closed.
    const assertLease = async (): Promise<void> => {
      if (leaseFailure) throw leaseFailure;
      const attempt = renewal.then(async () => {
        if (leaseFailure) throw leaseFailure;
        const count = await this.deps.runWrite((db) =>
          db.execute(
            "UPDATE governance_publication_leases SET expires_at=$1 WHERE project_id=$2 AND token=$3 AND expires_at >= $4",
            [new Date(Date.now() + leaseDurationMs).toISOString(), projectId, token, now()]
          )
        );
        if (count !== 1)
          governanceError(
            "The durable publication lease expired or changed owner; publication must be retried.",
            "GOVERNANCE_PUBLICATION_LEASE_LOST"
          );
      });
      renewal = attempt.catch((error) => {
        leaseFailure = error;
      });
      await attempt;
    };
    const cleanupLease = async (): Promise<void> => {
      try {
        await this.deps.runWrite((db) =>
          db.execute("DELETE FROM governance_publication_leases WHERE project_id=$1 AND token=$2", [
            projectId,
            token,
          ])
        );
      } catch (error) {
        this.orphanedPublicationTokens.set(projectId, token);
        throw error;
      }
    };
    try {
      const orphanedToken = this.orphanedPublicationTokens.get(projectId);
      if (orphanedToken) {
        // The prior local owner completed; retry its token-scoped cleanup after DB recovery.
        await this.deps.runWrite((db) =>
          db.execute("DELETE FROM governance_publication_leases WHERE project_id=$1 AND token=$2", [
            projectId,
            orphanedToken,
          ])
        );
        this.orphanedPublicationTokens.delete(projectId);
      }
      const count = await this.deps.runWrite((db) =>
        db.execute(
          "INSERT INTO governance_publication_leases(project_id,token,expires_at) VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE governance_publication_leases.expires_at < $4",
          [projectId, token, new Date(Date.now() + leaseDurationMs).toISOString(), now()]
        )
      );
      if (count !== 1)
        governanceError(
          "Another publication or policy mutation owns the durable project lease. Retry after it completes."
        );
      acquired = true;
      renewalTimer = setInterval(() => {
        void assertLease().catch(() => {});
      }, 60_000);
      renewalTimer.unref();
      return await fn(assertLease);
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      try {
        await renewal;
        if (acquired) await cleanupLease();
      } finally {
        // A transient cleanup failure must never strand all future local callers on an unresolved gate.
        release();
        if (this.publicationLocks.get(projectId) === tail) this.publicationLocks.delete(projectId);
      }
    }
  }
  private async ensureState(db: DbClient, projectId: string): Promise<void> {
    await db.execute(
      "INSERT INTO project_governance (project_id,version,active_release_id,config,updated_at) VALUES ($1,0,NULL,$2,$3) ON CONFLICT (project_id) DO NOTHING",
      [projectId, JSON.stringify(DEFAULT_GOVERNANCE_CONFIG), now()]
    );
  }
  private async event(
    db: DbClient,
    projectId: string,
    kind: string,
    actor: string,
    payload: Record<string, unknown>,
    caseId?: string
  ): Promise<void> {
    const event: GovernanceEvent = {
      id: id("event"),
      projectId,
      kind,
      actor,
      payload,
      createdAt: now(),
      ...(caseId ? { caseId } : {}),
    };
    await db.execute(
      "INSERT INTO governance_events (project_id,id,kind,payload,created_at) VALUES ($1,$2,$3,$4,$5)",
      [projectId, event.id, kind, JSON.stringify(event), event.createdAt]
    );
  }
  async getConfig(projectId: string): Promise<GovernanceConfig> {
    const row = await (
      await this.deps.getDb()
    ).queryOne("SELECT config,version FROM project_governance WHERE project_id=$1", [projectId]);
    return row
      ? {
          ...DEFAULT_GOVERNANCE_CONFIG,
          ...JSON.parse(String(row.config)),
          version: Number(row.version),
        }
      : { ...DEFAULT_GOVERNANCE_CONFIG };
  }
  async getActiveReleaseId(projectId: string): Promise<string | null> {
    const row = await (
      await this.deps.getDb()
    ).queryOne("SELECT active_release_id FROM project_governance WHERE project_id=$1", [projectId]);
    return row?.active_release_id ? String(row.active_release_id) : null;
  }
  async configure(
    projectId: string,
    input: Partial<GovernanceConfig> & { expectedVersion: number },
    actor: string
  ): Promise<GovernanceConfig> {
    return this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        await this.ensureState(db, projectId);
        const row = await db.queryOne(
          "SELECT config,version,active_release_id FROM project_governance WHERE project_id=$1",
          [projectId]
        );
        if (Number(row!.version) !== input.expectedVersion)
          governanceError("Governance configuration changed; reload before approving.");
        const next = {
          ...DEFAULT_GOVERNANCE_CONFIG,
          ...JSON.parse(String(row!.config)),
          ...input,
          version: input.expectedVersion + 1,
        } as GovernanceConfig;
        if (!["disabled", "shadow", "enforced"].includes(next.mode))
          governanceError("Invalid governance mode.");
        for (const field of [
          "maxAppeals",
          "maxTokens",
          "maxCostUsd",
          "maxElapsedMs",
          "contextMaxChars",
          "recurrenceThreshold",
        ] as const)
          if (!Number.isFinite(next[field]) || next[field] <= 0)
            governanceError(`Invalid ${field}.`);
        for (const [name, pricing] of [
          ["Judge", next.judgeTokenPricing],
          ["Reconsideration", next.reconsiderationTokenPricing],
        ] as const) {
          if (
            pricing !== undefined &&
            pricing !== null &&
            (typeof pricing !== "object" ||
              ![pricing.inputPerMillionUsd, pricing.outputPerMillionUsd].every(
                (v) => typeof v === "number" && Number.isFinite(v) && v >= 0
              ))
          )
            governanceError(`${name} token price ceilings must be non-negative finite numbers.`);
        }
        if (
          next.reconsiderationAgent !== undefined &&
          next.reconsiderationAgent !== null &&
          (typeof next.reconsiderationAgent !== "object" ||
            !["claude", "openai"].includes(next.reconsiderationAgent.type) ||
            typeof next.reconsiderationAgent.model !== "string" ||
            !next.reconsiderationAgent.model.trim() ||
            Boolean(next.reconsiderationAgent.cliCommand))
        )
          governanceError(
            "Reconsideration requires an explicit tool-free Claude or OpenAI API model; CLI commands are unavailable."
          );
        if (next.mode !== "disabled" && !row!.active_release_id)
          governanceError("Approve an initial policy release before enabling governance.");
        if (
          next.mode === "disabled" &&
          (
            await db.query(
              "SELECT id FROM review_cases WHERE project_id=$1 AND state IN ('awaiting_reconsideration','awaiting_judge','awaiting_human','evidence_requested','stale') LIMIT 1",
              [projectId]
            )
          ).length
        )
          governanceError(
            "Existing governance holds require explicit audited rulings before disabling."
          );
        const count = await db.execute(
          "UPDATE project_governance SET config=$1,version=version+1,updated_at=$2 WHERE project_id=$3 AND version=$4",
          [JSON.stringify(next), now(), projectId, input.expectedVersion]
        );
        if (count !== 1) governanceError("Concurrent governance update.");
        await this.event(db, projectId, "configuration_changed", actor, {
          before: JSON.parse(String(row!.config)),
          after: next,
        });
        return next;
      })
    );
  }
  async assertSourceDrift(projectId: string, currentHashes: Record<string, string>): Promise<void> {
    const release = await this.getActiveRelease(projectId);
    if (!release) return;
    const drift = Object.entries(currentHashes)
      .filter(
        ([name, hash]) =>
          release.sourceHashes[name] !== undefined && release.sourceHashes[name] !== hash
      )
      .map(([name]) => name);
    if (drift.length)
      governanceError(
        `Approved policy source drift detected: ${drift.join(", ")}. Reconcile through a reviewed policy amendment before scheduling.`,
        "GOVERNANCE_POLICY_DRIFT"
      );
  }
  async getActiveRelease(projectId: string): Promise<PolicyRelease | null> {
    const releaseId = await this.getActiveReleaseId(projectId);
    if (releaseId && (await this.isReleaseRevoked(projectId, releaseId)))
      governanceError(
        "Active policy was critically revoked. Approve a compatible replacement before scheduling."
      );
    return releaseId ? this.getRelease(projectId, releaseId) : null;
  }
  async recordPromptSnapshot(
    projectId: string,
    taskId: string,
    role: AgentRole,
    prompt: string,
    headSha: string,
    envelope?: { stablePrefix: string; dynamicContext: string },
    invocation?: {
      attempt: number;
      invocationId: string;
      assignmentCreatedAt: string;
      policyPin?: GovernanceTaskPin;
      contextArtifacts?: import("./governance-context-artifacts.js").GovernanceContextArtifacts;
    }
  ): Promise<void> {
    await this.deps.runWrite(async (db) => {
      await this.event(db, projectId, "prompt_snapshot", "system", {
        taskId,
        role,
        prompt,
        headSha,
        contentHash: governanceHash(prompt),
        ...(envelope ? { envelope, dynamicContext: envelope.dynamicContext } : {}),
        ...(invocation ?? {}),
      });
    });
  }
  async getPromptSnapshots(projectId: string, taskId: string): Promise<GovernanceEvent[]> {
    return (await this.listEvents(projectId, ["prompt_snapshot"])).filter(
      (e) => e.kind === "prompt_snapshot" && e.payload.taskId === taskId
    );
  }
  async recordContextRetrieval(
    projectId: string,
    taskId: string,
    receipt: PolicyContextReceipt
  ): Promise<void> {
    await this.deps.runWrite((db) =>
      this.event(db, projectId, "policy_context_retrieved", "system", { taskId, receipt })
    );
  }
  async listReleases(projectId: string): Promise<PolicyRelease[]> {
    return (
      await (
        await this.deps.getDb()
      ).query("SELECT payload FROM policy_releases WHERE project_id=$1 ORDER BY id", [projectId])
    ).map((r) => unpack<PolicyRelease>(r)!);
  }
  private async releaseRevokedInDb(
    db: DbClient,
    projectId: string,
    releaseId: string
  ): Promise<boolean> {
    return (
      await db.query(
        "SELECT payload FROM governance_events WHERE project_id=$1 AND kind='release_revoked'",
        [projectId]
      )
    ).some((row) => unpack<GovernanceEvent>(row)?.payload.releaseId === releaseId);
  }
  async isReleaseRevoked(projectId: string, releaseId: string): Promise<boolean> {
    return this.releaseRevokedInDb(await this.deps.getDb(), projectId, releaseId);
  }
  /** Critical human revocation is a durable admission constraint, including shadow assignments. */
  async revokeRelease(
    projectId: string,
    releaseId: string,
    rationale: string,
    actor: string
  ): Promise<void> {
    if (!rationale?.trim() || !actor?.trim())
      governanceError("Named human authority and a revocation rationale are required.");
    await this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        const release = unpack<PolicyRelease>(
          await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
            projectId,
            releaseId,
          ])
        );
        if (!release) governanceError("Policy release not found.", "GOVERNANCE_NOT_FOUND", 404);
        if (await this.releaseRevokedInDb(db, projectId, releaseId)) return;
        const timestamp = now();
        const pendingRemoteTasks = await this.pendingRemoteTaskIds(db, projectId);
        await this.event(db, projectId, "release_revoked", actor, { releaseId, rationale });
        await db.execute(
          "DELETE FROM governance_review_approvals WHERE project_id=$1 AND release_id=$2",
          [projectId, releaseId]
        );
        const pins = (
          await db.query(
            "SELECT payload FROM governance_task_pins WHERE project_id=$1 AND release_id=$2",
            [projectId, releaseId]
          )
        ).map((row) => unpack<GovernanceTaskPin>(row)!);
        for (const pin of pins) {
          const task = await db.queryOne(
            "SELECT status,extra FROM tasks WHERE project_id=$1 AND id=$2",
            [projectId, pin.taskId]
          );
          if (!task) continue;
          if (task.status === "closed" && !pendingRemoteTasks.has(pin.taskId)) {
            const extra = {
              ...JSON.parse(String(task.extra ?? "{}")),
              governance_remediation_required: { releaseId, rationale, createdAt: timestamp },
            };
            await db.execute(
              "UPDATE tasks SET extra=$1,updated_at=$2 WHERE project_id=$3 AND id=$4",
              [JSON.stringify(extra), timestamp, projectId, pin.taskId]
            );
            await this.event(db, projectId, "policy_revoked_after_publication", actor, {
              releaseId,
              taskId: pin.taskId,
              rationale,
              requiredAction:
                "Create an explicitly scoped follow-up remediation task; published history is unchanged.",
            });
            continue;
          }
          const caseId = `critical-${governanceHash([projectId, pin.taskId, releaseId]).slice(0, 32)}`;
          const existing = unpack<ReviewCase>(
            await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
              projectId,
              caseId,
            ])
          );
          if (existing) continue;
          const c: ReviewCase = {
            id: caseId,
            projectId,
            taskId: pin.taskId,
            releaseId,
            state: "stale",
            version: 1,
            headSha: pin.baseSha,
            diffHash: governanceHash(["policy-revocation", releaseId, pin.taskId]),
            baseSha: pin.baseSha,
            changedPaths: [],
            title: "Governing policy critically revoked",
            summary: `${actor} revoked policy ${releaseId}: ${rationale}. Activate a replacement policy, require a fix, and run a fresh review.`,
            findings: [
              {
                id: "critical-policy-revoked",
                category: "gate",
                file: "policy-release.json",
                codeRevision: pin.baseSha,
                evidence: `Approved policy ${releaseId} was critically revoked by ${actor}: ${rationale}`,
                severity: "blocking",
                suggestedRemedy:
                  "Activate a compatible replacement policy and require a fresh review. This administrative hold cannot be waived.",
                provenance: { reviewer: "policy-registry" },
              },
            ],
            appeals: [],
            evidence: {
              release,
              pin,
              criticalRevocation: { actor, rationale, createdAt: timestamp },
            },
            evidenceHash: governanceHash({ release, pin, actor, rationale }),
            worktreePath: pin.worktreePath,
            branchName: pin.branchName,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await db.execute(
            "INSERT INTO review_cases(project_id,id,task_id,release_id,state,version,idempotency_key,payload,created_at) VALUES($1,$2,$3,$4,'stale',1,$5,$6,$7)",
            [
              projectId,
              caseId,
              pin.taskId,
              releaseId,
              `critical-revocation:${pin.taskId}:${releaseId}`,
              JSON.stringify(c),
              timestamp,
            ]
          );
          await db.execute(
            "INSERT INTO review_findings(project_id,case_id,id,payload)VALUES($1,$2,$3,$4)",
            [projectId, caseId, c.findings[0].id, JSON.stringify(c.findings[0])]
          );
          await db.execute(
            "INSERT INTO governance_outbox(project_id,id,case_id,state,payload)VALUES($1,$2,$3,'pending',$4)",
            [projectId, `docket-${caseId}`, caseId, JSON.stringify({ caseId, caseVersion: 1 })]
          );
          const extra = {
            ...JSON.parse(String(task.extra ?? "{}")),
            governance_resume: null,
            block_reason: "Critical policy revocation",
          };
          await db.execute(
            "UPDATE tasks SET status='blocked',assignee=NULL,extra=$1,updated_at=$2 WHERE project_id=$3 AND id=$4",
            [JSON.stringify(extra), timestamp, projectId, pin.taskId]
          );
          await this.event(
            db,
            projectId,
            "case_opened",
            actor,
            { caseId, taskId: pin.taskId, state: "stale", criticalPolicyRevocation: true },
            caseId
          );
        }
      })
    );
    await this.deliverOutbox(projectId);
  }
  async getRelease(projectId: string, releaseId: string): Promise<PolicyRelease> {
    const release = unpack<PolicyRelease>(
      await (
        await this.deps.getDb()
      ).queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
        projectId,
        releaseId,
      ])
    );
    if (!release) governanceError("Policy release is unavailable.", "GOVERNANCE_NOT_FOUND", 404);
    return release;
  }
  private async saveRelease(db: DbClient, release: PolicyRelease): Promise<void> {
    validatePolicyRules(release.rules);
    for (const rule of release.rules) {
      await db.execute(
        "INSERT INTO policy_rules(project_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [release.projectId, rule.ruleId]
      );
      const hash = governanceHash(rule);
      const existing = await db.queryOne(
        "SELECT content_hash FROM policy_rule_revisions WHERE project_id=$1 AND id=$2",
        [release.projectId, rule.id]
      );
      if (existing && existing.content_hash !== hash)
        governanceError("Immutable rule revision content changed.");
      await db.execute(
        "INSERT INTO policy_rule_revisions(project_id,id,rule_id,revision,content_hash,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,id) DO NOTHING",
        [release.projectId, rule.id, rule.ruleId, rule.revision, hash, JSON.stringify(rule)]
      );
    }
    const existing = await db.queryOne(
      "SELECT content_hash FROM policy_releases WHERE project_id=$1 AND id=$2",
      [release.projectId, release.id]
    );
    if (existing && existing.content_hash !== release.contentHash)
      governanceError("Immutable release content changed.");
    await db.execute(
      "INSERT INTO policy_releases(project_id,id,content_hash,payload) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,id) DO NOTHING",
      [release.projectId, release.id, release.contentHash, JSON.stringify(release)]
    );
  }
  async createRelease(
    projectId: string,
    input: {
      rules: PolicyRuleRevision[];
      instructions: PolicyRelease["instructions"];
      sourceHashes: Record<string, string>;
      enforcementRevision: string;
    },
    actor: string
  ): Promise<PolicyRelease> {
    if (!input.enforcementRevision?.trim())
      governanceError("An enforcement Git revision is required.");
    const normalizedRules = Array.isArray(input.rules)
      ? input.rules.map((r) => ({
          ...r,
          sourceHash: governanceHash({ ...r, sourceHash: undefined }),
        }))
      : input.rules;
    const manifest = {
      rules: normalizedRules,
      instructions: input.instructions ?? {},
      sourceHashes: input.sourceHashes ?? {},
      enforcementRevision: input.enforcementRevision,
    };
    const release: PolicyRelease = {
      ...manifest,
      id: id("release"),
      projectId,
      contentHash: governanceHash(manifest),
      createdAt: now(),
      createdBy: actor,
    };
    await this.deps.runWrite(async (db) => {
      await this.ensureState(db, projectId);
      await this.saveRelease(db, release);
      await this.event(db, projectId, "release_staged", actor, { releaseId: release.id });
    });
    return release;
  }
  async activateRelease(
    projectId: string,
    releaseId: string,
    input: { expectedActiveReleaseId: string | null; rationale: string },
    actor: string,
    verifyRelease?: PolicyActivationVerifier
  ): Promise<PolicyRelease> {
    return this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        await this.ensureState(db, projectId);
        const state = await db.queryOne(
          "SELECT active_release_id FROM project_governance WHERE project_id=$1",
          [projectId]
        );
        if ((state?.active_release_id ?? null) !== input.expectedActiveReleaseId)
          governanceError("Active policy changed; reload before approving.");
        if (state?.active_release_id)
          governanceError(
            "Amendments require an evaluated proposal. Use rollback for an approved prior release."
          );
        const release = unpack<PolicyRelease>(
          await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
            projectId,
            releaseId,
          ])
        );
        if (!release) governanceError("Unknown release.");
        if (!input.rationale?.trim()) governanceError("Approval rationale is required.");
        await verifyRelease?.(release, db);
        await db.execute(
          "UPDATE project_governance SET active_release_id=$1,version=version+1,updated_at=$2 WHERE project_id=$3",
          [releaseId, now(), projectId]
        );
        await this.event(db, projectId, "release_activated", actor, {
          releaseId,
          rationale: input.rationale,
          initial: true,
        });
        return release;
      })
    );
  }
  async captureTrustedScope(
    projectId: string,
    taskId: string,
    _trustedScope: string
  ): Promise<string> {
    return this.deps.runWrite(async (db) => {
      await db.execute(
        "INSERT INTO governance_task_scopes(project_id,task_id,scope) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        // Legacy tasks without creation-time provenance have no implicit sensitive scope.
        [projectId, taskId, ""]
      );
      const row = await db.queryOne(
        "SELECT scope FROM governance_task_scopes WHERE project_id=$1 AND task_id=$2",
        [projectId, taskId]
      );
      return String(row!.scope);
    });
  }
  async authorizeTaskScope(
    projectId: string,
    taskId: string,
    scope: string,
    rationale: string,
    actor: string
  ): Promise<void> {
    if (!scope.trim() || !rationale.trim() || !actor.trim())
      governanceError("Named human scope authorization and rationale are required.");
    await this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        const task = await db.queryOne("SELECT id FROM tasks WHERE project_id=$1 AND id=$2", [
          projectId,
          taskId,
        ]);
        if (!task) governanceError("Task not found.", "GOVERNANCE_NOT_FOUND", 404);
        if (
          await db.queryOne(
            "SELECT task_id FROM governance_task_pins WHERE project_id=$1 AND task_id=$2",
            [projectId, taskId]
          )
        )
          governanceError(
            "An assigned task's trusted scope cannot be changed. Cancel it and create an explicitly scoped follow-up task."
          );
        const previous = await db.queryOne(
          "SELECT scope FROM governance_task_scopes WHERE project_id=$1 AND task_id=$2",
          [projectId, taskId]
        );
        await db.execute(
          "INSERT INTO governance_task_scopes(project_id,task_id,scope) VALUES($1,$2,$3) ON CONFLICT(project_id,task_id) DO UPDATE SET scope=excluded.scope",
          [projectId, taskId, scope]
        );
        await this.event(db, projectId, "task_scope_authorized", actor, {
          taskId,
          previousScope: previous?.scope ?? null,
          scope,
          rationale,
        });
      })
    );
  }
  async getTrustedScope(projectId: string, taskId: string): Promise<string | null> {
    const row = await (
      await this.deps.getDb()
    ).queryOne("SELECT scope FROM governance_task_scopes WHERE project_id=$1 AND task_id=$2", [
      projectId,
      taskId,
    ]);
    return row ? String(row.scope) : null;
  }
  async getTaskPinsForBranch(projectId: string, branchName: string): Promise<GovernanceTaskPin[]> {
    return (
      await (
        await this.deps.getDb()
      ).query("SELECT payload FROM governance_task_pins WHERE project_id=$1 ORDER BY task_id", [
        projectId,
      ])
    )
      .map((r) => unpack<GovernanceTaskPin>(r)!)
      .filter((p) => p.branchName === branchName);
  }
  async getReviewApproval(
    projectId: string,
    taskId: string
  ): Promise<{
    headSha: string;
    diffHash: string;
    releaseId: string;
    receipt: PolicyContextReceipt;
    scopeBaseSha?: string;
    changedPaths?: string[];
  } | null> {
    return unpack(
      await (
        await this.deps.getDb()
      ).queryOne(
        "SELECT payload FROM governance_review_approvals WHERE project_id=$1 AND task_id=$2",
        [projectId, taskId]
      )
    );
  }

  async getTaskPin(projectId: string, taskId: string): Promise<GovernanceTaskPin | null> {
    return unpack<GovernanceTaskPin>(
      await (
        await this.deps.getDb()
      ).queryOne("SELECT payload FROM governance_task_pins WHERE project_id=$1 AND task_id=$2", [
        projectId,
        taskId,
      ])
    );
  }
  async pinTask(
    input: Omit<GovernanceTaskPin, "releaseId" | "mode" | "createdAt">
  ): Promise<GovernanceTaskPin | null> {
    const existing = await this.getTaskPin(input.projectId, input.taskId);
    if (existing) {
      if (await this.isReleaseRevoked(input.projectId, existing.releaseId))
        governanceError(
          "A critically revoked assignment requires an explicit human policy revalidation before resuming."
        );
      return existing;
    }
    const config = await this.getConfig(input.projectId);
    if (config.mode === "disabled") return null;
    const releaseId = await this.getActiveReleaseId(input.projectId);
    if (!releaseId) governanceError("No approved policy release.");
    if (await this.isReleaseRevoked(input.projectId, releaseId))
      governanceError(
        "Active policy was critically revoked; approve a replacement before scheduling."
      );
    const release = await this.getRelease(input.projectId, releaseId);
    const pin: GovernanceTaskPin = {
      ...input,
      releaseId,
      mode: config.mode,
      instructionsByRole: { ...input.instructionsByRole, ...release.instructions },
      createdAt: now(),
    };
    await this.deps.runWrite(async (db) => {
      await db.execute(
        "INSERT INTO governance_task_pins(project_id,task_id,release_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [pin.projectId, pin.taskId, pin.releaseId, JSON.stringify(pin)]
      );
    });
    return this.getTaskPin(pin.projectId, pin.taskId);
  }
  /** Explicit human replacement of a held assignment's policy; this grants no code approval. */
  async revalidateTaskPolicy(
    projectId: string,
    taskId: string,
    input: { expectedReleaseId: string; rationale: string },
    actor: string,
    verifyRelease?: PolicyActivationVerifier
  ): Promise<GovernanceTaskPin> {
    if (!input.rationale?.trim() || !actor?.trim())
      governanceError("Named human authority and a revalidation rationale are required.");
    return this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        const oldPin = unpack<GovernanceTaskPin>(
          await db.queryOne(
            "SELECT payload FROM governance_task_pins WHERE project_id=$1 AND task_id=$2",
            [projectId, taskId]
          )
        );
        const task = await db.queryOne(
          "SELECT status,assignee,extra FROM tasks WHERE project_id=$1 AND id=$2",
          [projectId, taskId]
        );
        if (!oldPin || !task) governanceError("The held assignment is unavailable.");
        const cases = (
          await db.query("SELECT payload FROM review_cases WHERE project_id=$1 AND task_id=$2", [
            projectId,
            taskId,
          ])
        ).map((row) => unpack<ReviewCase>(row)!);
        if (
          task.status === "in_progress" ||
          task.status === "closed" ||
          String(task.assignee ?? "").trim() ||
          !(task.status === "blocked" || cases.some(isHeldCase))
        )
          governanceError(
            "Only a held, non-running task can be revalidated under replacement policy."
          );
        const state = await db.queryOne(
          "SELECT active_release_id,config FROM project_governance WHERE project_id=$1",
          [projectId]
        );
        if (
          !state?.active_release_id ||
          state.active_release_id !== input.expectedReleaseId ||
          state.active_release_id === oldPin.releaseId
        )
          governanceError(
            "Activate a different approved replacement policy and reload before revalidating."
          );
        if ((JSON.parse(String(state.config)) as GovernanceConfig).mode === "disabled")
          governanceError("Enable governed review before requesting policy revalidation.");
        const release = unpack<PolicyRelease>(
          await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
            projectId,
            input.expectedReleaseId,
          ])
        );
        if (!release || (await this.releaseRevokedInDb(db, projectId, release.id)))
          governanceError("Replacement policy is unavailable or critically revoked.");
        await verifyRelease?.(release, db);
        const next: GovernanceTaskPin = {
          ...oldPin,
          releaseId: release.id,
          instructionsByRole: { ...oldPin.instructionsByRole, ...release.instructions },
        };
        const changed = await db.execute(
          "UPDATE governance_task_pins SET release_id=$1,payload=$2 WHERE project_id=$3 AND task_id=$4 AND release_id=$5",
          [release.id, JSON.stringify(next), projectId, taskId, oldPin.releaseId]
        );
        if (changed !== 1)
          governanceError("Assignment policy changed concurrently; reload before revalidating.");
        await db.execute(
          "DELETE FROM governance_review_approvals WHERE project_id=$1 AND task_id=$2",
          [projectId, taskId]
        );
        for (const c of cases.filter((c) => c.releaseId === oldPin.releaseId)) {
          const superseded: ReviewCase = {
            ...c,
            state: "cancelled",
            supersededByReleaseId: release.id,
            version: c.version + 1,
            updatedAt: now(),
          };
          await db.execute(
            "UPDATE review_cases SET state='cancelled',version=$1,payload=$2 WHERE project_id=$3 AND id=$4 AND version=$5",
            [superseded.version, JSON.stringify(superseded), projectId, c.id, c.version]
          );
          await this.event(
            db,
            projectId,
            "case_superseded_by_policy_revalidation",
            actor,
            { previousCase: c, replacementReleaseId: release.id, rationale: input.rationale },
            c.id
          );
          await db.execute(
            "UPDATE open_questions SET status='resolved',resolved_at=$1 WHERE project_id=$2 AND id=$3",
            [superseded.updatedAt, projectId, `gov-${c.id}`]
          );
        }
        const extra = {
          ...JSON.parse(String(task.extra ?? "{}")),
          governance_resume: true,
          useExistingBranch: true,
          governance_revalidation_evidence: {
            previousReleaseId: oldPin.releaseId,
            replacementReleaseId: release.id,
            actor,
            rationale: input.rationale,
            cases: cases
              .filter((c) => c.releaseId === oldPin.releaseId)
              .map((c) => ({
                id: c.id,
                state: c.state,
                findings: c.findings,
                recommendation: c.recommendation,
              })),
          },
          block_reason: null,
        };
        await db.execute(
          "UPDATE tasks SET status='open',assignee=NULL,extra=$1,updated_at=$2 WHERE project_id=$3 AND id=$4",
          [JSON.stringify(extra), now(), projectId, taskId]
        );
        await this.event(db, projectId, "assignment_policy_revalidated", actor, {
          taskId,
          previousPin: oldPin,
          replacementPin: next,
          rationale: input.rationale,
          codeApprovalGranted: false,
        });
        return next;
      })
    );
  }
  async refreshContext(
    pin: GovernanceTaskPin,
    role: AgentRole,
    changedPaths: string[],
    components: string[] = []
  ): Promise<PolicyContext> {
    if (await this.isReleaseRevoked(pin.projectId, pin.releaseId))
      governanceError(
        "The assignment's governing policy was critically revoked; revalidation is required."
      );
    const release = await this.getRelease(pin.projectId, pin.releaseId);
    const config = await this.getConfig(pin.projectId);
    return resolvePolicyContext(
      { ...release, instructions: pin.instructionsByRole },
      role,
      changedPaths,
      components,
      config.contextMaxChars
    );
  }
  async getBudgetUsage(
    projectId: string,
    taskId: string
  ): Promise<{ tokens: number; costUsd: number; elapsedMs: number; appeals: number }> {
    const row = await (
      await this.deps.getDb()
    ).queryOne(
      "SELECT tokens,cost_usd,elapsed_ms,appeals FROM governance_task_pins WHERE project_id=$1 AND task_id=$2",
      [projectId, taskId]
    );
    return {
      tokens: Number(row?.tokens ?? 0),
      costUsd: Number(row?.cost_usd ?? 0),
      elapsedMs: Number(row?.elapsed_ms ?? 0),
      appeals: Number(row?.appeals ?? 0),
    };
  }
  async audit(
    projectId: string,
    kind: string,
    actor: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.deps.runWrite((db) => this.event(db, projectId, kind, actor, payload));
  }
  async consumeBudget(
    projectId: string,
    taskId: string,
    usage: { tokens?: number; costUsd?: number; elapsedMs?: number; appeals?: number }
  ): Promise<void> {
    const config = await this.getConfig(projectId);
    for (const v of Object.values(usage))
      if (typeof v !== "number" || v < 0 || !Number.isFinite(v))
        governanceError("Invalid adjudication budget usage.");
    await this.deps.runWrite(async (db) => {
      const row = await db.queryOne(
        "SELECT tokens,cost_usd,elapsed_ms,appeals FROM governance_task_pins WHERE project_id=$1 AND task_id=$2",
        [projectId, taskId]
      );
      if (!row) governanceError("Unpinned adjudication task.");
      const tokens = usage.tokens ?? 0;
      const cost = usage.costUsd ?? 0;
      const elapsed = usage.elapsedMs ?? 0;
      const appeals = usage.appeals ?? 0;
      // Conditional increments reserve against the latest row, including reservations by
      // other backend instances. A preceding SELECT is not a lock under PostgreSQL.
      const changed = await db.execute(
        "UPDATE governance_task_pins SET tokens=tokens+$1,cost_usd=cost_usd+$2,elapsed_ms=elapsed_ms+$3,appeals=appeals+$4 WHERE project_id=$5 AND task_id=$6 AND tokens+$7 <= $8 AND cost_usd+$9 <= $10 AND elapsed_ms+$11 <= $12 AND appeals+$13 <= $14",
        [
          tokens,
          cost,
          elapsed,
          appeals,
          projectId,
          taskId,
          tokens,
          config.maxTokens,
          cost,
          config.maxCostUsd,
          elapsed,
          config.maxElapsedMs,
          appeals,
          config.maxAppeals,
        ]
      );
      if (changed !== 1)
        governanceError(
          "Adjudication budget exhausted; an explicit human decision is required.",
          "GOVERNANCE_BUDGET_EXHAUSTED"
        );
    });
  }
  /** Expiry withdraws future authority; it never silently approves or removes an outstanding case. */
  private async pendingRemoteTaskIds(db: DbClient, projectId: string): Promise<Set<string>> {
    const events = (
      await db.query(
        "SELECT payload FROM governance_events WHERE project_id=$1 AND kind IN ('local_publication_registered','remote_publication_completed','remote_publication_attempt','remote_publication_superseded')",
        [projectId]
      )
    ).map((row) => unpack<GovernanceEvent>(row)!);
    const ids = (event: GovernanceEvent) =>
      Array.isArray(event.payload.receiptIds)
        ? event.payload.receiptIds.filter((value): value is string => typeof value === "string")
        : [];
    const completed = new Set(
      events.filter((event) => event.kind === "remote_publication_completed").flatMap(ids)
    );
    const attempted = new Set(
      events.filter((event) => event.kind === "remote_publication_attempt").flatMap(ids)
    );
    for (const event of events.filter((event) => event.kind === "remote_publication_superseded")) {
      const replacement = event.payload.replacementReceiptId;
      if (
        typeof replacement === "string" &&
        (attempted.has(replacement) || completed.has(replacement))
      )
        for (const receipt of ids(event)) completed.add(receipt);
    }
    const tasks = new Set<string>();
    for (const event of events.filter((event) => event.kind === "local_publication_registered")) {
      const receipt = event.payload.receipt as
        | {
            id?: string;
            taskId?: string;
            remoteExpected?: boolean;
            owners?: Array<{ taskId: string }>;
          }
        | undefined;
      if (!receipt?.id || receipt.remoteExpected === false || completed.has(receipt.id)) continue;
      if (receipt.taskId) tasks.add(receipt.taskId);
      for (const owner of receipt.owners ?? []) tasks.add(owner.taskId);
    }
    return tasks;
  }
  /**
   * A completed Git publication can be proved after a crash. Retire only its automatically
   * generated expiry hold, without restoring approval, changing a ruling, or clearing another hold.
   * Called under the publication lease after trusted origin ancestry verification.
   */
  async reconcilePublishedExpiryHolds(
    projectId: string,
    receiptIds: string[],
    publishedHeadSha: string
  ): Promise<void> {
    await this.deps.runWrite(async (db) => {
      const events = (
        await db.query(
          "SELECT payload FROM governance_events WHERE project_id=$1 AND kind IN ('local_publication_registered','remote_publication_completed','governance_allowance_expired')",
          [projectId]
        )
      ).map((row) => unpack<GovernanceEvent>(row)!);
      const proof = events.find(
        (event) =>
          event.kind === "remote_publication_completed" &&
          event.payload.recoveredFromOrigin === true &&
          event.payload.publishedHeadSha === publishedHeadSha &&
          receiptIds.every((id) => ((event.payload.receiptIds as string[]) ?? []).includes(id))
      );
      if (!proof)
        governanceError(
          "Trusted completed-publication proof is required for expiry reconciliation."
        );
      const affected = new Set<string>();
      for (const event of events.filter((event) => event.kind === "local_publication_registered")) {
        const receipt = event.payload.receipt as {
          id: string;
          taskId: string;
          owners?: Array<{ taskId: string }>;
        };
        if (receiptIds.includes(receipt.id)) {
          affected.add(receipt.taskId);
          for (const owner of receipt.owners ?? []) affected.add(owner.taskId);
        }
      }
      const cases = (
        await db.query("SELECT payload FROM review_cases WHERE project_id=$1", [projectId])
      ).map((row) => unpack<ReviewCase>(row)!);
      for (const c of cases) {
        if (
          !affected.has(c.taskId) ||
          c.state !== "stale" ||
          c.humanCancelled ||
          c.supersededByReleaseId ||
          c.publishedRemediationOnly
        )
          continue;
        const expiry = events.find(
          (event) =>
            event.kind === "governance_allowance_expired" &&
            event.caseId === c.id &&
            event.payload.version === c.version &&
            event.payload.previousTaskStatus === "closed"
        );
        if (!expiry) continue;
        const next: ReviewCase = {
          ...c,
          state: "cancelled",
          publishedRemediationOnly: true,
          version: c.version + 1,
          updatedAt: now(),
        };
        const updated = await db.execute(
          "UPDATE review_cases SET state='cancelled',version=$1,payload=$2 WHERE project_id=$3 AND id=$4 AND version=$5",
          [next.version, JSON.stringify(next), projectId, c.id, c.version]
        );
        if (updated !== 1) continue;
        Object.assign(c, next);
        const task = await db.queryOne(
          "SELECT status,extra,updated_at FROM tasks WHERE project_id=$1 AND id=$2",
          [projectId, c.taskId]
        );
        const otherHolds = cases.some(
          (other) => other.taskId === c.taskId && other.id !== c.id && isHeldCase(other)
        );
        const extra = JSON.parse(String(task?.extra ?? "{}")) as Record<string, unknown>;
        if (
          task?.status === "blocked" &&
          task.updated_at === expiry.payload.taskBlockedAt &&
          extra.block_reason === "Governance allowance expired" &&
          !otherHolds
        ) {
          await db.execute(
            "UPDATE tasks SET status='closed',extra=$1,updated_at=$2 WHERE project_id=$3 AND id=$4 AND updated_at=$5",
            [
              JSON.stringify({
                ...extra,
                block_reason: null,
                governance_remediation_required: {
                  caseId: c.id,
                  publishedHeadSha,
                  reason: "Allowance expiry discovered after completed publication",
                },
              }),
              next.updatedAt,
              projectId,
              c.taskId,
              task.updated_at,
            ]
          );
        }
        await db.execute(
          "UPDATE open_questions SET status='resolved',resolved_at=$1 WHERE project_id=$2 AND kind='governance' AND scope_change_metadata LIKE $3",
          [next.updatedAt, projectId, `%${c.id}%`]
        );
        await this.event(
          db,
          projectId,
          "published_expiry_remediation_only",
          "system",
          { receiptIds, publishedHeadSha, caseId: c.id, approvalRestored: false },
          c.id
        );
      }
    });
  }

  async refreshExpiredApprovals(projectId: string): Promise<void> {
    await this.deps.runWrite(async (db) => {
      const pendingRemoteTasks = await this.pendingRemoteTaskIds(db, projectId);
      const decisions = (
        await db.query("SELECT payload FROM policy_decisions WHERE project_id=$1", [projectId])
      ).map((row) => unpack<PolicyDecision>(row)!);
      const expired = new Set(
        decisions
          .filter(
            (decision) =>
              decision.action === "allow_reusable" &&
              decision.conditions &&
              Date.parse(decision.conditions.expiresAt) <= Date.now()
          )
          .map((decision) => decision.id)
      );
      if (!expired.size) return;
      const cases = (
        await db.query("SELECT payload FROM review_cases WHERE project_id=$1", [projectId])
      ).map((row) => unpack<ReviewCase>(row)!);
      for (const c of cases) {
        if (c.supersededByReleaseId) continue;
        if (holdStates.includes(c.state) || c.state === "fix_required") continue;
        const own = decisions.some(
          (decision) => decision.caseId === c.id && expired.has(decision.id)
        );
        const derived = c.verifiedDisposition?.decisionIds.some((decisionId) =>
          expired.has(decisionId)
        );
        if (!(c.state === "allowed" && own) && !derived) continue;
        const task = await db.queryOne(
          "SELECT status,extra FROM tasks WHERE project_id=$1 AND id=$2",
          [projectId, c.taskId]
        );
        // A completed publication keeps its historical ruling; expiry only forbids future reuse.
        if (task?.status === "closed" && !pendingRemoteTasks.has(c.taskId)) continue;
        const updatedAt = now();
        const next: ReviewCase = { ...c, state: "stale", version: c.version + 1, updatedAt };
        const count = await db.execute(
          "UPDATE review_cases SET state='stale',version=$1,payload=$2 WHERE project_id=$3 AND id=$4 AND version=$5",
          [next.version, JSON.stringify(next), projectId, c.id, c.version]
        );
        if (count !== 1) continue;
        await db.execute(
          "DELETE FROM governance_review_approvals WHERE project_id=$1 AND task_id=$2",
          [projectId, c.taskId]
        );
        if (task)
          await db.execute(
            "UPDATE tasks SET status='blocked',assignee=NULL,extra=$1,updated_at=$2 WHERE project_id=$3 AND id=$4",
            [
              JSON.stringify({
                ...JSON.parse(String(task.extra ?? "{}")),
                governance_resume: null,
                block_reason: "Governance allowance expired",
              }),
              updatedAt,
              projectId,
              c.taskId,
            ]
          );
        await this.event(
          db,
          projectId,
          "governance_allowance_expired",
          "system",
          {
            caseId: c.id,
            taskId: c.taskId,
            version: next.version,
            previousTaskStatus: task?.status ?? null,
            taskBlockedAt: updatedAt,
          },
          c.id
        );
        await db.execute(
          "INSERT INTO governance_outbox(project_id,id,case_id,state,payload) VALUES($1,$2,$3,'pending',$4) ON CONFLICT DO NOTHING",
          [
            projectId,
            `expiry-${c.id}-${next.version}`,
            c.id,
            JSON.stringify({ caseId: c.id, caseVersion: next.version }),
          ]
        );
      }
    });
  }
  async listCases(projectId: string): Promise<ReviewCase[]> {
    await this.refreshExpiredApprovals(projectId);
    return (
      await (
        await this.deps.getDb()
      ).query("SELECT payload FROM review_cases WHERE project_id=$1 ORDER BY created_at DESC", [
        projectId,
      ])
    ).map((r) => unpack<ReviewCase>(r)!);
  }
  async getTaskCases(projectId: string, taskId: string): Promise<ReviewCase[]> {
    return (await this.listCases(projectId)).filter((c) => c.taskId === taskId);
  }
  async getCase(projectId: string, caseId: string): Promise<ReviewCase> {
    await this.refreshExpiredApprovals(projectId);
    const c = unpack<ReviewCase>(
      await (
        await this.deps.getDb()
      ).queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
        projectId,
        caseId,
      ])
    );
    if (!c) governanceError("Review case not found.", "GOVERNANCE_NOT_FOUND", 404);
    return c;
  }
  async hasTaskHold(projectId: string, taskId: string): Promise<boolean> {
    return (await this.getTaskCases(projectId, taskId)).some(isHeldCase);
  }
  /** Called under the publication lock before a project can disappear from scheduling/UI. */
  async assertProjectRemovalAllowed(projectId: string, actor?: string): Promise<void> {
    const cases = await this.listCases(projectId);
    const config = await this.getConfig(projectId);
    if (config.mode === "disabled" && !cases.length && !(await this.getActiveReleaseId(projectId)))
      return;
    if (!actor?.trim())
      governanceError(
        "Removing a governed project requires the owner's approval capability.",
        "GOVERNANCE_HUMAN_REQUIRED",
        403
      );
    const db = await this.deps.getDb();
    const pendingRemote = await this.pendingRemoteTaskIds(db, projectId);
    const pendingTasks = await db.query(
      "SELECT t.id FROM tasks t JOIN governance_task_pins p ON p.project_id=t.project_id AND p.task_id=t.id WHERE t.project_id=$1 AND t.status<>'closed'",
      [projectId]
    );
    if (
      cases.some(
        (c) => isHeldCase(c) || (c.state === "fix_required" && !c.supersededByReleaseId)
      ) ||
      pendingTasks.length ||
      pendingRemote.size
    )
      governanceError(
        "Complete governed tasks and resolve their dockets and pending publication before removing the project.",
        "GOVERNANCE_HOLD"
      );
    await this.audit(projectId, "project_removal_authorized", actor, {
      scope: "archive_or_delete",
      evidenceRetained: true,
    });
  }
  /** An allowance is not completion: preserve its worktree until review/merge finishes. */
  async retainsTaskWorktree(projectId: string, taskId: string): Promise<boolean> {
    if (await this.hasPendingResume(projectId, taskId)) return true;
    const cases = await this.getTaskCases(projectId, taskId);
    if (cases.some(isHeldCase)) return true;
    if (
      !cases.some(
        (c) =>
          c.state === "allowed" ||
          (c.verifiedDisposition && c.verifiedDisposition.kind !== "fix_required")
      )
    )
      return false;
    const task = await (
      await this.deps.getDb()
    ).queryOne("SELECT status FROM tasks WHERE project_id=$1 AND id=$2", [projectId, taskId]);
    return Boolean(task && task.status !== "closed");
  }
  /** Recover ownership from task pins even when an ordinary lease row was lost. */
  async retainsWorktree(worktreeKey: string): Promise<boolean> {
    const rows = await (await this.deps.getDb()).query("SELECT payload FROM governance_task_pins");
    for (const row of rows) {
      const pin = unpack<GovernanceTaskPin>(row)!;
      if (
        pin.taskId !== worktreeKey &&
        pin.branchName !== worktreeKey &&
        pin.branchName !== `opensprint/${worktreeKey}`
      )
        continue;
      if (await this.retainsTaskWorktree(pin.projectId, pin.taskId)) return true;
    }
    return false;
  }
  async hasPendingResume(projectId: string, taskId: string): Promise<boolean> {
    const task = await (
      await this.deps.getDb()
    ).queryOne("SELECT status,extra FROM tasks WHERE project_id=$1 AND id=$2", [projectId, taskId]);
    return Boolean(
      task &&
      task.status !== "closed" &&
      JSON.parse(String(task.extra ?? "{}")).governance_resume === true
    );
  }
  async openCase(
    input: Omit<
      ReviewCase,
      "id" | "version" | "state" | "createdAt" | "updatedAt" | "evidenceHash"
    > & { idempotencyKey?: string; state?: ReviewCaseState }
  ): Promise<ReviewCase> {
    await this.refreshExpiredApprovals(input.projectId);
    const timestamp = now();
    const key =
      input.idempotencyKey ??
      governanceHash([
        input.taskId,
        input.releaseId,
        input.diffHash,
        input.findings.map((f) => f.id).sort(),
        input.appeals,
      ]);
    return this.withPublicationLock(input.projectId, () =>
      this.deps.runWrite(async (db) => {
        const existing = unpack<ReviewCase>(
          await db.queryOne(
            "SELECT payload FROM review_cases WHERE project_id=$1 AND idempotency_key=$2",
            [input.projectId, key]
          )
        );
        if (existing) return existing;
        if (input.evidence.invocationId || input.evidence.attempt !== undefined) {
          const task = await db.queryOne("SELECT status FROM tasks WHERE project_id=$1 AND id=$2", [
            input.projectId,
            input.taskId,
          ]);
          if (!task || task.status !== "in_progress")
            governanceError(
              "The reviewed task is no longer active; a late invocation cannot recreate a case after cancellation or retry."
            );
        }
        const release = unpack<PolicyRelease>(
          await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
            input.projectId,
            input.releaseId,
          ])
        );
        if (!release) governanceError("Case policy release is unavailable.");
        for (const f of input.findings) {
          if (!f.id || !f.file || !f.codeRevision || !f.evidence?.trim())
            governanceError("Every finding needs an identity and concrete code evidence.");
          if (
            f.category === "standard" &&
            (!f.ruleRevisionId ||
              !release.rules.some((r) => r.id === f.ruleRevisionId && r.ruleId === f.ruleId))
          )
            governanceError("Blocking standards findings must cite a governing rule revision.");
        }
        const c: ReviewCase = {
          ...input,
          id: id("case"),
          version: 1,
          state: input.state ?? "awaiting_human",
          evidenceHash: governanceHash(input.evidence),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await db.execute(
          "INSERT INTO review_cases(project_id,id,task_id,release_id,state,version,idempotency_key,payload,created_at) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8)",
          [c.projectId, c.id, c.taskId, c.releaseId, c.state, key, JSON.stringify(c), timestamp]
        );
        for (const finding of c.findings)
          await db.execute(
            "INSERT INTO review_findings(project_id,case_id,id,payload) VALUES($1,$2,$3,$4)",
            [c.projectId, c.id, finding.id, JSON.stringify(finding)]
          );
        if (holdStates.includes(c.state)) {
          const task = await db.queryOne("SELECT extra FROM tasks WHERE project_id=$1 AND id=$2", [
            c.projectId,
            c.taskId,
          ]);
          await db.execute(
            "UPDATE tasks SET status='blocked',assignee=NULL,extra=$1,updated_at=$2 WHERE project_id=$3 AND id=$4",
            [
              JSON.stringify({
                ...JSON.parse(String(task?.extra ?? "{}")),
                governance_case_id: c.id,
                block_reason: "Review governance: waiting for a human ruling",
              }),
              timestamp,
              c.projectId,
              c.taskId,
            ]
          );
        }
        await db.execute(
          "INSERT INTO governance_outbox(project_id,id,case_id,state,payload) VALUES($1,$2,$3,'pending',$4)",
          [c.projectId, `docket-${c.id}`, c.id, JSON.stringify({ caseId: c.id })]
        );
        await this.event(
          db,
          c.projectId,
          "case_opened",
          "system",
          { caseId: c.id, taskId: c.taskId, state: c.state, evidenceHash: c.evidenceHash },
          c.id
        );
        return c;
      })
    );
  }
  async recordRecommendation(
    projectId: string,
    caseId: string,
    recommendation: JudgeRecommendation,
    expectedVersion: number
  ): Promise<ReviewCase> {
    return this.deps.runWrite(async (db) => {
      const c = unpack<ReviewCase>(
        await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
          projectId,
          caseId,
        ])
      );
      if (!c || c.version !== expectedVersion || !holdStates.includes(c.state))
        governanceError("Late judge result cannot change this case.");
      const next = {
        ...c,
        recommendation,
        state: "awaiting_human" as const,
        version: c.version + 1,
        updatedAt: now(),
      };
      const count = await db.execute(
        "UPDATE review_cases SET state=$1,version=$2,payload=$3 WHERE project_id=$4 AND id=$5 AND version=$6",
        [next.state, next.version, JSON.stringify(next), projectId, caseId, expectedVersion]
      );
      if (count !== 1) governanceError("Concurrent case update.");
      await this.event(db, projectId, "judge_recommended", "judge", { recommendation }, caseId);
      await db.execute(
        "UPDATE governance_jobs SET state='complete' WHERE project_id=$1 AND id IN ($2,$3)",
        [projectId, `${caseId}:reconsideration`, `${caseId}:judge`]
      );
      return next;
    });
  }
  /** Claim once before external invocation. Restart recovery escalates incomplete claims instead of respawning. */
  async claimCaseJob(
    projectId: string,
    caseId: string,
    stage: "reconsideration" | "judge",
    expectedVersion: number
  ): Promise<boolean> {
    return this.deps.runWrite(async (db) => {
      const c = unpack<ReviewCase>(
        await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
          projectId,
          caseId,
        ])
      );
      const expectedState =
        stage === "reconsideration" ? "awaiting_reconsideration" : "awaiting_judge";
      if (!c || c.version !== expectedVersion || c.state !== expectedState) return false;
      const findingKeys = c.findings
        .filter((f) => f.severity === "blocking")
        .map(
          (f) =>
            `finding-cycle-${governanceHash([c.taskId, c.diffHash, f.id, f.ruleRevisionId, stage])}`
        )
        .sort();
      for (const key of findingKeys) {
        const existing = await db.queryOne(
          "SELECT id FROM governance_jobs WHERE project_id=$1 AND id=$2",
          [projectId, key]
        );
        if (existing) return false;
      }
      for (const key of findingKeys) {
        const inserted = await db.execute(
          "INSERT INTO governance_jobs(project_id,id,kind,state,payload)VALUES($1,$2,'finding_appeal_cycle','claimed',$3) ON CONFLICT DO NOTHING",
          [projectId, key, JSON.stringify({ caseId, stage, diffHash: c.diffHash })]
        );
        if (inserted !== 1) return false;
      }
      return (
        (await db.execute(
          "INSERT INTO governance_jobs(project_id,id,kind,state,payload) VALUES($1,$2,$3,'running',$4) ON CONFLICT DO NOTHING",
          [projectId, `${caseId}:${stage}`, stage, JSON.stringify({ caseId, expectedVersion })]
        )) === 1
      );
    });
  }

  /** Preserve omitted blockers; reconsideration is a single versioned transition per material case. */
  async recordReconsideration(
    projectId: string,
    caseId: string,
    result: ReviewAgentResult,
    expectedVersion: number
  ): Promise<ReviewCase> {
    return this.deps.runWrite(async (db) => {
      const c = unpack<ReviewCase>(
        await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
          projectId,
          caseId,
        ])
      );
      if (
        !c ||
        c.version !== expectedVersion ||
        c.state !== "awaiting_reconsideration" ||
        c.reconsideration
      )
        governanceError("Reviewer reconsideration is stale or already exhausted.");
      const release = unpack<PolicyRelease>(
        await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
          projectId,
          c.releaseId,
        ])
      );
      if (!release) governanceError("Governing policy unavailable.");
      const withdrawn = new Set(result.withdrawnFindingIds ?? []);
      for (const findingId of withdrawn) {
        const f = c.findings.find((f) => f.id === findingId);
        if (
          !f ||
          f.category !== "standard" ||
          !release.rules.some(
            (r) =>
              r.id === f.ruleRevisionId &&
              r.severity === "standard" &&
              (r.exceptionEligible ||
                (!r.components.length &&
                  !resolvePolicyContext(
                    release,
                    "reviewer",
                    [f.file],
                    [],
                    Number.MAX_SAFE_INTEGER
                  ).receipt.selected.some((selected) => selected.id === r.id)))
          )
        )
          governanceError(
            "Only an original exception-eligible standard can be withdrawn through this appeal."
          );
      }
      const findings = c.findings.filter((f) => !withdrawn.has(f.id));
      for (const f of result.findings ?? []) {
        if (f.codeRevision !== c.headSha || !c.changedPaths.includes(f.file))
          governanceError("Reconsideration evidence is not anchored to the reviewed code.");
        if (
          f.category === "standard" &&
          !release.rules.some((r) => r.id === f.ruleRevisionId && r.ruleId === f.ruleId)
        )
          governanceError("Reconsideration cited an unapproved standard.");
        const original = c.findings.find((old) => old.id === f.id);
        if (
          original &&
          (original.category !== f.category ||
            original.ruleRevisionId !== f.ruleRevisionId ||
            original.file !== f.file ||
            withdrawn.has(f.id))
        )
          governanceError("Reconsideration cannot silently replace or withdraw another finding.");
        if (!findings.some((old) => old.id === f.id)) findings.push(f);
      }
      const blockers = findings.filter((f) => f.severity === "blocking");
      const state: ReviewCaseState =
        blockers.length === 0 && result.status === "approved"
          ? "cancelled"
          : blockers.some((f) => f.category !== "standard")
            ? "fix_required"
            : "awaiting_judge";
      const next: ReviewCase = {
        ...c,
        findings,
        reconsideration: result,
        state,
        version: c.version + 1,
        updatedAt: now(),
        ...(state === "cancelled"
          ? { verifiedDisposition: { kind: "reviewer_withdrew", decisionIds: [] } }
          : {}),
      };
      const count = await db.execute(
        "UPDATE review_cases SET state=$1,version=$2,payload=$3 WHERE project_id=$4 AND id=$5 AND version=$6",
        [state, next.version, JSON.stringify(next), projectId, caseId, expectedVersion]
      );
      if (count !== 1) governanceError("Concurrent reconsideration.");
      await this.event(
        db,
        projectId,
        "reviewer_reconsidered",
        "reviewer",
        { result, state },
        caseId
      );
      await db.execute(
        "UPDATE governance_jobs SET state='complete' WHERE project_id=$1 AND id=$2",
        [projectId, `${caseId}:reconsideration`]
      );
      if (state === "cancelled") await this.finishVerifiedCase(db, c, next);
      return next;
    });
  }

  /** Deterministic authority checks; the model's confidence and claimed predicates confer no authority. */
  async applyVerifiedDisposition(
    projectId: string,
    caseId: string,
    kind: "finding_not_applicable" | "precedent_applied" | "fix_required",
    expectedVersion: number
  ): Promise<ReviewCase> {
    return this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        const c = unpack<ReviewCase>(
          await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
            projectId,
            caseId,
          ])
        );
        if (!c || c.version !== expectedVersion || c.state !== "awaiting_human")
          governanceError("Disposition is stale or already resolved.");
        const release = unpack<PolicyRelease>(
          await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
            projectId,
            c.releaseId,
          ])
        );
        if (!release) governanceError("Governing policy unavailable.");
        const blockers = c.findings.filter((f) => f.severity === "blocking");
        if (
          !blockers.length ||
          blockers.some(
            (f) =>
              f.category !== "standard" ||
              !release.rules.some(
                (r) =>
                  r.id === f.ruleRevisionId &&
                  r.severity === "standard" &&
                  (kind !== "precedent_applied" || r.exceptionEligible)
              )
          )
        )
          governanceError(
            "This disposition cannot waive a defect, constraint, hard gate, or unsupported finding."
          );
        const decisionIds: string[] = [];
        if (kind === "finding_not_applicable") {
          for (const f of blockers) {
            const r = release.rules.find((r) => r.id === f.ruleRevisionId)!;
            if (r.components.length)
              governanceError("Unverified component facts cannot authorize dismissal.");
            const context = resolvePolicyContext(
              release,
              "reviewer",
              [f.file],
              [],
              Number.MAX_SAFE_INTEGER
            );
            if (context.receipt.selected.some((s) => s.id === r.id))
              governanceError(
                "The cited standard applies; a model cannot dismiss it without existing authority."
              );
          }
        }
        if (kind === "precedent_applied") {
          const events = (
            await db.query("SELECT payload FROM governance_events WHERE project_id=$1", [projectId])
          ).map((r) => unpack<GovernanceEvent>(r)!);
          const decisions = (
            await db.query("SELECT payload FROM policy_decisions WHERE project_id=$1", [projectId])
          )
            .map((r) => unpack<PolicyDecision>(r)!)
            .filter(
              (d) =>
                !events.some((e) => e.kind === "decision_revoked" && e.payload.decisionId === d.id)
            );
          const compatible = decisions.filter(
            (d) =>
              d.ruleRevisionIds.some((id) => blockers.some((f) => f.ruleRevisionId === id)) &&
              d.ruleRevisionIds.every((id) => release.rules.some((r) => r.id === id))
          );
          for (const contrary of compatible.filter((d) => d.action === "require_fix")) {
            const old = unpack<ReviewCase>(
              await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
                projectId,
                contrary.caseId,
              ])
            );
            if (old?.changedPaths.some((p) => c.changedPaths.includes(p)))
              governanceError("Conflicting precedent requires an explicit human ruling.");
          }
          const reusable = compatible.filter(
            (d) =>
              d.action === "allow_reusable" &&
              d.conditions?.version === 1 &&
              Date.parse(d.conditions.expiresAt) > Date.now() &&
              d.conditions.ruleRevisionIds.every((id) =>
                blockers.some((f) => f.ruleRevisionId === id)
              ) &&
              c.changedPaths.every((p) =>
                d.conditions!.paths.some((pattern) => matchesPolicyPath(pattern, p))
              )
          );
          for (const f of blockers) {
            const match = reusable.find((d) =>
              d.conditions!.ruleRevisionIds.includes(f.ruleRevisionId!)
            );
            if (!match)
              governanceError(
                "No explicit compatible human reusable conditions cover every finding and trusted path."
              );
            if (!decisionIds.includes(match.id)) decisionIds.push(match.id);
          }
        }
        const state: ReviewCaseState = kind === "fix_required" ? "fix_required" : "cancelled";
        const next: ReviewCase = {
          ...c,
          state,
          version: c.version + 1,
          updatedAt: now(),
          verifiedDisposition: { kind, decisionIds },
        };
        const count = await db.execute(
          "UPDATE review_cases SET state=$1,version=$2,payload=$3 WHERE project_id=$4 AND id=$5 AND version=$6",
          [state, next.version, JSON.stringify(next), projectId, caseId, expectedVersion]
        );
        if (count !== 1) governanceError("Concurrent verified disposition.");
        await this.event(
          db,
          projectId,
          "verified_disposition",
          "judge",
          { kind, decisionIds },
          caseId
        );
        await this.finishVerifiedCase(db, c, next);
        return next;
      })
    );
  }

  /** Retain historical cases while retiring only blockers covered by an exact internal disposition. */
  private async finishVerifiedCase(
    db: DbClient,
    original: ReviewCase,
    next: ReviewCase
  ): Promise<void> {
    if (next.state === "cancelled") {
      const previous = (
        await db.query(
          "SELECT payload FROM review_cases WHERE project_id=$1 AND task_id=$2 AND state='fix_required'",
          [original.projectId, original.taskId]
        )
      ).map((r) => unpack<ReviewCase>(r)!);
      for (const old of previous) {
        if (
          old.id === original.id ||
          old.diffHash !== original.diffHash ||
          old.headSha !== original.headSha ||
          old.releaseId !== original.releaseId ||
          !old.findings
            .filter((f) => f.severity === "blocking")
            .every((f) => original.findings.some((n) => canonicalJson(n) === canonicalJson(f)))
        )
          continue;
        const retired = {
          ...old,
          state: "cancelled" as const,
          version: old.version + 1,
          updatedAt: next.updatedAt,
        };
        await db.execute(
          "UPDATE review_cases SET state='cancelled',version=$1,payload=$2 WHERE project_id=$3 AND id=$4",
          [retired.version, JSON.stringify(retired), old.projectId, old.id]
        );
        await this.event(
          db,
          old.projectId,
          "finding_superseded_by_disposition",
          "system",
          { caseId: next.id },
          old.id
        );
      }
    }
    const holds = await db.query(
      "SELECT id FROM review_cases WHERE project_id=$1 AND task_id=$2 AND state IN ('awaiting_reconsideration','awaiting_judge','awaiting_human','evidence_requested','stale') LIMIT 1",
      [original.projectId, original.taskId]
    );
    if (!holds.length)
      await db.execute(
        "UPDATE tasks SET status='in_progress',updated_at=$1 WHERE project_id=$2 AND id=$3 AND status='blocked'",
        [next.updatedAt, original.projectId, original.taskId]
      );
    await db.execute(
      "UPDATE open_questions SET status='resolved',resolved_at=$1 WHERE project_id=$2 AND kind='governance' AND source_id=$3",
      [next.updatedAt, original.projectId, original.taskId]
    );
  }

  async listDecisions(projectId: string): Promise<PolicyDecision[]> {
    const db = await this.deps.getDb();
    const decisions = (
      await db.query(
        "SELECT payload FROM policy_decisions WHERE project_id=$1 ORDER BY created_at DESC",
        [projectId]
      )
    ).map((r) => unpack<PolicyDecision>(r)!);
    const revocations = (await this.listEvents(projectId, ["decision_revoked"])).filter(
      (e) => e.kind === "decision_revoked"
    );
    return decisions.map((d) => ({
      ...d,
      ...(revocations.find((e) => e.payload.decisionId === d.id)
        ? { revokedAt: revocations.find((e) => e.payload.decisionId === d.id)!.createdAt }
        : {}),
    }));
  }
  async listEvents(projectId: string, kinds?: readonly string[]): Promise<GovernanceEvent[]> {
    if (kinds?.length === 0) return [];
    return (
      await (
        await this.deps.getDb()
      ).query(
        `SELECT payload FROM governance_events WHERE project_id=$1${kinds ? ` AND kind IN (${kinds.map((_, i) => `$${i + 2}`).join(",")})` : ""} ORDER BY created_at,id`,
        [projectId, ...(kinds ?? [])]
      )
    ).map((r) => unpack<GovernanceEvent>(r)!);
  }
  /** Full prompts/context remain retained, but polling the docket must not transfer them. */
  async listAuditEvents(projectId: string): Promise<GovernanceEvent[]> {
    const db = await this.deps.getDb();
    return (
      await db.query(
        "SELECT payload FROM governance_events WHERE project_id=$1 AND kind<>'prompt_snapshot' ORDER BY created_at,id",
        [projectId]
      )
    ).map((row) => unpack<GovernanceEvent>(row)!);
  }
  async resolveCase(
    projectId: string,
    caseId: string,
    input: ResolveGovernanceCaseInput,
    actor: string
  ): Promise<PolicyDecision> {
    return this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        const existing = unpack<PolicyDecision>(
          await db.queryOne(
            "SELECT payload FROM policy_decisions WHERE project_id=$1 AND idempotency_key=$2",
            [projectId, input.idempotencyKey]
          )
        );
        if (existing) {
          if (
            existing.caseId !== caseId ||
            existing.action !== input.action ||
            existing.rationale !== input.rationale ||
            existing.headSha !== input.headSha ||
            existing.diffHash !== input.diffHash ||
            canonicalJson(existing.conditions) !== canonicalJson(input.conditions)
          )
            governanceError("Idempotency key is already bound to a different ruling.");
          return existing;
        }
        const c = unpack<ReviewCase>(
          await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
            projectId,
            caseId,
          ])
        );
        if (!c || c.version !== input.expectedVersion || !isHeldCase(c))
          governanceError("Case changed or was already decided; reload before approving.");
        if (!input.idempotencyKey?.trim() || !input.rationale?.trim() || !actor?.trim())
          governanceError("Named human, rationale, and idempotency key are required.");
        if (c.headSha !== input.headSha || c.diffHash !== input.diffHash)
          governanceError("This ruling is bound to stale code.", "GOVERNANCE_STALE_CODE");
        if ((c.state === "stale" || c.humanCancelled) && input.action.startsWith("allow"))
          governanceError(
            "A stale case requires a fresh review before it can grant an allowance.",
            "GOVERNANCE_STALE_CODE"
          );
        const release = unpack<PolicyRelease>(
          await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
            projectId,
            c.releaseId,
          ])
        )!;
        if (
          !["require_fix", "allow_once", "allow_reusable", "request_evidence", "cancel"].includes(
            input.action
          )
        )
          governanceError("Invalid human ruling action.");
        if (input.action.startsWith("allow")) {
          if (
            c.findings.some(
              (f) =>
                f.severity === "blocking" &&
                (f.category !== "standard" ||
                  !release.rules.some(
                    (r) =>
                      r.id === f.ruleRevisionId && r.exceptionEligible && r.severity === "standard"
                  ))
            )
          )
            governanceError(
              "Human exceptions cannot waive defects, security constraints, hard gates, or non-waivable standards."
            );
        }
        if (input.action === "allow_reusable") {
          const cond = input.conditions;
          if (
            !cond ||
            cond.version !== 1 ||
            !Array.isArray(cond.paths) ||
            !cond.paths.length ||
            !Array.isArray(cond.ruleRevisionIds) ||
            !cond.ruleRevisionIds.length ||
            !Number.isFinite(Date.parse(cond.expiresAt)) ||
            Date.parse(cond.expiresAt) <= Date.now()
          )
            governanceError(
              "Reusable rulings require explicit versioned paths, rule revisions, and a future expiry."
            );
          if (
            cond.ruleRevisionIds.some((r) => !c.findings.some((f) => f.ruleRevisionId === r)) ||
            !c.changedPaths.every((p) => cond.paths.some((g) => matchesPolicyPath(g, p)))
          )
            governanceError(
              "Reusable conditions must cover the reviewed facts and only the reviewed rules."
            );
        }
        const d: PolicyDecision = {
          id: id("decision"),
          projectId,
          caseId,
          taskId: c.taskId,
          releaseId: c.releaseId,
          action: input.action,
          actor,
          rationale: input.rationale,
          headSha: c.headSha,
          diffHash: c.diffHash,
          findingIds: c.findings.map((f) => f.id),
          ruleRevisionIds: [
            ...new Set(c.findings.flatMap((f) => (f.ruleRevisionId ? [f.ruleRevisionId] : []))),
          ],
          ...(input.action === "allow_reusable" ? { conditions: input.conditions } : {}),
          createdAt: now(),
        };
        const state: ReviewCaseState = input.action.startsWith("allow")
          ? "allowed"
          : input.action === "require_fix"
            ? "fix_required"
            : input.action === "cancel"
              ? "cancelled"
              : "evidence_requested";
        const next = {
          ...c,
          state,
          version: c.version + 1,
          updatedAt: d.createdAt,
          humanCancelled: input.action === "cancel",
        };
        await db.execute(
          "INSERT INTO policy_decisions(project_id,id,case_id,idempotency_key,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)",
          [projectId, d.id, caseId, input.idempotencyKey, JSON.stringify(d), d.createdAt]
        );
        const count = await db.execute(
          "UPDATE review_cases SET state=$1,version=$2,payload=$3 WHERE project_id=$4 AND id=$5 AND version=$6",
          [state, next.version, JSON.stringify(next), projectId, caseId, input.expectedVersion]
        );
        if (count !== 1) governanceError("Concurrent ruling; retry with the same idempotency key.");
        const others = await db.query(
          "SELECT payload FROM review_cases WHERE project_id=$1 AND task_id=$2 AND id<>$3",
          [projectId, c.taskId, c.id]
        );
        if (
          !holdStates.includes(state) &&
          !others.some((row) => isHeldCase(unpack<ReviewCase>(row)!))
        ) {
          const task = await db.queryOne("SELECT extra FROM tasks WHERE project_id=$1 AND id=$2", [
            projectId,
            c.taskId,
          ]);
          if (task) {
            const extra = {
              ...JSON.parse(String(task.extra ?? "{}")),
              governance_resume: state === "allowed" ? true : null,
              ...(["allowed", "fix_required"].includes(state) ? { useExistingBranch: true } : {}),
              ...(state === "fix_required"
                ? {
                    next_retry_context: {
                      ...JSON.parse(String(task.extra ?? "{}")).next_retry_context,
                      previousFailure: `Human governance ruling requires a fix: ${d.rationale}`,
                      reviewFeedback: `Human authority ${d.actor} requires the cited findings to be addressed. This ruling grants no exception.\nRationale: ${d.rationale}\nFindings: ${JSON.stringify(c.findings)}`,
                      useExistingBranch: true,
                      failureType: "review_rejection",
                    },
                  }
                : {}),
              block_reason: state === "cancelled" ? "Governance case cancelled" : null,
            };
            await db.execute(
              "UPDATE tasks SET status=$1,assignee=NULL,extra=$2,updated_at=$3 WHERE project_id=$4 AND id=$5",
              [
                state === "cancelled" ? "blocked" : "open",
                JSON.stringify(extra),
                d.createdAt,
                projectId,
                c.taskId,
              ]
            );
          }
        }
        if (input.action !== "request_evidence" && input.action !== "cancel")
          await db.execute(
            "UPDATE open_questions SET status='resolved',resolved_at=$1 WHERE project_id=$2 AND kind='governance' AND scope_change_metadata LIKE $3",
            [d.createdAt, projectId, `%${caseId}%`]
          );
        await this.event(
          db,
          projectId,
          "human_ruling",
          actor,
          { decisionId: d.id, action: d.action, taskId: c.taskId },
          caseId
        );
        await db.execute(
          "INSERT INTO governance_jobs(project_id,id,kind,state,payload) VALUES($1,$2,'mine_decisions','pending',$3) ON CONFLICT DO NOTHING",
          [projectId, `mine-${d.id}`, JSON.stringify({ decisionId: d.id })]
        );
        if (state === "allowed") {
          const previous = (
            await db.query(
              "SELECT payload FROM review_cases WHERE project_id=$1 AND task_id=$2 AND state='fix_required'",
              [projectId, c.taskId]
            )
          ).map((r) => unpack<ReviewCase>(r)!);
          for (const old of previous)
            if (
              old.diffHash === c.diffHash &&
              old.headSha === c.headSha &&
              old.releaseId === c.releaseId &&
              old.findings.every((f) =>
                c.findings.some((cf) => canonicalJson(cf) === canonicalJson(f))
              )
            ) {
              const superseded = {
                ...old,
                state: "cancelled" as const,
                version: old.version + 1,
                updatedAt: now(),
              };
              await db.execute(
                "UPDATE review_cases SET state='cancelled',version=$1,payload=$2 WHERE project_id=$3 AND id=$4",
                [superseded.version, JSON.stringify(superseded), projectId, old.id]
              );
              await this.event(
                db,
                projectId,
                "finding_superseded_by_ruling",
                actor,
                { decisionId: d.id, caseId: old.id },
                old.id
              );
            }
        }
        return d;
      })
    );
  }
  async appendCaseEvidence(
    projectId: string,
    caseId: string,
    expectedVersion: number,
    evidence: Record<string, unknown>,
    actor: string
  ): Promise<ReviewCase> {
    return this.deps.runWrite(async (db) => {
      const c = unpack<ReviewCase>(
        await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
          projectId,
          caseId,
        ])
      );
      if (!c || c.version !== expectedVersion || c.state !== "evidence_requested")
        governanceError("Evidence request changed; reload before submitting.");
      const next = {
        ...c,
        state: "awaiting_human" as const,
        evidence: { ...c.evidence, additionalEvidence: evidence },
        evidenceHash: governanceHash({ ...c.evidence, additionalEvidence: evidence }),
        version: c.version + 1,
        updatedAt: now(),
      };
      const changed = await db.execute(
        "UPDATE review_cases SET state=$1,version=$2,payload=$3 WHERE project_id=$4 AND id=$5 AND version=$6",
        [next.state, next.version, JSON.stringify(next), projectId, caseId, expectedVersion]
      );
      if (changed !== 1)
        governanceError("Case changed concurrently while adding evidence; reload before retrying.");
      await this.event(
        db,
        projectId,
        "case_evidence_added",
        actor,
        { evidence, evidenceHash: next.evidenceHash },
        caseId
      );
      await db.execute(
        "INSERT INTO governance_outbox(project_id,id,case_id,state,payload) VALUES($1,$2,$3,'pending',$4) ON CONFLICT DO NOTHING",
        [
          projectId,
          `evidence-${caseId}-${next.version}`,
          caseId,
          JSON.stringify({ caseId, caseVersion: next.version }),
        ]
      );
      return next;
    });
  }
  async revokeDecision(
    projectId: string,
    decisionId: string,
    rationale: string,
    actor: string
  ): Promise<void> {
    await this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        const d = unpack<PolicyDecision>(
          await db.queryOne("SELECT payload FROM policy_decisions WHERE project_id=$1 AND id=$2", [
            projectId,
            decisionId,
          ])
        );
        if (!d) governanceError("Decision not found.", "GOVERNANCE_NOT_FOUND", 404);
        if (!rationale?.trim()) governanceError("Revocation rationale is required.");
        const c = unpack<ReviewCase>(
          await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
            projectId,
            d.caseId,
          ])
        );
        await this.event(
          db,
          projectId,
          "decision_revoked",
          actor,
          { decisionId, rationale },
          d.caseId
        );
        const pendingRemoteTasks = await this.pendingRemoteTaskIds(db, projectId);
        const affected = (
          await db.query("SELECT payload FROM review_cases WHERE project_id=$1", [projectId])
        )
          .map((row) => unpack<ReviewCase>(row)!)
          .filter(
            (candidate) =>
              candidate.id === c?.id ||
              candidate.verifiedDisposition?.decisionIds.includes(decisionId)
          );
        for (const affectedCase of affected) {
          const task = await db.queryOne(
            "SELECT status,extra FROM tasks WHERE project_id=$1 AND id=$2",
            [projectId, affectedCase.taskId]
          );
          if (task?.status === "closed" && !pendingRemoteTasks.has(affectedCase.taskId)) {
            const extra = {
              ...JSON.parse(String(task.extra ?? "{}")),
              governance_remediation_required: {
                decisionId,
                caseId: affectedCase.id,
                rationale,
                createdAt: now(),
              },
            };
            await db.execute(
              "UPDATE tasks SET extra=$1,updated_at=$2 WHERE project_id=$3 AND id=$4",
              [JSON.stringify(extra), now(), projectId, affectedCase.taskId]
            );
            await this.event(
              db,
              projectId,
              "published_ruling_revoked_remediation_required",
              actor,
              { taskId: affectedCase.taskId, caseId: affectedCase.id, decisionId, rationale },
              affectedCase.id
            );
            continue;
          }
          const next = {
            ...affectedCase,
            state: "stale" as const,
            version: affectedCase.version + 1,
            updatedAt: now(),
          };
          await db.execute(
            "UPDATE review_cases SET state='stale',version=$1,payload=$2 WHERE project_id=$3 AND id=$4",
            [next.version, JSON.stringify(next), projectId, affectedCase.id]
          );
          await db.execute(
            "DELETE FROM governance_review_approvals WHERE project_id=$1 AND task_id=$2",
            [projectId, affectedCase.taskId]
          );
          await db.execute(
            "UPDATE tasks SET status='blocked',updated_at=$1 WHERE project_id=$2 AND id=$3",
            [now(), projectId, affectedCase.taskId]
          );
          await db.execute(
            "INSERT INTO governance_outbox(project_id,id,case_id,state,payload)VALUES($1,$2,$3,'pending',$4) ON CONFLICT DO NOTHING",
            [
              projectId,
              `revocation-${decisionId}-${affectedCase.id}`,
              affectedCase.id,
              JSON.stringify({ caseId: affectedCase.id }),
            ]
          );
        }
      })
    );
  }
  async findPrecedent(
    projectId: string,
    releaseId: string,
    ruleRevisionIds: string[],
    changedPaths: string[]
  ): Promise<PolicyDecision[]> {
    const release = await this.getRelease(projectId, releaseId);
    const revisionIds = new Set(release.rules.map((r) => r.id));
    return (await this.listDecisions(projectId)).filter(
      (d) =>
        !d.revokedAt &&
        d.releaseId === releaseId &&
        d.ruleRevisionIds.some((r) => ruleRevisionIds.includes(r)) &&
        d.ruleRevisionIds.every((r) => revisionIds.has(r)) &&
        (d.action !== "allow_reusable" ||
          Boolean(
            d.conditions &&
            d.conditions.version === 1 &&
            Date.parse(d.conditions.expiresAt) > Date.now() &&
            d.conditions.ruleRevisionIds.every((r) => ruleRevisionIds.includes(r)) &&
            changedPaths.every((p) => d.conditions!.paths.some((g) => matchesPolicyPath(g, p)))
          ))
    );
  }
  async recordReviewApproval(input: {
    projectId: string;
    taskId: string;
    headSha: string;
    diffHash: string;
    releaseId: string;
    receipt: PolicyContextReceipt;
    gatePassed: true;
    scopeBaseSha?: string;
    changedPaths?: string[];
  }): Promise<void> {
    if (
      !input.gatePassed ||
      input.receipt.truncated ||
      input.receipt.conflicts.length ||
      input.receipt.releaseId !== input.releaseId
    )
      governanceError("Incomplete review cannot authorize merging.");
    await this.deps.runWrite(async (db) => {
      if (await this.releaseRevokedInDb(db, input.projectId, input.releaseId))
        governanceError("Critically revoked policy cannot authorize a review approval.");
      await db.execute(
        "INSERT INTO governance_review_approvals(project_id,task_id,head_sha,diff_hash,release_id,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,task_id) DO UPDATE SET head_sha=excluded.head_sha,diff_hash=excluded.diff_hash,release_id=excluded.release_id,payload=excluded.payload",
        [
          input.projectId,
          input.taskId,
          input.headSha,
          input.diffHash,
          input.releaseId,
          JSON.stringify({ ...input, createdAt: now() }),
        ]
      );
      const cases = (
        await db.query(
          "SELECT payload FROM review_cases WHERE project_id=$1 AND task_id=$2 AND state IN ('fix_required','allowed')",
          [input.projectId, input.taskId]
        )
      ).map((r) => unpack<ReviewCase>(r)!);
      for (const c of cases)
        if (c.diffHash !== input.diffHash) {
          const next = {
            ...c,
            state: "cancelled" as const,
            version: c.version + 1,
            updatedAt: now(),
          };
          await db.execute(
            "UPDATE review_cases SET state='cancelled',version=$1,payload=$2 WHERE project_id=$3 AND id=$4",
            [next.version, JSON.stringify(next), input.projectId, c.id]
          );
          await this.event(
            db,
            input.projectId,
            "finding_fixed",
            "reviewer",
            { headSha: input.headSha },
            c.id
          );
        }
    });
  }
  async assertMergeAdmission(input: {
    projectId: string;
    taskId: string;
    headSha: string;
    diffHash: string;
    changedPaths: string[];
    baseSha?: string;
  }): Promise<void> {
    const cases = await this.getTaskCases(input.projectId, input.taskId);
    if (cases.some(isHeldCase))
      governanceError("Unresolved durable governance hold prevents merging.", "GOVERNANCE_HOLD");
    const pin = await this.getTaskPin(input.projectId, input.taskId);
    if (pin && (await this.isReleaseRevoked(input.projectId, pin.releaseId)))
      governanceError("Governing policy was critically revoked.");
    if (!pin || pin.mode === "shadow") return;
    const approval = await (
      await this.deps.getDb()
    ).queryOne("SELECT * FROM governance_review_approvals WHERE project_id=$1 AND task_id=$2", [
      input.projectId,
      input.taskId,
    ]);
    if (
      !approval ||
      approval.head_sha !== input.headSha ||
      approval.diff_hash !== input.diffHash ||
      approval.release_id !== pin.releaseId
    )
      governanceError(
        "Code changed since its governance review; re-review is required.",
        "GOVERNANCE_STALE_CODE"
      );
    const release = await this.getRelease(input.projectId, pin.releaseId);
    resolvePolicyContext(
      release,
      "reviewer",
      input.changedPaths,
      [],
      (await this.getConfig(input.projectId)).contextMaxChars
    );
    const decisions = await this.listDecisions(input.projectId);
    for (const c of cases) {
      if (c.supersededByReleaseId === pin.releaseId) continue;
      if (c.verifiedDisposition?.kind === "precedent_applied") {
        for (const id of c.verifiedDisposition.decisionIds) {
          const d = decisions.find((d) => d.id === id && !d.revokedAt);
          if (
            !d?.conditions ||
            d.action !== "allow_reusable" ||
            Date.parse(d.conditions.expiresAt) <= Date.now() ||
            !input.changedPaths.every((p) =>
              d.conditions!.paths.some((g) => matchesPolicyPath(g, p))
            )
          )
            governanceError(
              "Applied precedent is revoked, expired, or outside its approved conditions."
            );
        }
      }
      if (c.state === "fix_required" && c.diffHash === input.diffHash)
        governanceError("An unresolved rejected finding prevents merging.");
      if (c.state === "allowed") {
        if (
          c.diffHash !== input.diffHash ||
          c.headSha !== input.headSha ||
          c.releaseId !== pin.releaseId
        )
          governanceError(
            "A human disposition is stale for this code or policy.",
            "GOVERNANCE_STALE_CODE"
          );
        const d = decisions.find(
          (d) => d.caseId === c.id && !d.revokedAt && d.action.startsWith("allow")
        );
        if (!d) governanceError("A disposition was revoked or is missing.");
        if (d.conditions && Date.parse(d.conditions.expiresAt) <= Date.now())
          governanceError("Reusable disposition expired.");
      }
    }
    const revocations = (await this.listEvents(input.projectId, ["release_revoked"])).filter(
      (e) => e.kind === "release_revoked" && e.payload.releaseId === pin.releaseId
    );
    if (revocations.length) governanceError("Governing policy was critically revoked.");
  }
  async listProposals(projectId: string): Promise<PolicyProposal[]> {
    return (
      await (
        await this.deps.getDb()
      ).query("SELECT payload FROM policy_proposals WHERE project_id=$1 ORDER BY id", [projectId])
    ).map((r) => unpack<PolicyProposal>(r)!);
  }
  async getProposal(projectId: string, proposalId: string): Promise<PolicyProposal> {
    const proposal = unpack<PolicyProposal>(
      await (
        await this.deps.getDb()
      ).queryOne("SELECT payload FROM policy_proposals WHERE project_id=$1 AND id=$2", [
        projectId,
        proposalId,
      ])
    );
    if (!proposal) governanceError("Proposal not found.", "GOVERNANCE_NOT_FOUND", 404);
    return proposal;
  }
  async createProposal(
    projectId: string,
    input: Omit<PolicyProposal, "id" | "state" | "version" | "createdAt" | "projectId">,
    actor = "congress"
  ): Promise<PolicyProposal> {
    const base = await this.getRelease(projectId, input.baseReleaseId);
    const proposal: PolicyProposal = {
      ...input,
      id: id("proposal"),
      projectId,
      state: "draft",
      version: 1,
      createdAt: now(),
    };
    if (input.sourceNominationId) {
      const existing = (await this.listProposals(projectId)).find(
        (p) => p.sourceNominationId === input.sourceNominationId
      );
      if (existing) return existing;
    }
    if (
      !(input.supportingDecisionIds.length || input.supportingEventIds?.length) ||
      !input.positiveExamples.length ||
      !input.negativeExamples.length ||
      !input.compatibility?.trim() ||
      !input.scope?.trim()
    )
      governanceError(
        "Proposals need supporting and contrary evidence, scope, compatibility effects, and positive/negative examples."
      );
    const decisions = await this.listDecisions(projectId);
    for (const cited of [...input.supportingDecisionIds, ...input.contraryDecisionIds])
      if (!decisions.some((d) => d.id === cited))
        governanceError("Proposal cited an unknown project decision.");
    const eventIds = [...(input.supportingEventIds ?? []), ...(input.contraryEventIds ?? [])];
    if (eventIds.length) {
      const events = await this.listEvents(projectId);
      const cases = await this.listCases(projectId);
      for (const cited of eventIds) {
        const event = events.find((event) => event.id === cited);
        if (!event?.caseId || !cases.some((c) => c.id === event.caseId))
          governanceError(
            "Proposal cited advisory evidence without retained project-local case provenance."
          );
      }
    }
    buildProposalRelease(base, proposal);
    await this.deps.runWrite(async (db) => {
      const inserted = await db.execute(
        "INSERT INTO policy_proposals(project_id,id,state,version,source_nomination_id,payload) VALUES($1,$2,'draft',1,$3,$4) ON CONFLICT(project_id,source_nomination_id) DO NOTHING",
        [projectId, proposal.id, input.sourceNominationId ?? null, JSON.stringify(proposal)]
      );
      if (inserted === 1)
        await this.event(db, projectId, "proposal_drafted", actor, { proposalId: proposal.id });
    });
    if (input.sourceNominationId)
      return (await this.listProposals(projectId)).find(
        (p) => p.sourceNominationId === input.sourceNominationId
      )!;
    return proposal;
  }
  async previewProposalRelease(projectId: string, proposalId: string): Promise<PolicyRelease> {
    const p = await this.getProposal(projectId, proposalId);
    return buildProposalRelease(await this.getRelease(projectId, p.baseReleaseId), p);
  }
  /** Internal evaluator-only method. There is deliberately no API accepting arbitrary scores. */
  async recordEvaluation(
    projectId: string,
    proposalId: string,
    evaluation: PolicyEvaluation,
    expectedVersion: number
  ): Promise<PolicyProposal> {
    return this.deps.runWrite(async (db) => {
      const proposal = unpack<PolicyProposal>(
        await db.queryOne("SELECT payload FROM policy_proposals WHERE project_id=$1 AND id=$2", [
          projectId,
          proposalId,
        ])
      );
      if (
        !proposal ||
        proposal.version !== expectedVersion ||
        !["draft", "evaluated"].includes(proposal.state)
      )
        governanceError("Proposal changed while evaluating.");
      const base = unpack<PolicyRelease>(
        await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
          projectId,
          proposal.baseReleaseId,
        ])
      )!;
      const candidate = buildProposalRelease(base, proposal);
      if (evaluation.releaseContentHash !== candidate.contentHash)
        governanceError("Evaluation does not cover the exact candidate content.");
      const next = {
        ...proposal,
        evaluation,
        state: (evaluation.complete && evaluation.passed
          ? "evaluated"
          : "draft") as PolicyProposal["state"],
        version: proposal.version + 1,
      };
      const changed = await db.execute(
        "UPDATE policy_proposals SET state=$1,version=$2,payload=$3 WHERE project_id=$4 AND id=$5 AND version=$6",
        [next.state, next.version, JSON.stringify(next), projectId, proposalId, expectedVersion]
      );
      if (changed !== 1)
        governanceError("Proposal changed concurrently while evaluating; reload before retrying.");
      await this.event(db, projectId, "proposal_evaluated", "isolated_evaluator", {
        proposalId,
        evaluation,
      });
      return next;
    });
  }
  async activateProposal(
    projectId: string,
    proposalId: string,
    input: { expectedVersion: number; expectedActiveReleaseId: string | null; rationale: string },
    actor: string,
    verifyRelease?: PolicyActivationVerifier
  ): Promise<PolicyRelease> {
    return this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        const p = unpack<PolicyProposal>(
          await db.queryOne("SELECT payload FROM policy_proposals WHERE project_id=$1 AND id=$2", [
            projectId,
            proposalId,
          ])
        );
        if (!p || p.version !== input.expectedVersion || p.state !== "evaluated")
          governanceError("A complete, current evaluation is required before approval.");
        const state = await db.queryOne(
          "SELECT active_release_id FROM project_governance WHERE project_id=$1",
          [projectId]
        );
        if (
          state?.active_release_id !== input.expectedActiveReleaseId ||
          p.baseReleaseId !== input.expectedActiveReleaseId
        )
          governanceError("Proposal approval is stale against the active policy.");
        const base = unpack<PolicyRelease>(
          await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
            projectId,
            p.baseReleaseId,
          ])
        )!;
        const release = { ...buildProposalRelease(base, p), createdBy: actor };
        const e = p.evaluation;
        if (
          !input.rationale?.trim() ||
          !e?.complete ||
          !e.passed ||
          e.releaseContentHash !== release.contentHash ||
          e.heldOutCount < 1 ||
          e.positiveCount < 1 ||
          e.negativeCount < 1 ||
          !e.executor ||
          e.executor.includes("placeholder") ||
          !e.artifactHash
        )
          governanceError(
            "Incomplete, placeholder, or mismatched evaluation cannot authorize activation."
          );
        await verifyRelease?.(release, db);
        await this.saveRelease(db, release);
        const activated = await db.execute(
          "UPDATE project_governance SET active_release_id=$1,version=version+1,updated_at=$2 WHERE project_id=$3 AND active_release_id=$4",
          [release.id, now(), projectId, p.baseReleaseId]
        );
        if (activated !== 1)
          governanceError("Active policy changed concurrently; reload before approving.");
        const next = { ...p, state: "activated" as const, version: p.version + 1 };
        const changed = await db.execute(
          "UPDATE policy_proposals SET state='activated',version=$1,payload=$2 WHERE project_id=$3 AND id=$4 AND version=$5",
          [next.version, JSON.stringify(next), projectId, p.id, p.version]
        );
        if (changed !== 1)
          governanceError("Proposal changed concurrently before activation; approval is stale.");
        await this.event(db, projectId, "release_activated", actor, {
          releaseId: release.id,
          proposalId: p.id,
          previousReleaseId: p.baseReleaseId,
          rationale: input.rationale,
        });
        return release;
      })
    );
  }
  async rejectProposal(
    projectId: string,
    proposalId: string,
    expectedVersion: number,
    rationale: string,
    actor: string
  ): Promise<void> {
    await this.deps.runWrite(async (db) => {
      const p = unpack<PolicyProposal>(
        await db.queryOne("SELECT payload FROM policy_proposals WHERE project_id=$1 AND id=$2", [
          projectId,
          proposalId,
        ])
      );
      if (!p || p.version !== expectedVersion || p.state === "activated" || !rationale?.trim())
        governanceError("Proposal changed or rejection rationale missing.");
      const next = { ...p, state: "rejected" as const, version: p.version + 1 };
      const changed = await db.execute(
        "UPDATE policy_proposals SET state='rejected',version=$1,payload=$2 WHERE project_id=$3 AND id=$4 AND version=$5",
        [next.version, JSON.stringify(next), projectId, p.id, p.version]
      );
      if (changed !== 1)
        governanceError("Proposal changed concurrently before rejection; reload before retrying.");
      await this.event(db, projectId, "proposal_rejected", actor, { proposalId, rationale });
    });
  }
  async rollback(
    projectId: string,
    releaseId: string,
    expectedActiveReleaseId: string,
    rationale: string,
    actor: string,
    verifyRelease?: PolicyActivationVerifier
  ): Promise<PolicyRelease> {
    return this.withPublicationLock(projectId, () =>
      this.deps.runWrite(async (db) => {
        const state = await db.queryOne(
          "SELECT active_release_id FROM project_governance WHERE project_id=$1",
          [projectId]
        );
        if (state?.active_release_id !== expectedActiveReleaseId || !rationale?.trim())
          governanceError("Rollback approval is stale or lacks rationale.");
        const release = unpack<PolicyRelease>(
          await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
            projectId,
            releaseId,
          ])
        );
        if (!release) governanceError("Rollback release unavailable.");
        if (await this.releaseRevokedInDb(db, projectId, releaseId))
          governanceError("A critically revoked release cannot be restored by rollback.");
        const activations = (
          await db.query(
            "SELECT payload FROM governance_events WHERE project_id=$1 AND kind='release_activated'",
            [projectId]
          )
        ).map((r) => unpack<GovernanceEvent>(r)!);
        if (!activations.some((e) => e.payload.releaseId === releaseId))
          governanceError("Only a previously approved release can be restored.");
        await verifyRelease?.(release, db);
        const changed = await db.execute(
          "UPDATE project_governance SET active_release_id=$1,version=version+1,updated_at=$2 WHERE project_id=$3 AND active_release_id=$4",
          [releaseId, now(), projectId, expectedActiveReleaseId]
        );
        if (changed !== 1)
          governanceError("Active policy changed concurrently before rollback; approval is stale.");
        await this.event(db, projectId, "policy_rollback", actor, {
          releaseId,
          previousReleaseId: expectedActiveReleaseId,
          rationale,
        });
        return release;
      })
    );
  }
  async mineDecisions(projectId: string): Promise<PolicyProposal[]> {
    return this.deps.runWrite(async (db) => {
      await this.ensureState(db, projectId);
      const state = await db.queryOne(
        "SELECT active_release_id,config FROM project_governance WHERE project_id=$1",
        [projectId]
      );
      if (!state?.active_release_id) return [];
      const release = unpack<PolicyRelease>(
        await db.queryOne("SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2", [
          projectId,
          state.active_release_id,
        ])
      );
      if (!release) governanceError("Active policy is unavailable for decision mining.");
      const relevantKinds = new Set([
        "human_ruling",
        "reviewer_reconsidered",
        "verified_disposition",
        "finding_fixed",
        "case_opened",
        "judge_recommended",
        "decision_revoked",
      ]);
      const events = (
        await db.query(
          `SELECT payload FROM governance_events WHERE project_id=$1 AND kind IN (${[...relevantKinds].map((_, i) => `$${i + 2}`).join(",")}) ORDER BY created_at,id`,
          [projectId, ...relevantKinds]
        )
      )
        .map((row) => unpack<GovernanceEvent>(row)!)
        .filter((event) => relevantKinds.has(event.kind));
      const receipts = await db.query(
        "SELECT id FROM governance_jobs WHERE project_id=$1 AND kind='congress_event_cursor' AND state='complete'",
        [projectId]
      );
      const processed = new Set(receipts.map((row) => String(row.id)));
      const fresh = events.filter((event) => !processed.has(`mined-event:${event.id}`));
      if (!fresh.length) return [];
      const cases = new Map(
        (await db.query("SELECT payload FROM review_cases WHERE project_id=$1", [projectId])).map(
          (row) => {
            const c = unpack<ReviewCase>(row)!;
            return [c.id, c] as const;
          }
        )
      );
      const originals = new Map<string, ReviewCase["findings"]>();
      for (const row of await db.query(
        "SELECT case_id,payload FROM review_findings WHERE project_id=$1",
        [projectId]
      ))
        originals.set(String(row.case_id), [
          ...(originals.get(String(row.case_id)) ?? []),
          JSON.parse(String(row.payload)) as ReviewCase["findings"][number],
        ]);
      const decisions = (
        await db.query(
          "SELECT payload FROM policy_decisions WHERE project_id=$1 ORDER BY created_at,id",
          [projectId]
        )
      ).map((row) => unpack<PolicyDecision>(row)!);
      type EvidenceGroup = {
        cases: Set<string>;
        events: Set<string>;
        supportEvents: Set<string>;
        contraryEvents: Set<string>;
        supportDecisions: Set<string>;
        contraryDecisions: Set<string>;
      };
      const groups = new Map<string, EvidenceGroup>();
      for (const event of events) {
        const c = cases.get(event.caseId ?? String(event.payload.caseId ?? ""));
        if (!c) continue;
        let supporting: boolean;
        if (event.kind === "human_ruling") {
          if (
            typeof event.payload.action !== "string" ||
            !["allow_once", "allow_reusable", "require_fix"].includes(event.payload.action)
          )
            continue;
          supporting = event.payload.action.startsWith("allow");
        } else if (event.kind === "case_opened") {
          if (event.payload.state !== "fix_required") continue;
          supporting = false;
        } else if (event.kind === "reviewer_reconsidered")
          supporting = event.payload.state === "cancelled";
        else if (event.kind === "verified_disposition")
          supporting = event.payload.kind !== "fix_required";
        else if (event.kind === "judge_recommended")
          supporting = ["finding_invalid", "exception_authorized"].includes(
            String((event.payload.recommendation as JudgeRecommendation | undefined)?.disposition)
          );
        else supporting = false;
        const findings = originals.get(c.id) ?? c.findings;
        for (const ruleId of new Set(
          findings.flatMap((f) => (f.ruleRevisionId ? [f.ruleRevisionId] : []))
        )) {
          if (!release.rules.some((rule) => rule.id === ruleId)) continue;
          let group = groups.get(ruleId);
          if (!group) {
            group = {
              cases: new Set(),
              events: new Set(),
              supportEvents: new Set(),
              contraryEvents: new Set(),
              supportDecisions: new Set(),
              contraryDecisions: new Set(),
            };
            groups.set(ruleId, group);
          }
          group.cases.add(c.id);
          group.events.add(event.id);
          (supporting ? group.supportEvents : group.contraryEvents).add(event.id);
          if (event.kind === "human_ruling") {
            const decision = decisions.find(
              (d) => d.id === event.payload.decisionId && d.caseId === c.id
            );
            if (decision)
              (supporting ? group.supportDecisions : group.contraryDecisions).add(decision.id);
          }
        }
      }
      const threshold =
        Number((JSON.parse(String(state.config)) as GovernanceConfig).recurrenceThreshold) || 3;
      const newIds = new Set(fresh.map((event) => event.id));
      const nominations: PolicyProposal[] = [];
      for (const [ruleRevisionId, group] of groups) {
        if (group.cases.size < threshold || ![...group.events].some((id) => newIds.has(id)))
          continue;
        const evidenceIds = [...group.events].sort();
        const proposalId = `nomination-${governanceHash([projectId, ruleRevisionId, evidenceIds]).slice(0, 24)}`;
        const proposal: PolicyProposal = {
          id: proposalId,
          projectId,
          baseReleaseId: release.id,
          state: "nominated",
          version: 1,
          title: `Review recurring findings for ${ruleRevisionId}`,
          rationale:
            "Recurring upheld, overturned, fixed and disputed findings nominate review. Agent events are advisory evidence, never exception authority. Counts do not justify weakening a standard; consider improving the reviewer and retain contrary evidence.",
          patches: [],
          supportingDecisionIds: [...group.supportDecisions],
          contraryDecisionIds: [...group.contraryDecisions],
          supportingEventIds: [...group.supportEvents],
          contraryEventIds: [...group.contraryEvents],
          scope: `Rule revision ${ruleRevisionId}`,
          compatibility: "Requires explicit rule-lineage and enforcement compatibility analysis.",
          enforcementRevision: "",
          positiveExamples: [],
          negativeExamples: [],
          createdAt: now(),
        };
        const inserted = await db.execute(
          "INSERT INTO policy_proposals(project_id,id,state,version,payload) VALUES($1,$2,'nominated',1,$3) ON CONFLICT DO NOTHING",
          [projectId, proposal.id, JSON.stringify(proposal)]
        );
        if (inserted === 1) {
          nominations.push(proposal);
          await this.event(db, projectId, "rule_nominated", "congress", {
            proposalId: proposal.id,
            caseIds: [...group.cases],
            advisoryEventIds: evidenceIds,
            decisionIds: [...group.supportDecisions, ...group.contraryDecisions],
          });
        }
      }
      // Exact event receipts form a durable cursor even when events share a timestamp or arrive late.
      for (const event of fresh)
        await db.execute(
          "INSERT INTO governance_jobs(project_id,id,kind,state,payload) VALUES($1,$2,'congress_event_cursor','complete',$3) ON CONFLICT DO NOTHING",
          [
            projectId,
            `mined-event:${event.id}`,
            JSON.stringify({ eventId: event.id, processedAt: now() }),
          ]
        );
      if (decisions.length)
        await db.execute("UPDATE project_governance SET decision_cursor=$1 WHERE project_id=$2", [
          decisions.at(-1)!.id,
          projectId,
        ]);
      await db.execute(
        "UPDATE governance_jobs SET state='complete' WHERE project_id=$1 AND kind='mine_decisions' AND state='pending'",
        [projectId]
      );
      return nominations;
    });
  }
  async deliverOutbox(projectId: string): Promise<void> {
    // The database commit precedes external delivery. A failed callback leaves a retryable
    // outbox row with the same notification ID, which clients can safely deduplicate.
    await this.withPublicationLock(projectId, async () => {
      const entries = await (
        await this.deps.getDb()
      ).query("SELECT id FROM governance_outbox WHERE project_id=$1 AND state='pending'", [
        projectId,
      ]);
      for (const entry of entries) {
        const notification = await this.deps.runWrite(async (db) => {
          const pending = await db.queryOne(
            "SELECT case_id FROM governance_outbox WHERE project_id=$1 AND id=$2 AND state='pending'",
            [projectId, entry.id]
          );
          if (!pending) return null;
          const c = unpack<ReviewCase>(
            await db.queryOne("SELECT payload FROM review_cases WHERE project_id=$1 AND id=$2", [
              projectId,
              pending.case_id,
            ])
          );
          if (!c || !isHeldCase(c)) {
            await db.execute(
              "UPDATE governance_outbox SET state='delivered' WHERE project_id=$1 AND id=$2",
              [projectId, entry.id]
            );
            return null;
          }
          const notificationId = `gov-${c.id}`;
          const metadata = {
            caseId: c.id,
            taskId: c.taskId,
            caseVersion: c.version,
            deepLinkPath: `/projects/${encodeURIComponent(projectId)}/settings?tab=governance&case=${encodeURIComponent(c.id)}`,
          };
          await db.execute(
            "INSERT INTO open_questions(id,project_id,source,source_id,questions,status,created_at,kind,scope_change_metadata) VALUES($1,$2,'execute',$3,$4,'open',$5,'governance',$6) ON CONFLICT(id) DO UPDATE SET questions=excluded.questions,status='open',resolved_at=NULL,scope_change_metadata=excluded.scope_change_metadata WHERE open_questions.project_id=excluded.project_id AND open_questions.kind='governance'",
            [
              notificationId,
              projectId,
              c.taskId,
              JSON.stringify([
                {
                  id: `q-${c.id}`,
                  text: `Human ruling required: ${c.title}`,
                  createdAt: c.createdAt,
                },
              ]),
              c.createdAt,
              JSON.stringify(metadata),
            ]
          );
          const row = await db.queryOne(
            "SELECT * FROM open_questions WHERE project_id=$1 AND id=$2",
            [projectId, notificationId]
          );
          await db.execute(
            "UPDATE governance_outbox SET attempts=attempts+1 WHERE project_id=$1 AND id=$2",
            [projectId, entry.id]
          );
          if (!row || row.status !== "open") return null;
          return {
            id: String(row.id),
            projectId: String(row.project_id),
            source: "execute",
            sourceId: String(row.source_id),
            questions: JSON.parse(String(row.questions)),
            status: "open",
            createdAt: String(row.created_at),
            resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
            kind: "governance",
            scopeChangeMetadata: JSON.parse(String(row.scope_change_metadata)),
          } satisfies Notification;
        });
        if (notification) await this.deps.onNotification?.(notification);
        await this.deps.runWrite((db) =>
          db.execute(
            "UPDATE governance_outbox SET state='delivered' WHERE project_id=$1 AND id=$2 AND state='pending'",
            [projectId, entry.id]
          )
        );
      }
    });
  }
}
