import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AgentRuntime,
  AllowanceRecord,
  AppealRecord,
  CaseRecord,
  CredentialSecret,
  DependencyRecord,
  EvaluationRecord,
  EvidenceItem,
  FindingRecord,
  FrameRecord,
  GovernanceMode,
  InviteRecord,
  MembershipRecord,
  NominationRecord,
  PolicyPinRecord,
  PolicyReleaseRecord,
  PolicyRuleRecord,
  ProjectRecord,
  ProposalRecord,
  Role,
  RunbookDocument,
  RunbookRevisionRecord,
  RunRecord,
  RunRole,
  RunState,
  RulingRecord,
  ScopeGrantRecord,
  TeamRecord,
  ThreadEntryRecord,
  ThreadRecord,
  UserRecord,
  WorkItemRecord,
  WorkStatus,
} from "../domain.js";

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const value = row[key];
  return value == null ? "" : String(value);
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value == null ? null : String(value);
}

function num(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  return value == null ? null : Number(value);
}

function flag(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

function json<T>(row: Row, key: string, fallback: T): T {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `os-${randomBytes(4).toString("hex")}`;
}

export class ForgeStore {
  constructor(private readonly db: Database.Database) {}

  close(): void {
    this.db.close();
  }

  insertUser(input: { email: string; name: string; passwordHash: string }): UserRecord {
    const row: UserRecord = {
      id: newId(),
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, created_at) VALUES (@id, @email, @name, @passwordHash, @createdAt)`
      )
      .run(row);
    return row;
  }

  userById(id: string): UserRecord | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapUser(row) : null;
  }

  userByEmail(email: string): UserRecord | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as
      | Row
      | undefined;
    return row ? mapUser(row) : null;
  }

  insertTeam(name: string): TeamRecord {
    const row = { id: newId(), name, createdAt: nowIso() };
    this.db.prepare(`INSERT INTO teams (id, name, created_at) VALUES (@id, @name, @createdAt)`).run(row);
    return row;
  }

  insertMembership(input: { teamId: string; userId: string; role: Role }): MembershipRecord {
    const row = { ...input, createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO memberships (team_id, user_id, role, created_at) VALUES (@teamId, @userId, @role, @createdAt)`
      )
      .run(row);
    return row;
  }

  membership(teamId: string, userId: string): MembershipRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM memberships WHERE team_id = ? AND user_id = ?`)
      .get(teamId, userId) as Row | undefined;
    return row ? mapMembership(row) : null;
  }

  membershipsForUser(userId: string): Array<MembershipRecord & { teamName: string }> {
    const rows = this.db
      .prepare(
        `SELECT memberships.*, teams.name AS team_name FROM memberships JOIN teams ON teams.id = memberships.team_id WHERE memberships.user_id = ? ORDER BY teams.created_at`
      )
      .all(userId) as Row[];
    return rows.map((row) => ({ ...mapMembership(row), teamName: str(row, "team_name") }));
  }

  membersOfTeam(teamId: string): Array<MembershipRecord & { name: string; email: string }> {
    const rows = this.db
      .prepare(
        `SELECT memberships.*, users.name AS user_name, users.email AS user_email FROM memberships JOIN users ON users.id = memberships.user_id WHERE memberships.team_id = ? ORDER BY users.name`
      )
      .all(teamId) as Row[];
    return rows.map((row) => ({
      ...mapMembership(row),
      name: str(row, "user_name"),
      email: str(row, "user_email"),
    }));
  }

  updateMembershipRole(teamId: string, userId: string, role: Role): void {
    this.db
      .prepare(`UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?`)
      .run(role, teamId, userId);
  }

  insertInvite(input: { teamId: string; role: Role; tokenHash: string; createdBy: string }): InviteRecord {
    const row: InviteRecord = {
      id: newId(),
      teamId: input.teamId,
      role: input.role,
      tokenHash: input.tokenHash,
      createdBy: input.createdBy,
      acceptedBy: null,
      createdAt: nowIso(),
      acceptedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO invites (id, team_id, role, token_hash, created_by, accepted_by, created_at, accepted_at) VALUES (@id, @teamId, @role, @tokenHash, @createdBy, NULL, @createdAt, NULL)`
      )
      .run(row);
    return row;
  }

  inviteByHash(tokenHash: string): InviteRecord | null {
    const row = this.db.prepare(`SELECT * FROM invites WHERE token_hash = ?`).get(tokenHash) as
      | Row
      | undefined;
    return row ? mapInvite(row) : null;
  }

  markInviteAccepted(id: string, userId: string): void {
    this.db
      .prepare(`UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE id = ?`)
      .run(userId, nowIso(), id);
  }

  insertProject(input: {
    teamId: string;
    name: string;
    remoteUrl: string;
    baseBranch: string;
    runtime: AgentRuntime;
  }): ProjectRecord {
    const row: ProjectRecord = {
      id: newId(),
      teamId: input.teamId,
      name: input.name,
      remoteUrl: input.remoteUrl,
      baseBranch: input.baseBranch,
      runtime: input.runtime,
      credentialId: null,
      governanceMode: "disabled",
      runbookLocked: false,
      activeRunbookDigest: null,
      shadowRecord: false,
      evolveCursor: "",
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, team_id, name, remote_url, base_branch, runtime_json, credential_id, governance_mode, runbook_locked, active_runbook_digest, shadow_record, evolve_cursor, created_at)
         VALUES (@id, @teamId, @name, @remoteUrl, @baseBranch, @runtime, NULL, 'disabled', 0, NULL, 0, '', @createdAt)`
      )
      .run({ ...row, runtime: JSON.stringify(row.runtime) });
    return row;
  }

  projectById(id: string): ProjectRecord | null {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapProject(row) : null;
  }

  allProjects(): ProjectRecord[] {
    return (this.db.prepare(`SELECT * FROM projects ORDER BY created_at`).all() as Row[]).map(mapProject);
  }

  projectsByTeamIds(teamIds: string[]): ProjectRecord[] {
    if (teamIds.length === 0) return [];
    const marks = teamIds.map(() => "?").join(",");
    return (
      this.db.prepare(`SELECT * FROM projects WHERE team_id IN (${marks}) ORDER BY created_at`).all(...teamIds) as Row[]
    ).map(mapProject);
  }

  updateProject(
    id: string,
    patch: Partial<
      Pick<
        ProjectRecord,
        | "credentialId"
        | "governanceMode"
        | "runbookLocked"
        | "activeRunbookDigest"
        | "shadowRecord"
        | "evolveCursor"
      >
    >
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.credentialId !== undefined) {
      sets.push("credential_id = @credentialId");
      params.credentialId = patch.credentialId;
    }
    if (patch.governanceMode !== undefined) {
      sets.push("governance_mode = @governanceMode");
      params.governanceMode = patch.governanceMode;
    }
    if (patch.runbookLocked !== undefined) {
      sets.push("runbook_locked = @runbookLocked");
      params.runbookLocked = patch.runbookLocked ? 1 : 0;
    }
    if (patch.activeRunbookDigest !== undefined) {
      sets.push("active_runbook_digest = @activeRunbookDigest");
      params.activeRunbookDigest = patch.activeRunbookDigest;
    }
    if (patch.shadowRecord !== undefined) {
      sets.push("shadow_record = @shadowRecord");
      params.shadowRecord = patch.shadowRecord ? 1 : 0;
    }
    if (patch.evolveCursor !== undefined) {
      sets.push("evolve_cursor = @evolveCursor");
      params.evolveCursor = patch.evolveCursor;
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  deleteProject(id: string): void {
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  insertCredential(projectId: string, kind: string, ciphertext: string): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO credentials (id, project_id, kind, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, projectId, kind, ciphertext, nowIso());
    return id;
  }

  credentialById(id: string): { id: string; projectId: string; kind: string; ciphertext: string } | null {
    const row = this.db.prepare(`SELECT * FROM credentials WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: str(row, "id"),
      projectId: str(row, "project_id"),
      kind: str(row, "kind"),
      ciphertext: str(row, "ciphertext"),
    };
  }

  insertFrame(input: { projectId: string; markdown: string; createdBy: string }): FrameRecord {
    const latest = this.latestFrame(input.projectId);
    const row: FrameRecord = {
      projectId: input.projectId,
      version: (latest?.version ?? 0) + 1,
      markdown: input.markdown,
      createdBy: input.createdBy,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO frame_versions (project_id, version, markdown, created_by, created_at) VALUES (@projectId, @version, @markdown, @createdBy, @createdAt)`
      )
      .run(row);
    return row;
  }

  latestFrame(projectId: string): FrameRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM frame_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`)
      .get(projectId) as Row | undefined;
    return row ? mapFrame(row) : null;
  }

  frameVersion(projectId: string, version: number): FrameRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM frame_versions WHERE project_id = ? AND version = ?`)
      .get(projectId, version) as Row | undefined;
    return row ? mapFrame(row) : null;
  }

  listFrames(projectId: string): FrameRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM frame_versions WHERE project_id = ? ORDER BY version`)
        .all(projectId) as Row[]
    ).map(mapFrame);
  }

  insertWorkItem(input: {
    projectId: string;
    parentId?: string | null;
    title: string;
    body: string;
    status: WorkStatus;
    ownerUserId?: string | null;
    frameVersion?: number | null;
    scopePaths?: string[];
    blockedReason?: string | null;
  }): WorkItemRecord {
    return this.db.transaction(() => {
      const parentId = input.parentId ?? null;
      let id: string;
      if (parentId) {
        const siblingRows = this.db
          .prepare(`SELECT id FROM work_items WHERE parent_id = ?`)
          .all(parentId) as Row[];
        id = nextChildId(
          parentId,
          siblingRows.map((row) => str(row, "id"))
        );
      } else {
        id = newId();
      }
      const createdAt = nowIso();
      const record: WorkItemRecord = {
        id,
        projectId: input.projectId,
        parentId,
        title: input.title,
        body: input.body,
        status: input.status,
        ownerUserId: input.ownerUserId ?? null,
        frameVersion: input.frameVersion ?? null,
        scopePaths: input.scopePaths ?? [],
        blockedReason: input.blockedReason ?? null,
        shipCommit: null,
        createdAt,
        updatedAt: createdAt,
      };
      this.db
        .prepare(
          `INSERT INTO work_items (id, project_id, parent_id, title, body, status, owner_user_id, frame_version, scope_json, blocked_reason, ship_commit, created_at, updated_at)
           VALUES (@id, @projectId, @parentId, @title, @body, @status, @ownerUserId, @frameVersion, @scopePaths, @blockedReason, NULL, @createdAt, @updatedAt)`
        )
        .run({ ...record, scopePaths: JSON.stringify(record.scopePaths) });
      return record;
    })();
  }

  workItem(id: string): WorkItemRecord | null {
    const row = this.db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapWorkItem(row) : null;
  }

  workItemsByProject(projectId: string): WorkItemRecord[] {
    return (
      this.db.prepare(`SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at`).all(projectId) as Row[]
    ).map(mapWorkItem);
  }

  updateWorkItem(
    id: string,
    patch: Partial<
      Pick<WorkItemRecord, "status" | "ownerUserId" | "blockedReason" | "shipCommit" | "frameVersion" | "scopePaths">
    >
  ): void {
    const sets = ["updated_at = @updatedAt"];
    const params: Record<string, unknown> = { id, updatedAt: nowIso() };
    if (patch.status !== undefined) {
      sets.push("status = @status");
      params.status = patch.status;
    }
    if (patch.ownerUserId !== undefined) {
      sets.push("owner_user_id = @ownerUserId");
      params.ownerUserId = patch.ownerUserId;
    }
    if (patch.blockedReason !== undefined) {
      sets.push("blocked_reason = @blockedReason");
      params.blockedReason = patch.blockedReason;
    }
    if (patch.shipCommit !== undefined) {
      sets.push("ship_commit = @shipCommit");
      params.shipCommit = patch.shipCommit;
    }
    if (patch.frameVersion !== undefined) {
      sets.push("frame_version = @frameVersion");
      params.frameVersion = patch.frameVersion;
    }
    if (patch.scopePaths !== undefined) {
      sets.push("scope_json = @scopePaths");
      params.scopePaths = JSON.stringify(patch.scopePaths);
    }
    this.db.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  insertDependency(input: DependencyRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO dependencies (project_id, work_item_id, depends_on_id) VALUES (?, ?, ?)`
      )
      .run(input.projectId, input.workItemId, input.dependsOnId);
  }

  dependenciesByProject(projectId: string): DependencyRecord[] {
    return (
      this.db.prepare(`SELECT * FROM dependencies WHERE project_id = ?`).all(projectId) as Row[]
    ).map((row) => ({
      projectId: str(row, "project_id"),
      workItemId: str(row, "work_item_id"),
      dependsOnId: str(row, "depends_on_id"),
    }));
  }

  ensureThread(projectId: string, workItemId: string): ThreadRecord {
    const existing = this.threadByWorkItem(workItemId);
    if (existing) return existing;
    const row: ThreadRecord = { id: newId(), projectId, workItemId, cursor: 0 };
    this.db
      .prepare(
        `INSERT INTO threads (id, project_id, work_item_id, cursor) VALUES (@id, @projectId, @workItemId, 0)`
      )
      .run(row);
    return row;
  }

  threadByWorkItem(workItemId: string): ThreadRecord | null {
    const row = this.db.prepare(`SELECT * FROM threads WHERE work_item_id = ?`).get(workItemId) as
      | Row
      | undefined;
    return row ? mapThread(row) : null;
  }

  appendEntry(input: {
    threadId: string;
    authorId: string;
    kind: "post" | "guidance";
    body: string;
    idempotencyKey?: string | null;
  }): { entry: ThreadEntryRecord; created: boolean } {
    return this.db.transaction(() => {
      const key = input.idempotencyKey?.trim() ? input.idempotencyKey.trim() : null;
      if (key) {
        const existing = this.db
          .prepare(`SELECT * FROM thread_entries WHERE thread_id = ? AND idempotency_key = ?`)
          .get(input.threadId, key) as Row | undefined;
        if (existing) return { entry: mapEntry(existing), created: false };
      }
      const thread = this.db.prepare(`SELECT cursor FROM threads WHERE id = ?`).get(input.threadId) as Row;
      const cursor = num(thread, "cursor") + 1;
      this.db.prepare(`UPDATE threads SET cursor = ? WHERE id = ?`).run(cursor, input.threadId);
      const entry: ThreadEntryRecord = {
        id: newId(),
        threadId: input.threadId,
        cursor,
        authorId: input.authorId,
        kind: input.kind,
        body: input.body,
        idempotencyKey: key,
        createdAt: nowIso(),
      };
      this.db
        .prepare(
          `INSERT INTO thread_entries (id, thread_id, cursor, author_id, kind, body, idempotency_key, created_at)
           VALUES (@id, @threadId, @cursor, @authorId, @kind, @body, @idempotencyKey, @createdAt)`
        )
        .run(entry);
      return { entry, created: true };
    })();
  }

  entries(threadId: string): ThreadEntryRecord[] {
    return (
      this.db.prepare(`SELECT * FROM thread_entries WHERE thread_id = ? ORDER BY cursor`).all(threadId) as Row[]
    ).map(mapEntry);
  }

  insertRun(input: {
    projectId: string;
    workItemId: string | null;
    role: RunRole;
    state: RunState;
    attempt?: number;
    runbookDigest?: string | null;
    executionContractHash?: string | null;
    baseRevision?: string | null;
    frameVersion?: number | null;
    runtimeArgv?: string[];
    policyPinId?: string | null;
  }): RunRecord {
    const createdAt = nowIso();
    const record: RunRecord = {
      id: newId(),
      projectId: input.projectId,
      workItemId: input.workItemId,
      attempt: input.attempt ?? 1,
      state: input.state,
      role: input.role,
      runbookDigest: input.runbookDigest ?? null,
      executionContractHash: input.executionContractHash ?? null,
      baseRevision: input.baseRevision ?? null,
      frameVersion: input.frameVersion ?? null,
      pid: null,
      heartbeatAt: null,
      controllerUserId: null,
      controlRevision: 0,
      policyRule: null,
      retryCount: 0,
      verifyHealCount: 0,
      codeRetryCount: 0,
      failureSignature: null,
      guidance: [],
      answers: [],
      failureNote: null,
      midTurn: null,
      toolBindings: {},
      runtimeArgv: input.runtimeArgv ?? [],
      resultStatus: null,
      resultSummary: null,
      evidence: [],
      questions: [],
      worktreePath: null,
      assignmentPath: null,
      patchHash: null,
      policyPinId: input.policyPinId ?? null,
      slotReleased: false,
      gateEvaluated: false,
      createdAt,
      updatedAt: createdAt,
    };
    this.insertRunRow(record);
    return record;
  }

  private insertRunRow(record: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, project_id, work_item_id, attempt, state, role, runbook_digest, execution_contract_hash,
          base_revision, frame_version, pid, heartbeat_at, controller_user_id, control_revision, policy_rule,
          retry_count, verify_heal_count, code_retry_count, failure_signature, guidance_json, answers_json,
          failure_note, mid_turn, tool_bindings_json, runtime_argv_json, result_status, result_summary,
          evidence_json, questions_json, worktree_path, assignment_path, patch_hash, policy_pin_id,
          slot_released, gate_evaluated, created_at, updated_at
        ) VALUES (
          @id, @projectId, @workItemId, @attempt, @state, @role, @runbookDigest, @executionContractHash,
          @baseRevision, @frameVersion, @pid, @heartbeatAt, @controllerUserId, @controlRevision, @policyRule,
          @retryCount, @verifyHealCount, @codeRetryCount, @failureSignature, @guidance, @answers,
          @failureNote, @midTurn, @toolBindings, @runtimeArgv, @resultStatus, @resultSummary,
          @evidence, @questions, @worktreePath, @assignmentPath, @patchHash, @policyPinId,
          @slotReleased, @gateEvaluated, @createdAt, @updatedAt
        )`
      )
      .run(serializeRun(record));
  }

  runById(id: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapRun(row) : null;
  }

  runsByProject(projectId: string): RunRecord[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY created_at`).all(projectId) as Row[]).map(
      mapRun
    );
  }

  openRunForItem(workItemId: string): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE work_item_id = ? AND state != 'done' ORDER BY created_at DESC LIMIT 1`
      )
      .get(workItemId) as Row | undefined;
    return row ? mapRun(row) : null;
  }

  activeRuns(): RunRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs WHERE state IN ('assigned', 'running', 'verifying', 'gating', 'integrating') ORDER BY created_at`
        )
        .all() as Row[]
    ).map(mapRun);
  }

  updateRun(id: string, patch: Partial<RunRecord>): void {
    const columns: Record<string, string> = {
      attempt: "attempt",
      state: "state",
      runbookDigest: "runbook_digest",
      executionContractHash: "execution_contract_hash",
      baseRevision: "base_revision",
      frameVersion: "frame_version",
      pid: "pid",
      heartbeatAt: "heartbeat_at",
      controllerUserId: "controller_user_id",
      controlRevision: "control_revision",
      policyRule: "policy_rule",
      retryCount: "retry_count",
      verifyHealCount: "verify_heal_count",
      codeRetryCount: "code_retry_count",
      failureSignature: "failure_signature",
      guidance: "guidance_json",
      answers: "answers_json",
      failureNote: "failure_note",
      midTurn: "mid_turn",
      toolBindings: "tool_bindings_json",
      runtimeArgv: "runtime_argv_json",
      resultStatus: "result_status",
      resultSummary: "result_summary",
      evidence: "evidence_json",
      questions: "questions_json",
      worktreePath: "worktree_path",
      assignmentPath: "assignment_path",
      patchHash: "patch_hash",
      policyPinId: "policy_pin_id",
      slotReleased: "slot_released",
      gateEvaluated: "gate_evaluated",
    };
    const jsonKeys = new Set([
      "guidance",
      "answers",
      "toolBindings",
      "runtimeArgv",
      "evidence",
      "questions",
    ]);
    const boolKeys = new Set(["slotReleased", "gateEvaluated"]);
    const sets = ["updated_at = @updatedAt"];
    const params: Record<string, unknown> = { id, updatedAt: nowIso() };
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = patch[key as keyof RunRecord];
      sets.push(`${column} = @${key}`);
      if (jsonKeys.has(key)) params[key] = JSON.stringify(value ?? null);
      else if (boolKeys.has(key)) params[key] = value ? 1 : 0;
      else params[key] = value ?? null;
    }
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  insertRunEvent(runId: string, type: string, payload: unknown): void {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?`).get(runId) as Row;
    this.db
      .prepare(
        `INSERT INTO run_events (id, run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(newId(), runId, num(row, "seq") + 1, type, JSON.stringify(payload), nowIso());
  }

  insertRevision(input: {
    projectId: string;
    digest: string;
    document: RunbookDocument;
    status: RunbookRevisionRecord["status"];
    probe: EvidenceItem[];
  }): RunbookRevisionRecord {
    const row: RunbookRevisionRecord = {
      id: newId(),
      projectId: input.projectId,
      digest: input.digest,
      document: input.document,
      status: input.status,
      probe: input.probe,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO runbook_revisions (id, project_id, digest, document_json, status, probe_json, created_at)
         VALUES (@id, @projectId, @digest, @document, @status, @probe, @createdAt)`
      )
      .run({
        ...row,
        document: JSON.stringify(row.document),
        probe: JSON.stringify(row.probe),
      });
    return row;
  }

  revisionsByProject(projectId: string): RunbookRevisionRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM runbook_revisions WHERE project_id = ? ORDER BY created_at`)
        .all(projectId) as Row[]
    ).map(mapRevision);
  }

  revisionByDigest(projectId: string, digest: string): RunbookRevisionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runbook_revisions WHERE project_id = ? AND digest = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(projectId, digest) as Row | undefined;
    return row ? mapRevision(row) : null;
  }

  activeRevision(projectId: string): RunbookRevisionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runbook_revisions WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`
      )
      .get(projectId) as Row | undefined;
    return row ? mapRevision(row) : null;
  }

  archiveActive(projectId: string): void {
    this.db
      .prepare(`UPDATE runbook_revisions SET status = 'archived' WHERE project_id = ? AND status = 'active'`)
      .run(projectId);
  }

  insertRelease(input: {
    projectId: string;
    version: number;
    contentHash: string;
    rules: Array<Omit<PolicyRuleRecord, "id" | "releaseId">>;
  }): PolicyReleaseRecord {
    return this.db.transaction(() => {
      this.db
        .prepare(`UPDATE policy_releases SET status = 'archived' WHERE project_id = ? AND status = 'active'`)
        .run(input.projectId);
      const release: PolicyReleaseRecord = {
        id: newId(),
        projectId: input.projectId,
        version: input.version,
        contentHash: input.contentHash,
        status: "active",
        createdAt: nowIso(),
        activatedAt: nowIso(),
      };
      this.db
        .prepare(
          `INSERT INTO policy_releases (id, project_id, version, content_hash, status, created_at, activated_at)
           VALUES (@id, @projectId, @version, @contentHash, 'active', @createdAt, @activatedAt)`
        )
        .run(release);
      for (const rule of input.rules) {
        this.db
          .prepare(
            `INSERT INTO policy_rules (id, release_id, rule_key, revision, text, detector, paths_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(newId(), release.id, rule.ruleKey, rule.revision, rule.text, rule.detector, JSON.stringify(rule.paths));
      }
      return release;
    })();
  }

  releases(projectId: string): PolicyReleaseRecord[] {
    return (
      this.db.prepare(`SELECT * FROM policy_releases WHERE project_id = ? ORDER BY version`).all(projectId) as Row[]
    ).map(mapRelease);
  }

  activeRelease(projectId: string): PolicyReleaseRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM policy_releases WHERE project_id = ? AND status = 'active' LIMIT 1`)
      .get(projectId) as Row | undefined;
    return row ? mapRelease(row) : null;
  }

  rulesForRelease(releaseId: string): PolicyRuleRecord[] {
    return (this.db.prepare(`SELECT * FROM policy_rules WHERE release_id = ?`).all(releaseId) as Row[]).map(mapRule);
  }

  activateExistingRelease(projectId: string, releaseId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE policy_releases SET status = 'archived' WHERE project_id = ? AND status = 'active'`)
        .run(projectId);
      this.db
        .prepare(`UPDATE policy_releases SET status = 'active', activated_at = ? WHERE id = ? AND project_id = ?`)
        .run(nowIso(), releaseId, projectId);
    })();
  }

  insertPin(input: Omit<PolicyPinRecord, "id" | "createdAt">): PolicyPinRecord {
    const row: PolicyPinRecord = { ...input, id: newId(), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO policy_pins (id, run_id, release_id, instruction_snapshot, original_scope, base_revision, created_at)
         VALUES (@id, @runId, @releaseId, @instructionSnapshot, @originalScope, @baseRevision, @createdAt)`
      )
      .run(row);
    return row;
  }

  pinByRun(runId: string): PolicyPinRecord | null {
    const row = this.db.prepare(`SELECT * FROM policy_pins WHERE run_id = ?`).get(runId) as Row | undefined;
    if (!row) return null;
    return {
      id: str(row, "id"),
      runId: str(row, "run_id"),
      releaseId: str(row, "release_id"),
      instructionSnapshot: str(row, "instruction_snapshot"),
      originalScope: str(row, "original_scope"),
      baseRevision: str(row, "base_revision"),
      createdAt: str(row, "created_at"),
    };
  }

  insertFinding(input: Omit<FindingRecord, "id" | "createdAt" | "appeal" | "judge">): FindingRecord {
    const row: FindingRecord = {
      ...input,
      id: newId(),
      appeal: null,
      judge: null,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO review_findings (id, project_id, run_id, work_item_id, kind, rule_key, rule_revision, evidence, status, appeal_json, judge_json, created_at)
         VALUES (@id, @projectId, @runId, @workItemId, @kind, @ruleKey, @ruleRevision, @evidence, @status, NULL, NULL, @createdAt)`
      )
      .run(row);
    return row;
  }

  findingsByProject(projectId: string): FindingRecord[] {
    return (
      this.db.prepare(`SELECT * FROM review_findings WHERE project_id = ? ORDER BY created_at`).all(projectId) as Row[]
    ).map(mapFinding);
  }

  findingById(id: string): FindingRecord | null {
    const row = this.db.prepare(`SELECT * FROM review_findings WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapFinding(row) : null;
  }

  updateFinding(
    id: string,
    patch: { status?: string; appeal?: AppealRecord | null; judge?: FindingRecord["judge"] }
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.status !== undefined) {
      sets.push("status = @status");
      params.status = patch.status;
    }
    if (patch.appeal !== undefined) {
      sets.push("appeal_json = @appeal");
      params.appeal = patch.appeal ? JSON.stringify(patch.appeal) : null;
    }
    if (patch.judge !== undefined) {
      sets.push("judge_json = @judge");
      params.judge = patch.judge ? JSON.stringify(patch.judge) : null;
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE review_findings SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  countAppeals(workItemId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_findings WHERE work_item_id = ? AND appeal_json IS NOT NULL`
      )
      .get(workItemId) as Row;
    return num(row, "n");
  }

  insertCase(input: Omit<CaseRecord, "id" | "createdAt">): CaseRecord {
    const row: CaseRecord = { ...input, id: newId(), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO review_cases (id, project_id, finding_id, work_item_id, run_id, kind, status, payload_json, created_at)
         VALUES (@id, @projectId, @findingId, @workItemId, @runId, @kind, @status, @payload, @createdAt)`
      )
      .run({ ...row, payload: JSON.stringify(row.payload) });
    return row;
  }

  casesByProject(projectId: string): CaseRecord[] {
    return (
      this.db.prepare(`SELECT * FROM review_cases WHERE project_id = ? ORDER BY created_at`).all(projectId) as Row[]
    ).map(mapCase);
  }

  caseById(id: string): CaseRecord | null {
    const row = this.db.prepare(`SELECT * FROM review_cases WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapCase(row) : null;
  }

  updateCase(id: string, status: string, payload?: Record<string, unknown>): void {
    if (payload) {
      this.db
        .prepare(`UPDATE review_cases SET status = ?, payload_json = ? WHERE id = ?`)
        .run(status, JSON.stringify(payload), id);
      return;
    }
    this.db.prepare(`UPDATE review_cases SET status = ? WHERE id = ?`).run(status, id);
  }

  openCasesForRun(runId: string): CaseRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM review_cases WHERE run_id = ? AND status = 'open'`)
        .all(runId) as Row[]
    ).map(mapCase);
  }

  insertRuling(input: Omit<RulingRecord, "id" | "createdAt">): RulingRecord {
    const row: RulingRecord = { ...input, id: newId(), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO review_rulings (id, case_id, project_id, decision, rationale, allowance_json, patch_hash, rule_key, created_by, created_at)
         VALUES (@id, @caseId, @projectId, @decision, @rationale, @allowance, @patchHash, @ruleKey, @createdBy, @createdAt)`
      )
      .run({ ...row, allowance: row.allowance ? JSON.stringify(row.allowance) : null });
    return row;
  }

  rulingsByProject(projectId: string): RulingRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM review_rulings WHERE project_id = ? ORDER BY created_at, id`)
        .all(projectId) as Row[]
    ).map(mapRuling);
  }

  insertAllowance(input: Omit<AllowanceRecord, "id" | "createdAt" | "used">): AllowanceRecord {
    const row: AllowanceRecord = { ...input, id: newId(), used: false, createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO allowances (id, project_id, release_id, rule_key, kind, patch_hash, paths_json, expires_at, used, created_at)
         VALUES (@id, @projectId, @releaseId, @ruleKey, @kind, @patchHash, @paths, @expiresAt, 0, @createdAt)`
      )
      .run({ ...row, paths: JSON.stringify(row.paths) });
    return row;
  }

  allowancesForRelease(releaseId: string): AllowanceRecord[] {
    return (this.db.prepare(`SELECT * FROM allowances WHERE release_id = ?`).all(releaseId) as Row[]).map(mapAllowance);
  }

  markAllowanceUsed(id: string): void {
    this.db.prepare(`UPDATE allowances SET used = 1 WHERE id = ?`).run(id);
  }

  insertScopeGrant(input: { projectId: string; workItemId: string; paths: string[] }): ScopeGrantRecord {
    const row: ScopeGrantRecord = { ...input, id: newId(), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO scope_grants (id, project_id, work_item_id, paths_json, created_at) VALUES (@id, @projectId, @workItemId, @paths, @createdAt)`
      )
      .run({ ...row, paths: JSON.stringify(row.paths) });
    return row;
  }

  grantsForItem(workItemId: string): ScopeGrantRecord[] {
    return (
      this.db.prepare(`SELECT * FROM scope_grants WHERE work_item_id = ? ORDER BY created_at DESC`).all(workItemId) as Row[]
    ).map((row) => ({
      id: str(row, "id"),
      projectId: str(row, "project_id"),
      workItemId: str(row, "work_item_id"),
      paths: json<string[]>(row, "paths_json", []),
      createdAt: str(row, "created_at"),
    }));
  }

  insertNomination(input: Omit<NominationRecord, "id" | "createdAt" | "status">): NominationRecord {
    const row: NominationRecord = { ...input, id: newId(), status: "open", createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO congress_nominations (id, project_id, release_id, rule_key, status, supporting_json, contrary_json, created_at)
         VALUES (@id, @projectId, @releaseId, @ruleKey, 'open', @supporting, @contrary, @createdAt)`
      )
      .run({
        ...row,
        supporting: JSON.stringify(row.supporting),
        contrary: JSON.stringify(row.contrary),
      });
    return row;
  }

  nominationsByProject(projectId: string): NominationRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM congress_nominations WHERE project_id = ? ORDER BY created_at`)
        .all(projectId) as Row[]
    ).map(mapNomination);
  }

  nominationById(id: string): NominationRecord | null {
    const row = this.db.prepare(`SELECT * FROM congress_nominations WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapNomination(row) : null;
  }

  openNomination(releaseId: string, ruleKey: string): NominationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM congress_nominations WHERE release_id = ? AND rule_key = ? AND status = 'open' LIMIT 1`
      )
      .get(releaseId, ruleKey) as Row | undefined;
    return row ? mapNomination(row) : null;
  }

  updateNomination(id: string, patch: { status?: string; contrary?: unknown[]; supporting?: unknown[] }): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.status !== undefined) {
      sets.push("status = @status");
      params.status = patch.status;
    }
    if (patch.contrary !== undefined) {
      sets.push("contrary_json = @contrary");
      params.contrary = JSON.stringify(patch.contrary);
    }
    if (patch.supporting !== undefined) {
      sets.push("supporting_json = @supporting");
      params.supporting = JSON.stringify(patch.supporting);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE congress_nominations SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  insertProposal(input: Omit<ProposalRecord, "id" | "createdAt">): ProposalRecord {
    const row: ProposalRecord = { ...input, id: newId(), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO congress_proposals (id, nomination_id, project_id, rule_key, text, detector, paths_json, author_kind, created_at)
         VALUES (@id, @nominationId, @projectId, @ruleKey, @text, @detector, @paths, @authorKind, @createdAt)`
      )
      .run({ ...row, paths: JSON.stringify(row.paths) });
    return row;
  }

  proposalsByProject(projectId: string): ProposalRecord[] {
    return (
      this.db.prepare(`SELECT * FROM congress_proposals WHERE project_id = ? ORDER BY created_at`).all(projectId) as Row[]
    ).map(mapProposal);
  }

  proposalById(id: string): ProposalRecord | null {
    const row = this.db.prepare(`SELECT * FROM congress_proposals WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapProposal(row) : null;
  }

  insertFixture(proposalId: string, inputs: unknown, heldOut: unknown[]): void {
    this.db
      .prepare(
        `INSERT INTO replay_fixtures (id, proposal_id, inputs_json, held_out_json, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(newId(), proposalId, JSON.stringify(inputs), JSON.stringify(heldOut), nowIso());
  }

  fixtureByProposal(proposalId: string): { inputs: unknown; heldOut: unknown[] } | null {
    const row = this.db
      .prepare(`SELECT * FROM replay_fixtures WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(proposalId) as Row | undefined;
    if (!row) return null;
    return { inputs: json(row, "inputs_json", null), heldOut: json<unknown[]>(row, "held_out_json", []) };
  }

  insertEvaluation(input: Omit<EvaluationRecord, "id" | "createdAt">): EvaluationRecord {
    const row: EvaluationRecord = { ...input, id: newId(), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO replay_evaluations (id, proposal_id, status, report_json, created_at) VALUES (@id, @proposalId, @status, @report, @createdAt)`
      )
      .run({ ...row, report: JSON.stringify(row.report) });
    return row;
  }

  latestEvaluation(proposalId: string): EvaluationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM replay_evaluations WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(proposalId) as Row | undefined;
    if (!row) return null;
    return {
      id: str(row, "id"),
      proposalId: str(row, "proposal_id"),
      status: str(row, "status") === "complete" ? "complete" : "incomplete",
      report: json<Record<string, unknown>>(row, "report_json", {}),
      createdAt: str(row, "created_at"),
    };
  }

  evaluationsByProject(projectId: string): EvaluationRecord[] {
    return (
      this.db
        .prepare(
          `SELECT replay_evaluations.* FROM replay_evaluations
           JOIN congress_proposals ON congress_proposals.id = replay_evaluations.proposal_id
           WHERE congress_proposals.project_id = ? ORDER BY replay_evaluations.created_at`
        )
        .all(projectId) as Row[]
    ).map((row) => ({
      id: str(row, "id"),
      proposalId: str(row, "proposal_id"),
      status: str(row, "status") === "complete" ? "complete" : "incomplete",
      report: json<Record<string, unknown>>(row, "report_json", {}),
      createdAt: str(row, "created_at"),
    }));
  }

  recentShips(projectIds: string[]): WorkItemRecord[] {
    if (projectIds.length === 0) return [];
    const marks = projectIds.map(() => "?").join(",");
    return (
      this.db
        .prepare(
          `SELECT * FROM work_items WHERE project_id IN (${marks}) AND status = 'done' AND ship_commit IS NOT NULL ORDER BY updated_at DESC LIMIT 10`
        )
        .all(...projectIds) as Row[]
    ).map(mapWorkItem);
  }
}

function nextChildId(parentId: string, ids: string[]): string {
  const escaped = parentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`^${escaped}\\.(\\d+)$`);
  const max = ids.reduce((highest, id) => {
    const match = matcher.exec(id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `${parentId}.${max + 1}`;
}

function serializeRun(record: RunRecord): Record<string, unknown> {
  return {
    ...record,
    guidance: JSON.stringify(record.guidance),
    answers: JSON.stringify(record.answers),
    toolBindings: JSON.stringify(record.toolBindings),
    runtimeArgv: JSON.stringify(record.runtimeArgv),
    evidence: JSON.stringify(record.evidence),
    questions: JSON.stringify(record.questions),
    slotReleased: record.slotReleased ? 1 : 0,
    gateEvaluated: record.gateEvaluated ? 1 : 0,
  };
}

function mapUser(row: Row): UserRecord {
  return {
    id: str(row, "id"),
    email: str(row, "email"),
    name: str(row, "name"),
    passwordHash: str(row, "password_hash"),
    createdAt: str(row, "created_at"),
  };
}

function mapMembership(row: Row): MembershipRecord {
  return {
    teamId: str(row, "team_id"),
    userId: str(row, "user_id"),
    role: str(row, "role") as Role,
    createdAt: str(row, "created_at"),
  };
}

function mapInvite(row: Row): InviteRecord {
  return {
    id: str(row, "id"),
    teamId: str(row, "team_id"),
    role: str(row, "role") as Role,
    tokenHash: str(row, "token_hash"),
    createdBy: str(row, "created_by"),
    acceptedBy: strOrNull(row, "accepted_by"),
    createdAt: str(row, "created_at"),
    acceptedAt: strOrNull(row, "accepted_at"),
  };
}

function mapProject(row: Row): ProjectRecord {
  return {
    id: str(row, "id"),
    teamId: str(row, "team_id"),
    name: str(row, "name"),
    remoteUrl: str(row, "remote_url"),
    baseBranch: str(row, "base_branch"),
    runtime: json<AgentRuntime>(row, "runtime_json", { argv: [], timeoutSec: 60 }),
    credentialId: strOrNull(row, "credential_id"),
    governanceMode: str(row, "governance_mode") as GovernanceMode,
    runbookLocked: flag(row, "runbook_locked"),
    activeRunbookDigest: strOrNull(row, "active_runbook_digest"),
    shadowRecord: flag(row, "shadow_record"),
    evolveCursor: str(row, "evolve_cursor"),
    createdAt: str(row, "created_at"),
  };
}

function mapFrame(row: Row): FrameRecord {
  return {
    projectId: str(row, "project_id"),
    version: num(row, "version"),
    markdown: str(row, "markdown"),
    createdBy: str(row, "created_by"),
    createdAt: str(row, "created_at"),
  };
}

function mapWorkItem(row: Row): WorkItemRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    parentId: strOrNull(row, "parent_id"),
    title: str(row, "title"),
    body: str(row, "body"),
    status: str(row, "status") as WorkStatus,
    ownerUserId: strOrNull(row, "owner_user_id"),
    frameVersion: numOrNull(row, "frame_version"),
    scopePaths: json<string[]>(row, "scope_json", []),
    blockedReason: strOrNull(row, "blocked_reason"),
    shipCommit: strOrNull(row, "ship_commit"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

function mapThread(row: Row): ThreadRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    workItemId: str(row, "work_item_id"),
    cursor: num(row, "cursor"),
  };
}

function mapEntry(row: Row): ThreadEntryRecord {
  return {
    id: str(row, "id"),
    threadId: str(row, "thread_id"),
    cursor: num(row, "cursor"),
    authorId: str(row, "author_id"),
    kind: str(row, "kind") === "guidance" ? "guidance" : "post",
    body: str(row, "body"),
    idempotencyKey: strOrNull(row, "idempotency_key"),
    createdAt: str(row, "created_at"),
  };
}

function mapRun(row: Row): RunRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    workItemId: strOrNull(row, "work_item_id"),
    attempt: num(row, "attempt"),
    state: str(row, "state") as RunState,
    role: str(row, "role") as RunRole,
    runbookDigest: strOrNull(row, "runbook_digest"),
    executionContractHash: strOrNull(row, "execution_contract_hash"),
    baseRevision: strOrNull(row, "base_revision"),
    frameVersion: numOrNull(row, "frame_version"),
    pid: numOrNull(row, "pid"),
    heartbeatAt: strOrNull(row, "heartbeat_at"),
    controllerUserId: strOrNull(row, "controller_user_id"),
    controlRevision: num(row, "control_revision"),
    policyRule: strOrNull(row, "policy_rule"),
    retryCount: num(row, "retry_count"),
    verifyHealCount: num(row, "verify_heal_count"),
    codeRetryCount: num(row, "code_retry_count"),
    failureSignature: strOrNull(row, "failure_signature"),
    guidance: json<string[]>(row, "guidance_json", []),
    answers: json<string[]>(row, "answers_json", []),
    failureNote: strOrNull(row, "failure_note"),
    midTurn: strOrNull(row, "mid_turn"),
    toolBindings: json<Record<string, string>>(row, "tool_bindings_json", {}),
    runtimeArgv: json<string[]>(row, "runtime_argv_json", []),
    resultStatus: strOrNull(row, "result_status"),
    resultSummary: strOrNull(row, "result_summary"),
    evidence: json<EvidenceItem[]>(row, "evidence_json", []),
    questions: json<string[]>(row, "questions_json", []),
    worktreePath: strOrNull(row, "worktree_path"),
    assignmentPath: strOrNull(row, "assignment_path"),
    patchHash: strOrNull(row, "patch_hash"),
    policyPinId: strOrNull(row, "policy_pin_id"),
    slotReleased: flag(row, "slot_released"),
    gateEvaluated: flag(row, "gate_evaluated"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

function mapRevision(row: Row): RunbookRevisionRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    digest: str(row, "digest"),
    document: json<RunbookDocument>(row, "document_json", {
      version: 1,
      install: null,
      health: null,
      gates: [],
      ship: null,
      runtimeTools: [],
      dependencyPaths: [],
      blockedPaths: [],
    }),
    status: str(row, "status") as RunbookRevisionRecord["status"],
    probe: json<EvidenceItem[]>(row, "probe_json", []),
    createdAt: str(row, "created_at"),
  };
}

function mapRelease(row: Row): PolicyReleaseRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    version: num(row, "version"),
    contentHash: str(row, "content_hash"),
    status: str(row, "status") === "active" ? "active" : "archived",
    createdAt: str(row, "created_at"),
    activatedAt: strOrNull(row, "activated_at"),
  };
}

function mapRule(row: Row): PolicyRuleRecord {
  return {
    id: str(row, "id"),
    releaseId: str(row, "release_id"),
    ruleKey: str(row, "rule_key"),
    revision: num(row, "revision"),
    text: str(row, "text"),
    detector: str(row, "detector"),
    paths: json<string[]>(row, "paths_json", []),
  };
}

function mapFinding(row: Row): FindingRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    runId: str(row, "run_id"),
    workItemId: str(row, "work_item_id"),
    kind: str(row, "kind") === "defect" ? "defect" : "standard",
    ruleKey: strOrNull(row, "rule_key"),
    ruleRevision: numOrNull(row, "rule_revision"),
    evidence: str(row, "evidence"),
    status: str(row, "status"),
    appeal: json<AppealRecord | null>(row, "appeal_json", null),
    judge: json(row, "judge_json", null),
    createdAt: str(row, "created_at"),
  };
}

function mapCase(row: Row): CaseRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    findingId: strOrNull(row, "finding_id"),
    workItemId: strOrNull(row, "work_item_id"),
    runId: strOrNull(row, "run_id"),
    kind: str(row, "kind"),
    status: str(row, "status"),
    payload: json<Record<string, unknown>>(row, "payload_json", {}),
    createdAt: str(row, "created_at"),
  };
}

function mapRuling(row: Row): RulingRecord {
  return {
    id: str(row, "id"),
    caseId: str(row, "case_id"),
    projectId: str(row, "project_id"),
    decision: str(row, "decision"),
    rationale: str(row, "rationale"),
    allowance: json<Record<string, unknown> | null>(row, "allowance_json", null),
    patchHash: strOrNull(row, "patch_hash"),
    ruleKey: strOrNull(row, "rule_key"),
    createdBy: str(row, "created_by"),
    createdAt: str(row, "created_at"),
  };
}

function mapAllowance(row: Row): AllowanceRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    releaseId: str(row, "release_id"),
    ruleKey: str(row, "rule_key"),
    kind: str(row, "kind") === "reusable" ? "reusable" : "once",
    patchHash: strOrNull(row, "patch_hash"),
    paths: json<string[]>(row, "paths_json", []),
    expiresAt: strOrNull(row, "expires_at"),
    used: flag(row, "used"),
    createdAt: str(row, "created_at"),
  };
}

function mapNomination(row: Row): NominationRecord {
  return {
    id: str(row, "id"),
    projectId: str(row, "project_id"),
    releaseId: str(row, "release_id"),
    ruleKey: str(row, "rule_key"),
    status: str(row, "status"),
    supporting: json<unknown[]>(row, "supporting_json", []),
    contrary: json<unknown[]>(row, "contrary_json", []),
    createdAt: str(row, "created_at"),
  };
}

function mapProposal(row: Row): ProposalRecord {
  return {
    id: str(row, "id"),
    nominationId: str(row, "nomination_id"),
    projectId: str(row, "project_id"),
    ruleKey: str(row, "rule_key"),
    text: str(row, "text"),
    detector: str(row, "detector"),
    paths: json<string[]>(row, "paths_json", []),
    authorKind: str(row, "author_kind") === "drafter" ? "drafter" : "person",
    createdAt: str(row, "created_at"),
  };
}

export type { CredentialSecret };
