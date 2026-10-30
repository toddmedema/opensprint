import { createHash } from "node:crypto";
import type { ReviewAppeal, StructuredReviewFinding } from "@opensprint/shared";

type FindingSource = NonNullable<StructuredReviewFinding["provenance"]["sources"]>[number];
/** Commit authority belongs to the case fingerprint; finding identity follows its exact material facts. */
export function reviewFindingIdentity(f: StructuredReviewFinding): string {
  return `finding-${createHash("sha256")
    .update(
      JSON.stringify([
        f.category,
        f.ruleId ?? null,
        f.ruleRevisionId ?? null,
        f.file,
        f.evidence,
        f.severity,
        f.suggestedRemedy,
      ])
    )
    .digest("hex")}`;
}

/** O(n log n): retain every distinct blocker, deduplicate exact facts and preserve all original reports. */
export function aggregateReviewFindings(
  inputs: Array<{ angle?: string; findings: StructuredReviewFinding[] }>
): StructuredReviewFinding[] {
  const groups = new Map<
    string,
    Map<string, { finding: StructuredReviewFinding; sources: Map<string, FindingSource> }>
  >();
  for (const input of inputs)
    for (const finding of input.findings) {
      const id = reviewFindingIdentity(finding);
      const revisions = groups.get(id) ?? new Map();
      groups.set(id, revisions);
      const entry = revisions.get(finding.codeRevision) ?? {
        finding,
        sources: new Map<string, FindingSource>(),
      };
      revisions.set(finding.codeRevision, entry);
      const sources =
        (finding.id === id || finding.id.startsWith(`${id}-`)) && finding.provenance.sources?.length
          ? finding.provenance.sources
          : [
              {
                findingId: finding.id,
                reviewer: finding.provenance.reviewer,
                ...((input.angle ?? finding.provenance.angle)
                  ? { angle: input.angle ?? finding.provenance.angle }
                  : {}),
                ...(finding.provenance.model ? { model: finding.provenance.model } : {}),
              },
            ];
      for (const source of sources)
        entry.sources.set(
          JSON.stringify([
            source.reviewer,
            source.angle ?? null,
            source.model ?? null,
            source.findingId,
          ]),
          source
        );
    }
  const result: StructuredReviewFinding[] = [];
  for (const [identity, revisions] of groups)
    for (const [revision, { finding, sources }] of revisions) {
      const reports = [...sources.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, source]) => source);
      const first = reports[0]!;
      // Preserve conflicting code revisions as separate reports so the trusted runtime rejects stale evidence.
      const id =
        revisions.size === 1
          ? identity
          : `${identity}-${createHash("sha256").update(revision).digest("hex")}`;
      result.push({
        ...finding,
        id,
        provenance: {
          reviewer: first.reviewer,
          ...(first.angle ? { angle: first.angle } : {}),
          ...(first.model ? { model: first.model } : {}),
          sources: reports,
        },
      });
    }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** Local reviewer IDs are usable only when they identify exactly one current material finding. */
export function mapReviewAppeals(
  findings: StructuredReviewFinding[],
  appeals: ReviewAppeal[]
): ReviewAppeal[] {
  const canonical = new Set(findings.map((f) => f.id));
  const aliases = new Map<string, Set<string>>();
  for (const finding of findings)
    for (const source of finding.provenance.sources ?? []) {
      const targets = aliases.get(source.findingId) ?? new Set<string>();
      targets.add(finding.id);
      aliases.set(source.findingId, targets);
    }
  const result = new Map<string, ReviewAppeal>();
  const unique = (items: string[]) => [...new Set(items)].sort();
  for (const appeal of appeals) {
    const targets = aliases.get(appeal.findingId);
    const findingId = canonical.has(appeal.findingId)
      ? appeal.findingId
      : targets?.size === 1
        ? [...targets][0]
        : undefined;
    if (!findingId) continue;
    const old = result.get(findingId);
    result.set(
      findingId,
      old
        ? {
            findingId,
            requestedException: unique([old.requestedException, appeal.requestedException]).join(
              "\n\n"
            ),
            whyCompliantOptionsFail: unique([
              old.whyCompliantOptionsFail,
              appeal.whyCompliantOptionsFail,
            ]).join("\n\n"),
            alternatives: unique([...old.alternatives, ...appeal.alternatives]),
            tests: unique([...old.tests, ...appeal.tests]),
            risks: unique([...old.risks, ...appeal.risks]),
            proposedLimits: unique([...old.proposedLimits, ...appeal.proposedLimits]),
          }
        : { ...appeal, findingId }
    );
  }
  return [...result.values()].sort((a, b) => a.findingId.localeCompare(b.findingId));
}
