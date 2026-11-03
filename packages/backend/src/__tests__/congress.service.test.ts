import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGovernanceCongress } from "../services/congress.service.js";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  invoke: vi.fn(),
  finish: vi.fn(),
  nomination: {} as Record<string, unknown>,
  nominated: { id: "standard@1", ruleId: "standard", revision: 1, severity: "standard" },
  other: { id: "other@1", ruleId: "other", revision: 1, severity: "standard" },
}));
vi.mock("../services/governance.service.js", () => ({
  governanceService: {
    getConfig: vi.fn().mockResolvedValue({ mode: "enforced", contextMaxChars: 100_000 }),
    refreshExpiredApprovals: vi.fn(),
    deliverOutbox: vi.fn(),
    mineDecisions: vi.fn(),
    listProposals: vi.fn().mockImplementation(async () => [mocks.nomination]),
    listDecisions: vi.fn().mockResolvedValue([{ id: "support" }, { id: "contrary" }]),
    listAuditEvents: vi.fn().mockResolvedValue([{ id: "event-support" }, { id: "event-contrary" }]),
    getRelease: vi.fn().mockResolvedValue({
      id: "release",
      rules: [mocks.nominated, mocks.other],
      enforcementRevision: "e",
    }),
    getCase: vi.fn(),
    createProposal: mocks.create,
  },
}));
vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getSettings: vi.fn().mockResolvedValue({}),
    getProject: vi.fn().mockResolvedValue({ repoPath: "/repo" }),
  })),
}));
vi.mock("../services/governance-source-hashes.js", () => ({
  readGovernanceSourceHashes: vi.fn().mockResolvedValue({ "AGENTS.md": "current" }),
}));
vi.mock("@opensprint/shared", async (original) => ({
  ...(await original<typeof import("@opensprint/shared")>()),
  getAgentForPlanningRole: () => ({ type: "claude" }),
}));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: { runWrite: (fn: (db: unknown) => unknown) => fn({}) },
}));
vi.mock("../services/congress-job.js", () => ({
  claimCongressDraft: vi.fn().mockResolvedValue({ nominationId: "n" }),
  finishCongressDraft: (...args: unknown[]) => mocks.finish(...args),
}));
vi.mock("../services/structured-agent-output.service.js", () => ({
  invokeStructuredPlanningAgent: mocks.invoke,
}));
const draft = (overrides: Record<string, unknown> = {}) => ({
  title: "Amend",
  rationale: "Evidence",
  changes: [
    {
      ruleId: "standard",
      text: "New text",
      rationale: "Why",
      compliant: ["c"],
      noncompliant: ["n"],
    },
  ],
  supportingDecisionIds: ["support"],
  contraryDecisionIds: ["contrary"],
  supportingEventIds: ["event-support"],
  contraryEventIds: ["event-contrary"],
  scope: "scope",
  compatibility: "same",
  positiveExamples: ["p"],
  negativeExamples: ["n"],
  ...overrides,
});
const respond = (parsed: unknown) => mocks.invoke.mockResolvedValue({ ok: true, parsed });
const failure = () => mocks.finish.mock.calls[0]?.[3] as string | undefined;
describe("Congress draft boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.nomination, {
      id: "n",
      state: "nominated",
      baseReleaseId: "release",
      nominatedRuleRevisionId: "standard@1",
      supportingDecisionIds: ["support"],
      contraryDecisionIds: ["contrary"],
      supportingEventIds: ["event-support"],
      contraryEventIds: ["event-contrary"],
    });
  });
  it("drafts a change to the nominated rule with evidence on its own side", async () => {
    respond(draft());
    await runGovernanceCongress("project");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({
      sourceHashes: { "AGENTS.md": "current" },
    });
    expect(failure()).toBeUndefined();
  });
  it.each([
    ["contrary ruling cited as support", { supportingDecisionIds: ["contrary"] }, "ruling"],
    ["supporting ruling cited as contrary", { contraryDecisionIds: ["support"] }, "ruling"],
    ["contrary event cited as support", { supportingEventIds: ["event-contrary"] }, "event"],
    ["supporting event cited as contrary", { contraryEventIds: ["event-support"] }, "event"],
  ])("rejects a %s", async (_name, overrides, kind) => {
    respond(draft(overrides));
    await runGovernanceCongress("project");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(failure()).toContain(`${kind} outside its nominated side`);
  });
  it("rejects a change to any other existing standard", async () => {
    respond(
      draft({
        changes: [
          {
            ruleId: "other",
            text: "New text",
            rationale: "Why",
            compliant: ["c"],
            noncompliant: ["n"],
          },
        ],
      })
    );
    await runGovernanceCongress("project");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(failure()).toContain("nominated rule");
  });
});
