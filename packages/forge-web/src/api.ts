import { queryClient } from "./queryClient";
import { asRecord, bool, num, numOrNull, questionSummary, str, strOrNull, textList } from "./text";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

export const queryKeys = {
  session: ["session"] as const,
  health: ["health"] as const,
  home: ["home"] as const,
  members: (teamId: string) => ["team", teamId, "members"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  frame: (projectId: string) => ["project", projectId, "frame"] as const,
  runbook: (projectId: string) => ["project", projectId, "runbook"] as const,
  order: (projectId: string) => ["project", projectId, "order"] as const,
  workItem: (projectId: string, workItemId: string) =>
    ["project", projectId, "order", workItemId] as const,
  gate: (projectId: string) => ["project", projectId, "gate"] as const,
  evolve: (projectId: string) => ["project", projectId, "evolve"] as const,
};

export const ROLES = ["view", "discuss", "steer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const GOVERNANCE_MODES = ["disabled", "shadow", "enforced"] as const;
export type GovernanceMode = (typeof GOVERNANCE_MODES)[number];

export const DECISIONS = ["reject", "allow_once"] as const;
export type Decision = (typeof DECISIONS)[number];

export const AUTHOR_KINDS = ["person", "drafter"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export const DETECTOR = "protected-path";

export const FALLBACK_REPLAY_NOTE =
  "Replay is strong evidence about a cooperative agent. Checks against the coder's own workspace can still be influenced by that code.";

const PROJECT_EVENTS = [
  "run.updated",
  "work_item.updated",
  "thread.appended",
  "runbook.updated",
  "membership.updated",
] as const;

export type ProjectEventName = (typeof PROJECT_EVENTS)[number];

export function isProjectEvent(value: string): value is ProjectEventName {
  return (PROJECT_EVENTS as readonly string[]).includes(value);
}

export async function invalidateProject(projectId: string): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) => query.queryKey.includes(projectId),
  });
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: "include",
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed.";
    throw new ApiError(0, "network", message);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(
        response.status,
        "invalid_json",
        response.ok
          ? "The server returned an unreadable response."
          : "The server returned an unreadable error."
      );
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/session")) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    }
    const record = asRecord(payload);
    const errorRecord = asRecord(record.error);
    throw new ApiError(
      response.status,
      str(errorRecord.code, "http_error"),
      str(errorRecord.message, `Request failed (${response.status}).`)
    );
  }

  return payload;
}

async function allowMissing(path: string): Promise<unknown> {
  try {
    return await request(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export type User = {
  id: string;
  email: string;
  name: string;
};

export type Ack = {
  outcome: string | null;
  digest: string | null;
  questions: string[];
  failure: string | null;
  detail: string | null;
};

export type AgentRuntime = {
  argv: string[];
  timeoutSec: number;
};

export type TeamSummary = {
  id: string;
  name: string;
  role: string;
};

export type ProjectSummary = {
  id: string;
  teamId: string;
  name: string;
  remoteUrl: string | null;
  baseBranch: string;
  governanceMode: string;
  runbookLocked: boolean;
  activeRunbookDigest: string | null;
  credentialKind: string;
  hasCredential: boolean;
  agentRuntime: AgentRuntime;
};

export type Ship = {
  workItemId: string;
  projectId: string;
  title: string;
  shipCommit: string | null;
  updatedAt: string | null;
};

export type HomeData = {
  healthOk: boolean | null;
  teams: TeamSummary[];
  projects: ProjectSummary[];
  recentShips: Ship[];
};

export type Member = {
  userId: string;
  name: string;
  email: string;
  role: string;
};

export type Invite = {
  token: string;
  role: string;
};

export type Membership = {
  teamId: string;
  role: string;
};

export type ProjectBundle = {
  project: ProjectSummary;
  frame: { version: number; markdown: string } | null;
  runbook: { locked: boolean; activeDigest: string | null; document: unknown } | null;
};

export type FrameVersion = {
  version: number;
  createdAt: string | null;
};

export type FrameData = {
  version: number;
  markdown: string;
  versions: FrameVersion[];
};

export type RunbookRevision = {
  id: string;
  digest: string;
  status: string;
  createdAt: string | null;
  probe: unknown;
};

export type RunbookData = {
  locked: boolean;
  activeDigest: string | null;
  active: unknown;
  revisions: RunbookRevision[];
};

export type WorkItem = {
  id: string;
  title: string;
  body: string;
  status: string;
  ownerUserId: string | null;
  blockedReason: string | null;
  shipCommit: string | null;
  parentId: string | null;
  scopePaths: string[];
};

export type Dependency = {
  workItemId: string;
  dependsOnId: string;
};

export type OrderData = {
  items: WorkItem[];
  dependencies: Dependency[];
};

export type Evidence = {
  command: string;
  exitCode: number | null;
  excerpt: string;
};

export type ThreadEntry = {
  id: string;
  cursor: string;
  authorId: string;
  authorName: string;
  kind: string;
  body: string;
  createdAt: string | null;
};

export type RunSnapshot = {
  id: string;
  attempt: number;
  state: string;
  runbookDigest: string | null;
  frameVersion: number | null;
  controllerUserId: string | null;
  controlRevision: number | null;
  policyRule: string | null;
  midTurn: string | null;
  questions: string[];
  resultStatus: string | null;
  resultSummary: string | null;
  policyPin: string | null;
};

export type Controller = {
  userId: string;
  name: string;
  revision: number;
};

export type WorkRoom = {
  item: WorkItem;
  dependencies: Dependency[];
  diff: string;
  evidence: Evidence[];
  thread: { cursor: string; entries: ThreadEntry[] };
  run: RunSnapshot | null;
  controller: Controller | null;
};

export type GateHold = {
  id: string;
  workItemId: string | null;
  title: string;
  status: string;
  reason: string;
  failing: boolean;
};

export type GateQuestion = {
  id: string;
  runId: string;
  prompt: string;
  status: string;
  role: string;
};

export type GateCase = {
  id: string;
  workItemId: string | null;
  title: string;
  status: string;
  summary: string;
};

export type GateFinding = {
  id: string;
  title: string;
  summary: string;
  status: string;
  rule: string | null;
};

export type GateData = {
  holds: GateHold[];
  questions: GateQuestion[];
  cases: GateCase[];
  findings: GateFinding[];
};

export type Release = {
  id: string;
  title: string;
  createdAt: string | null;
  status: string;
};

export type Nomination = {
  id: string;
  title: string;
  beforeText: string;
  afterText: string;
  supportingEvidence: string[];
  contraryEvidence: string[];
  status: string;
};

export type Proposal = {
  id: string;
  nominationId: string | null;
  text: string;
  detector: string;
  paths: string[];
  authorKind: string;
  beforeText: string;
  afterText: string;
  supportingEvidence: string[];
  contraryEvidence: string[];
  evaluationStatus: string;
  status: string;
};

export type Evaluation = {
  id: string;
  proposalId: string | null;
  status: string;
  summary: string;
  supportingEvidence: string[];
  contraryEvidence: string[];
};

export type EvolveData = {
  replayNote: string;
  releases: Release[];
  nominations: Nomination[];
  proposals: Proposal[];
  evaluations: Evaluation[];
};

export type CredentialInput =
  | { type: "none" }
  | { type: "https_token"; username: string; token: string };

export type CreateProjectInput = {
  origin?: "scratch" | "import";
  name: string;
  remoteUrl?: string;
  baseBranch: string;
  agentRuntime: AgentRuntime;
  credential: CredentialInput;
};

function readUser(payload: unknown): User | null {
  const record = asRecord(payload);
  const nested = asRecord(record.user);
  const source = nested.id || nested.email ? nested : record;
  const id = str(source.id).trim();
  const email = str(source.email).trim();
  const name = str(source.name).trim();
  if (!id || !email) return null;
  return { id, email, name: name || email };
}

function readHealthOk(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const record = asRecord(value);
  if (typeof record.ok === "boolean") return record.ok;
  return null;
}

function readRuntime(value: unknown): AgentRuntime {
  const record = asRecord(value);
  const argv = Array.isArray(record.argv)
    ? record.argv.map((item) => str(item)).filter(Boolean)
    : [];
  return { argv, timeoutSec: num(record.timeoutSec) };
}

function readProject(value: unknown): ProjectSummary {
  const record = asRecord(value);
  const credentialKind = str(
    record.credentialKind,
    bool(record.hasCredential) ? "https_token" : "none"
  );
  return {
    id: str(record.id),
    teamId: str(record.teamId),
    name: str(record.name, "Untitled project"),
    remoteUrl: strOrNull(record.remoteUrl),
    baseBranch: str(record.baseBranch),
    governanceMode: str(record.governanceMode, "disabled"),
    runbookLocked: bool(record.runbookLocked),
    activeRunbookDigest: strOrNull(record.activeRunbookDigest),
    credentialKind,
    hasCredential: credentialKind === "https_token",
    agentRuntime: readRuntime(record.agentRuntime),
  };
}

function readWorkItem(value: unknown, index: number): WorkItem {
  const record = asRecord(value);
  return {
    id: str(record.id, `item-${index + 1}`),
    title: str(record.title, "Untitled work item"),
    body: str(record.body),
    status: str(record.status, "unknown"),
    ownerUserId: strOrNull(record.ownerUserId),
    blockedReason: strOrNull(record.blockedReason),
    shipCommit: strOrNull(record.shipCommit),
    parentId: strOrNull(record.parentId),
    scopePaths: textList(record.scopePaths),
  };
}

function readDependencies(value: unknown): Dependency[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const workItemId = str(record.workItemId);
      const dependsOnId = str(record.dependsOnId);
      if (!workItemId || !dependsOnId) return null;
      return { workItemId, dependsOnId };
    })
    .filter((item): item is Dependency => item != null);
}

function readExact(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

function readEvidenceLists(record: Record<string, unknown>): {
  supportingEvidence: string[];
  contraryEvidence: string[];
} {
  return {
    supportingEvidence: textList(record.supportingEvidence ?? record.supporting),
    contraryEvidence: textList(record.contraryEvidence ?? record.contrary),
  };
}

export function readAck(payload: unknown): Ack {
  const record = asRecord(payload);
  const errorRecord = asRecord(record.error);
  const questions = textList(record.questions);
  return {
    outcome: strOrNull(record.outcome),
    digest: strOrNull(record.digest),
    questions: questions.length > 0 ? questions : textList(record.question),
    failure:
      strOrNull(record.failure) ??
      (typeof record.error === "string" ? strOrNull(record.error) : strOrNull(errorRecord.message)),
    detail: strOrNull(record.summary) ?? messageUnless(record.message, record.outcome),
  };
}

export function readCreatedId(payload: unknown): string | null {
  const record = asRecord(payload);
  return (
    strOrNull(asRecord(record.project).id) ??
    strOrNull(asRecord(record.team).id) ??
    strOrNull(asRecord(record.item).id) ??
    strOrNull(record.projectId) ??
    strOrNull(record.id)
  );
}

function messageUnless(message: unknown, outcome: unknown): string | null {
  const text = strOrNull(message);
  if (!text || text === strOrNull(outcome)) return null;
  return text;
}

function readDiff(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("\n");
  }
  const record = asRecord(value);
  for (const key of ["patch", "unified", "text", "diff"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

function readRun(value: unknown): RunSnapshot | null {
  if (value == null) return null;
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return null;
  const questions = textList(record.questions);
  return {
    id: str(record.id),
    attempt: num(record.attempt),
    state: str(record.state, "unknown"),
    runbookDigest: strOrNull(record.runbookDigest),
    frameVersion: numOrNull(record.frameVersion),
    controllerUserId: strOrNull(record.controllerUserId),
    controlRevision: numOrNull(record.controlRevision),
    policyRule: strOrNull(record.policyRule),
    midTurn: strOrNull(record.midTurn),
    questions: questions.length > 0 ? questions : textList(record.question),
    resultStatus: strOrNull(record.resultStatus),
    resultSummary: strOrNull(record.resultSummary),
    policyPin: readLooseText(record.policyPin),
  };
}

function readLooseText(value: unknown): string | null {
  const direct = strOrNull(value);
  if (direct) return direct;
  if (value == null || typeof value === "string") return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function clearHoldStatus(status: string): boolean {
  return ["ok", "pass", "passed", "clear", "cleared", "resolved", "satisfied"].includes(
    status.trim().toLowerCase()
  );
}

export async function getHealth(): Promise<{ ok: boolean }> {
  const payload = await request("/health");
  return { ok: asRecord(payload).ok === true };
}

export async function getSession(): Promise<User | null> {
  try {
    const user = readUser(await request("/session"));
    if (!user) {
      throw new ApiError(500, "invalid_session", "Session response did not include a user.");
    }
    return user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

async function establishSession(path: string, body: unknown): Promise<User> {
  const user = readUser(await request(path, { method: "POST", body: JSON.stringify(body) }));
  if (user) return user;
  const current = await getSession();
  if (!current) {
    throw new ApiError(500, "invalid_session", "Signed in, but the server did not return a user.");
  }
  return current;
}

export function register(input: { email: string; name: string; password: string }): Promise<User> {
  return establishSession("/session/register", input);
}

export function signIn(input: { email: string; password: string }): Promise<User> {
  return establishSession("/session", input);
}

export async function signOut(): Promise<void> {
  await request("/session", { method: "DELETE" });
}

export async function getHome(): Promise<HomeData> {
  const record = asRecord(await request("/home"));
  const teams = Array.isArray(record.teams)
    ? record.teams.map((item) => {
        const team = asRecord(item);
        return { id: str(team.id), name: str(team.name, "Untitled team"), role: str(team.role) };
      })
    : [];
  const projects = Array.isArray(record.projects) ? record.projects.map(readProject) : [];
  const recentShips = Array.isArray(record.recentShips)
    ? record.recentShips.map((item) => {
        const ship = asRecord(item);
        return {
          workItemId: str(ship.workItemId),
          projectId: str(ship.projectId),
          title: str(ship.title, "Untitled ship"),
          shipCommit: strOrNull(ship.shipCommit),
          updatedAt: strOrNull(ship.updatedAt),
        };
      })
    : [];
  return {
    healthOk: readHealthOk(record.health),
    teams: teams.filter((team) => team.id),
    projects: projects.filter((project) => project.id),
    recentShips: recentShips.filter((ship) => ship.workItemId && ship.projectId),
  };
}

export async function createTeam(name: string): Promise<{ id: string; name: string }> {
  const payload = await request("/teams", { method: "POST", body: JSON.stringify({ name }) });
  const team = asRecord(asRecord(payload).team);
  const id = str(team.id);
  if (!id) throw new ApiError(500, "invalid_response", "The server did not return a team.");
  return { id, name: str(team.name, name) };
}

export async function getMembers(teamId: string): Promise<Member[]> {
  const payload = await request(`/teams/${enc(teamId)}/members`);
  const members = asRecord(payload).members;
  if (!Array.isArray(members)) return [];
  return members
    .map((item) => {
      const record = asRecord(item);
      return {
        userId: str(record.userId),
        name: str(record.name, "Unnamed member"),
        email: str(record.email),
        role: str(record.role, "view"),
      };
    })
    .filter((member) => member.userId);
}

export async function updateMemberRole(
  teamId: string,
  userId: string,
  role: string
): Promise<void> {
  await request(`/teams/${enc(teamId)}/members/${enc(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function createInvite(teamId: string, role: string): Promise<Invite> {
  const payload = await request(`/teams/${enc(teamId)}/invites`, {
    method: "POST",
    body: JSON.stringify({ role }),
  });
  const invite = asRecord(asRecord(payload).invite);
  const token = str(invite.token);
  if (!token)
    throw new ApiError(500, "invalid_response", "The server did not return an invite token.");
  return { token, role: str(invite.role, role) };
}

export async function acceptInvite(token: string): Promise<Membership> {
  const payload = await request(`/invites/${enc(token)}/accept`, { method: "POST" });
  const membership = asRecord(asRecord(payload).membership);
  const teamId = str(membership.teamId);
  if (!teamId) {
    throw new ApiError(500, "invalid_response", "The server did not return a membership.");
  }
  return { teamId, role: str(membership.role) };
}

export async function createProject(
  teamId: string,
  input: CreateProjectInput
): Promise<string | null> {
  const payload = await request(`/teams/${enc(teamId)}/projects`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return readCreatedId(payload);
}

export async function getProject(projectId: string): Promise<ProjectBundle> {
  const record = asRecord(await request(`/projects/${enc(projectId)}`));
  const frameRecord = record.frame == null ? null : asRecord(record.frame);
  const runbookRecord = record.runbook == null ? null : asRecord(record.runbook);
  return {
    project: readProject(record.project ?? record),
    frame: frameRecord
      ? { version: num(frameRecord.version), markdown: str(frameRecord.markdown) }
      : null,
    runbook: runbookRecord
      ? {
          locked: bool(runbookRecord.locked),
          activeDigest: strOrNull(runbookRecord.activeDigest),
          document: runbookRecord.document ?? null,
        }
      : null,
  };
}

export async function getFrame(projectId: string): Promise<FrameData> {
  const payload = await allowMissing(`/projects/${enc(projectId)}/frame`);
  const record = asRecord(payload);
  const versions = Array.isArray(record.versions)
    ? record.versions
        .map((item) => {
          const version = asRecord(item);
          const number = numOrNull(version.version);
          if (number == null) return null;
          return { version: number, createdAt: strOrNull(version.createdAt) };
        })
        .filter((item): item is FrameVersion => item != null)
    : [];
  return {
    version: num(record.version),
    markdown: str(record.markdown),
    versions,
  };
}

export async function saveFrame(
  projectId: string,
  markdown: string
): Promise<{ version: number; markdown: string }> {
  const record = asRecord(
    await request(`/projects/${enc(projectId)}/frame`, {
      method: "PUT",
      body: JSON.stringify({ markdown }),
    })
  );
  return { version: num(record.version), markdown: str(record.markdown, markdown) };
}

export async function getRunbook(projectId: string): Promise<RunbookData> {
  const payload = await allowMissing(`/projects/${enc(projectId)}/runbook`);
  const record = asRecord(payload);
  const revisions = Array.isArray(record.revisions)
    ? record.revisions.map((item, index) => {
        const revision = asRecord(item);
        return {
          id: str(revision.id, `revision-${index + 1}`),
          digest: str(revision.digest),
          status: str(revision.status, "unknown"),
          createdAt: strOrNull(revision.createdAt),
          probe: revision.probe ?? null,
        };
      })
    : [];
  return {
    locked: bool(record.locked),
    activeDigest: strOrNull(record.activeDigest),
    active: record.active ?? null,
    revisions,
  };
}

export async function discoverRunbook(projectId: string): Promise<Ack> {
  return readAck(await request(`/projects/${enc(projectId)}/runbook/discover`, { method: "POST" }));
}

export async function proposeRunbook(
  projectId: string,
  document: Record<string, unknown>
): Promise<Ack> {
  return readAck(
    await request(`/projects/${enc(projectId)}/runbook/proposals`, {
      method: "POST",
      body: JSON.stringify({ document }),
    })
  );
}

export async function probeVerification(projectId: string, command: string): Promise<Ack> {
  return readAck(
    await request(`/projects/${enc(projectId)}/runbook/verification`, {
      method: "POST",
      body: JSON.stringify({ command }),
    })
  );
}

export async function lockRunbook(projectId: string, locked: boolean): Promise<void> {
  await request(`/projects/${enc(projectId)}/runbook/lock`, {
    method: "POST",
    body: JSON.stringify({ locked }),
  });
}

export async function getOrder(projectId: string): Promise<OrderData> {
  const payload = await allowMissing(`/projects/${enc(projectId)}/order`);
  const record = asRecord(payload);
  const items = Array.isArray(record.items)
    ? record.items.map(readWorkItem).filter((item) => item.id)
    : [];
  return { items, dependencies: readDependencies(record.dependencies) };
}

export async function createWorkItem(
  projectId: string,
  input: {
    title: string;
    body: string;
    dependsOnIds?: string[];
    ownerUserId?: string;
    scopePaths?: string[];
  }
): Promise<void> {
  await request(`/projects/${enc(projectId)}/order`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function planWork(projectId: string, instruction: string): Promise<Ack> {
  return readAck(
    await request(`/projects/${enc(projectId)}/order/plan`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
    })
  );
}

export async function getWorkRoom(projectId: string, workItemId: string): Promise<WorkRoom> {
  const record = asRecord(await request(`/projects/${enc(projectId)}/order/${enc(workItemId)}`));
  const thread = asRecord(record.thread);
  const entries = Array.isArray(thread.entries)
    ? thread.entries.map((item, index) => {
        const entry = asRecord(item);
        return {
          id: str(entry.id, `entry-${index + 1}`),
          cursor: str(entry.cursor),
          authorId: str(entry.authorId),
          authorName: str(entry.authorName, "Unknown author"),
          kind: str(entry.kind, "post"),
          body: str(entry.body),
          createdAt: strOrNull(entry.createdAt),
        };
      })
    : [];
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map((item) => {
        const row = asRecord(item);
        return {
          command: str(row.command),
          exitCode: numOrNull(row.exitCode),
          excerpt: str(row.excerpt),
        };
      })
    : [];
  if (!str(asRecord(record.item).id)) {
    throw new ApiError(500, "invalid_response", "The work room did not include a work item.");
  }
  const controllerRecord = record.controller == null ? null : asRecord(record.controller);
  return {
    item: readWorkItem(record.item, 0),
    dependencies: readDependencies(record.dependencies),
    diff: readDiff(record.diff),
    evidence,
    thread: { cursor: str(thread.cursor), entries },
    run: readRun(record.run),
    controller: controllerRecord
      ? {
          userId: str(controllerRecord.userId),
          name: str(controllerRecord.name, "Unknown controller"),
          revision: num(controllerRecord.revision),
        }
      : null,
  };
}

function steerPath(projectId: string, workItemId: string, action: string): string {
  return `/projects/${enc(projectId)}/order/${enc(workItemId)}/steer/${action}`;
}

export async function postThread(
  projectId: string,
  workItemId: string,
  input: { body: string; idempotencyKey: string }
): Promise<void> {
  await request(`/projects/${enc(projectId)}/order/${enc(workItemId)}/thread`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function claimControl(
  projectId: string,
  workItemId: string,
  revision: number
): Promise<void> {
  await request(steerPath(projectId, workItemId, "claim"), {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
}

export async function handoffControl(
  projectId: string,
  workItemId: string,
  input: { revision: number; toUserId: string }
): Promise<void> {
  await request(steerPath(projectId, workItemId, "handoff"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function submitGuidance(
  projectId: string,
  workItemId: string,
  input: { revision: number; body: string }
): Promise<void> {
  await request(steerPath(projectId, workItemId, "guidance"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getGate(projectId: string): Promise<GateData> {
  const payload = await allowMissing(`/projects/${enc(projectId)}/gate`);
  const record = asRecord(payload);
  const holds = Array.isArray(record.holds)
    ? record.holds.map((item, index) => {
        const hold = asRecord(item);
        const status = str(hold.status, "failing");
        return {
          id: str(hold.id, `hold-${index + 1}`),
          workItemId: strOrNull(hold.workItemId),
          title: str(hold.title, str(hold.summary, "Hold")),
          status,
          reason: str(hold.reason, str(hold.detail, str(hold.message))),
          failing: !clearHoldStatus(status),
        };
      })
    : [];
  const questions = Array.isArray(record.questions)
    ? record.questions.map((item, index) => {
        const question = asRecord(item);
        const prompt = textList([item])[0] || str(question.prompt, str(question.text, "Question"));
        return {
          id: str(question.id, `question-${index + 1}`),
          runId: str(question.runId),
          prompt,
          status: str(question.status, "open"),
          role: str(question.role),
        };
      })
    : [];
  const cases = Array.isArray(record.cases)
    ? record.cases.map((item, index) => {
        const gateCase = asRecord(item);
        return {
          id: str(gateCase.id, `case-${index + 1}`),
          workItemId: strOrNull(gateCase.workItemId),
          title: str(gateCase.title, "Governance case"),
          status: str(gateCase.status, "open"),
          summary: questionSummary(str(gateCase.summary, str(gateCase.reason))),
        };
      })
    : [];
  const findings = Array.isArray(record.findings)
    ? record.findings.map((item, index) => {
        const finding = asRecord(item);
        return {
          id: str(finding.id, `finding-${index + 1}`),
          title: str(finding.title, "Finding"),
          summary: str(finding.summary, str(finding.detail)),
          status: str(finding.status, "open"),
          rule: strOrNull(finding.rule) ?? strOrNull(finding.policyRule),
        };
      })
    : [];
  return { holds, questions, cases, findings };
}

export async function answerQuestion(
  projectId: string,
  runId: string,
  text: string
): Promise<void> {
  await request(`/projects/${enc(projectId)}/gate/questions/${enc(runId)}/answer`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function appealFinding(
  projectId: string,
  findingId: string,
  input: { alternatives: string; evidence: string; risks: string; limits: string }
): Promise<void> {
  await request(`/projects/${enc(projectId)}/gate/findings/${enc(findingId)}/appeal`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resolveCase(
  projectId: string,
  caseId: string,
  input: { ownerKey: string; decision: Decision; rationale: string }
): Promise<void> {
  await request(`/projects/${enc(projectId)}/gate/cases/${enc(caseId)}/resolve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function setGovernance(
  projectId: string,
  input: { ownerKey: string; mode: GovernanceMode }
): Promise<void> {
  await request(`/projects/${enc(projectId)}/governance`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function grantScope(
  projectId: string,
  input: { ownerKey: string; workItemId: string; paths: string[] }
): Promise<void> {
  await request(`/projects/${enc(projectId)}/scope-grants`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function readNomination(value: unknown, index: number): Nomination {
  const record = asRecord(value);
  const evidence = readEvidenceLists(record);
  return {
    id: str(record.id, `nomination-${index + 1}`),
    title: str(record.title, "Nomination"),
    beforeText: readExact(record, ["beforeText", "before", "currentText"]),
    afterText: readExact(record, ["afterText", "after", "proposedText"]),
    ...evidence,
    status: str(record.status, "open"),
  };
}

function readProposal(value: unknown, index: number): Proposal {
  const record = asRecord(value);
  const evidence = readEvidenceLists(record);
  return {
    id: str(record.id, `proposal-${index + 1}`),
    nominationId: strOrNull(record.nominationId),
    text: str(record.text),
    detector: str(record.detector),
    paths: textList(record.paths),
    authorKind: str(record.authorKind),
    beforeText: readExact(record, ["beforeText", "before", "currentText"]),
    afterText: readExact(record, ["afterText", "after", "proposedText"]),
    ...evidence,
    evaluationStatus: str(record.evaluationStatus, str(record.status, "not evaluated")),
    status: str(record.status, "open"),
  };
}

export async function getEvolve(projectId: string): Promise<EvolveData> {
  const payload = await allowMissing(`/projects/${enc(projectId)}/evolve`);
  const record = asRecord(payload);
  const note = str(record.replayNote).trim();
  return {
    replayNote: note || FALLBACK_REPLAY_NOTE,
    releases: Array.isArray(record.releases)
      ? record.releases.map((item, index) => {
          const release = asRecord(item);
          const id = str(release.id, `release-${index + 1}`);
          return {
            id,
            title: str(release.title, str(release.name, id)),
            createdAt: strOrNull(release.createdAt),
            status: str(release.status, "recorded"),
          };
        })
      : [],
    nominations: Array.isArray(record.nominations) ? record.nominations.map(readNomination) : [],
    proposals: Array.isArray(record.proposals) ? record.proposals.map(readProposal) : [],
    evaluations: Array.isArray(record.evaluations)
      ? record.evaluations.map((item, index) => {
          const evaluation = asRecord(item);
          const evidence = readEvidenceLists(evaluation);
          return {
            id: str(evaluation.id, `evaluation-${index + 1}`),
            proposalId: strOrNull(evaluation.proposalId),
            status: str(evaluation.status, "unknown"),
            summary: str(evaluation.summary),
            ...evidence,
          };
        })
      : [],
  };
}

export async function mineDecisions(projectId: string): Promise<Ack> {
  return readAck(await request(`/projects/${enc(projectId)}/evolve/mine`, { method: "POST" }));
}

export async function proposeNomination(
  projectId: string,
  nominationId: string,
  input: { text: string; detector: string; paths: string[]; authorKind: AuthorKind }
): Promise<void> {
  await request(`/projects/${enc(projectId)}/evolve/nominations/${enc(nominationId)}/proposals`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function evaluateProposal(projectId: string, proposalId: string): Promise<Ack> {
  return readAck(
    await request(`/projects/${enc(projectId)}/evolve/proposals/${enc(proposalId)}/evaluate`, {
      method: "POST",
    })
  );
}

export async function activateProposal(
  projectId: string,
  proposalId: string,
  ownerKey: string
): Promise<void> {
  await request(`/projects/${enc(projectId)}/evolve/proposals/${enc(proposalId)}/activate`, {
    method: "POST",
    body: JSON.stringify({ ownerKey }),
  });
}

export async function rollbackRelease(
  projectId: string,
  input: { ownerKey: string; releaseId: string }
): Promise<void> {
  await request(`/projects/${enc(projectId)}/evolve/rollback`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
