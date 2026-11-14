import {
  PLATFORM_RULE_KEY,
  type GovernanceMode,
  type PolicyRuleRecord,
  type ProjectRecord,
  type RunRecord,
} from "../domain.js";
import { ForgeError } from "../errors.js";
import { isPlatformProtected, pathMatches, SEEDED_RULE_PATHS } from "../integrate/blocked.js";
import { canonicalJson, sha256 } from "../runbook/runbook.js";
import type { AllowanceRecord } from "../domain.js";
import type { ForgeStore } from "../store/store.js";

export function missingScopeGrant(
  scopePaths: string[],
  grantPaths: string[] | null,
  mode: GovernanceMode
): string[] | null {
  if (mode !== "enforced") return null;
  const needed = scopePaths.filter((file) => isPlatformProtected(file)).sort();
  if (needed.length === 0) return null;
  const granted = [...(grantPaths ?? [])].sort();
  if (needed.join("\n") !== granted.join("\n")) return needed;
  return null;
}

export function seedRelease(store: ForgeStore, projectId: string): void {
  if (store.activeRelease(projectId)) return;
  const text =
    "Integration, OAuth, and token paths stay untouched unless the owner granted that exact scope before assignment.";
  const rules = [
    {
      ruleKey: PLATFORM_RULE_KEY,
      revision: 1,
      text,
      detector: "protected-path",
      paths: SEEDED_RULE_PATHS,
    },
  ];
  store.insertRelease({
    projectId,
    version: 1,
    contentHash: sha256(canonicalJson(rules)),
    rules,
  });
}

export function changeGovernance(store: ForgeStore, project: ProjectRecord, mode: GovernanceMode): void {
  if (mode === "enforced") {
    if (project.governanceMode === "disabled" || !project.shadowRecord) {
      throw new ForgeError(
        409,
        "shadow_required",
        "Turning governance on starts in shadow. Enforced mode waits until shadow has a record."
      );
    }
  }
  if (mode === "shadow" || mode === "enforced") seedRelease(store, project.id);
  store.updateProject(project.id, { governanceMode: mode });
}

export class GateService {
  constructor(private readonly store: ForgeStore) {}

  evaluate(input: {
    project: ProjectRecord;
    run: RunRecord;
    files: string[];
    patchHash: string;
    now?: string;
  }): { disposition: "clear" | "held"; reason?: string } {
    if (input.project.governanceMode === "disabled") return { disposition: "clear" };
    const pin = input.run.policyPinId ? this.store.pinByRun(input.run.id) : null;
    if (!pin) return { disposition: "held", reason: "missing_pin" };
    const rules = this.store.rulesForRelease(pin.releaseId);
    const allowances = this.store.allowancesForRelease(pin.releaseId);
    const now = input.now ?? new Date().toISOString();
    let wouldHold = false;
    for (const rule of rules) {
      if (rule.detector !== "protected-path") continue;
      const hits = input.files.filter((file) => rule.paths.some((pattern) => pathMatches(file, pattern)));
      const uncovered: string[] = [];
      const consumed: string[] = [];
      for (const file of hits) {
        const allowance = allowances.find((item) => covers(item, file, rule, input.patchHash, now));
        if (!allowance) uncovered.push(file);
        else if (allowance.kind === "once") consumed.push(allowance.id);
      }
      if (uncovered.length === 0) {
        if (input.project.governanceMode === "enforced") {
          for (const id of new Set(consumed)) this.store.markAllowanceUsed(id);
        }
        continue;
      }
      const finding = this.store.insertFinding({
        projectId: input.project.id,
        runId: input.run.id,
        workItemId: input.run.workItemId ?? "",
        kind: "standard",
        ruleKey: rule.ruleKey,
        ruleRevision: rule.revision,
        evidence: uncovered.join("\n"),
        status: input.project.governanceMode === "shadow" ? "shadowed" : "open",
      });
      this.store.insertCase({
        projectId: input.project.id,
        findingId: finding.id,
        workItemId: input.run.workItemId,
        runId: input.run.id,
        kind: input.project.governanceMode === "shadow" ? "shadow" : "governance",
        status: input.project.governanceMode === "shadow" ? "recorded" : "open",
        payload: { files: uncovered, ruleKey: rule.ruleKey },
      });
      wouldHold = true;
    }
    if (input.project.governanceMode === "shadow") {
      this.store.updateProject(input.project.id, { shadowRecord: true });
      this.store.insertCase({
        projectId: input.project.id,
        findingId: null,
        workItemId: input.run.workItemId,
        runId: input.run.id,
        kind: "shadow_observation",
        status: "recorded",
        payload: { wouldHold },
      });
      return { disposition: "clear" };
    }
    return wouldHold
      ? { disposition: "held", reason: "governance" }
      : { disposition: "clear" };
  }
}

function covers(
  allowance: AllowanceRecord,
  file: string,
  rule: PolicyRuleRecord,
  patchHash: string,
  now: string
): boolean {
  if (allowance.used || allowance.ruleKey !== rule.ruleKey) return false;
  if (allowance.kind === "once") return allowance.patchHash === patchHash;
  if (allowance.expiresAt && allowance.expiresAt <= now) return false;
  return allowance.paths.some((pattern) => pathMatches(file, pattern));
}
