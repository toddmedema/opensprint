import { describe, expect, it } from "vitest";
import type { ReviewAppeal, StructuredReviewFinding } from "@opensprint/shared";
import {
  aggregateReviewFindings,
  mapReviewAppeals,
  reviewFindingIdentity,
} from "../services/review-findings.js";
import { parseReviewFindings } from "../services/agent-result-validation.js";
const finding: StructuredReviewFinding = {
  id: "f1",
  category: "standard",
  ruleId: "repository",
  ruleRevisionId: "repository@1",
  file: "src/service.ts",
  codeRevision: "a".repeat(40),
  evidence: "Direct read",
  severity: "blocking",
  suggestedRemedy: "Use repository",
  provenance: { reviewer: "reviewer" },
};
const appeal: ReviewAppeal = {
  findingId: "f1",
  requestedException: "Diagnostic only",
  alternatives: ["Repository"],
  whyCompliantOptionsFail: "Metadata unavailable",
  tests: ["Read only"],
  risks: ["Coupling"],
  proposedLimits: ["This diagnostic"],
};
describe("deterministic multi-reviewer finding identities", () => {
  it("keeps distinct same-local-ID blockers and merges equivalent reports with every angle's provenance", () => {
    const inputs = [
      { angle: "security", findings: [finding] },
      {
        angle: "performance",
        findings: [
          { ...finding, id: "different-local-id", provenance: { reviewer: "fast-reviewer" } },
        ],
      },
      { angle: "quality", findings: [{ ...finding, evidence: "Another raw query" }] },
    ];
    const result = aggregateReviewFindings(inputs);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((f) => f.id)).size).toBe(2);
    expect(result.find((f) => f.evidence === finding.evidence)?.provenance.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ findingId: "f1", angle: "security", reviewer: "reviewer" }),
        expect.objectContaining({
          findingId: "different-local-id",
          angle: "performance",
          reviewer: "fast-reviewer",
        }),
      ])
    );
    expect(aggregateReviewFindings([...inputs].reverse())).toEqual(result);
    expect(aggregateReviewFindings([{ findings: result }])).toEqual(result);
  });
  it("does not reuse an ambiguous local appeal ID to cover multiple independent blockers", () => {
    const findings = aggregateReviewFindings([
      { angle: "security", findings: [finding] },
      { angle: "quality", findings: [{ ...finding, evidence: "A different blocker" }] },
    ]);
    expect(mapReviewAppeals(findings, [appeal])).toEqual([]);
    expect(mapReviewAppeals(findings, [{ ...appeal, findingId: findings[0]!.id }])).toEqual([
      { ...appeal, findingId: findings[0]!.id },
    ]);
  });
  it("maps a unique local alias and the prior aggregate appeal across new reviewer IDs and commit hashes", () => {
    const first = aggregateReviewFindings([{ angle: "security", findings: [finding] }])[0]!;
    const refreshed = aggregateReviewFindings([
      { angle: "quality", findings: [{ ...finding, id: "new-id", codeRevision: "b".repeat(40) }] },
    ]);
    expect(refreshed[0]!.id).toBe(first.id);
    expect(mapReviewAppeals(refreshed, [{ ...appeal, findingId: first.id }])).toEqual([
      { ...appeal, findingId: first.id },
    ]);
    expect(mapReviewAppeals(refreshed, [{ ...appeal, findingId: "new-id" }])).toEqual([
      { ...appeal, findingId: first.id },
    ]);
    expect(reviewFindingIdentity({ ...finding, ruleRevisionId: "repository@2" })).not.toBe(
      first.id
    );
    expect(
      mapReviewAppeals(
        aggregateReviewFindings([{ findings: [{ ...finding, evidence: "Changed evidence" }] }]),
        [{ ...appeal, findingId: first.id }]
      )
    ).toEqual([]);
  });
  it("merges duplicate equivalent appeals without losing alternatives, evidence or limits", () => {
    const findings = aggregateReviewFindings([
      { angle: "a", findings: [finding] },
      { angle: "b", findings: [{ ...finding, id: "f2" }] },
    ]);
    const result = mapReviewAppeals(findings, [
      appeal,
      {
        ...appeal,
        findingId: "f2",
        tests: ["No writes"],
        alternatives: ["Alternative adapter"],
        proposedLimits: ["Expires tomorrow"],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.tests).toEqual(["No writes", "Read only"]);
    expect(result[0]?.alternatives).toContain("Alternative adapter");
    expect(result[0]?.proposedLimits).toContain("Expires tomorrow");
  });
  it("preserves stale-code reports instead of hiding one behind equivalent current evidence", () => {
    const inputs = [{ findings: [finding, { ...finding, codeRevision: "b".repeat(40) }] }];
    const result = aggregateReviewFindings(inputs);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((f) => f.id)).size).toBe(2);
    expect(aggregateReviewFindings([{ findings: [...inputs[0]!.findings].reverse() }])).toEqual(
      result
    );
  });
  it("does not trust source aliases supplied by an agent result", () => {
    const parsed = parseReviewFindings([
      {
        ...finding,
        provenance: {
          ...finding.provenance,
          sources: [{ findingId: "another-approved-id", reviewer: "invented-owner" }],
        },
      },
    ]);
    expect(parsed?.[0]?.provenance.sources).toBeUndefined();
  });
});
