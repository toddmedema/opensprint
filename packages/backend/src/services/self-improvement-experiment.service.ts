/** Instruction snapshots and candidate bundles replayed by policy evaluation. */

import type { AgentRole, PolicyRelease } from "@opensprint/shared";
import { AGENT_ROLE_CANONICAL_ORDER } from "@opensprint/shared";
import type { AgentInstructionsService } from "./agent-instructions.service.js";
import { createPatch } from "diff";

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
