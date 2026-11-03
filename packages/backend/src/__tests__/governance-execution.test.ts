import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GovernanceTaskPin,
  PolicyRelease,
  ReviewCase,
  ReviewAppeal,
  StructuredReviewFinding,
} from "@opensprint/shared";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getTaskPin: vi.fn(),
  getActiveRelease: vi.fn(),
  pinTask: vi.fn(),
  refreshContext: vi.fn(),
  getRelease: vi.fn(),
  isReleaseRevoked: vi.fn(),
  getTrustedScope: vi.fn(),
  getGrantedScope: vi.fn(),
  getCase: vi.fn(),
  getApprovedSourceHashes: vi.fn(),
  settleBudget: vi.fn(),
  captureTrustedScope: vi.fn(),
  openCase: vi.fn(),
  claimCaseJob: vi.fn(),
  recordRecommendation: vi.fn(),
  recordReconsideration: vi.fn(),
  applyVerifiedDisposition: vi.fn(),
  consumeBudget: vi.fn(),
  getBudgetUsage: vi.fn(),
  isGovernanceInactive: async () => false,
  getTaskPinsForBranch: vi.fn(),
  getReviewApproval: vi.fn(),
  assertMergeAdmission: vi.fn(),
  getTaskCases: vi.fn(),
  listDecisions: vi.fn(),
  listCases: vi.fn(),
  findPrecedent: vi.fn(),
  getPromptSnapshots: vi.fn(),
  recordPromptSnapshot: vi.fn(),
  recordReviewApproval: vi.fn(),
  deliverOutbox: vi.fn(),
  audit: vi.fn(),
  invoke: vi.fn(),
  guidance: vi.fn().mockReturnValue([]),
  anthropicConstructor: vi.fn(),
  openaiConstructor: vi.fn(),
  anthropicStream: vi.fn(),
  openaiCreate: vi.fn(),
}));
vi.mock("../services/governance.service.js", () => ({ governanceService: mocks }));
vi.mock("../services/agent.service.js", () => ({
  agentService: { invokePlanningAgent: mocks.invoke },
}));
vi.mock("../services/agent-chat.service.js", () => ({
  agentChatService: { getHistory: mocks.guidance },
}));
// One regression traverses the real AgentService with SDKs that cannot reach the network.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(options: unknown) {
      mocks.anthropicConstructor(options);
    }
    messages = { stream: (...args: unknown[]) => mocks.anthropicStream(...args) };
  },
}));
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) {
      mocks.openaiConstructor(options);
    }
    chat = { completions: { create: (...args: unknown[]) => mocks.openaiCreate(...args) } };
    responses = { create: (...args: unknown[]) => mocks.openaiCreate(...args) };
  },
}));
vi.mock("../services/agent-client.js", () => ({ AgentClient: class {} }));
vi.mock("../services/agent-global-concurrency.service.js", () => ({
  acquireGlobalAgentSlot: async () => () => {},
}));
vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: { register: () => {}, unregister: () => {} },
}));
vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: async () => ({ key: "test-sdk-key", keyId: "test-key", source: "env" }),
  clearLimitHit: async () => {},
  recordLimitHit: async () => {},
  ENV_FALLBACK_KEY_ID: "test-key",
}));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    runWrite: async (fn: (db: unknown) => Promise<unknown>) => fn({ execute: async () => 1 }),
  },
  TaskStoreService: class {},
}));
vi.mock("../services/governance-source-hashes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/governance-source-hashes.js")>()),
  readGovernanceSourceHashes: async () => ({}),
  assertGovernanceSensitiveSourceApproval: async () => {},
  governanceSensitiveSourcePaths: () => [],
  resolveGovernanceCandidateSensitiveSourcePaths: async (_input: { changedPaths: string[] }) => [],
  resolveGovernanceSensitiveSourcePaths: async () => [],
}));
vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: async () => "live instructions",
}));

import {
  GovernanceExecutionService,
  governanceCodeSnapshot,
} from "../services/governance-execution.service.js";
import { agentProcessEnvironment } from "../utils/agent-process-env.js";
const exec = promisify(execFile);
let repo: string, pin: GovernanceTaskPin, release: PolicyRelease, finding: StructuredReviewFinding;
let cases: ReviewCase[];
const service = new GovernanceExecutionService();
const appeal: ReviewAppeal = {
  findingId: "f1",
  requestedException: "Read-only diagnostic",
  alternatives: ["Repository API lacks diagnostic metadata"],
  whyCompliantOptionsFail: "Cannot express metadata retrieval",
  tests: ["Read-only invariant verified"],
  risks: ["Storage coupling"],
  proposedLimits: ["Only diagnostic.ts"],
};
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.guidance.mockReturnValue([]);
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "governance-execution-"));
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await fs.mkdir(path.join(repo, "src"));
  await fs.writeFile(path.join(repo, "src/diagnostic.ts"), "export const diagnostic = 0;\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"],
    { cwd: repo }
  );
  const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await fs.writeFile(path.join(repo, "src/diagnostic.ts"), "export const diagnostic = 1;\n");
  await exec("git", ["commit", "-am", "diagnostic"], { cwd: repo });
  const code = await governanceCodeSnapshot(repo, baseSha);
  pin = {
    projectId: "project",
    taskId: "os-test",
    releaseId: "release",
    mode: "enforced",
    baseSha,
    trustedScope: "Diagnostic",
    instructionsByRole: {
      coder: "frozen coder",
      reviewer: "frozen reviewer",
      judge: "frozen judge",
    },
    worktreePath: repo,
    branchName: "main",
    createdAt: new Date().toISOString(),
  };
  release = {
    id: "release",
    projectId: "project",
    rules: [
      {
        id: "repository@1",
        ruleId: "repository",
        revision: 1,
        text: "Use repository",
        rationale: "Consistency",
        owner: "Owner",
        paths: ["src/**"],
        components: [],
        roles: [],
        severity: "standard",
        mandatory: false,
        exceptionEligible: true,
        examples: { compliant: [], noncompliant: [] },
        parentIds: [],
        overrideIds: [],
        conflictIds: [],
        layer: 1,
        sourceHash: "rulehash",
      },
    ],
    instructions: pin.instructionsByRole,
    sourceHashes: {},
    contentHash: "releasehash",
    enforcementRevision: baseSha,
    createdAt: pin.createdAt,
    createdBy: "Owner",
  };
  finding = {
    id: "f1",
    category: "standard",
    ruleId: "repository",
    ruleRevisionId: "repository@1",
    file: "src/diagnostic.ts",
    codeRevision: code.headSha,
    evidence: "Direct storage access",
    severity: "blocking",
    suggestedRemedy: "Use repository",
    provenance: { reviewer: "Reviewer" },
  };
  cases = [];
  mocks.claimCaseJob.mockResolvedValue(true);
  mocks.getConfig.mockResolvedValue({
    mode: "enforced",
    version: 1,
    judgeAgent: { type: "openai", model: "test-model" },
    judgeTokenPricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    maxTokens: 100_000,
    maxCostUsd: 10,
    maxAppeals: 3,
    maxElapsedMs: 90_000,
    contextMaxChars: 100_000,
  });
  mocks.getTaskPin.mockResolvedValue(pin);
  mocks.getRelease.mockResolvedValue(release);
  mocks.refreshContext.mockResolvedValue({
    content: "pinned rule",
    receipt: {
      releaseId: "release",
      role: "reviewer",
      changedPaths: code.changedPaths,
      selected: [{ id: "repository@1", ruleId: "repository", sourceHash: "rulehash" }],
      excluded: [],
      conflicts: [],
      truncated: false,
      contentHash: "receipt",
    },
  });
  mocks.getTrustedScope.mockResolvedValue("Diagnostic");
  mocks.getGrantedScope.mockResolvedValue("Diagnostic");
  mocks.getApprovedSourceHashes.mockImplementation(
    async (_project: string, r: PolicyRelease) => r.sourceHashes
  );
  mocks.getTaskCases.mockImplementation(async () => cases);
  mocks.listCases.mockImplementation(async () => cases);
  mocks.listDecisions.mockResolvedValue([]);
  mocks.findPrecedent.mockResolvedValue([]);
  mocks.getBudgetUsage.mockResolvedValue({ tokens: 0, costUsd: 0, elapsedMs: 0, appeals: 0 });
  mocks.getPromptSnapshots.mockResolvedValue([
    { payload: { prompt: "full original coder prompt" } },
  ]);
  mocks.openCase.mockImplementation(async (input) => {
    const existing = cases.find((c) => c.evidence.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const c = {
      ...input,
      id: `case-${cases.length}`,
      version: 1,
      evidenceHash: "evidencehash",
      createdAt: pin.createdAt,
      updatedAt: pin.createdAt,
      evidence: { ...input.evidence, idempotencyKey: input.idempotencyKey },
    } as ReviewCase;
    cases.push(c);
    return c;
  });
  mocks.recordRecommendation.mockImplementation(async (_projectId, id, recommendation, version) => {
    const c = cases.find((c) => c.id === id)!;
    if (c.version !== version) throw new Error("Stale recommendation");
    Object.assign(c, { recommendation, state: "awaiting_human", version: version + 1 });
    return c;
  });
  mocks.recordReconsideration.mockImplementation(async (_projectId, id, result, version) => {
    const c = cases.find((c) => c.id === id)!;
    Object.assign(c, {
      state: "awaiting_judge",
      version: version + 1,
      evidence: { ...c.evidence, reconsideration: result },
    });
    return c;
  });
  mocks.invoke.mockImplementation(async (input) => {
    if (input.role === "reviewer") {
      expect(cases[0].state).toBe("awaiting_reconsideration");
      return {
        content: JSON.stringify({
          status: "rejected",
          summary: "Finding upheld",
          findings: [finding],
          withdrawnFindingIds: [],
          notes: "Appeal reconsidered",
        }),
      };
    }
    expect(cases[0].state).toBe("awaiting_judge");
    return {
      content: JSON.stringify({
        disposition: "human_required",
        rationale: "Novel exception",
        evidence: ["Direct storage access"],
        ruleIds: ["repository"],
        decisionIds: [],
      }),
    };
  });
});
afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});
function reject(appeals: ReviewAppeal[] = []) {
  return service.rejected({
    projectId: pin.projectId,
    taskId: pin.taskId,
    cwd: repo,
    title: "Diagnostic",
    result: { status: "rejected", summary: "Repository standard", findings: [finding], notes: "" },
    appeals,
    reviewOutput: "Full review log",
    reviewerAgent: { type: "openai", model: "test-model", cliCommand: null },
  });
}

describe("re-review, budgets and reviewer output", () => {
  const ruled = (over: Partial<ReviewCase> = {}) =>
    ({
      id: "allowed-case",
      state: "allowed",
      headSha: finding.codeRevision,
      releaseId: release.id,
      findings: [finding],
      evidence: {},
      ...over,
    }) as ReviewCase;
  const snapshot = () => governanceCodeSnapshot(repo, pin.baseSha, "HEAD", false, undefined);
  it("W2: a reworded finding on the same rule and file stays allowed for the same code", async () => {
    const { diffHash } = await snapshot();
    cases = [ruled({ diffHash })];
    mocks.listDecisions.mockResolvedValue([
      { caseId: "allowed-case", action: "allow_once", conditions: undefined },
    ]);
    finding = { ...finding, id: "other", evidence: "Reworded by the second reviewer" };
    expect(await reject()).toMatchObject({ waiting: false, authorized: true });
    expect(mocks.openCase).not.toHaveBeenCalled();
  });
  it("W2: a revoked ruling is not carried into re-review or the prompt", async () => {
    const { diffHash } = await snapshot();
    cases = [ruled({ diffHash })];
    mocks.listDecisions.mockResolvedValue([
      { caseId: "allowed-case", action: "allow_once", revokedAt: "now" },
    ]);
    expect(await service.validRulings("project", pin.taskId, repo)).toBe("");
    expect((await reject()).authorized).toBeUndefined();
  });
  it("W2: valid rulings reach the resumed reviewer's prompt", async () => {
    const { diffHash } = await snapshot();
    cases = [ruled({ diffHash })];
    mocks.listDecisions.mockResolvedValue([{ caseId: "allowed-case", action: "allow_once" }]);
    const text = await service.validRulings("project", pin.taskId, repo);
    expect(text).toContain("repository@1");
    expect(text).toContain("src/diagnostic.ts");
  });
  it("W3: three default appeals fit the budget once usage is reconciled, despite a huge case", async () => {
    let tokens = 0;
    mocks.getConfig.mockResolvedValue({
      mode: "enforced",
      version: 1,
      judgeAgent: { type: "openai", model: "test-model" },
      judgeTokenPricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      maxTokens: 100_000,
      maxCostUsd: 10,
      maxAppeals: 3,
      maxElapsedMs: 1_800_000,
      contextMaxChars: 100_000,
    });
    mocks.consumeBudget.mockImplementation(async (_p, _t, usage: { tokens: number }) => {
      if (tokens + usage.tokens > 100_000) throw new Error("Budget exhausted");
      tokens += usage.tokens;
    });
    mocks.settleBudget.mockImplementation(async (_p, _t, refund: { tokens: number }) => {
      tokens -= refund.tokens;
    });
    mocks.invoke.mockImplementation(async (input) => ({
      cacheMetrics: {
        inputTokens: Math.ceil(input.messages[0].content.length / 4),
        outputTokens: 200,
      },
      content: JSON.stringify(
        input.role === "reviewer"
          ? { status: "rejected", summary: "Upheld", findings: [finding], notes: "" }
          : {
              disposition: "human_required",
              rationale: "Novel",
              evidence: ["e"],
              ruleIds: ["repository"],
              decisionIds: [],
            }
      ),
    }));
    for (let cycle = 0; cycle < 3; cycle++) {
      await fs.writeFile(
        path.join(repo, "src/diagnostic.ts"),
        `export const diagnostic = ${cycle + 2}; // ${"x".repeat(300_000)}\n`
      );
      await exec("git", ["commit", "-am", `cycle ${cycle}`], { cwd: repo });
      finding = {
        ...finding,
        codeRevision: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
      };
      mocks.getPromptSnapshots.mockResolvedValue([{ payload: { prompt: "p".repeat(500_000) } }]);
      const outcome = await reject([appeal]);
      expect(outcome.case?.recommendation?.rationale).toBe("Novel");
    }
    expect(mocks.invoke).toHaveBeenCalledTimes(6);
  });
  it("W3: the prompt carries the applicable rules and a capped diff, not stored evidence", async () => {
    mocks.getPromptSnapshots.mockResolvedValue([{ payload: { prompt: "secret-prompt" } }]);
    await reject([appeal]);
    const prompt = mocks.invoke.mock.calls[0]?.[0].messages[0].content as string;
    expect(prompt).not.toContain("secret-prompt");
    expect(JSON.parse(prompt).rules.map((r: { id: string }) => r.id)).toEqual(["repository@1"]);
    expect(JSON.parse(prompt).case.diff).toContain("diagnostic");
  });
  it("W4: a judge result arriving after the case moved is discarded, not a crash", async () => {
    mocks.getCase.mockImplementation(async () => cases[0]);
    mocks.recordRecommendation.mockImplementation(async () => {
      throw Object.assign(new Error("Late judge result"), { code: "GOVERNANCE_STALE_VERSION" });
    });
    expect(await reject([appeal])).toMatchObject({ waiting: true });
    expect(mocks.applyVerifiedDisposition).not.toHaveBeenCalled();
  });
  const rejectPlain = () =>
    service.rejected({
      projectId: pin.projectId,
      taskId: pin.taskId,
      cwd: repo,
      title: "T",
      result: { status: "rejected", summary: "No", issues: ["Tests are missing"], notes: "" },
      appeals: [],
      reviewOutput: "log",
    });
  it("W5: an unstructured enforced rejection becomes a fix request with its raw issues", async () => {
    expect(await rejectPlain()).toMatchObject({ waiting: false, case: { state: "fix_required" } });
    expect(cases[0]?.findings[0]).toMatchObject({
      category: "defect",
      severity: "blocking",
      evidence: "Tests are missing",
    });
  });
  it("W5: a defect in an unchanged file is recorded", async () => {
    finding = {
      ...finding,
      category: "defect",
      ruleId: undefined,
      ruleRevisionId: undefined,
      file: "src/untouched.ts",
    };
    expect(await reject()).toMatchObject({ case: { state: "fix_required" } });
  });
  it("W6: an unstructured shadow rejection falls back to ordinary review with an audit", async () => {
    mocks.getConfig.mockResolvedValue({ mode: "shadow", version: 1 });
    mocks.getTaskPin.mockResolvedValue({ ...pin, mode: "shadow" });
    expect(await rejectPlain()).toEqual({ waiting: false });
    expect(mocks.openCase).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      "project",
      "shadow_unstructured_review",
      "system",
      expect.objectContaining({ taskId: pin.taskId })
    );
  });
  it("W6: shadow admission records drift, while enforced admission refuses it", async () => {
    release.sourceHashes = { "AGENTS.md": "approved" };
    mocks.getActiveRelease.mockResolvedValue(release);
    mocks.getTaskPin.mockResolvedValue(null);
    mocks.pinTask.mockResolvedValue(pin);
    const prepare = () =>
      service.prepareTask({
        projectId: "project",
        taskId: pin.taskId,
        repoPath: repo,
        worktreePath: repo,
        branchName: "main",
        baseSha: pin.baseSha,
        trustedScope: "",
        settings: { reviewMode: "always" } as never,
      });
    await expect(prepare()).rejects.toThrow("source drift");
    mocks.getConfig.mockResolvedValue({ mode: "shadow", version: 1 });
    await expect(prepare()).resolves.toBe(pin);
    expect(mocks.audit).toHaveBeenCalledWith(
      "project",
      "shadow_policy_drift",
      "system",
      expect.objectContaining({ taskId: pin.taskId })
    );
  });
  it("A2: enforcement reaches a shadow pin at publication", async () => {
    mocks.getTaskPinsForBranch.mockResolvedValue([{ ...pin, mode: "shadow" }]);
    mocks.getReviewApproval.mockResolvedValue(null);
    await expect(
      service.assertPublicationAuthority({
        projectId: "project",
        taskId: pin.taskId,
        repoPath: repo,
        branchName: "main",
      })
    ).rejects.toThrow("no current durable code approval");
  });
  it("A2: a pinless task cannot publish in enforced mode", async () => {
    mocks.getTaskPinsForBranch.mockResolvedValue([]);
    await expect(
      service.assertPublicationAuthority({
        projectId: "project",
        taskId: pin.taskId,
        repoPath: repo,
        branchName: "main",
      })
    ).rejects.toMatchObject({ code: "GOVERNANCE_NOT_PINNED" });
  });
});

describe("governance execution", () => {
  it("retains complete evidence and commits independently before a fix retry", async () => {
    const guidance = [
      { role: "user", status: "included", content: "Retained live clarification", attempt: 1 },
    ];
    mocks.guidance.mockReturnValue(guidance);
    expect(await reject()).toMatchObject({ waiting: false, case: { state: "fix_required" } });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(cases[0].evidence.diff).toContain("diagnostic = 1");
    expect(cases[0].evidence.guidance).toEqual(guidance);
    expect(cases[0].evidence.prompts).toEqual([
      { payload: { prompt: "full original coder prompt" } },
    ]);
    const refs = cases[0].evidence.retentionRefs as { base: string; head: string };
    expect((await exec("git", ["rev-parse", refs.base], { cwd: repo })).stdout.trim()).toBe(
      pin.baseSha
    );
    expect((await exec("git", ["rev-parse", refs.head], { cwd: repo })).stdout.trim()).toBe(
      finding.codeRevision
    );
  });
  it("persists the case before a bounded, tool-free judge call and does not repeat it", async () => {
    expect(await reject([appeal])).toMatchObject({
      waiting: true,
      case: { state: "awaiting_human" },
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "judge",
        maxOutputTokens: 2048,
        abortSignal: expect.any(AbortSignal),
      })
    );
    expect(mocks.consumeBudget).toHaveBeenCalledWith(
      "project",
      "os-test",
      // A per-call share of maxElapsedMs allows both calls of all three default appeals.
      expect.objectContaining({ appeals: 1, elapsedMs: 15_000, costUsd: expect.any(Number) })
    );
    expect(await reject([appeal])).toMatchObject({ waiting: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.recordReconsideration).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewApproval).not.toHaveBeenCalled();
  });
  it("runs separately configured API reconsideration and judge after initial CLI review through the actual SDK adapters", async () => {
    const config = await mocks.getConfig();
    config.reconsiderationAgent = {
      type: "claude",
      model: "reconsideration-model",
      cliCommand: null,
    };
    config.reconsiderationTokenPricing = { inputPerMillionUsd: 3, outputPerMillionUsd: 5 };
    mocks.anthropicStream.mockImplementation((request, options) => {
      expect(cases[0].state).toBe("awaiting_reconsideration");
      expect(request).toMatchObject({ model: "reconsideration-model", max_tokens: 2048 });
      expect(request).not.toHaveProperty("tools");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return {
        finalMessage: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "rejected",
                summary: "Finding upheld",
                findings: [finding],
                withdrawnFindingIds: [],
                notes: "Appeal reconsidered",
              }),
            },
          ],
        }),
      };
    });
    mocks.openaiCreate.mockImplementation(async (request, options) => {
      expect(cases[0].state).toBe("awaiting_judge");
      expect(request).toMatchObject({ model: "test-model", max_tokens: 2048 });
      expect(request).not.toHaveProperty("tools");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                disposition: "human_required",
                rationale: "Novel diagnostic exception",
                evidence: ["Direct storage access"],
                ruleIds: ["repository"],
                decisionIds: [],
              }),
            },
          },
        ],
      };
    });
    const actual = await vi.importActual<typeof import("../services/agent.service.js")>(
      "../services/agent.service.js"
    );
    mocks.invoke.mockImplementation((options) => actual.agentService.invokePlanningAgent(options));
    const result = await service.rejected({
      projectId: pin.projectId,
      taskId: pin.taskId,
      cwd: repo,
      title: "Diagnostic",
      result: { status: "rejected", summary: "Standard", findings: [finding], notes: "" },
      appeals: [appeal],
      reviewOutput: "retained",
      reviewerAgent: { type: "claude-cli", model: "initial-cli-model", cliCommand: null },
    });
    expect(result).toMatchObject({ waiting: true, case: { state: "awaiting_human" } });
    expect(mocks.anthropicStream).toHaveBeenCalledTimes(1);
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(1);
    expect(mocks.anthropicConstructor).toHaveBeenCalledWith({
      apiKey: "test-sdk-key",
      maxRetries: 0,
    });
    expect(mocks.openaiConstructor).toHaveBeenCalledWith({ apiKey: "test-sdk-key", maxRetries: 0 });
    const reservations = mocks.consumeBudget.mock.calls.map((call) => call[2]);
    const calls = mocks.invoke.mock.calls.map((call) => call[0]);
    expect(calls.map((call) => [call.role, call.config.type, call.config.model])).toEqual([
      ["reviewer", "claude", "reconsideration-model"],
      ["judge", "openai", "test-model"],
    ]);
    expect(reservations).toHaveLength(2);
    expect(reservations.map((value) => value.appeals)).toEqual([1, 0]);
    for (let i = 0; i < 2; i++) {
      const inputTokens = Buffer.byteLength(
        calls[i].systemPrompt + calls[i].messages[0].content,
        "utf8"
      );
      const prices = i === 0 ? config.reconsiderationTokenPricing : config.judgeTokenPricing;
      expect(reservations[i]).toMatchObject({ tokens: inputTokens + 2048, elapsedMs: 15_000 });
      expect(reservations[i].costUsd).toBe(
        (inputTokens * prices.inputPerMillionUsd + 2048 * prices.outputPerMillionUsd) / 1_000_000
      );
    }
  });
  it("requires a human for a different initial API reviewer without separate reconsideration authority", async () => {
    const result = await service.rejected({
      projectId: pin.projectId,
      taskId: pin.taskId,
      cwd: repo,
      title: "Diagnostic",
      result: { status: "rejected", summary: "Standard", findings: [finding], notes: "" },
      appeals: [appeal],
      reviewOutput: "retained",
      reviewerAgent: { type: "claude", model: "different-reviewer-model", cliCommand: null },
    });
    expect(result).toMatchObject({
      waiting: true,
      case: {
        recommendation: {
          disposition: "human_required",
          rationale: expect.stringContaining(
            "Configure a separate read-only API reconsideration model"
          ),
        },
      },
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.consumeBudget).not.toHaveBeenCalled();
  });
  it("does not borrow judge prices for an explicit reconsideration model with missing prices", async () => {
    const config = await mocks.getConfig();
    config.reconsiderationAgent = { type: "claude", model: "reviewer-model", cliCommand: null };
    expect(await reject([appeal])).toMatchObject({
      waiting: true,
      case: {
        recommendation: {
          rationale: expect.stringContaining("reconsideration input/output price ceilings"),
        },
      },
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.consumeBudget).not.toHaveBeenCalled();
  });
  it("requires human attention when pricing or an API judge is unavailable", async () => {
    const config = await mocks.getConfig();
    delete config.judgeTokenPricing;
    expect(await reject([appeal])).toMatchObject({
      waiting: true,
      case: { recommendation: { disposition: "human_required" } },
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("reassociates an appeal to a prior aggregate ID after independent reviewers rename their local IDs", async () => {
    await reject();
    const canonical = cases[0]!.findings[0]!.id;
    finding.id = "reviewer-renamed-local-id";
    mocks.claimCaseJob.mockResolvedValue(false);
    await reject([{ ...appeal, findingId: canonical }]);
    expect(mocks.openCase).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "awaiting_reconsideration",
        appeals: [expect.objectContaining({ findingId: canonical })],
      })
    );
  });
  it("does not apply an ambiguous angle-local appeal to two distinct standards blockers", async () => {
    mocks.claimCaseJob.mockResolvedValue(false);
    await service.rejected({
      projectId: pin.projectId,
      taskId: pin.taskId,
      cwd: repo,
      title: "Diagnostic",
      result: {
        status: "rejected",
        summary: "Two findings",
        notes: "",
        findings: [finding, { ...finding, evidence: "A second raw query" }],
      },
      appeals: [appeal],
      reviewOutput: "retained",
    });
    expect(cases[0]!.findings).toHaveLength(2);
    expect(cases[0]!.appeals).toEqual([]);
    expect(cases[0]!.state).toBe("fix_required");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("cannot appeal away a real defect reported by another review angle", async () => {
    finding.category = "defect";
    expect(await reject([appeal])).toMatchObject({
      waiting: false,
      case: { state: "fix_required" },
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("rejects stale code anchors before opening a case", async () => {
    finding.codeRevision = pin.baseSha;
    await expect(reject([appeal])).rejects.toThrow("reviewed code revision");
    expect(mocks.openCase).not.toHaveBeenCalled();
  });
  it("does not authorize a protected-path change from mutable task wording", async () => {
    await expect(
      service.assertScope("project", "os-test", ["packages/backend/src/routes/oauth.ts"])
    ).rejects.toThrow("Protected path authorization failed");
    // Enforced mode takes structured human grants; a sentence containing the word grants nothing.
    mocks.getGrantedScope.mockResolvedValue("Explicit OAuth integration task");
    await expect(
      service.assertScope("project", "os-test", ["packages/backend/src/routes/oauth.ts"])
    ).rejects.toThrow("Protected path authorization failed");
    mocks.getGrantedScope.mockResolvedValue("oauth");
    await expect(
      service.assertScope("project", "os-test", ["packages/backend/src/routes/oauth.ts"])
    ).resolves.toBeUndefined();
  });
  it("withholds approval when mandatory governing context cannot fit", async () => {
    const context = await mocks.refreshContext();
    context.receipt.truncated = true;
    await expect(service.approved("project", "os-test", repo)).rejects.toThrow(
      "incomplete or conflicted"
    );
    expect(mocks.recordReviewApproval).not.toHaveBeenCalled();
  });
  it("does not inherit human credentials into agent or command environments", () => {
    const source = {
      PATH: "/bin",
      OPENAI_API_KEY: "task",
      OPENSPRINT_GOVERNANCE_APPROVAL_SECRET: "human",
      OPENSPRINT_GOVERNANCE_OWNER: "Owner",
    };
    expect(agentProcessEnvironment(source)).toEqual({ PATH: "/bin", OPENAI_API_KEY: "task" });
    expect(source.OPENSPRINT_GOVERNANCE_APPROVAL_SECRET).toBe("human");
  });
});

it("audits each epic child contribution and detects later merger edits", async () => {
  const baseline = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await exec("git", ["checkout", "-b", "epic"], { cwd: repo });
  await fs.mkdir(path.join(repo, "src/routes"));
  await fs.writeFile(
    path.join(repo, "src/routes/integrations-example.ts"),
    "export const integration = true;\n"
  );
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "integration child"], { cwd: repo });
  const childOne = await governanceCodeSnapshot(repo, baseline);
  const pinOne = { ...pin, taskId: "integration-child", branchName: "epic", baseSha: baseline };
  await fs.writeFile(path.join(repo, "src/unrelated.ts"), "export const unrelated = true;\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "ordinary child"], { cwd: repo });
  const childTwo = await governanceCodeSnapshot(repo, childOne.headSha);
  const pinTwo = {
    ...pin,
    taskId: "ordinary-child",
    branchName: "epic",
    baseSha: childOne.headSha,
  };
  mocks.getTaskPinsForBranch.mockResolvedValue([pinOne, pinTwo]);
  mocks.getReviewApproval.mockImplementation(async (_project, id) => ({
    headSha: id === pinOne.taskId ? childOne.headSha : childTwo.headSha,
    diffHash: id === pinOne.taskId ? childOne.diffHash : childTwo.diffHash,
    releaseId: pin.releaseId,
  }));
  mocks.getGrantedScope.mockImplementation(async (_project, id) =>
    id === pinOne.taskId ? "integration" : ""
  );
  await exec("git", ["checkout", "main"], { cwd: repo });
  await exec("git", ["merge", "--no-commit", "--no-ff", "epic"], { cwd: repo });
  const input = {
    projectId: pin.projectId,
    taskId: pinTwo.taskId,
    repoPath: repo,
    candidatePath: repo,
    branchName: "epic",
    baseBranch: "main",
  };
  await expect(service.assertPublication(input)).resolves.toBeUndefined();
  await fs.writeFile(
    path.join(repo, "src/routes/integrations-example.ts"),
    "export const integration = 'merger changed this';\n"
  );
  await expect(service.assertPublication(input)).rejects.toThrow("re-review required");
});

it("keeps task scope separate from upstream protected changes after a real rebase", async () => {
  await exec("git", ["branch", "task"], { cwd: repo });
  await exec("git", ["reset", "--hard", pin.baseSha], { cwd: repo });
  await fs.mkdir(path.join(repo, "src/routes"));
  await fs.writeFile(
    path.join(repo, "src/routes/integrations-upstream.ts"),
    "export const upstream = true;\n"
  );
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "independent upstream integration"], { cwd: repo });
  await exec("git", ["checkout", "task"], { cwd: repo });
  await exec("git", ["rebase", "main"], { cwd: repo });
  const snapshot = await governanceCodeSnapshot(repo, pin.baseSha, "HEAD", false, "main");
  expect(snapshot.changedPaths).toEqual(["src/diagnostic.ts"]);
  expect(snapshot.diff).toContain("integrations-upstream.ts");
  await expect(
    service.assertScope(pin.projectId, pin.taskId, snapshot.changedPaths)
  ).resolves.toBeUndefined();
});
