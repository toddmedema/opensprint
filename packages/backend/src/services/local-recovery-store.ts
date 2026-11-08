import { randomUUID } from "node:crypto";
import os from "node:os";
import type { DbClient, DbRow } from "../db/client.js";
import type { MergeQualityGateFailure } from "./merge-quality-gate-runner.js";

export type RecoveryRecipe =
  | "repair_dependencies"
  | "retry_validation"
  | {
      action: "bind_runtime";
      binding: import("./project-execution-profile.service.js").RuntimeBinding;
    };
export type RecoveryState =
  | "validating"
  | "diagnosing"
  | "repairing"
  | "waiting"
  | "passed"
  | "held"
  | "failed"
  | "cancelled";
export interface RecoveryData {
  head?: string;
  contextHash: string;
  recipeHash?: string;
  startedAt: number;
  recoveryStartedAt?: number;
  deadlineAt?: number;
  remainingRepairMs?: number;
  waitProbes?: number;
  attempts: number;
  commands: number;
  diagnoses: number;
  activeCommand?: { pid?: number; label: string };
  recipe?: RecoveryRecipe;
  failureKey?: string;
  executionContract?: Record<string, unknown>;
  runtimeBindings?: import("./project-execution-profile.service.js").RuntimeBinding[];
  failure?: MergeQualityGateFailure;
  history: Array<{ at: string; event: string; detail?: string }>;
}
export interface RecoveryIncident {
  id: string;
  projectId: string;
  workspace: string;
  generation: number;
  owner: string;
  ownerPid: number;
  ownerHost: string;
  state: RecoveryState;
  data: RecoveryData;
}
export interface RecoveryCheckpoint {
  worktreePath: string;
  validationWorkspacePath?: string;
  validationBranchName?: string;
  worktreeKey?: string;
  continuation?: "post_coding_validation" | "review_validation" | "merge_validation";
  branchName: string;
  baseBranch: string;
  head: string;
  contextHash: string;
  phase?: "coding" | "review";
  phaseResult?: import("./orchestrator-phase-context.js").PhaseResult;
  attempt?: number;
}

function incident(row: DbRow): RecoveryIncident {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workspace: String(row.workspace),
    generation: Number(row.generation),
    owner: String(row.owner),
    ownerPid: Number(row.owner_pid),
    ownerHost: String(row.owner_host),
    state: row.state as RecoveryState,
    data: JSON.parse(String(row.data)) as RecoveryData,
  };
}

/** All claims and mutations are fenced in SQL, including across backend processes. */
export class LocalRecoveryStore {
  readonly owner = randomUUID();
  constructor(
    private readonly db: () => Promise<DbClient>,
    readonly host = os.hostname(),
    readonly pid = process.pid
  ) {}

  async pinAuthority(
    projectId: string,
    taskId: string,
    attemptKey: string,
    hash: string
  ): Promise<void> {
    await (
      await this.db()
    ).execute(
      "INSERT INTO local_validation_authorities(project_id,task_id,attempt_key,authority_hash) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,task_id,attempt_key) DO NOTHING",
      [projectId, taskId, attemptKey, hash]
    );
  }
  async authority(
    projectId: string,
    taskId: string,
    attemptKey: string
  ): Promise<string | undefined> {
    const row = await (
      await this.db()
    ).queryOne(
      "SELECT authority_hash FROM local_validation_authorities WHERE project_id=$1 AND task_id=$2 AND attempt_key=$3",
      [projectId, taskId, attemptKey]
    );
    return row && String(row.authority_hash);
  }

  async get(projectId: string, workspace: string): Promise<RecoveryIncident | undefined> {
    const row = await (
      await this.db()
    ).queryOne("SELECT * FROM local_recovery_incidents WHERE project_id=$1 AND workspace=$2", [
      projectId,
      workspace,
    ]);
    return row && incident(row);
  }

  async create(
    projectId: string,
    workspace: string,
    contextHash: string
  ): Promise<RecoveryIncident> {
    const data: RecoveryData = {
      contextHash,
      startedAt: Date.now(),
      attempts: 0,
      commands: 0,
      diagnoses: 0,
      history: [],
    };
    await (
      await this.db()
    ).execute(
      `INSERT INTO local_recovery_incidents(id,project_id,workspace,generation,owner,owner_pid,owner_host,state,data,updated_at)
       VALUES($1,$2,$3,1,$4,$5,$6,'validating',$7,$8) ON CONFLICT(project_id,workspace) DO NOTHING`,
      [
        randomUUID(),
        projectId,
        workspace,
        this.owner,
        this.pid,
        this.host,
        JSON.stringify(data),
        new Date().toISOString(),
      ]
    );
    return (await this.get(projectId, workspace))!;
  }

  async claim(
    previous: RecoveryIncident,
    reset = false,
    contextHash = previous.data.contextHash
  ): Promise<RecoveryIncident | undefined> {
    const data: RecoveryData = reset
      ? { contextHash, startedAt: Date.now(), attempts: 0, commands: 0, diagnoses: 0, history: [] }
      : { ...previous.data, activeCommand: undefined };
    return (await this.db()).runInTransaction(async (db) => {
      const changed = await db.execute(
        `UPDATE local_recovery_incidents SET generation=generation+1,owner=$1,owner_pid=$2,owner_host=$3,state=$4,data=$5,updated_at=$6
         WHERE id=$7 AND generation=$8 AND owner=$9 AND state=$10`,
        [
          this.owner,
          this.pid,
          this.host,
          reset ? "validating" : previous.state,
          JSON.stringify(data),
          new Date().toISOString(),
          previous.id,
          previous.generation,
          previous.owner,
          previous.state,
        ]
      );
      if (!changed) return undefined;
      // A resumed incident keeps its members; a new validation must not inherit old
      // tasks whose later cancellation could fence the new owner.
      if (!reset)
        await db.execute(
          "UPDATE local_recovery_tasks SET generation=$1 WHERE incident_id=$2 AND generation=$3",
          [previous.generation + 1, previous.id, previous.generation]
        );
      const row = await db.queryOne("SELECT * FROM local_recovery_incidents WHERE id=$1", [
        previous.id,
      ]);
      return row && incident(row);
    });
  }

  async owns(run: RecoveryIncident): Promise<boolean> {
    const row = await this.get(run.projectId, run.workspace);
    return (
      !!row &&
      row.owner === this.owner &&
      row.generation === run.generation &&
      row.state !== "cancelled"
    );
  }

  async save(run: RecoveryIncident): Promise<void> {
    const changed = await (
      await this.db()
    ).execute(
      `UPDATE local_recovery_incidents SET state=$1,data=$2,updated_at=$3
       WHERE id=$4 AND generation=$5 AND owner=$6 AND state <> 'cancelled'`,
      [
        run.state,
        JSON.stringify(run.data),
        new Date().toISOString(),
        run.id,
        run.generation,
        this.owner,
      ]
    );
    if (!changed) throw new Error("Local recovery ownership changed");
  }

  async checkpoint(
    run: RecoveryIncident,
    taskId: string,
    checkpoint: RecoveryCheckpoint
  ): Promise<void> {
    await (
      await this.db()
    ).execute(
      `INSERT INTO local_recovery_tasks(project_id,task_id,incident_id,generation,checkpoint) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(project_id,task_id) DO UPDATE SET incident_id=excluded.incident_id,generation=excluded.generation,checkpoint=excluded.checkpoint`,
      [run.projectId, taskId, run.id, run.generation, JSON.stringify(checkpoint)]
    );
  }

  async checkpointForTask(
    projectId: string,
    taskId: string
  ): Promise<RecoveryCheckpoint | undefined> {
    const row = await (
      await this.db()
    ).queryOne("SELECT checkpoint FROM local_recovery_tasks WHERE project_id=$1 AND task_id=$2", [
      projectId,
      taskId,
    ]);
    return row ? (JSON.parse(String(row.checkpoint)) as RecoveryCheckpoint) : undefined;
  }
  async beginRequest(projectId: string, taskId: string, requestId: string): Promise<void> {
    await (
      await this.db()
    ).execute(
      "INSERT INTO local_recovery_requests(project_id,task_id,request_id) VALUES($1,$2,$3) ON CONFLICT(project_id,task_id,request_id) DO NOTHING",
      [projectId, taskId, requestId]
    );
  }
  async requestCancelled(projectId: string, taskId: string, requestId: string): Promise<boolean> {
    const row = await (
      await this.db()
    ).queryOne(
      "SELECT cancelled FROM local_recovery_requests WHERE project_id=$1 AND task_id=$2 AND request_id=$3",
      [projectId, taskId, requestId]
    );
    return !row || Number(row.cancelled) === 1;
  }
  async rememberReview(
    projectId: string,
    taskId: string,
    attemptKey: string,
    angle: string,
    outcome: import("./task-phase-coordinator.js").ReviewOutcome
  ): Promise<void> {
    await (
      await this.db()
    ).execute(
      "INSERT INTO local_recovery_reviews(project_id,task_id,attempt_key,angle,outcome) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,task_id,attempt_key,angle) DO UPDATE SET outcome=excluded.outcome",
      [projectId, taskId, attemptKey, angle, JSON.stringify(outcome)]
    );
  }
  async reviews(
    projectId: string,
    taskId: string,
    attemptKey: string
  ): Promise<
    Array<{ angle: string; outcome: import("./task-phase-coordinator.js").ReviewOutcome }>
  > {
    return (
      await (
        await this.db()
      ).query(
        "SELECT angle,outcome FROM local_recovery_reviews WHERE project_id=$1 AND task_id=$2 AND attempt_key=$3",
        [projectId, taskId, attemptKey]
      )
    ).map((r) => ({ angle: String(r.angle), outcome: JSON.parse(String(r.outcome)) }));
  }

  async retained(
    projectId: string
  ): Promise<Array<{ taskId: string; checkpoint: RecoveryCheckpoint }>> {
    const rows = await (
      await this.db()
    ).query(
      `SELECT t.task_id,t.checkpoint,i.state,i.data FROM local_recovery_tasks t JOIN local_recovery_incidents i ON i.id=t.incident_id
       WHERE t.project_id=$1 AND t.generation=i.generation AND i.state IN ('validating','diagnosing','repairing','waiting','held')`,
      [projectId]
    );
    return rows.map((r) => ({
      taskId: String(r.task_id),
      checkpoint: JSON.parse(String(r.checkpoint)) as RecoveryCheckpoint,
    }));
  }

  async cancelTask(projectId: string, taskId: string): Promise<void> {
    await (
      await this.db()
    ).runInTransaction(async (db) => {
      await db.execute(
        "UPDATE local_recovery_requests SET cancelled=1 WHERE project_id=$1 AND task_id=$2",
        [projectId, taskId]
      );
      const rows = await db.query(
        `SELECT i.id,i.generation FROM local_recovery_incidents i JOIN local_recovery_tasks t ON i.id=t.incident_id AND i.generation=t.generation WHERE t.project_id=$1 AND t.task_id=$2 AND i.state NOT IN ('passed','failed','cancelled')`,
        [projectId, taskId]
      );
      for (const row of rows) {
        const changed = await db.execute(
          "UPDATE local_recovery_incidents SET state='cancelled',generation=generation+1,updated_at=$1 WHERE id=$2 AND generation=$3",
          [new Date().toISOString(), row.id, row.generation]
        );
        if (changed)
          await db.execute(
            "UPDATE local_recovery_tasks SET generation=$1 WHERE incident_id=$2 AND generation=$3",
            [Number(row.generation) + 1, row.id, row.generation]
          );
      }
    });
  }

  /** A fenced command may only release its own cancelled receipt after observed close. */
  async observedCommandClosed(run: RecoveryIncident): Promise<void> {
    const db = await this.db();
    const latest = await this.get(run.projectId, run.workspace);
    if (
      !latest ||
      latest.owner !== this.owner ||
      latest.state !== "cancelled" ||
      latest.generation !== run.generation + 1
    )
      return;
    if (JSON.stringify(latest.data.activeCommand) !== JSON.stringify(run.data.activeCommand))
      return;
    const previousData = JSON.stringify(latest.data);
    latest.data.activeCommand = undefined;
    await db.execute(
      "UPDATE local_recovery_incidents SET data=$1 WHERE id=$2 AND generation=$3 AND owner=$4 AND state='cancelled' AND data=$5",
      [JSON.stringify(latest.data), latest.id, latest.generation, this.owner, previousData]
    );
  }

  async protectsWorkspace(workspace: string): Promise<boolean> {
    const rows = await (
      await this.db()
    ).query(
      "SELECT t.checkpoint,i.state,i.data FROM local_recovery_tasks t JOIN local_recovery_incidents i ON i.id=t.incident_id AND i.generation=t.generation WHERE i.state IN ('validating','diagnosing','repairing','waiting','held','cancelled')"
    );
    return rows.some((r) => {
      if (r.state === "cancelled" && !(JSON.parse(String(r.data)) as RecoveryData).activeCommand)
        return false;
      const cp = JSON.parse(String(r.checkpoint)) as RecoveryCheckpoint;
      return cp.worktreePath === workspace || cp.validationWorkspacePath === workspace;
    });
  }
  async protectsWorktreeKey(key: string): Promise<boolean> {
    const rows = await (
      await this.db()
    ).query(
      "SELECT t.task_id,t.checkpoint,i.state,i.data FROM local_recovery_tasks t JOIN local_recovery_incidents i ON i.id=t.incident_id AND i.generation=t.generation WHERE i.state IN ('validating','diagnosing','repairing','waiting','held','cancelled')"
    );
    return rows.some((r) => {
      if (r.state === "cancelled" && !(JSON.parse(String(r.data)) as RecoveryData).activeCommand)
        return false;
      const cp = JSON.parse(String(r.checkpoint)) as RecoveryCheckpoint;
      return r.task_id === key || cp.worktreeKey === key || cp.branchName === `opensprint/${key}`;
    });
  }

  async canResume(projectId: string, workspace: string): Promise<boolean> {
    const run = await this.get(projectId, workspace);
    if (!run || !["validating", "diagnosing", "repairing", "waiting"].includes(run.state))
      return false;
    if (run.owner === this.owner) return false;
    if (run.ownerHost !== this.host) return false;
    const live = (pid: number, group = false) => {
      try {
        process.kill(group && process.platform !== "win32" ? -pid : pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    if (live(run.ownerPid)) return false;
    return (
      !run.data.activeCommand ||
      (!!run.data.activeCommand.pid && !live(run.data.activeCommand.pid, true))
    );
  }

  async recipe(
    projectId: string,
    hash: string,
    failureKey?: string
  ): Promise<RecoveryRecipe | undefined> {
    const row = await (
      await this.db()
    ).queryOne(
      `SELECT recipe FROM local_execution_profiles WHERE project_id=$1 AND context_hash=$2 AND failure_key<>'__execution__'${failureKey !== undefined ? " AND failure_key=$3" : ""} ORDER BY verified_at DESC LIMIT 1`,
      [projectId, hash, ...(failureKey !== undefined ? [failureKey] : [])]
    );
    if (!row) return undefined;
    try {
      return JSON.parse(String(row.recipe)) as RecoveryRecipe;
    } catch {
      return ["repair_dependencies", "retry_validation"].includes(String(row.recipe))
        ? (row.recipe as RecoveryRecipe)
        : undefined;
    }
  }

  async executionProfile(
    projectId: string,
    hash: string
  ): Promise<
    | { runtimeBindings?: import("./project-execution-profile.service.js").RuntimeBinding[] }
    | undefined
  > {
    const row = await (
      await this.db()
    ).queryOne(
      "SELECT contract FROM local_execution_profiles WHERE project_id=$1 AND context_hash=$2 AND failure_key='__execution__'",
      [projectId, hash]
    );
    return row ? JSON.parse(String(row.contract)) : undefined;
  }

  async promote(run: RecoveryIncident, evidence: string): Promise<void> {
    if (run.state !== "passed") return;
    // Conditional insert keeps a late/cancelled worker from publishing learned authority.
    await (
      await this.db()
    ).execute(
      `INSERT INTO local_execution_profiles(project_id,context_hash,failure_key,recipe,evidence,verified_at,contract)
       SELECT project_id,$1,'__execution__','null',$2,$3,$4 FROM local_recovery_incidents WHERE id=$5 AND generation=$6 AND owner=$7 AND state='passed'
       ON CONFLICT(project_id,context_hash,failure_key) DO UPDATE SET evidence=excluded.evidence,verified_at=excluded.verified_at,contract=excluded.contract`,
      [
        run.data.recipeHash ?? run.data.contextHash,
        evidence,
        new Date().toISOString(),
        JSON.stringify({
          ...run.data.executionContract,
          runtimeBindings: run.data.runtimeBindings ?? [],
        }),
        run.id,
        run.generation,
        this.owner,
      ]
    );
    if (run.data.recipe)
      await (
        await this.db()
      ).execute(
        `INSERT INTO local_execution_profiles(project_id,context_hash,failure_key,recipe,evidence,verified_at)
       SELECT project_id,$1,$2,$3,$4,$5 FROM local_recovery_incidents WHERE id=$6 AND generation=$7 AND owner=$8 AND state='passed'
       ON CONFLICT(project_id,context_hash,failure_key) DO UPDATE SET recipe=excluded.recipe,evidence=excluded.evidence,verified_at=excluded.verified_at`,
        [
          run.data.recipeHash ?? run.data.contextHash,
          run.data.failureKey ?? "",
          JSON.stringify(run.data.recipe),
          evidence,
          new Date().toISOString(),
          run.id,
          run.generation,
          this.owner,
        ]
      );
  }
}
