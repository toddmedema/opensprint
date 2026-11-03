import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import type {
  GovernanceSummary,
  PolicyDecision,
  PolicyProposal,
  PolicyRelease,
  PolicyRuleRevision,
  ReviewCase,
} from "@opensprint/shared";
import { GovernanceSettingsContent } from "./GovernanceSettingsContent";
import { api, ApiError } from "../../api/client";
import { queryKeys } from "../../api/queryKeys";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      governance: {
        get: vi.fn(),
        getCase: vi.fn(),
        revokeRelease: vi.fn(),
        configure: vi.fn(),
        resolve: vi.fn(),
        createRelease: vi.fn(),
        activateRelease: vi.fn(),
        propose: vi.fn(),
        rejectProposal: vi.fn(),
        rollback: vi.fn(),
        revoke: vi.fn(),
        fixtures: vi.fn(),
        replaySources: vi.fn(),
        sourceChanges: vi.fn(),
      },
    },
  };
});

const rule: PolicyRuleRevision = {
  id: "repository@1",
  ruleId: "repository",
  revision: 1,
  text: "Use the repository layer for service reads.",
  rationale: "Keep query behavior consistent.",
  owner: "Project owner",
  paths: ["src/**"],
  components: [],
  roles: ["coder", "reviewer", "judge"],
  severity: "standard",
  mandatory: true,
  exceptionEligible: true,
  examples: { compliant: ["Read via repository"], noncompliant: ["Raw query"] },
  parentIds: [],
  overrideIds: [],
  conflictIds: [],
  layer: 1,
  sourceHash: "rule-hash",
};
const release = (id: string, createdAt: string): PolicyRelease => ({
  id,
  projectId: "proj-1",
  rules: [rule],
  instructions: {},
  sourceHashes: {},
  contentHash: `${id}-hash`,
  enforcementRevision: "b".repeat(40),
  createdAt,
  createdBy: "Owner",
});
const item: ReviewCase = {
  id: "case-1",
  projectId: "proj-1",
  taskId: "os-abcd",
  releaseId: "release-1",
  state: "awaiting_human",
  version: 3,
  headSha: "a".repeat(40),
  diffHash: "diff-hash",
  baseSha: "b".repeat(40),
  changedPaths: ["src/diagnostics.ts"],
  title: "Read-only diagnostic exception",
  summary: "Add a diagnostic read.",
  findings: [
    {
      id: "finding-1",
      category: "standard",
      ruleId: rule.ruleId,
      ruleRevisionId: rule.id,
      file: "src/diagnostics.ts:12",
      codeRevision: "a".repeat(40),
      evidence: "A direct read bypasses the repository.",
      severity: "blocking",
      suggestedRemedy: "Add a repository method.",
      provenance: { reviewer: "reviewer-1" },
    },
  ],
  appeals: [
    {
      findingId: "finding-1",
      requestedException: "Allow a read-only diagnostic once.",
      alternatives: [],
      whyCompliantOptionsFail: "The repository omits this metadata.",
      tests: [],
      risks: [],
      proposedLimits: [],
    },
  ],
  evidence: { diff: "--- a/x\n+++ b/x\n+ added line\n- removed line", extra: "raw-only-value" },
  evidenceHash: "evidence-hash",
  worktreePath: "/synthetic/task",
  branchName: "task/os-abcd",
  createdAt: "2026-10-30T12:00:00Z",
  updatedAt: "2026-10-30T12:01:00Z",
};
const decision: PolicyDecision = {
  id: "decision-1",
  projectId: "proj-1",
  caseId: "case-9",
  taskId: "os-abcd",
  releaseId: "release-1",
  action: "allow_once",
  actor: "Owner",
  rationale: "Bounded exception.",
  headSha: "a".repeat(40),
  diffHash: "diff-hash",
  findingIds: ["finding-1"],
  ruleRevisionIds: [rule.id],
  createdAt: "2026-10-30T12:00:00Z",
};
const proposal: PolicyProposal = {
  id: "proposal-1",
  projectId: "proj-1",
  baseReleaseId: "release-old",
  state: "draft",
  version: 1,
  title: "Clarify diagnostics",
  rationale: "Recurring exceptions deserve review.",
  patches: [{ ruleId: rule.ruleId, before: rule, after: { ...rule, id: "repository@2" } }],
  supportingDecisionIds: [],
  contraryDecisionIds: [],
  scope: "Diagnostics",
  compatibility: "Compatible.",
  enforcementRevision: "b".repeat(40),
  positiveExamples: ["Positive"],
  negativeExamples: ["Negative"],
  createdAt: "2026-10-30T00:00:00Z",
};
function summary(overrides: Partial<GovernanceSummary> = {}): GovernanceSummary {
  return {
    config: {
      mode: "enforced",
      version: 1,
      maxAppeals: 2,
      maxTokens: 20000,
      maxCostUsd: 10,
      maxElapsedMs: 900000,
      contextMaxChars: 20000,
      recurrenceThreshold: 3,
    },
    activeReleaseId: "release-1",
    rules: [rule],
    releases: [release("release-1", "2026-10-30T00:00:00Z")],
    cases: [item],
    decisions: [],
    proposals: [],
    events: [],
    authority: { configured: true },
    ...overrides,
  };
}
async function renderGovernance(data = summary(), entry = "?tab=governance&case=case-1") {
  vi.mocked(api.governance.getCase).mockImplementation(async (_project, caseId) => {
    const current = data.cases.find((entry) => entry.id === caseId)!;
    return { ...current, evidence: item.evidence };
  });
  vi.mocked(api.governance.get).mockResolvedValue({
    ...data,
    cases: data.cases.map((entry) => {
      const { evidence: _evidence, ...brief } = entry as ReviewCase;
      return brief;
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/projects/proj-1/settings${entry}`]}>
        <GovernanceSettingsContent projectId="proj-1" />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await screen.findByRole("heading", { name: "Review governance" });
  return client;
}
const poll = (client: QueryClient, data: GovernanceSummary) =>
  act(async () => {
    client.setQueryData(queryKeys.governance.summary("proj-1"), data);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function unlock() {
  await userEvent.click(screen.getByText("Human authority & rollout"));
  fireEvent.change(screen.getByLabelText("Approval capability"), {
    target: { value: "synthetic-capability" },
  });
}
async function prepareRuling() {
  await unlock();
  fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "Drafted reasoning" } });
  await userEvent.click(
    screen.getByLabelText("I reviewed the evidence and the consequence of this action.")
  );
}
const submitRuling = () =>
  userEvent.click(screen.getByRole("button", { name: "Record human ruling" }));

describe("GovernanceSettingsContent review regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.governance.fixtures).mockResolvedValue([]);
    vi.mocked(api.governance.replaySources).mockResolvedValue([]);
  });

  describe("H1 ruling drafts across case versions", () => {
    it("blocks a drafted evidence request when a poll marks the case stale", async () => {
      const client = await renderGovernance();
      await prepareRuling();
      await userEvent.selectOptions(screen.getByLabelText("Decision"), "request_evidence");
      await poll(client, summary({ cases: [{ ...item, version: 4, state: "stale" }] }));
      await userEvent.click(
        screen.getByLabelText("I reviewed the evidence and the consequence of this action.")
      );
      expect(screen.getByRole("button", { name: "Record human ruling" })).toBeDisabled();
      expect(api.governance.resolve).not.toHaveBeenCalled();
    });
    it("keeps the draft, requires a fresh confirmation, and binds a new idempotency key", async () => {
      vi.mocked(api.governance.resolve).mockRejectedValueOnce(
        new ApiError("Network blip", "UNKNOWN")
      );
      const client = await renderGovernance();
      await prepareRuling();
      await submitRuling();
      await waitFor(() => expect(api.governance.resolve).toHaveBeenCalledTimes(1));
      const firstKey = vi.mocked(api.governance.resolve).mock.calls[0]![2].idempotencyKey;
      await poll(client, summary({ cases: [{ ...item, version: 4 }] }));
      expect(screen.getByLabelText("Rationale")).toHaveValue("Drafted reasoning");
      const banner = screen.getByTestId("governance-case-changed");
      expect(banner).toHaveTextContent("Case changed from version 3 to 4");
      await waitFor(() => expect(banner).toHaveFocus());
      expect(screen.getByRole("button", { name: "Record human ruling" })).toBeDisabled();
      await userEvent.click(
        screen.getByLabelText("I reviewed the evidence and the consequence of this action.")
      );
      vi.mocked(api.governance.resolve).mockResolvedValue(decision);
      await submitRuling();
      await waitFor(() => expect(api.governance.resolve).toHaveBeenCalledTimes(2));
      const second = vi.mocked(api.governance.resolve).mock.calls[1]![2];
      expect(second.expectedVersion).toBe(4);
      expect(second.idempotencyKey).not.toBe(firstKey);
    });
    it("does not pull focus out of a field being typed in when a poll changes the case", async () => {
      const client = await renderGovernance();
      const rationale = screen.getByLabelText("Rationale");
      rationale.focus();
      await poll(client, summary({ cases: [{ ...item, version: 4 }] }));
      expect(screen.getByTestId("governance-case-changed")).toBeInTheDocument();
      expect(rationale).toHaveFocus();
    });
    it("keeps a proposal activation rationale when the proposal version changes", async () => {
      const current = { ...proposal, baseReleaseId: "release-1" };
      const client = await renderGovernance(summary({ proposals: [current] }));
      await userEvent.click(screen.getByRole("tab", { name: "Rule amendments" }));
      fireEvent.change(screen.getByLabelText("Decision rationale"), {
        target: { value: "Drafted activation reason" },
      });
      await poll(client, summary({ proposals: [{ ...current, version: 2 }] }));
      expect(screen.getByLabelText("Decision rationale")).toHaveValue("Drafted activation reason");
    });
  });

  describe("H2 and H3 mutation feedback", () => {
    it("never labels a validation error as a changed review", async () => {
      vi.mocked(api.governance.resolve).mockRejectedValue(
        new ApiError("Named human, rationale, and key are required.", "GOVERNANCE_INVALID_INPUT")
      );
      await renderGovernance();
      await prepareRuling();
      await submitRuling();
      await screen.findByText(/Named human, rationale, and key are required/);
      expect(screen.queryByText(/changed before your (action|decision)/)).not.toBeInTheDocument();
    });
    it("does not label a generic governance conflict as a changed review", async () => {
      vi.mocked(api.governance.resolve).mockRejectedValue(
        new ApiError("Late judge result cannot change this case.", "GOVERNANCE_CONFLICT")
      );
      await renderGovernance();
      await prepareRuling();
      await submitRuling();
      await screen.findByText(/Late judge result/);
      expect(screen.queryByText(/changed before your (action|decision)/)).not.toBeInTheDocument();
    });
    it("labels the stale version code, refetches, and shows the error in the case and focuses it", async () => {
      vi.mocked(api.governance.resolve).mockRejectedValue(
        new ApiError("Case changed.", "GOVERNANCE_STALE_VERSION")
      );
      await renderGovernance();
      await prepareRuling();
      const fetches = vi.mocked(api.governance.get).mock.calls.length;
      await submitRuling();
      const detail = screen.getByTestId("governance-case-detail");
      const message = await within(detail).findByText(/changed before your action/);
      await waitFor(() => expect(message.closest('[role="alert"]')).toHaveFocus());
      await waitFor(() =>
        expect(vi.mocked(api.governance.get).mock.calls.length).toBeGreaterThan(fetches)
      );
    });
    it("shows success beside the form and keeps the decided case on screen", async () => {
      vi.mocked(api.governance.resolve).mockResolvedValue(decision);
      const client = await renderGovernance(
        summary({ cases: [item, { ...item, id: "case-2", title: "Other case" }] }),
        "?tab=governance"
      );
      await prepareRuling();
      await submitRuling();
      const detail = screen.getByTestId("governance-case-detail");
      await within(detail).findByText(/Human ruling recorded/);
      await poll(
        client,
        summary({
          cases: [
            { ...item, state: "allowed", version: 4 },
            { ...item, id: "case-2", title: "Other case" },
          ],
        })
      );
      expect(
        within(screen.getByTestId("governance-case-detail")).getByRole("heading", {
          level: 3,
        })
      ).toHaveTextContent(item.title);
      expect(screen.getByText(/This case is resolved/)).toBeInTheDocument();
    });
  });

  describe("H4 and H5 draft lifecycle", () => {
    const addDraft = async () => {
      await userEvent.click(screen.getByRole("tab", { name: "Standards" }));
      await userEvent.click(screen.getByRole("button", { name: "Add a standard" }));
      fireEvent.change(screen.getByLabelText("Stable rule ID"), { target: { value: "draft-1" } });
      fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "Owner" } });
      fireEvent.change(screen.getByLabelText("Full rule text"), {
        target: { value: "Draft text" },
      });
      fireEvent.change(screen.getByLabelText("Rationale", { selector: "textarea" }), {
        target: { value: "Draft why" },
      });
      await userEvent.click(screen.getByRole("button", { name: "Add to initial release" }));
    };
    const onboarding = () => summary({ activeReleaseId: null, rules: [], releases: [], cases: [] });

    it("keeps unpublished standards across a tab switch", async () => {
      await renderGovernance(onboarding());
      await addDraft();
      expect(screen.getByText("Unpublished initial standards")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("tab", { name: "Decision history" }));
      await userEvent.click(screen.getByRole("tab", { name: "Standards" }));
      expect(screen.getByText("Unpublished initial standards")).toBeInTheDocument();
    });
    it("clears drafts and rationale after publishing and does not reuse it for activation", async () => {
      vi.mocked(api.governance.createRelease).mockResolvedValue(
        release("r", "2026-10-30T00:00:00Z")
      );
      const client = await renderGovernance(onboarding());
      await unlock();
      await addDraft();
      fireEvent.change(screen.getByLabelText("Compatible enforcement commit"), {
        target: { value: "b".repeat(40) },
      });
      fireEvent.change(screen.getByLabelText("Approval rationale"), {
        target: { value: "Publish reason" },
      });
      await userEvent.click(screen.getByRole("button", { name: "Publish initial release" }));
      await screen.findByText(/Initial release saved/);
      expect(screen.queryByText("Unpublished initial standards")).not.toBeInTheDocument();
      await poll(
        client,
        summary({
          activeReleaseId: null,
          rules: [],
          cases: [],
          releases: [release("r", "2026-10-30T00:00:00Z")],
        })
      );
      expect(screen.getByLabelText("Activation rationale")).toHaveValue("");
    });
    it("offers the newest unactivated release by createdAt, not list order", async () => {
      await renderGovernance(
        summary({
          activeReleaseId: null,
          rules: [],
          cases: [],
          releases: [
            release("release-aaa-old", "2026-10-01T00:00:00Z"),
            release("release-zzz-new", "2026-10-30T00:00:00Z"),
          ],
        })
      );
      await userEvent.click(screen.getByRole("tab", { name: "Standards" }));
      expect(screen.getByLabelText("Release to activate")).toHaveValue("release-zzz-new");
    });
    it("closes the amendment editor and clears its evidence after a successful proposal", async () => {
      vi.mocked(api.governance.propose).mockResolvedValue(proposal);
      await renderGovernance();
      await unlock();
      await userEvent.click(screen.getByRole("tab", { name: "Standards" }));
      await userEvent.click(screen.getByRole("button", { name: "Propose a change" }));
      fireEvent.change(screen.getByLabelText(/^Intended scope/), { target: { value: "Scope" } });
      fireEvent.change(screen.getByLabelText(/^Migration/), { target: { value: "Compatible" } });
      fireEvent.change(screen.getByLabelText(/^Compatible enforcement commit/), {
        target: { value: "b".repeat(40) },
      });
      fireEvent.change(screen.getByLabelText(/^Supporting decision IDs/), {
        target: { value: "decision-1" },
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Submit amendment for evaluation" })
      );
      await screen.findByText(/Amendment proposed/);
      expect(screen.queryByLabelText(/^Intended scope/)).not.toBeInTheDocument();
    });
    it("names missing required amendment evidence instead of submitting", async () => {
      await renderGovernance();
      await unlock();
      await userEvent.click(screen.getByRole("tab", { name: "Standards" }));
      await userEvent.click(screen.getByRole("button", { name: "Propose a change" }));
      fireEvent.change(screen.getByLabelText(/^Intended scope/), { target: { value: "Scope" } });
      fireEvent.change(screen.getByLabelText(/^Migration/), { target: { value: "Compatible" } });
      fireEvent.change(screen.getByLabelText(/^Compatible enforcement commit/), {
        target: { value: "b".repeat(40) },
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Submit amendment for evaluation" })
      );
      expect(
        await screen.findByText(/Still required: .*supporting decision ID/)
      ).toBeInTheDocument();
      expect(api.governance.propose).not.toHaveBeenCalled();
    });
  });

  describe("H7 evidence review", () => {
    it("loads evidence on demand from a summary without evidence and offers retry after failure", async () => {
      await renderGovernance();
      expect(api.governance.getCase).not.toHaveBeenCalled();
      vi.mocked(api.governance.getCase).mockRejectedValueOnce(new Error("Evidence unavailable"));
      await userEvent.click(screen.getByText("Inspect full diff & retained evidence"));
      expect(await screen.findByText("Evidence unavailable")).toBeInTheDocument();
      expect(screen.queryByText("No diff was retained for this case.")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Retry loading evidence" }));
      expect(await screen.findByTestId("governance-evidence-diff")).toHaveTextContent(
        "+ added line"
      );
      expect(api.governance.getCase).toHaveBeenCalledWith("proj-1", item.id);
    });

    it("never displays evidence from a different case version and refreshes the summary", async () => {
      await renderGovernance();
      const fetches = vi.mocked(api.governance.get).mock.calls.length;
      vi.mocked(api.governance.getCase).mockResolvedValue({
        ...item,
        version: item.version + 1,
        evidence: { diff: "+ unreviewed revision" },
      });
      await userEvent.click(screen.getByText("Inspect full diff & retained evidence"));
      expect(
        await screen.findByText(/This case changed. Review the refreshed case/)
      ).toBeInTheDocument();
      expect(screen.queryByTestId("governance-evidence-diff")).not.toBeInTheDocument();
      expect(vi.mocked(api.governance.get).mock.calls.length).toBeGreaterThan(fetches);
    });

    it("replaces cached evidence when polling reports a new case version", async () => {
      const client = await renderGovernance();
      await userEvent.click(screen.getByText("Inspect full diff & retained evidence"));
      await screen.findByTestId("governance-evidence-diff");
      const changed = { ...item, version: 4, evidenceHash: "new-evidence" };
      vi.mocked(api.governance.getCase).mockResolvedValue({
        ...changed,
        evidence: { diff: "+ updated evidence" },
      });
      await poll(client, summary({ cases: [changed] }));
      await waitFor(() =>
        expect(screen.getByTestId("governance-evidence-diff")).toHaveTextContent("updated evidence")
      );
      expect(screen.getByTestId("governance-evidence-diff")).not.toHaveTextContent("added line");
    });

    it("shows the diff first, keeps JSON secondary, and adds reconsideration and disposition", async () => {
      await renderGovernance(
        summary({
          cases: [
            {
              ...item,
              reconsideration: {
                status: "rejected",
                summary: "The finding stands.",
                notes: "Reviewer notes.",
                withdrawnFindingIds: [],
              },
              verifiedDisposition: { kind: "precedent_applied", decisionIds: ["decision-7"] },
            },
          ],
        })
      );
      await userEvent.click(screen.getByText("Inspect full diff & retained evidence"));
      const diff = await screen.findByTestId("governance-evidence-diff");
      expect(diff).toHaveTextContent("+ added line");
      expect(diff).not.toHaveTextContent("raw-only-value");
      expect(screen.getByText("Raw retained evidence (JSON)")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Reviewer reconsideration" })).toHaveTextContent(
        "The finding stands."
      );
      expect(screen.getByRole("region", { name: "Verified disposition" })).toHaveTextContent(
        "Approved precedent applied"
      );
      expect(screen.getByText("Why compliant options fail")).toBeInTheDocument();
    });
  });

  describe("docket states", () => {
    it("M1 shows a deep-linked resolved case and says it is resolved", async () => {
      await renderGovernance(
        summary({
          cases: [
            { ...item, id: "open-case", title: "Different open case" },
            { ...item, state: "allowed", title: "Linked resolved case" },
          ],
        })
      );
      expect(screen.getByText(/This case is resolved · Exception allowed/)).toBeInTheDocument();
      expect(
        within(screen.getByTestId("governance-case-detail")).getByRole("heading", { level: 3 })
      ).toHaveTextContent("Linked resolved case");
    });
    it("M1 says when a deep-linked case does not exist", async () => {
      await renderGovernance(summary(), "?tab=governance&case=missing-case");
      expect(screen.getByText(/Case missing-case was not found/)).toBeInTheDocument();
    });
    it("M3 counts only human-actionable cases and labels others in progress", async () => {
      await renderGovernance(
        summary({
          cases: [
            item,
            { ...item, id: "judge", state: "awaiting_judge", title: "With judge" },
            { ...item, id: "reviewer", state: "awaiting_reconsideration", title: "With reviewer" },
          ],
        })
      );
      expect(screen.getByRole("tab", { name: "Docket (1)" })).toBeInTheDocument();
      expect(screen.getByText("2 in progress")).toBeInTheDocument();
    });
    it("M4 tells the owner an agent-held case needs no action", async () => {
      await renderGovernance(summary({ cases: [{ ...item, state: "awaiting_judge" }] }));
      expect(screen.getByTestId("governance-agent-held")).toHaveTextContent("No action needed");
      expect(screen.queryByRole("button", { name: "Record human ruling" })).not.toBeInTheDocument();
    });
  });

  describe("destructive actions", () => {
    it("M2 asks each ruling for its own reason before a danger confirmation", async () => {
      vi.mocked(api.governance.revoke).mockResolvedValue({ ok: true });
      await renderGovernance(summary({ decisions: [decision, { ...decision, id: "decision-2" }] }));
      await unlock();
      await userEvent.click(screen.getByRole("tab", { name: "Decision history" }));
      expect(screen.queryByText("Revocation or rollback rationale")).not.toBeInTheDocument();
      await userEvent.click(screen.getAllByRole("button", { name: "Revoke ruling" })[0]!);
      expect(screen.getAllByRole("button", { name: "Revoke ruling" })).toHaveLength(1);
      const confirm = screen.getByRole("button", { name: "Confirm revocation" });
      expect(confirm).toHaveClass("btn-danger");
      expect(confirm).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Reason for revoking this ruling"), {
        target: { value: "Unsafe precedent" },
      });
      await userEvent.click(confirm);
      await waitFor(() =>
        expect(api.governance.revoke).toHaveBeenCalledWith(
          "proj-1",
          "decision-1",
          "Unsafe precedent",
          "synthetic-capability"
        )
      );
    });
    it("M2 rejects a proposal with its own reason, separate from activation rationale", async () => {
      vi.mocked(api.governance.rejectProposal).mockResolvedValue({ ok: true });
      await renderGovernance(summary({ proposals: [{ ...proposal, baseReleaseId: "release-1" }] }));
      await unlock();
      await userEvent.click(screen.getByRole("tab", { name: "Rule amendments" }));
      fireEvent.change(screen.getByLabelText("Decision rationale"), {
        target: { value: "Activation draft" },
      });
      await userEvent.click(screen.getByRole("button", { name: "Reject amendment" }));
      fireEvent.change(screen.getByLabelText("Reason for rejecting this amendment"), {
        target: { value: "Too broad" },
      });
      await userEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
      await waitFor(() =>
        expect(api.governance.rejectProposal).toHaveBeenCalledWith(
          "proj-1",
          "proposal-1",
          { expectedVersion: 1, rationale: "Too broad" },
          "synthetic-capability"
        )
      );
    });
    it("M7 lists only previously activated, unrevoked releases for rollback", async () => {
      const event = (kind: string, releaseId: string) => ({
        id: `${kind}-${releaseId}`,
        projectId: "proj-1",
        kind,
        actor: "Owner",
        payload: { releaseId },
        createdAt: "2026-10-30T00:00:00Z",
      });
      await renderGovernance(
        summary({
          releases: [
            release("release-1", "2026-10-30T00:00:00Z"),
            release("release-restorable", "2026-10-29T00:00:00Z"),
            release("release-revoked", "2026-10-28T00:00:00Z"),
            release("release-never-active", "2026-10-27T00:00:00Z"),
          ],
          events: [
            event("release_activated", "release-restorable"),
            event("release_activated", "release-revoked"),
            event("release_revoked", "release-revoked"),
          ],
        })
      );
      await userEvent.click(screen.getByRole("tab", { name: "Decision history" }));
      const options = within(screen.getByLabelText("Previous release"))
        .getAllByRole("option")
        .map((option) => option.getAttribute("value"));
      expect(options).toEqual(["", "release-restorable"]);
    });
  });

  it("M5 explains how to recover a proposal drafted on a replaced release", async () => {
    await renderGovernance(summary({ proposals: [proposal] }));
    await userEvent.click(screen.getByRole("tab", { name: "Rule amendments" }));
    expect(screen.queryByText(/must be rebased/)).not.toBeInTheDocument();
    expect(screen.getByText(/draft the same change again/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to Standards" }));
    expect(screen.getByRole("tab", { name: "Standards" })).toHaveAttribute("aria-selected", "true");
  });

  it("M8 marks a revoked active release with a badge", async () => {
    await renderGovernance(
      summary({
        events: [
          {
            id: "event-1",
            projectId: "proj-1",
            kind: "release_revoked",
            actor: "Owner",
            payload: { releaseId: "release-1" },
            createdAt: "2026-10-30T00:00:00Z",
          },
        ],
      })
    );
    await userEvent.click(screen.getByRole("tab", { name: "Standards" }));
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });

  it("requires confirmation again if the active release changes during revocation", async () => {
    const client = await renderGovernance();
    await unlock();
    await userEvent.click(screen.getByRole("tab", { name: "Standards" }));
    await userEvent.click(screen.getByText("Critical policy revocation"));
    fireEvent.change(screen.getByLabelText("Reason for critical revocation"), {
      target: { value: "Unsafe rule" },
    });
    await userEvent.click(screen.getByLabelText(/I understand affected tasks will pause/));
    expect(screen.getByRole("button", { name: "Revoke current policy release" })).toBeEnabled();
    await poll(
      client,
      summary({
        activeReleaseId: "replacement",
        releases: [release("replacement", "2026-11-02T00:00:00Z")],
      })
    );
    expect(screen.getByLabelText(/I understand affected tasks will pause/)).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Revoke current policy release" })).toBeDisabled();
    expect(screen.getByText("Release to revoke: replacement")).toBeInTheDocument();
    expect(api.governance.revokeRelease).not.toHaveBeenCalled();
  });

  it("M9 keeps stale data visible and reports reconnecting when a refetch fails", async () => {
    const client = await renderGovernance();
    vi.mocked(api.governance.get).mockRejectedValue(new Error("offline"));
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.governance.summary("proj-1") });
    });
    await waitFor(() =>
      expect(screen.getByTestId("governance-connection-status")).toHaveTextContent(
        /Last updated .* Reconnecting/
      )
    );
    expect(screen.getByTestId("governance-case-detail")).toBeInTheDocument();
  });

  it("M11 ignores a slower response for a previous task and shows the previewed task", async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof api.governance.sourceChanges>>) => void;
    vi.mocked(api.governance.sourceChanges).mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      })
    );
    await renderGovernance();
    await userEvent.click(screen.getByRole("tab", { name: "Standards" }));
    await userEvent.click(screen.getByText("Review changes to policy or enforcement files"));
    fireEvent.change(screen.getByLabelText("Task ID"), { target: { value: "os-old" } });
    await userEvent.click(screen.getByRole("button", { name: "Inspect change" }));
    fireEvent.change(screen.getByLabelText("Task ID"), { target: { value: "os-new" } });
    const change = {
      taskId: "os-old",
      releaseId: "release-1",
      headSha: "c".repeat(40),
      diffHash: "hash",
      changedPaths: ["AGENTS.md"],
      diff: "+ change",
    };
    await act(async () => finishOld(change));
    expect(screen.queryByText("AGENTS.md")).not.toBeInTheDocument();
    vi.mocked(api.governance.sourceChanges).mockResolvedValueOnce(change);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inspect change" })).toBeEnabled()
    );
    await userEvent.click(screen.getByRole("button", { name: "Inspect change" }));
    expect(await screen.findByText(/Task os-old · Code/)).toBeInTheDocument();
  });

  it("M12 states the always-review requirement for every enabled mode", async () => {
    await renderGovernance();
    expect(screen.getByTestId("governance-rollout-help")).toHaveTextContent(
      /Shadow pilot and Bounded adjudication both need/
    );
  });

  it("exposes every tab panel, focusable when shown, and a non-saved capability field", async () => {
    await renderGovernance();
    for (const name of ["Standards", "Rule amendments", "Decision history"]) {
      const panelId = screen.getByRole("tab", { name }).getAttribute("aria-controls");
      expect(document.getElementById(panelId!)).toHaveAttribute("hidden");
    }
    expect(screen.getByRole("tabpanel")).toHaveAttribute("tabindex", "0");
    expect(screen.getByLabelText("Approval capability")).toHaveAttribute(
      "autocomplete",
      "new-password"
    );
  });
});
