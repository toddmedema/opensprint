import type { PolicyEvaluationFixtureCoverage } from "@opensprint/shared";
import type { GovernanceService } from "../services/governance-store.js";
import type {
  ReplayEvaluationArtifact,
  ReplayEvidenceStore,
  StoredReplayFixture,
} from "../services/replay-fixture.service.js";

/** In-memory stand-in for the retained files; the real store has its own binding tests. */
export class MemoryReplayEvidence implements ReplayEvidenceStore {
  private fixtures = new Map<string, StoredReplayFixture>();
  private artifacts = new Map<string, ReplayEvaluationArtifact>();
  async read(projectId: string, sessionId: number): Promise<StoredReplayFixture> {
    const stored = this.fixtures.get(`${projectId}:${sessionId}`);
    if (!stored) throw new Error("missing fixture");
    return stored;
  }
  async readEvaluation(projectId: string, hash: string): Promise<ReplayEvaluationArtifact> {
    const artifact = this.artifacts.get(`${projectId}:${hash}`);
    if (!artifact) throw new Error("missing artifact");
    return artifact;
  }
  /** Bind one exercised held-out positive and negative, and retain a matching artifact. */
  async seed(
    svc: GovernanceService,
    projectId: string,
    proposalId: string,
    contentHash: string,
    releaseId: string
  ): Promise<{ fixtureCoverage: PolicyEvaluationFixtureCoverage[]; artifactHash: string }> {
    const fixtureCoverage = (["accept", "block_or_avoid"] as const).map((expectedOutcome, i) => ({
      fixtureId: String(i + 1),
      fixtureHash: `fixture-hash-${i + 1}`,
      taskId: `held-out-task-${i + 1}`,
      label: expectedOutcome === "accept" ? "compliant" : "defect",
      expectedOutcome,
      holdout: true,
      evidenceTask: false,
      amendedRuleSelected: true,
      contentDiffers: true,
    }));
    for (const c of fixtureCoverage) {
      this.fixtures.set(`${projectId}:${c.fixtureId}`, {
        hash: c.fixtureHash,
        fixture: {} as StoredReplayFixture["fixture"],
      });
      await svc.recordReplayFixture(projectId, {
        sessionId: Number(c.fixtureId),
        taskId: c.taskId,
        releaseId,
        hash: c.fixtureHash,
      });
    }
    const artifactHash = `artifact-${proposalId}`;
    this.artifacts.set(`${projectId}:${artifactHash}`, {
      proposalId,
      candidateRelease: { contentHash },
      fixtureHashes: fixtureCoverage.map((c) => c.fixtureHash),
      complete: true,
      passed: true,
    });
    return { fixtureCoverage, artifactHash };
  }
}
