import type { Request, Response, NextFunction, RequestHandler } from "express";
import { governanceService } from "../services/governance.service.js";
import { governanceError, governanceHash } from "../services/policy-context.js";
import {
  getGovernanceActor,
  governanceAuthorityConfigured,
  requireGovernanceHuman,
} from "./governance-auth.js";
import { AppError } from "./error-handler.js";
import { normalizeAgentTimeoutMs, mergeDeploymentConfigPatch } from "@opensprint/shared";

function authorizeConfigurationChange(
  req: Request,
  res: Response,
  next: NextFunction,
  projectIds: string[],
  keys: string[]
): void {
  requireGovernanceHuman(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    // Record authorization, rather than an applied change: validation in the controller can still fail.
    void Promise.all(
      projectIds.map((projectId) =>
        governanceService.audit(
          projectId,
          "policy_configuration_change_authorized",
          getGovernanceActor(req),
          {
            scope: req.params.id || req.params.projectId ? "project" : "global",
            keys: [...keys].sort(),
            payloadHash: governanceHash(req.body),
          }
        )
      )
    ).then(() => next(), next);
  });
}

/** Live prompt edits cannot alter approved releases; use an evaluated amendment. */
export const guardGovernedInstructionEdit: RequestHandler = (req, res, next) => {
  const projectId = String(req.params.projectId ?? req.params.id);
  void governanceService
    .getConfig(projectId)
    .then(async (config) => {
      const cases = await governanceService.listCases(projectId);
      if (
        config.mode !== "disabled" ||
        (await governanceService.getActiveReleaseId(projectId)) !== null ||
        cases.some((c) => !["cancelled", "fix_required"].includes(c.state))
      )
        governanceError(
          "Instruction changes require an evaluated policy amendment while governance is active or assignments retain governed policy."
        );
      next();
    })
    .catch(next);
};
/** Include accepted legacy API aliases; middleware runs before settings normalization. */
export const GOVERNANCE_REVIEW_SETTING_KEYS = [
  "reviewMode",
  "simpleComplexityAgent",
  "complexComplexityAgent",
  "lowComplexityAgent",
  "highComplexityAgent",
  "reviewerAgents",
  "reviewAngles",
  "includeGeneralReview",
  "hilConfig",
  "aiAutonomyLevel",
  "runAgentEnhancementExperiments",
  "selfImprovementReviewerAgents",
  "selfImprovementIncludeGeneralReview",
  "deployment",
] as const;
/** Live settings cannot replace checker/prompt enforcement installed through an amendment. */
export const GOVERNANCE_ENFORCEMENT_SETTING_KEYS = [
  "testCommand",
  "testFramework",
  "enforceMergeGatesOnCodingSuccess",
  "mergeQualityGateCommands",
  "toolchainProfile",
  "validationTimeoutMsOverride",
  "agenticRepairEnabled",
  "gitWorkingMode",
  "mergeStrategy",
  "worktreeBaseBranch",
  "unknownScopeStrategy",
  "selfImprovementActiveBehaviorVersionId",
  "selfImprovementBehaviorVersions",
  "selfImprovementBehaviorHistory",
] as const;
const sensitive = [...GOVERNANCE_REVIEW_SETTING_KEYS, ...GOVERNANCE_ENFORCEMENT_SETTING_KEYS];
/** Full settings payloads must authorize semantic changes rather than the presence of unchanged keys. */
export function changedGovernanceSettings(
  body: Record<string, unknown>,
  current: Record<string, unknown>
): string[] {
  const aliases: Record<string, string> = {
    lowComplexityAgent: "simpleComplexityAgent",
    highComplexityAgent: "complexComplexityAgent",
  };
  const defaults: Record<string, unknown> = {
    reviewMode: "always",
    reviewAngles: [],
    includeGeneralReview: false,
    runAgentEnhancementExperiments: false,
    enforceMergeGatesOnCodingSuccess: true,
    agenticRepairEnabled: true,
    mergeStrategy: "per_task",
    gitWorkingMode: "worktree",
    worktreeBaseBranch: "main",
    unknownScopeStrategy: "optimistic",
    deployment: { mode: "custom" },
  };
  const normalizedAgent = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const agent = value as Record<string, unknown>;
    const fallbackUrl =
      agent.type === "ollama"
        ? "http://localhost:11434"
        : agent.type === "lmstudio"
          ? "http://localhost:1234"
          : undefined;
    const baseUrl =
      typeof agent.baseUrl === "string" && agent.baseUrl.trim()
        ? agent.baseUrl.trim().replace(/\/+$/, "")
        : fallbackUrl;
    return {
      type: agent.type,
      model: agent.model || null,
      cliCommand: agent.cliCommand || null,
      timeoutMs: normalizeAgentTimeoutMs(agent.timeoutMs),
      ...(baseUrl ? { baseUrl } : {}),
    };
  };
  return Object.keys(body).filter((key) => {
    const canonical = aliases[key] ?? key;
    if (
      !sensitive.includes(key as (typeof sensitive)[number]) &&
      !/^selfImprovement(Pending|Behavior)/.test(key)
    )
      return false;
    const before = current[canonical] ?? defaults[canonical];
    let after = body[key];
    if (after === undefined) return false;
    if (
      (canonical === "simpleComplexityAgent" || canonical === "complexComplexityAgent") &&
      after === null &&
      current[`${canonical}Inherited`] === true
    )
      return false;
    let comparableBefore = before;
    if (canonical === "simpleComplexityAgent" || canonical === "complexComplexityAgent") {
      comparableBefore = normalizedAgent(before);
      after = normalizedAgent(after);
    }
    if (["reviewAngles", "selfImprovementReviewerAgents"].includes(canonical)) {
      comparableBefore = Array.isArray(before) ? [...before].sort() : before;
      after = Array.isArray(after) ? [...after].sort() : after;
    }
    return governanceHash(comparableBefore) !== governanceHash(after);
  });
}
export const guardGovernedSettings: RequestHandler = (req, res, next) => {
  let keys = Object.keys(req.body ?? {});
  let behaviorPayload = keys.some((key) => /^selfImprovement(Pending|Behavior)/.test(key));
  if (!behaviorPayload && !sensitive.some((key) => keys.includes(key))) {
    next();
    return;
  }
  const projectId = String(req.params.projectId ?? req.params.id);
  void governanceService
    .getConfig(projectId)
    .then(async (config) => {
      const cases = await governanceService.listCases(projectId);
      if (
        config.mode === "disabled" &&
        !cases.length &&
        !(await governanceService.getActiveReleaseId(projectId))
      ) {
        next();
        return;
      }
      const { ProjectService } = await import("../services/project.service.js");
      const current = await new ProjectService().getSettings(projectId);
      keys = changedGovernanceSettings(
        req.body ?? {},
        current as unknown as Record<string, unknown>
      );
      behaviorPayload = keys.some((key) => /^selfImprovement(Pending|Behavior)/.test(key));
      if (!keys.length) {
        next();
        return;
      }
      if (req.body.reviewMode !== undefined && req.body.reviewMode !== "always")
        governanceError(
          "Governance requires reviewMode: always. Resolve all holds and explicitly disable governance before changing review mode."
        );
      if (behaviorPayload || GOVERNANCE_ENFORCEMENT_SETTING_KEYS.some((key) => keys.includes(key)))
        governanceError(
          "Policy-sensitive enforcement and behavior changes require an evaluated amendment."
        );
      authorizeConfigurationChange(
        req,
        res,
        next,
        [projectId],
        keys.filter(
          (key) =>
            sensitive.includes(key as (typeof sensitive)[number]) ||
            /^selfImprovement(Pending|Behavior)/.test(key)
        )
      );
    })
    .catch(next);
};

/** Deployment commands execute repository code and must not become an alternate approval channel. */
export const guardGovernedDeploymentSettings: RequestHandler = (req, res, next) => {
  const projectId = String(req.params.projectId ?? req.params.id);
  void import("../services/project.service.js")
    .then(async ({ ProjectService }) => {
      const settings = await new ProjectService().getSettings(projectId);
      const request = Object.create(req) as Request;
      request.body = {
        deployment: mergeDeploymentConfigPatch(settings.deployment, req.body ?? {}),
      };
      guardGovernedSettings(request, res, next);
    })
    .catch(next);
};

/** Global inherited model defaults and database authority cannot bypass project governance. */
export const guardGovernedGlobalSettings: RequestHandler = (req, res, next) => {
  const keys = Object.keys(req.body ?? {}).filter((key) =>
    ["simpleComplexityAgent", "complexComplexityAgent", "databaseUrl"].includes(key)
  );
  if (!keys.length) {
    next();
    return;
  }
  // Approval capability configuration is server-owned and cannot race with an HTTP onboarding
  // request. Refusing even before the first release exists prevents check-then-switch from
  // dropping a policy created concurrently after an empty-state lookup.
  if (keys.includes("databaseUrl") && governanceAuthorityConfigured()) {
    next(
      new AppError(
        409,
        "GOVERNANCE_DATABASE_AUTHORITY_LOCKED",
        "Database authority cannot be replaced while governance approval is configured. Use a stopped-server migration that preserves the complete governance database."
      )
    );
    return;
  }
  void (async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const db = await taskStore.getDb();
    const governed = await db.query(
      "SELECT project_id FROM project_governance WHERE active_release_id IS NOT NULL"
    );
    if (!governed.length) {
      next();
      return;
    }
    if (keys.includes("databaseUrl")) {
      governanceError(
        "This database retains approved governance policy and cannot be replaced through ordinary settings or live migration. Use a stopped-server migration preserving all authority records.",
        "GOVERNANCE_DATABASE_AUTHORITY_LOCKED"
      );
    }
    const { getRawSettingsRecord } = await import("../services/settings-store.service.js");
    const affected: string[] = [];
    for (const row of governed) {
      const projectId = String(row.project_id);
      const raw = await getRawSettingsRecord(projectId);
      const inheritsSimple =
        keys.includes("simpleComplexityAgent") &&
        raw.simpleComplexityAgent == null &&
        raw.lowComplexityAgent == null;
      const inheritsComplex =
        keys.includes("complexComplexityAgent") &&
        raw.complexComplexityAgent == null &&
        raw.highComplexityAgent == null;
      if (inheritsSimple || inheritsComplex) affected.push(projectId);
    }
    if (!affected.length) {
      next();
      return;
    }
    authorizeConfigurationChange(req, res, next, affected, keys);
  })().catch(next);
};
