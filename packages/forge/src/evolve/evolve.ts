import { PLATFORM_RULE_KEY, type ProjectRecord } from "../domain.js";
import { ForgeError } from "../errors.js";
import { ownerMatches } from "../crypto/crypto.js";
import { canonicalJson, sha256 } from "../runbook/runbook.js";
import type { ForgeStore } from "../store/store.js";
import { normalizeReplay, type ReplayReport, type ReplayRunner } from "./replay.js";

export class EvolveService {
  constructor(
    private readonly store: ForgeStore,
    private readonly runner: ReplayRunner,
    private readonly ownerKey: string | null,
    private readonly replayImage: string | null
  ) {}

  mine(projectId: string): { nominations: number } {
    const release = this.store.activeRelease(projectId);
    if (!release) return { nominations: 0 };
    const rulings = this.store.rulingsByProject(projectId);
    const groups = new Map<string, typeof rulings>();
    for (const ruling of rulings) {
      if (!ruling.ruleKey) continue;
      const list = groups.get(ruling.ruleKey) ?? [];
      list.push(ruling);
      groups.set(ruling.ruleKey, list);
    }
    let created = 0;
    for (const [ruleKey, list] of groups) {
      if (list.length < 2) continue;
      const already = this.store
        .nominationsByProject(projectId)
        .some((nomination) => nomination.releaseId === release.id && nomination.ruleKey === ruleKey);
      if (already) continue;
      this.store.insertNomination({
        projectId,
        releaseId: release.id,
        ruleKey,
        supporting: list
          .filter((ruling) => ruling.decision !== "allow_once")
          .map(summarizeRuling),
        contrary: list
          .filter((ruling) => ruling.decision === "allow_once")
          .map(summarizeRuling),
      });
      created += 1;
    }
    const last = rulings.at(-1);
    if (last) this.store.updateProject(projectId, { evolveCursor: last.id });
    return { nominations: created };
  }

  propose(input: {
    projectId: string;
    nominationId: string;
    text: string;
    detector: string;
    paths: string[];
    authorKind: "person" | "drafter";
  }) {
    const nomination = this.requireNomination(input.projectId, input.nominationId);
    if (nomination.supporting.length === 0 || nomination.contrary.length === 0) {
      throw new ForgeError(
        400,
        "incomplete_evidence",
        "A proposal needs both supporting and contrary evidence."
      );
    }
    if (input.detector !== "protected-path") {
      throw new ForgeError(
        409,
        "enforcement_not_landed",
        "This server can enforce the protected-path detector only."
      );
    }
    const proposal = this.store.insertProposal({
      nominationId: nomination.id,
      projectId: input.projectId,
      ruleKey: nomination.ruleKey,
      text: input.text,
      detector: input.detector,
      paths: input.paths,
      authorKind: input.authorKind,
    });
    this.store.insertFixture(
      proposal.id,
      { supporting: nomination.supporting, proposal: input.text },
      nomination.contrary
    );
    this.store.updateNomination(nomination.id, { status: "drafted" });
    return proposal;
  }

  async evaluate(projectId: string, proposalId: string) {
    const proposal = this.requireProposal(projectId, proposalId);
    const fixture = this.store.fixtureByProposal(proposal.id);
    const report = fixture
      ? await this.runner({ image: this.replayImage, fixture })
      : normalizeReplay({
          imageDigest: this.replayImage,
          network: "unknown",
          isolation: "unavailable",
          originalInputsPresent: false,
          heldOut: [],
          metrics: { placeholder: true },
          missing: ["missing_inputs"],
          note: "",
        }).report;
    const normalized = normalizeReplay(report as ReplayReport);
    return this.store.insertEvaluation({
      proposalId: proposal.id,
      status: normalized.status,
      report: { ...normalized.report },
    });
  }

  activate(projectId: string, proposalId: string, presentedOwnerKey: string | undefined) {
    this.assertOwner(presentedOwnerKey);
    const proposal = this.requireProposal(projectId, proposalId);
    const evaluation = this.store.latestEvaluation(proposal.id);
    if (!evaluation) {
      throw new ForgeError(409, "incomplete_evaluation", "Activation needs a complete evaluation.");
    }
    const normalized = normalizeReplay(evaluation.report as unknown as ReplayReport);
    if (normalized.status !== "complete" || proposal.detector !== "protected-path") {
      throw new ForgeError(
        409,
        normalized.status !== "complete" ? "incomplete_evaluation" : "enforcement_not_landed",
        normalized.status !== "complete"
          ? "Activation needs a complete evaluation."
          : "Compatible enforcement has not landed for this proposal."
      );
    }
    const release = this.store.activeRelease(projectId);
    if (!release) throw new ForgeError(409, "not_found", "There is no active policy release.");
    const rules = this.store.rulesForRelease(release.id).map((rule) =>
      rule.ruleKey === proposal.ruleKey
        ? {
            ruleKey: rule.ruleKey,
            revision: rule.revision + 1,
            text: proposal.text,
            detector: proposal.detector,
            paths: proposal.paths,
          }
        : {
            ruleKey: rule.ruleKey,
            revision: rule.revision,
            text: rule.text,
            detector: rule.detector,
            paths: rule.paths,
          }
    );
    if (!rules.some((rule) => rule.ruleKey === proposal.ruleKey)) {
      throw new ForgeError(409, "not_found", "The proposal does not match a rule in the active release.");
    }
    return this.store.insertRelease({
      projectId,
      version: release.version + 1,
      contentHash: sha256(canonicalJson(rules)),
      rules,
    });
  }

  rollback(project: ProjectRecord, releaseId: string, presentedOwnerKey: string | undefined): void {
    this.assertOwner(presentedOwnerKey);
    const release = this.store.releases(project.id).find((item) => item.id === releaseId);
    if (!release) throw new ForgeError(404, "not_found", "Release not found.");
    this.store.activateExistingRelease(project.id, release.id);
  }

  private assertOwner(presented: string | undefined): void {
    if (!ownerMatches(presented, this.ownerKey)) {
      throw new ForgeError(403, "owner_required", "The owner capability is required for this action.");
    }
  }

  private requireNomination(projectId: string, nominationId: string) {
    const nomination = this.store.nominationById(nominationId);
    if (!nomination || nomination.projectId !== projectId) {
      throw new ForgeError(404, "not_found", "Nomination not found.");
    }
    return nomination;
  }

  private requireProposal(projectId: string, proposalId: string) {
    const proposal = this.store.proposalById(proposalId);
    if (!proposal || proposal.projectId !== projectId) {
      throw new ForgeError(404, "not_found", "Proposal not found.");
    }
    if (proposal.ruleKey !== PLATFORM_RULE_KEY && proposal.detector !== "protected-path") {
      throw new ForgeError(409, "enforcement_not_landed", "Compatible enforcement has not landed.");
    }
    return proposal;
  }
}

function summarizeRuling(ruling: { id: string; decision: string; rationale: string }) {
  return { id: ruling.id, decision: ruling.decision, rationale: ruling.rationale };
}
