/**
 * Self-improvement experiment pipeline (mining replay-grade Execute sessions + candidate behavior bundles).
 * Replay-grade: archived session with completion metadata and an opensprint/* task branch (merge-style success path).
 */

import type { AgentRole, PolicyRelease } from "@opensprint/shared";
import { AGENT_ROLE_CANONICAL_ORDER } from "@opensprint/shared";
import type { AgentInstructionsService } from "./agent-instructions.service.js";
import { runBehaviorVersionStoreWrite } from "./behavior-version-store.service.js";
import { taskStore } from "./task-store.service.js";
import { toPgParams } from "../db/sql-params.js";
import { createLogger } from "../utils/logger.js";
import { createPatch } from "diff";

const log = createLogger("self-improvement-experiment");

const REPLAY_GRADE_SESSION_SQL = toPgParams(`
  SELECT id FROM agent_sessions
  WHERE project_id = ?
    AND completed_at IS NOT NULL
    AND TRIM(git_branch) <> ''
    AND git_branch LIKE 'opensprint/%'
  ORDER BY id DESC
  LIMIT 500
`);

/** Baseline instruction + template bodies used to build experiment diffs. */
export interface BehaviorExperimentInstructionBaseline {
  general: string;
  roles: Partial<Record<AgentRole, string>>;
  templates: {
    coder: string;
    reviewer: string;
    finalReview: string;
    selfImprovement: string;
  };
}

export interface BehaviorExperimentCandidateBundle {
  versionType: "candidate";
  minedSessionIds: number[];
  runId: string;
  generalInstructionDiff: string;
  roleInstructionDiffs: Partial<Record<AgentRole, string>>;
  promptTemplateDiffs: {
    coder: string;
    reviewer: string;
    finalReview: string;
    selfImprovement: string;
  };
  createdAt: string;
  /** Complete executable content. Diff summaries are never used as instructions. */
  baselineContent?: BehaviorExperimentInstructionBaseline;
  candidateContent?: BehaviorExperimentInstructionBaseline;
  supportingDecisionIds?: string[];
  contraryDecisionIds?: string[];
  policyAffecting?: boolean;
  policyRelease?: PolicyRelease;
}

export interface BehaviorAmendment {
  target:
    | "general"
    | `role:${AgentRole}`
    | `template:${keyof BehaviorExperimentInstructionBaseline["templates"]}`;
  before: string;
  after: string;
  supportingDecisionIds: string[];
  contraryDecisionIds: string[];
}

/** Canonical prompt anchors (stable substrings; align with Execute / final review / self-improvement contracts). */
const TEMPLATE_SNIPPETS = {
  coder:
    'a JSON object like {"status":"success","summary":"..."} or {"status":"failed","summary":"..."}',
  reviewer:
    'a JSON object like {"status":"approved","summary":"..."} or {"status":"rejected","summary":"..."}',
  finalReview: '"status": "pass" | "issues"',
  selfImprovement: "Output MUST be one of:",
} as const;

function diffText(path: string, before: string, after: string): string {
  return before === after
    ? ""
    : createPatch(path, before, after, "approved baseline", "proposed amendment");
}

/**
 * Mine agent_sessions ids suitable for Execute replay (completed, branch under opensprint/).
 */
export async function mineReplayGradeExecuteSessionIds(projectId: string): Promise<number[]> {
  const client = await taskStore.getDb();
  const rows = await client.query(REPLAY_GRADE_SESSION_SQL, [projectId]);
  const ids: number[] = [];
  for (const row of rows) {
    const id = row.id;
    if (typeof id === "number" && Number.isFinite(id)) ids.push(id);
    else if (typeof id === "string" && /^\d+$/.test(id)) ids.push(Number(id));
  }
  return ids;
}

export async function buildBehaviorInstructionBaseline(
  projectId: string,
  instructions: AgentInstructionsService
): Promise<BehaviorExperimentInstructionBaseline> {
  const general = await instructions.getGeneralInstructions(projectId);
  const roles: Partial<Record<AgentRole, string>> = {};
  for (const role of AGENT_ROLE_CANONICAL_ORDER) {
    roles[role] = await instructions.getRoleInstructions(projectId, role);
  }
  return {
    general,
    roles,
    templates: { ...TEMPLATE_SNIPPETS },
  };
}

/**
 * Apply exact, evidence-backed amendments. No decision content means no invented rule change.
 */
export function buildBehaviorExperimentCandidateBundle(params: {
  sessionIds: number[];
  baseline: BehaviorExperimentInstructionBaseline;
  runId: string;
  amendments?: BehaviorAmendment[];
}): BehaviorExperimentCandidateBundle {
  const { sessionIds, baseline, runId } = params;
  const createdAt = new Date().toISOString();
  const candidate = structuredClone(baseline);
  for (const amendment of params.amendments ?? []) {
    if (amendment.supportingDecisionIds.length === 0)
      throw new Error("Amendment requires supporting decisions");
    const [kind, key] = amendment.target.split(":");
    const source =
      kind === "general"
        ? candidate.general
        : kind === "role"
          ? (candidate.roles[key as AgentRole] ?? "")
          : candidate.templates[key as keyof typeof candidate.templates];
    if (source !== amendment.before)
      throw new Error(`Stale amendment baseline for ${amendment.target}`);
    if (kind === "general") candidate.general = amendment.after;
    else if (kind === "role") candidate.roles[key as AgentRole] = amendment.after;
    else if (kind === "template" && key in candidate.templates)
      candidate.templates[key as keyof typeof candidate.templates] = amendment.after;
    else throw new Error(`Unknown amendment target: ${amendment.target}`);
  }
  const roleInstructionDiffs: Partial<Record<AgentRole, string>> = {};
  for (const role of AGENT_ROLE_CANONICAL_ORDER) {
    const prev = baseline.roles[role] ?? "";
    const next = candidate.roles[role] ?? "";
    const d = diffText(`.opensprint/agents/${role}.md`, prev, next);
    if (d) roleInstructionDiffs[role] = d;
  }

  return {
    versionType: "candidate",
    minedSessionIds: sessionIds,
    runId,
    generalInstructionDiff: diffText("AGENTS.md", baseline.general, candidate.general),
    roleInstructionDiffs,
    promptTemplateDiffs: {
      coder: diffText("templates/coder.md", baseline.templates.coder, candidate.templates.coder),
      reviewer: diffText(
        "templates/reviewer.md",
        baseline.templates.reviewer,
        candidate.templates.reviewer
      ),
      finalReview: diffText(
        "templates/final-review.md",
        baseline.templates.finalReview,
        candidate.templates.finalReview
      ),
      selfImprovement: diffText(
        "templates/self-improvement.md",
        baseline.templates.selfImprovement,
        candidate.templates.selfImprovement
      ),
    },
    createdAt,
    baselineContent: structuredClone(baseline),
    candidateContent: candidate,
    supportingDecisionIds: [
      ...new Set(params.amendments?.flatMap((a) => a.supportingDecisionIds) ?? []),
    ],
    contraryDecisionIds: [
      ...new Set(params.amendments?.flatMap((a) => a.contraryDecisionIds) ?? []),
    ],
    policyAffecting: true,
  };
}

export class SelfImprovementExperimentService {
  constructor(private readonly instructions: AgentInstructionsService) {}

  /**
   * Mine sessions, build a rule-based candidate bundle, persist as behavior_versions (version_type candidate).
   */
  async generateAndPersistCandidate(
    projectId: string,
    runId: string,
    amendments: BehaviorAmendment[] = []
  ): Promise<{ versionId: string; bundle: BehaviorExperimentCandidateBundle }> {
    const sessionIds = await mineReplayGradeExecuteSessionIds(projectId);
    const baseline = await buildBehaviorInstructionBaseline(projectId, this.instructions);
    if (amendments.length === 0)
      throw new Error(
        "No evidence-backed amendments available; nominate a governance proposal first"
      );
    const bundle = buildBehaviorExperimentCandidateBundle({
      sessionIds,
      baseline,
      runId,
      amendments,
    });
    const versionId = `exp-${runId}`;

    await runBehaviorVersionStoreWrite(async (store) => {
      await store.saveCandidate(projectId, versionId, JSON.stringify(bundle));
    });

    log.info("Persisted behavior experiment candidate", {
      projectId,
      runId,
      versionId,
      minedCount: sessionIds.length,
    });

    return { versionId, bundle };
  }
}
