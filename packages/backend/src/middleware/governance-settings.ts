import path from "node:path";
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

/** Default-off projects keep their ordinary self-improvement approvals; no capability exists to ask for. */
export const requireGovernanceHumanWhenActive: RequestHandler = (req, res, next) => {
  void governanceService
    .isGovernanceInactive(String(req.params.projectId ?? req.params.id))
    .then((inactive) => (inactive ? next() : requireGovernanceHuman(req, res, next)))
    .catch(next);
};

/** Pinned work keeps its approved prompts. Edits need the owner and leave drift to reconcile. */
export const guardGovernedInstructionEdit: RequestHandler = (req, res, next) => {
  const projectId = String(req.params.projectId ?? req.params.id);
  void governanceService
    .isGovernanceInactive(projectId)
    .then(async (inactive) => {
      if (inactive) {
        next();
        return;
      }
      if (await governanceService.isGovernanceDormant(projectId)) {
        next();
        return;
      }
      authorizeConfigurationChange(req, res, next, [projectId], ["instructions"]);
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
/** Enforcement settings: changed only by the owner, and every change is audited. */
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
  const behaviorPayload = keys.some((key) => /^selfImprovement(Pending|Behavior)/.test(key));
  if (!behaviorPayload && !sensitive.some((key) => keys.includes(key))) {
    next();
    return;
  }
  const projectId = String(req.params.projectId ?? req.params.id);
  void governanceService
    .isGovernanceInactive(projectId)
    .then(async (inactive) => {
      if (inactive) {
        next();
        return;
      }
      const { ProjectService } = await import("../services/project.service.js");
      const current = await new ProjectService().getSettings(projectId);
      keys = changedGovernanceSettings(
        req.body ?? {},
        current as unknown as Record<string, unknown>
      );
      // Disabled with nothing retained has nothing to protect, even with releases on record.
      if (!keys.length || (await governanceService.isGovernanceDormant(projectId))) {
        next();
        return;
      }
      if (req.body.reviewMode !== undefined && req.body.reviewMode !== "always")
        governanceError(
          "Governance requires reviewMode: always. Resolve all holds and explicitly disable governance before changing review mode."
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

/** Pins, retained refs and approved hashes all name one checkout. */
export function createGovernedRepoPathGuard(
  service: Pick<import("../services/project.service.js").ProjectService, "getProject">
): RequestHandler {
  return (req, res, next) => {
    const requested = (req.body as { repoPath?: unknown } | undefined)?.repoPath;
    if (typeof requested !== "string") {
      next();
      return;
    }
    const projectId = String(req.params.id);
    void (async () => {
      if (await governanceService.isGovernanceInactive(projectId)) return next();
      const project = await service.getProject(projectId);
      if (path.resolve(project.repoPath) === path.resolve(requested)) return next();
      requireGovernanceHuman(req, res, (error?: unknown) => {
        if (error) return next(error);
        governanceService
          .assertRepoPathChangeAllowed(projectId, getGovernanceActor(req))
          .then(() => next(), next);
      });
    })().catch(next);
  };
}

/** Deployment commands execute repository code and must not become an alternate approval channel. */
export function createGovernedDeploymentSettingsGuard(
  service?: Pick<import("../services/project.service.js").ProjectService, "getSettings">
): RequestHandler {
  return (req, res, next) => {
    const projectId = String(req.params.projectId ?? req.params.id);
    void import("../services/project.service.js")
      .then(async ({ ProjectService }) => {
        const settings = await (service ?? new ProjectService()).getSettings(projectId);
        const request = Object.create(req) as Request;
        request.body = {
          deployment: mergeDeploymentConfigPatch(settings.deployment, req.body ?? {}),
        };
        guardGovernedSettings(request, res, next);
      })
      .catch(next);
  };
}
export const guardGovernedDeploymentSettings = createGovernedDeploymentSettingsGuard();

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
