import { agentProcessEnvironment } from "../utils/agent-process-env.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type {
  AgentSession,
  GovernanceTaskPin,
  GovernanceEvent,
  PolicyRelease,
} from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import type { GovernanceContextArtifacts } from "./governance-context-artifacts.js";
const run = promisify(execFile);
export interface GovernanceReplayInput {
  sessionId: number;
  taskId: string;
  attempt: number;
  status: string;
  startedAt: string;
  completedAt: string;
  invocationId: string;
  promptEventId: string;
  taskPrompt: string;
  originalPrompt: string;
  baseSha: string;
  headSha: string;
  diff: string;
  changedPaths: string[];
  pin: GovernanceTaskPin;
  release: PolicyRelease;
  contextArtifacts: GovernanceContextArtifacts;
}
/** Called under the session archive transaction before pruning. Never reconstruct from a later attempt. */
export async function retainGovernanceReplayInput(
  db: DbClient,
  projectId: string,
  sessionId: number,
  session: AgentSession,
  repoPath: string
): Promise<void> {
  const row = await db.queryOne(
    "SELECT payload FROM governance_task_pins WHERE project_id=$1 AND task_id=$2",
    [projectId, session.taskId]
  );
  if (!row || !session.completedAt) return;
  const events = (
    await db.query(
      "SELECT payload FROM governance_events WHERE project_id=$1 AND kind='prompt_snapshot'",
      [projectId]
    )
  ).map((row) => JSON.parse(String(row.payload)) as GovernanceEvent);
  const matching = events
    .filter(
      (event) =>
        event.payload.taskId === session.taskId &&
        event.payload.role === "coder" &&
        event.payload.attempt === session.attempt &&
        typeof event.payload.dynamicContext === "string" &&
        typeof event.payload.invocationId === "string" &&
        typeof event.payload.assignmentCreatedAt === "string" &&
        Date.parse(String(event.payload.assignmentCreatedAt)) <= Date.parse(session.startedAt) &&
        Date.parse(event.createdAt) <= Date.parse(session.completedAt!)
    )
    .sort((a, b) =>
      String(b.payload.assignmentCreatedAt).localeCompare(String(a.payload.assignmentCreatedAt))
    );
  const prompt = matching[0];
  if (!prompt || matching[1]?.payload.assignmentCreatedAt === prompt.payload.assignmentCreatedAt)
    return;
  const pin = prompt.payload.policyPin as GovernanceTaskPin | undefined;
  if (!pin || pin.projectId !== projectId || pin.taskId !== session.taskId || !pin.releaseId)
    return;
  const releaseRow = await db.queryOne(
    "SELECT payload FROM policy_releases WHERE project_id=$1 AND id=$2",
    [projectId, pin.releaseId]
  );
  if (!releaseRow) return;
  const contextArtifacts = prompt.payload.contextArtifacts as
    | GovernanceContextArtifacts
    | undefined;
  if (
    !contextArtifacts?.complete ||
    !contextArtifacts.files ||
    !("spec.md" in contextArtifacts.files) ||
    !("plan.md" in contextArtifacts.files)
  )
    return;
  const baseSha = String(prompt.payload.headSha);
  if (!/^[a-f0-9]{40,64}$/.test(baseSha)) return;
  const options = {
    env: agentProcessEnvironment(),
    cwd: repoPath,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  };
  const headSha = (
    await run("git", ["rev-parse", "--verify", `${session.gitBranch}^{commit}`], options)
  ).stdout.trim();
  const diff = (
    await run("git", ["diff", "--binary", "--no-ext-diff", baseSha, headSha, "--"], options)
  ).stdout;
  const changedPaths = (
    await run("git", ["diff", "--name-only", "--no-renames", "-z", baseSha, headSha, "--"], options)
  ).stdout
    .split("\0")
    .filter(Boolean)
    .sort();
  const ref = `refs/opensprint/replay-inputs/${createHash("sha256").update(projectId).digest("hex")}/${sessionId}`;
  await run("git", ["update-ref", `${ref}/base`, baseSha], options);
  await run("git", ["update-ref", `${ref}/head`, headSha], options);
  const input: GovernanceReplayInput = {
    sessionId,
    taskId: session.taskId,
    attempt: session.attempt,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    invocationId: String(prompt.payload.invocationId),
    promptEventId: prompt.id,
    taskPrompt: String(prompt.payload.dynamicContext),
    originalPrompt: String(prompt.payload.prompt),
    baseSha,
    headSha,
    diff,
    changedPaths,
    pin,
    release: JSON.parse(String(releaseRow.payload)) as PolicyRelease,
    contextArtifacts,
  };
  await db.execute(
    "INSERT INTO governance_replay_inputs(project_id,session_id,task_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [projectId, sessionId, session.taskId, JSON.stringify(input)]
  );
}
