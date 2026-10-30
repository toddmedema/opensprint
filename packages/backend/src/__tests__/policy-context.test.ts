import { describe, it, expect } from "vitest";
import type { PolicyRelease, PolicyRuleRevision, PolicyProposal } from "@opensprint/shared";
import {
  buildProposalRelease,
  governanceHash,
  matchesPolicyPath,
  resolvePolicyContext,
  validatePolicyRules,
} from "../services/policy-context.js";
export function rule(overrides: Partial<PolicyRuleRevision> = {}): PolicyRuleRevision {
  return {
    id: "repository@1",
    ruleId: "repository",
    revision: 1,
    text: "Use the repository layer.",
    rationale: "Keep storage access consistent.",
    owner: "owner",
    paths: ["src/**"],
    components: [],
    roles: [],
    severity: "standard",
    mandatory: false,
    exceptionEligible: true,
    examples: { compliant: ["repository.find()"], noncompliant: ["db.query()"] },
    parentIds: [],
    overrideIds: [],
    conflictIds: [],
    layer: 1,
    sourceHash: "fixture",
    ...overrides,
  };
}
export function release(rules: PolicyRuleRevision[] = [rule()]): PolicyRelease {
  return {
    id: "release-1",
    projectId: "project",
    rules,
    instructions: { coder: "Frozen coder instructions", reviewer: "Frozen reviewer instructions" },
    sourceHashes: {},
    contentHash: governanceHash(rules),
    enforcementRevision: "a".repeat(40),
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "owner",
  };
}
describe("deterministic policy context", () => {
  it("matches the bounded path language without regex predicates or traversal", () => {
    expect(matchesPolicyPath("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(matchesPolicyPath("src/**/*.ts", "src/a/b.ts")).toBe(true);
    expect(matchesPolicyPath("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(matchesPolicyPath("**", "../secret")).toBe(false);
    expect(matchesPolicyPath("src/[special]+(a).ts", "src/[special]+(a).ts")).toBe(true);
    expect(matchesPolicyPath("src/[special]+(a).ts", "src/sa.ts")).toBe(false);
  });
  it("includes mandatory rules and required parents outside direct scope with complete receipts", () => {
    const parent = rule({ id: "parent@1", ruleId: "parent", paths: ["lib/**"] });
    const child = rule({ id: "child@1", ruleId: "child", parentIds: [parent.id] });
    const mandatory = rule({
      id: "security@1",
      ruleId: "security",
      severity: "constraint",
      exceptionEligible: false,
      mandatory: true,
      paths: ["other/**"],
    });
    const irrelevant = rule({ id: "docs@1", ruleId: "docs", paths: ["docs/**"] });
    const result = resolvePolicyContext(release([parent, child, mandatory, irrelevant]), "coder", [
      "src/a.ts",
    ]);
    expect(result.receipt.selected.map((r) => r.id)).toEqual(["child@1", "parent@1", "security@1"]);
    expect(result.receipt.excluded).toContainEqual({
      id: irrelevant.id,
      reason: "outside role, component, or changed-path scope",
    });
    expect(result.content).toContain("Frozen coder instructions");
    expect(result.receipt.contentHash).toBe(governanceHash(result.content));
  });
  it("refreshes coverage when paths expand", () => {
    const r = release([rule(), rule({ id: "docs@1", ruleId: "docs", paths: ["docs/**"] })]);
    expect(resolvePolicyContext(r, "reviewer", ["src/a.ts"]).receipt.selected).toHaveLength(1);
    expect(
      resolvePolicyContext(r, "reviewer", ["src/a.ts", "docs/a.md"]).receipt.selected
    ).toHaveLength(2);
  });
  it("rejects cycles missing parents conflicts and incomparable overrides", () => {
    expect(() => validatePolicyRules([rule({ parentIds: ["missing"] })])).toThrow(/Missing parent/);
    expect(() => validatePolicyRules([rule({ parentIds: ["repository@1"] })])).toThrow(/cycle/);
    const left = rule({ conflictIds: ["right@1"] });
    const right = rule({ id: "right@1", ruleId: "right" });
    expect(() => resolvePolicyContext(release([left, right]), "reviewer", ["src/a.ts"])).toThrow(
      /Conflicting/
    );
    const base = rule();
    const override = (n: string) =>
      rule({
        id: `${n}@1`,
        ruleId: n,
        paths: ["src/diagnostics/**"],
        parentIds: [base.id],
        overrideIds: [base.id],
      });
    expect(() =>
      resolvePolicyContext(release([base, override("first"), override("second")]), "reviewer", [
        "src/diagnostics/a.ts",
      ])
    ).toThrow(/Incomparable/);
  });
  it("resolves an explicit nested override chain without treating ancestors as competing siblings", () => {
    const general = rule({ id: "general@1", ruleId: "general", paths: ["src/**"] });
    const service = rule({
      id: "service@1",
      ruleId: "service",
      paths: ["src/services/**"],
      parentIds: [general.id],
      overrideIds: [general.id],
    });
    const cache = rule({
      id: "cache@1",
      ruleId: "cache",
      paths: ["src/services/cache/**"],
      parentIds: [service.id, general.id],
      overrideIds: [service.id, general.id],
    });
    const context = resolvePolicyContext(release([general, service, cache]), "reviewer", [
      "src/services/cache/read.ts",
    ]);
    expect(context.receipt.conflicts).toEqual([]);
    expect(context.receipt.selected.map((r) => r.id)).toEqual([cache.id, general.id, service.id]);
    const sibling = rule({
      id: "sibling@1",
      ruleId: "sibling",
      paths: ["src/services/cache/**"],
      parentIds: [general.id],
      overrideIds: [general.id],
    });
    expect(() =>
      resolvePolicyContext(release([general, service, cache, sibling]), "reviewer", [
        "src/services/cache/read.ts",
      ])
    ).toThrow(/Incomparable overrides/);
  });
  it("does not allow higher authority constraints to be overridden or waived", () => {
    const constraint = rule({ severity: "constraint", exceptionEligible: false });
    expect(() =>
      validatePolicyRules([
        constraint,
        rule({
          id: "override@1",
          ruleId: "override",
          parentIds: [constraint.id],
          overrideIds: [constraint.id],
          paths: ["src/diagnostics/**"],
        }),
      ])
    ).toThrow(/cannot override/);
    expect(() =>
      validatePolicyRules([rule({ severity: "constraint", exceptionEligible: true })])
    ).toThrow(/cannot grant/);
  });
  it("withholds approval instead of truncating governing policy", () => {
    expect(() => resolvePolicyContext(release(), "coder", ["src/a.ts"], [], 10)).toThrow(
      /exceed the context budget/
    );
  });
  it("builds complete exact amendments and rejects stale before content", () => {
    const base = release();
    const proposal: PolicyProposal = {
      id: "p",
      projectId: "project",
      baseReleaseId: base.id,
      state: "draft",
      version: 1,
      title: "Clarify",
      rationale: "evidence",
      patches: [
        {
          ruleId: "repository",
          before: base.rules[0],
          after: rule({
            id: "repository@2",
            revision: 2,
            text: "Use repository access, including diagnostics.",
          }),
        },
      ],
      supportingDecisionIds: ["d"],
      contraryDecisionIds: [],
      scope: "src",
      compatibility: "same enforcement",
      enforcementRevision: base.enforcementRevision,
      positiveExamples: ["x"],
      negativeExamples: ["y"],
      createdAt: base.createdAt,
    };
    const candidate = buildProposalRelease(base, proposal);
    expect(candidate.rules[0].text).toContain("diagnostics");
    expect(candidate.instructions).toEqual(base.instructions);
    expect(candidate.contentHash).not.toBe(base.contentHash);
    expect(() =>
      buildProposalRelease(base, {
        ...proposal,
        patches: [{ ...proposal.patches[0], before: rule({ text: "stale" }) }],
      })
    ).toThrow(/Stale before/);
  });
});
