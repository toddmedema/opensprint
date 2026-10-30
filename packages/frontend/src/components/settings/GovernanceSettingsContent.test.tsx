import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import type { GovernanceSummary, PolicyRuleRevision, ReviewCase } from "@opensprint/shared";
import { GovernanceSettingsContent } from "./GovernanceSettingsContent";
import { api, ApiError } from "../../api/client";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      governance: {
        get: vi.fn(),
        configure: vi.fn(),
        resolve: vi.fn(),
        createRelease: vi.fn(),
        activateRelease: vi.fn(),
        propose: vi.fn(),
        activate: vi.fn(),
        rejectProposal: vi.fn(),
        mine: vi.fn(),
        rollback: vi.fn(),
        revoke: vi.fn(),
        fixtures: vi.fn(),
        replaySources: vi.fn(),
        captureFixture: vi.fn(),
        evaluate: vi.fn(),
      },
    },
  };
});

const rule: PolicyRuleRevision = {
  id: "repository@1",
  ruleId: "repository",
  revision: 1,
  text: "Use the repository layer for service reads.",
  rationale: "Keep authorization and query behavior consistent.",
  owner: "Project owner",
  paths: ["src/**"],
  components: [],
  roles: ["coder", "reviewer", "judge"],
  severity: "standard",
  mandatory: true,
  exceptionEligible: true,
  examples: { compliant: ["Read via repository"], noncompliant: ["Raw query from service"] },
  parentIds: [],
  overrideIds: [],
  conflictIds: [],
  layer: 1,
  sourceHash: "rule-hash",
};
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
  summary: "Add a diagnostic read that the current repository cannot express.",
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
      provenance: { reviewer: "reviewer-1", angle: "code_quality" },
    },
  ],
  appeals: [
    {
      findingId: "finding-1",
      requestedException: "Allow a read-only diagnostic once.",
      alternatives: ["Existing repository projection cannot return the diagnostic."],
      whyCompliantOptionsFail: "The repository omits this metadata.",
      tests: ["Diagnostic has no writes"],
      risks: ["May drift from repository behavior"],
      proposedLimits: ["Read-only path"],
    },
  ],
  evidence: { diff: "+ diagnostic read" },
  evidenceHash: "evidence-hash",
  recommendation: {
    disposition: "human_required",
    rationale: "Mixed precedent needs owner authority.",
    evidence: ["No approved exception clause"],
    ruleIds: [rule.id],
    decisionIds: [],
  },
  worktreePath: "/tmp/task",
  branchName: "task/os-abcd",
  createdAt: "2026-10-30T12:00:00Z",
  updatedAt: "2026-10-30T12:01:00Z",
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
    releases: [
      {
        id: "release-1",
        projectId: "proj-1",
        rules: [rule],
        instructions: { coder: "Pinned coder instructions" },
        sourceHashes: {},
        contentHash: "release-hash",
        enforcementRevision: "b".repeat(40),
        createdAt: "2026-10-30T00:00:00Z",
        createdBy: "Owner",
      },
    ],
    cases: [item],
    decisions: [],
    proposals: [],
    events: [],
    authority: { configured: true },
    ...overrides,
  };
}
async function renderGovernance(data = summary()) {
  vi.mocked(api.governance.get).mockResolvedValue(data);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={["/projects/proj-1/settings?tab=governance&case=case-1"]}>
        <GovernanceSettingsContent projectId="proj-1" />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await screen.findByRole("heading", { name: "Review governance" });
}
async function unlock() {
  await userEvent.click(screen.getByText("Human authority & rollout"));
  fireEvent.change(screen.getByLabelText("Approval capability"), {
    target: { value: "owner-approval-capability" },
  });
}
async function prepareRuling(action: string) {
  await unlock();
  await userEvent.selectOptions(screen.getByLabelText("Decision"), action);
  fireEvent.change(screen.getByLabelText("Rationale"), {
    target: { value: "The diagnostic is read only and bounded to this change." },
  });
  await userEvent.click(
    screen.getByLabelText("I reviewed the evidence and the consequence of this action.")
  );
}

describe("GovernanceSettingsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.governance.resolve).mockResolvedValue({ ...item, state: "allowed", version: 4 });
    vi.mocked(api.governance.fixtures).mockResolvedValue([]);
    vi.mocked(api.governance.replaySources).mockResolvedValue([]);
  });
  it("saves independent read-only reconsideration model and price ceilings without changing the judge", async () => {
    const data = summary();
    data.config.judgeAgent = { type: "openai", model: "judge-model", cliCommand: null };
    data.config.judgeTokenPricing = { inputPerMillionUsd: 1, outputPerMillionUsd: 2 };
    await renderGovernance(data);
    await unlock();
    expect(screen.getByText(/including an initial CLI reviewer/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Reconsideration provider"), "claude");
    fireEvent.change(screen.getByLabelText("Reconsideration model"), {
      target: { value: "reviewer-api-model" },
    });
    fireEvent.change(
      screen.getByLabelText("Reconsideration input price ceiling ($ / million tokens)"),
      { target: { value: "3" } }
    );
    fireEvent.change(
      screen.getByLabelText("Reconsideration output price ceiling ($ / million tokens)"),
      { target: { value: "5" } }
    );
    await userEvent.click(screen.getByRole("button", { name: "Save rollout settings" }));
    await waitFor(() =>
      expect(api.governance.configure).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          expectedVersion: 1,
          judgeAgent: { type: "openai", model: "judge-model", cliCommand: null },
          judgeTokenPricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
          reconsiderationAgent: { type: "claude", model: "reviewer-api-model", cliCommand: null },
          reconsiderationTokenPricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 5 },
        }),
        "owner-approval-capability"
      )
    );
  });
  it("explicitly clears optional reconsideration model and ceilings", async () => {
    const data = summary();
    data.config.reconsiderationAgent = {
      type: "claude",
      model: "reviewer-api-model",
      cliCommand: null,
    };
    data.config.reconsiderationTokenPricing = { inputPerMillionUsd: 3, outputPerMillionUsd: 5 };
    await renderGovernance(data);
    await unlock();
    fireEvent.change(screen.getByLabelText("Reconsideration model"), { target: { value: "" } });
    fireEvent.change(
      screen.getByLabelText("Reconsideration input price ceiling ($ / million tokens)"),
      { target: { value: "" } }
    );
    fireEvent.change(
      screen.getByLabelText("Reconsideration output price ceiling ($ / million tokens)"),
      { target: { value: "" } }
    );
    await userEvent.click(screen.getByRole("button", { name: "Save rollout settings" }));
    await waitFor(() =>
      expect(api.governance.configure).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ reconsiderationAgent: null, reconsiderationTokenPricing: null }),
        "owner-approval-capability"
      )
    );
  });
  it("supports roving keyboard navigation between governance panels", async () => {
    await renderGovernance();
    const docket = screen.getByRole("tab", { name: "Docket (1)" });
    docket.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Standards" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Standards" })).toHaveAttribute("aria-selected", "true");
    expect(docket).toHaveAttribute("tabindex", "-1");
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Decision history" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(docket).toHaveFocus();
  });
  it("opens and focuses approval authority from the ruling form without losing the draft rationale", async () => {
    await renderGovernance();
    fireEvent.change(screen.getByLabelText("Rationale"), {
      target: { value: "Retain this drafted reasoning" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Unlock approval controls" }));
    expect(screen.getByLabelText("Approval capability")).toHaveFocus();
    expect(screen.getByLabelText("Rationale")).toHaveValue("Retain this drafted reasoning");
  });

  it("records an explicit one-time ruling bound to the reviewed code, policy case version, and diff", async () => {
    await renderGovernance();
    expect(screen.getByText("Use the repository layer for service reads.")).toBeInTheDocument();
    expect(screen.getByText("Mixed precedent needs owner authority.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record human ruling" })).toBeDisabled();
    await prepareRuling("allow_once");
    expect(screen.getByTestId("governance-action-consequence")).toHaveTextContent(
      "Future tasks gain no exception"
    );
    await userEvent.click(screen.getByRole("button", { name: "Record human ruling" }));
    await waitFor(() =>
      expect(api.governance.resolve).toHaveBeenCalledWith(
        "proj-1",
        "case-1",
        expect.objectContaining({
          expectedVersion: 3,
          idempotencyKey: expect.any(String),
          action: "allow_once",
          headSha: item.headSha,
          diffHash: item.diffHash,
          rationale: "The diagnostic is read only and bounded to this change.",
        }),
        "owner-approval-capability"
      )
    );
    expect(vi.mocked(api.governance.resolve).mock.calls[0]![2]).not.toHaveProperty("conditions");
  });

  it("requires explicit paths, compatible revisions, and future expiry for reusable precedent", async () => {
    await renderGovernance();
    await prepareRuling("allow_reusable");
    const submit = screen.getByRole("button", { name: "Record human ruling" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Expires at"), {
      target: { value: "2099-01-01T08:00" },
    });
    await userEvent.click(screen.getByLabelText(rule.id));
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByLabelText(rule.id));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(api.governance.resolve).toHaveBeenCalled());
    expect(vi.mocked(api.governance.resolve).mock.calls[0]![2].conditions).toEqual({
      version: 1,
      paths: ["src/diagnostics.ts"],
      ruleRevisionIds: [rule.id],
      expiresAt: new Date("2099-01-01T08:00").toISOString(),
    });
  });

  it("refreshes stale approvals and offers safe recovery without another allowance", async () => {
    await renderGovernance();
    await prepareRuling("allow_once");
    vi.mocked(api.governance.get).mockResolvedValue(
      summary({ cases: [{ ...item, state: "stale", version: 4 }] })
    );
    vi.mocked(api.governance.resolve).mockRejectedValue(
      new ApiError("Case revision changed", "GOVERNANCE_CONFLICT")
    );
    await userEvent.click(screen.getByRole("button", { name: "Record human ruling" }));
    await screen.findByText(/This review changed before your decision was saved/);
    await screen.findByText(/Code or policy changed after this review/);
    expect(screen.getByRole("option", { name: "Allow this change once" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Allow with reusable conditions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Record human ruling" })).toBeDisabled();
    expect(api.governance.resolve).toHaveBeenCalledTimes(1);
  });

  it("lets the owner require a fix for a stale held task", async () => {
    await renderGovernance(summary({ cases: [{ ...item, state: "stale", version: 4 }] }));
    await prepareRuling("require_fix");
    await userEvent.click(screen.getByRole("button", { name: "Record human ruling" }));
    await waitFor(() =>
      expect(api.governance.resolve).toHaveBeenCalledWith(
        "proj-1",
        "case-1",
        expect.objectContaining({ expectedVersion: 4, action: "require_fix" }),
        "owner-approval-capability"
      )
    );
  });

  it("shows recovered published expiry as remediation history without new approval controls", async () => {
    await renderGovernance(
      summary({ cases: [{ ...item, state: "cancelled", publishedRemediationOnly: true }] })
    );
    expect(screen.getByText("No cases are waiting for a decision.")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Show resolved cases"));
    expect(screen.getAllByText("Published · remediation required").length).toBeGreaterThan(0);
    expect(screen.getByText(/original change was already published/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record human ruling" })).not.toBeInTheDocument();
  });
  it("does not let a standards exception waive a defect or failed gate", async () => {
    await renderGovernance(
      summary({
        cases: [
          {
            ...item,
            findings: [
              ...item.findings,
              {
                ...item.findings[0]!,
                id: "gate-1",
                category: "gate",
                ruleId: undefined,
                ruleRevisionId: undefined,
              },
            ],
          },
        ],
      })
    );
    await prepareRuling("allow_once");
    expect(screen.getByText(/standards exception cannot waive those blockers/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record human ruling" })).toBeDisabled();
  });

  it("shows exact proposal content and contrary rulings while incomplete evaluation locks activation", async () => {
    await renderGovernance(
      summary({
        proposals: [
          {
            id: "proposal-1",
            projectId: "proj-1",
            baseReleaseId: "release-1",
            state: "draft",
            version: 1,
            title: "Clarify read-only diagnostics",
            rationale: "Recurring exceptions deserve review.",
            patches: [
              {
                ruleId: rule.ruleId,
                before: rule,
                after: {
                  ...rule,
                  id: "repository@2",
                  revision: 2,
                  text: "Use the repository layer except approved read-only diagnostics.",
                },
              },
            ],
            supportingDecisionIds: [],
            contraryDecisionIds: ["decision-conflict"],
            scope: "Read-only diagnostics",
            compatibility: "Existing enforcement supports both releases.",
            enforcementRevision: "b".repeat(40),
            positiveExamples: ["Bounded read-only metadata"],
            negativeExamples: ["Unbounded service writes"],
            createdAt: "2026-10-30T00:00:00Z",
          },
        ],
      })
    );
    await userEvent.click(screen.getByRole("tab", { name: "Rule amendments" }));
    const proposal = screen.getByTestId("governance-proposal");
    expect(within(proposal).getByText("Before")).toBeInTheDocument();
    expect(within(proposal).getByText("After")).toBeInTheDocument();
    expect(
      within(proposal).getByText("Use the repository layer except approved read-only diagnostics.")
    ).toBeInTheDocument();
    expect(within(proposal).getByText("decision-conflict")).toBeInTheDocument();
    expect(within(proposal).getByText(/No complete evaluation is available/)).toBeInTheDocument();
    expect(
      within(proposal).getByRole("button", { name: "Approve & activate amendment" })
    ).toBeDisabled();
  });

  it("preserves stale case evidence and offers only safe recovery actions", async () => {
    await renderGovernance(summary({ cases: [{ ...item, state: "stale" }] }));
    expect(screen.getByText(/a fresh review is required/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Inspect full diff & retained evidence"));
    expect(screen.getByText(/diagnostic read/, { selector: "pre" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record human ruling" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Allow this change once" })).toBeDisabled();
  });
  it("keeps a human-cancelled change visible with safe recovery and no allowance", async () => {
    await renderGovernance(
      summary({ cases: [{ ...item, state: "cancelled", humanCancelled: true }] })
    );
    expect(await screen.findByText(/A human cancelled this change/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Decision/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Allow this change once" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Allow with reusable conditions" })).toBeDisabled();
  });
});
