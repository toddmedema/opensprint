import type { AppealRecord, FindingRecord } from "../domain.js";

export function hasConcreteEvidence(evidence: string): boolean {
  return evidence.includes("/") || /[\w.-]+\.[A-Za-z0-9]+/.test(evidence);
}

export function reconsider(finding: Pick<FindingRecord, "evidence" | "ruleKey">): {
  evidence: string;
  ruleKey: string | null;
} {
  return { evidence: finding.evidence, ruleKey: finding.ruleKey };
}

export function judgeAppeal(
  finding: Pick<FindingRecord, "kind" | "evidence">,
  appeal: AppealRecord
): { decision: "uphold" | "dismiss"; rationale: string } {
  if (finding.kind === "defect") {
    return {
      decision: "uphold",
      rationale: "A defect stands without a preexisting rule. This judge cannot dismiss it.",
    };
  }
  if (hasConcreteEvidence(finding.evidence)) {
    return {
      decision: "uphold",
      rationale: "The finding cites concrete code. The judge cannot waive it.",
    };
  }
  if (!appeal.evidence.trim()) {
    return { decision: "uphold", rationale: "The appeal has no evidence." };
  }
  return { decision: "dismiss", rationale: "The finding has no concrete code evidence." };
}
