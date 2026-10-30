import { describe, it, expect } from "vitest";
import { MAX_TOTAL_CONCURRENT_AGENTS_CAP } from "../constants/index.js";
import {
  DEFAULT_HIL_CONFIG,
  DEFAULT_DATABASE_URL,
  getAgentForComplexity,
  getAgentForPlanningRole,
  parseSettings,
  getDefaultDeploymentTarget,
  getDeploymentTargetConfig,
  getTargetsForDeployEvent,
  getTargetsForNightlyDeploy,
  getDeploymentTargetsForUi,
  mergeDeploymentConfigPatch,
  deploymentConfigForApiResponse,
  API_KEY_PROVIDERS,
  validateApiKeyEntry,
  getDatabaseDialect,
  validateDatabaseUrl,
  maskDatabaseUrl,
  isLocalDatabaseUrl,
  sanitizeApiKeys,
  mergeApiKeysWithCurrent,
  isLimitHitExpired,
  maskApiKeysForResponse,
  getProvidersInUse,
  getProvidersRequiringApiKeys,
  getProviderForAgentType,
  VALID_SELF_IMPROVEMENT_FREQUENCIES,
  SELF_IMPROVEMENT_FREQUENCY_OPTIONS,
  projectStoredDefinesSimpleAgent,
  projectStoredDefinesComplexAgent,
  applyGlobalAgentDefaultsToRawRecord,
  omitInheritedAgentTiersForStore,
  getSelfImprovementReviewerAgents,
  getSelfImprovementReviewAngles,
  getSelfImprovementIncludeGeneralReview,
  parsePreferredEditor,
  VALID_PREFERRED_EDITORS,
  maskTodoistOAuthForResponse,
  parseTodoistOAuthCredentials,
} from "../types/settings.ts";
import type {
  ProjectSettings,
  AgentConfig,
  DeploymentConfig,
  ApiKeys,
  SelfImprovementFrequency,
  ReviewAngle,
} from "../types/settings.ts";

const defaultAgent: AgentConfig = { type: "claude", model: "claude-sonnet-4", cliCommand: null };
const highAgent: AgentConfig = { type: "claude", model: "claude-opus-5", cliCommand: null };
const lowAgent: AgentConfig = { type: "cursor", model: "fast-model", cliCommand: null };

describe("projectStoredDefinesSimpleAgent / projectStoredDefinesComplexAgent", () => {
  it("detects new and legacy simple-tier keys", () => {
    expect(
      projectStoredDefinesSimpleAgent({
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      })
    ).toBe(true);
    expect(
      projectStoredDefinesSimpleAgent({
        lowComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      })
    ).toBe(true);
    expect(projectStoredDefinesSimpleAgent({ deployment: { mode: "custom" } })).toBe(false);
  });

  it("detects new and legacy complex-tier keys", () => {
    expect(
      projectStoredDefinesComplexAgent({
        complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      })
    ).toBe(true);
    expect(
      projectStoredDefinesComplexAgent({
        highComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      })
    ).toBe(true);
    expect(projectStoredDefinesComplexAgent({})).toBe(false);
  });
});

describe("applyGlobalAgentDefaultsToRawRecord / omitInheritedAgentTiersForStore", () => {
  const gs = {
    simpleComplexityAgent: lowAgent,
    complexComplexityAgent: highAgent,
  };

  it("merges global agents only when project JSON omits that tier", () => {
    const merged = applyGlobalAgentDefaultsToRawRecord({ deployment: { mode: "custom" } }, gs);
    expect(merged.simpleComplexityAgent).toEqual(lowAgent);
    expect(merged.complexComplexityAgent).toEqual(highAgent);

    const withProjectSimple = applyGlobalAgentDefaultsToRawRecord(
      { simpleComplexityAgent: defaultAgent, deployment: { mode: "custom" } },
      gs
    );
    expect(withProjectSimple.simpleComplexityAgent).toEqual(defaultAgent);
    expect(withProjectSimple.complexComplexityAgent).toEqual(highAgent);
  });

  it("strips agent keys from a persisted object when raw had no override", () => {
    const persisted = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" as const },
    };
    const stripped = omitInheritedAgentTiersForStore(persisted, {
      deployment: { mode: "custom" },
    });
    expect(stripped.simpleComplexityAgent).toBeUndefined();
    expect(stripped.complexComplexityAgent).toBeUndefined();
    expect(stripped.deployment).toEqual({ mode: "custom" });
  });

  it("preserves agent keys in persisted object when raw defined that tier", () => {
    const raw = { simpleComplexityAgent: defaultAgent, deployment: { mode: "custom" } };
    const persisted = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" as const },
    };
    const stripped = omitInheritedAgentTiersForStore(persisted, raw);
    expect(stripped.simpleComplexityAgent).toEqual(lowAgent);
    expect(stripped.complexComplexityAgent).toBeUndefined();
  });
});

function makeSettings(overrides?: Partial<ProjectSettings>): ProjectSettings {
  return {
    simpleComplexityAgent: defaultAgent,
    complexComplexityAgent: defaultAgent,
    deployment: { mode: "custom" },
    hilConfig: DEFAULT_HIL_CONFIG,
    testFramework: null,
    gitWorkingMode: "worktree",
    ...overrides,
  };
}

describe("DEFAULT_HIL_CONFIG", () => {
  it("defaults all three categories to automated for new projects", () => {
    expect(DEFAULT_HIL_CONFIG.scopeChanges).toBe("automated");
    expect(DEFAULT_HIL_CONFIG.architectureDecisions).toBe("automated");
    expect(DEFAULT_HIL_CONFIG.dependencyModifications).toBe("automated");
  });
});

describe("getAgentForComplexity", () => {
  it("should return simpleComplexityAgent for low", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    expect(getAgentForComplexity(settings, "low")).toBe(lowAgent);
  });

  it("should return simpleComplexityAgent for medium", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    expect(getAgentForComplexity(settings, "medium")).toBe(lowAgent);
  });

  it("should return complexComplexityAgent for high", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    expect(getAgentForComplexity(settings, "high")).toBe(highAgent);
  });

  it("should return complexComplexityAgent for very_high", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    expect(getAgentForComplexity(settings, "very_high")).toBe(highAgent);
  });

  it("should return simpleComplexityAgent when complexity is undefined", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    expect(getAgentForComplexity(settings, undefined)).toBe(lowAgent);
  });
});

describe("getAgentForPlanningRole", () => {
  it("Dreamer always returns complexComplexityAgent", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    expect(getAgentForPlanningRole(settings, "dreamer")).toBe(highAgent);
    expect(getAgentForPlanningRole(settings, "dreamer", "low")).toBe(highAgent);
    expect(getAgentForPlanningRole(settings, "dreamer", "high")).toBe(highAgent);
  });

  it("Analyst always returns simpleComplexityAgent", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    expect(getAgentForPlanningRole(settings, "analyst")).toBe(lowAgent);
    expect(getAgentForPlanningRole(settings, "analyst", "high")).toBe(lowAgent);
    expect(getAgentForPlanningRole(settings, "analyst", "very_high")).toBe(lowAgent);
  });

  it("Planner/Harmonizer/Auditor/Summarizer inherit plan complexity", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    for (const role of ["planner", "harmonizer", "auditor", "summarizer"] as const) {
      expect(getAgentForPlanningRole(settings, role, "low")).toBe(lowAgent);
      expect(getAgentForPlanningRole(settings, role, "medium")).toBe(lowAgent);
      expect(getAgentForPlanningRole(settings, role, "high")).toBe(highAgent);
      expect(getAgentForPlanningRole(settings, role, "very_high")).toBe(highAgent);
      expect(getAgentForPlanningRole(settings, role, undefined)).toBe(lowAgent);
    }
  });
});

describe("parseSettings", () => {
  const defaultParsed = { type: "cursor", model: null, cliCommand: null };

  it("should pass through two-tier format unchanged", () => {
    const settings = makeSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
    });
    const parsed = parseSettings(settings);
    expect(parsed.simpleComplexityAgent).toBe(lowAgent);
    expect(parsed.complexComplexityAgent).toBe(highAgent);
  });

  it("should default both tiers when missing", () => {
    const parsed = parseSettings({});
    expect(parsed.simpleComplexityAgent).toEqual(defaultParsed);
    expect(parsed.complexComplexityAgent).toEqual(defaultParsed);
  });

  it("defaults enforceMergeGatesOnCodingSuccess to true unless explicitly false", () => {
    expect(parseSettings({}).enforceMergeGatesOnCodingSuccess).toBe(true);
    expect(
      parseSettings({ enforceMergeGatesOnCodingSuccess: false }).enforceMergeGatesOnCodingSuccess
    ).toBe(false);
  });

  it("should default gitWorkingMode to worktree when parseSettings receives empty object", () => {
    const parsed = parseSettings({});
    expect(parsed.gitWorkingMode).toBe("worktree");
  });

  it("should use provided simple/complex when present", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.simpleComplexityAgent).toEqual(lowAgent);
    expect(parsed.complexComplexityAgent).toEqual(highAgent);
  });

  it("should default gitWorkingMode to worktree when missing", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.gitWorkingMode).toBe("worktree");
  });

  it("should default gitWorkingMode to worktree when invalid", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      gitWorkingMode: "invalid",
    };
    const parsed = parseSettings(raw);
    expect(parsed.gitWorkingMode).toBe("worktree");
  });

  it("should preserve gitWorkingMode branches when valid", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      gitWorkingMode: "branches",
    };
    const parsed = parseSettings(raw);
    expect(parsed.gitWorkingMode).toBe("branches");
  });

  it("should preserve gitWorkingMode worktree when valid", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      gitWorkingMode: "worktree",
    };
    const parsed = parseSettings(raw);
    expect(parsed.gitWorkingMode).toBe("worktree");
  });

  it("should omit maxTotalConcurrentAgents when missing or invalid", () => {
    expect(parseSettings({}).maxTotalConcurrentAgents).toBeUndefined();
    const base = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    expect(
      parseSettings({ ...base, maxTotalConcurrentAgents: 0 }).maxTotalConcurrentAgents
    ).toBeUndefined();
    expect(
      parseSettings({ ...base, maxTotalConcurrentAgents: -1 }).maxTotalConcurrentAgents
    ).toBeUndefined();
  });

  it("should clamp maxTotalConcurrentAgents to 1..MAX_TOTAL_CONCURRENT_AGENTS_CAP", () => {
    const base = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    expect(parseSettings({ ...base, maxTotalConcurrentAgents: 3 }).maxTotalConcurrentAgents).toBe(
      3
    );
    expect(parseSettings({ ...base, maxTotalConcurrentAgents: 99 }).maxTotalConcurrentAgents).toBe(
      MAX_TOTAL_CONCURRENT_AGENTS_CAP
    );
  });

  it("should parse and preserve a valid toolchainProfile", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      toolchainProfile: {
        mergeQualityGateCommands: ["go test ./...", "golangci-lint run"],
        dependencyStrategy: "none",
        dependencyChangePathspecs: ["go.mod", "go.sum"],
        deterministicTestCommand: "go test ./...",
        deterministicTestEnv: { GOFLAGS: "-count=1" },
      },
    });
    expect(parsed.toolchainProfile).toEqual({
      mergeQualityGateCommands: ["go test ./...", "golangci-lint run"],
      dependencyStrategy: "none",
      dependencyChangePathspecs: ["go.mod", "go.sum"],
      deterministicTestCommand: "go test ./...",
      deterministicTestEnv: { GOFLAGS: "-count=1" },
    });
  });

  it("should parse toolchainProfile with npm_ci_worktree dependency strategy", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      toolchainProfile: {
        dependencyStrategy: "npm_ci_worktree",
      },
    });
    expect(parsed.toolchainProfile?.dependencyStrategy).toBe("npm_ci_worktree");
  });

  it("should parse and preserve valid reviewAngles", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      reviewAngles: ["security", "performance", "test_coverage"],
    };
    const parsed = parseSettings(raw);
    expect(parsed.reviewAngles).toEqual(["security", "performance", "test_coverage"]);
  });

  it("should filter invalid reviewAngles and return undefined when empty", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      reviewAngles: ["security", "invalid", "performance"],
    };
    const parsed = parseSettings(raw);
    expect(parsed.reviewAngles).toEqual(["security", "performance"]);
  });

  it("should return undefined for reviewAngles when array is empty", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      reviewAngles: [],
    };
    const parsed = parseSettings(raw);
    expect(parsed.reviewAngles).toBeUndefined();
  });

  it("should parse enableHumanTeammates (default false)", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    expect(parseSettings(raw).enableHumanTeammates).toBe(false);
    expect(parseSettings({ ...raw, enableHumanTeammates: true }).enableHumanTeammates).toBe(true);
    expect(parseSettings({ ...raw, enableHumanTeammates: false }).enableHumanTeammates).toBe(false);
  });

  it("should round-trip teamMembers through parseSettings", () => {
    const teamMembers = [
      { id: "alice-id", name: "Alice" },
      { id: "bob-id", name: "Bob" },
    ];
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      teamMembers,
    };
    const parsed = parseSettings(raw);
    expect(parsed.teamMembers).toEqual(teamMembers);
    const roundTripped = parseSettings(parsed);
    expect(roundTripped.teamMembers).toEqual(teamMembers);
  });

  it("should filter invalid teamMembers entries and trim id/name", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      teamMembers: [
        { id: "valid-id", name: "Valid" },
        { id: "", name: "Empty id" },
        { id: "no-name" },
        { name: "No id" },
        { id: "  trimmed  ", name: "  Trimmed Name  " },
        { id: "uuid-123", name: "" },
      ],
    };
    const parsed = parseSettings(raw);
    expect(parsed.teamMembers).toEqual([
      { id: "valid-id", name: "Valid" },
      { id: "no-name", name: "" },
      { id: "trimmed", name: "Trimmed Name" },
      { id: "uuid-123", name: "" },
    ]);
  });

  it("should return empty array for teamMembers when array is empty (explicit clear)", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      teamMembers: [],
    };
    const parsed = parseSettings(raw);
    expect(parsed.teamMembers).toEqual([]);
  });

  it("parses selfImprovementBehaviorVersions and history with optional ids", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      selfImprovementBehaviorVersions: [{ id: "  v1  ", promotedAt: " 2025-01-01T00:00:00Z " }],
      selfImprovementBehaviorHistory: [
        {
          timestamp: " 2025-01-02T00:00:00Z ",
          action: "approved" as const,
          behaviorVersionId: "  bv1  ",
          candidateId: "  c1  ",
        },
      ],
    };
    const parsed = parseSettings(raw);
    expect(parsed.selfImprovementBehaviorVersions).toEqual([
      { id: "v1", promotedAt: "2025-01-01T00:00:00Z" },
    ]);
    expect(parsed.selfImprovementBehaviorHistory).toEqual([
      {
        timestamp: "2025-01-02T00:00:00Z",
        action: "approved",
        behaviorVersionId: "bv1",
        candidateId: "c1",
      },
    ]);
  });

  it("should preserve a valid aiAutonomyLevel", () => {
    const parsed = parseSettings({
      aiAutonomyLevel: "major_only",
    });

    expect(parsed.aiAutonomyLevel).toBe("major_only");
  });

  describe("mergeStrategy", () => {
    it("should default to per_task when parseSettings receives empty object", () => {
      const parsed = parseSettings({});
      expect(parsed.mergeStrategy).toBe("per_task");
    });

    it("should yield per_epic when mergeStrategy is per_epic", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        mergeStrategy: "per_epic",
      });
      expect(parsed.mergeStrategy).toBe("per_epic");
    });

    it("should yield per_task when mergeStrategy is per_task", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        mergeStrategy: "per_task",
      });
      expect(parsed.mergeStrategy).toBe("per_task");
    });

    it("should normalize invalid mergeStrategy to per_task", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        mergeStrategy: "invalid",
      });
      expect(parsed.mergeStrategy).toBe("per_task");
    });

    it("should normalize non-string mergeStrategy to per_task", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        mergeStrategy: 123,
      });
      expect(parsed.mergeStrategy).toBe("per_task");
    });

    it("should default to per_task when mergeStrategy is missing", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
      });
      expect(parsed.mergeStrategy).toBe("per_task");
    });

    it("should preserve mergeStrategy on round-trip", () => {
      const withPerTask = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        mergeStrategy: "per_task",
      });
      expect(parseSettings(withPerTask).mergeStrategy).toBe("per_task");

      const withPerEpic = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        mergeStrategy: "per_epic",
      });
      expect(parseSettings(withPerEpic).mergeStrategy).toBe("per_epic");
    });
  });

  describe("worktreeBaseBranch", () => {
    it("should default to main when parseSettings receives empty object", () => {
      const parsed = parseSettings({});
      expect(parsed.worktreeBaseBranch).toBe("main");
    });

    it("should default to main when worktreeBaseBranch is empty string", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: "",
      });
      expect(parsed.worktreeBaseBranch).toBe("main");
    });

    it("should default to main when worktreeBaseBranch is whitespace only", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: "   ",
      });
      expect(parsed.worktreeBaseBranch).toBe("main");
    });

    it("should default to main when worktreeBaseBranch contains invalid chars (spaces)", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: "my branch",
      });
      expect(parsed.worktreeBaseBranch).toBe("main");
    });

    it("should default to main when worktreeBaseBranch contains invalid chars", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: "branch@name",
      });
      expect(parsed.worktreeBaseBranch).toBe("main");
    });

    it("should preserve valid worktreeBaseBranch main", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: "main",
      });
      expect(parsed.worktreeBaseBranch).toBe("main");
    });

    it("should preserve valid worktreeBaseBranch with slash", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: "release/1.0",
      });
      expect(parsed.worktreeBaseBranch).toBe("release/1.0");
    });

    it("should preserve valid worktreeBaseBranch with underscore, hyphen, dot", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: "feature_my-branch.v2",
      });
      expect(parsed.worktreeBaseBranch).toBe("feature_my-branch.v2");
    });

    it("should trim valid worktreeBaseBranch", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: "  develop  ",
      });
      expect(parsed.worktreeBaseBranch).toBe("develop");
    });

    it("should default to main when worktreeBaseBranch is not a string", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        worktreeBaseBranch: 123,
      });
      expect(parsed.worktreeBaseBranch).toBe("main");
    });
  });

  describe("selfImprovementFrequency", () => {
    it("VALID_SELF_IMPROVEMENT_FREQUENCIES contains never, after_each_plan, daily, weekly", () => {
      expect(VALID_SELF_IMPROVEMENT_FREQUENCIES).toEqual([
        "never",
        "after_each_plan",
        "daily",
        "weekly",
      ]);
    });

    it("SELF_IMPROVEMENT_FREQUENCY_OPTIONS has one option per frequency with labels", () => {
      expect(SELF_IMPROVEMENT_FREQUENCY_OPTIONS).toHaveLength(4);
      const values = SELF_IMPROVEMENT_FREQUENCY_OPTIONS.map((o) => o.value);
      expect(values).toEqual(VALID_SELF_IMPROVEMENT_FREQUENCIES);
      expect(SELF_IMPROVEMENT_FREQUENCY_OPTIONS.map((o) => o.label)).toEqual([
        "Never",
        "After each Plan",
        "Daily",
        "Weekly",
      ]);
    });

    it("should default to never when parseSettings receives empty object", () => {
      const parsed = parseSettings({});
      expect(parsed.selfImprovementFrequency).toBe("never");
    });

    it("should default to never when selfImprovementFrequency is missing", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
      });
      expect(parsed.selfImprovementFrequency).toBe("never");
    });

    it("should preserve valid selfImprovementFrequency values", () => {
      for (const freq of VALID_SELF_IMPROVEMENT_FREQUENCIES as SelfImprovementFrequency[]) {
        const parsed = parseSettings({
          simpleComplexityAgent: lowAgent,
          complexComplexityAgent: highAgent,
          selfImprovementFrequency: freq,
        });
        expect(parsed.selfImprovementFrequency).toBe(freq);
      }
    });

    it("should normalize invalid selfImprovementFrequency to never", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementFrequency: "invalid",
      });
      expect(parsed.selfImprovementFrequency).toBe("never");
    });

    it("should pass through selfImprovementLastRunAt and selfImprovementLastCommitSha when present", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementFrequency: "daily",
        selfImprovementLastRunAt: "2025-01-01T00:00:00Z",
        selfImprovementLastCommitSha: "abc123",
      });
      expect(parsed.selfImprovementFrequency).toBe("daily");
      expect(parsed.selfImprovementLastRunAt).toBe("2025-01-01T00:00:00Z");
      expect(parsed.selfImprovementLastCommitSha).toBe("abc123");
    });

    it("should leave selfImprovementLastRunAt and selfImprovementLastCommitSha undefined when missing or invalid", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementFrequency: "weekly",
        selfImprovementLastRunAt: "",
        selfImprovementLastCommitSha: 123,
      });
      expect(parsed.selfImprovementLastRunAt).toBeUndefined();
      expect(parsed.selfImprovementLastCommitSha).toBeUndefined();
    });
  });

  describe("autoExecutePlans", () => {
    it("should default to false when parseSettings receives empty object", () => {
      const parsed = parseSettings({});
      expect(parsed.autoExecutePlans).toBe(false);
    });

    it("should default to false when autoExecutePlans is missing", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
      });
      expect(parsed.autoExecutePlans).toBe(false);
    });

    it("should preserve true when autoExecutePlans is true", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        autoExecutePlans: true,
      });
      expect(parsed.autoExecutePlans).toBe(true);
    });

    it("should normalize non-boolean to false", () => {
      expect(
        parseSettings({
          simpleComplexityAgent: lowAgent,
          complexComplexityAgent: highAgent,
          autoExecutePlans: "yes",
        }).autoExecutePlans
      ).toBe(false);
      expect(
        parseSettings({
          simpleComplexityAgent: lowAgent,
          complexComplexityAgent: highAgent,
          autoExecutePlans: 1,
        }).autoExecutePlans
      ).toBe(false);
    });
  });

  describe("runAgentEnhancementExperiments", () => {
    it("should default to false when parseSettings receives empty object", () => {
      const parsed = parseSettings({});
      expect(parsed.runAgentEnhancementExperiments).toBe(false);
    });

    it("should default to false when runAgentEnhancementExperiments is missing", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
      });
      expect(parsed.runAgentEnhancementExperiments).toBe(false);
    });

    it("should preserve true when runAgentEnhancementExperiments is true", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        runAgentEnhancementExperiments: true,
      });
      expect(parsed.runAgentEnhancementExperiments).toBe(true);
    });

    it("should normalize non-boolean to false", () => {
      expect(
        parseSettings({
          simpleComplexityAgent: lowAgent,
          complexComplexityAgent: highAgent,
          runAgentEnhancementExperiments: "yes",
        }).runAgentEnhancementExperiments
      ).toBe(false);
      expect(
        parseSettings({
          simpleComplexityAgent: lowAgent,
          complexComplexityAgent: highAgent,
          runAgentEnhancementExperiments: 1,
        }).runAgentEnhancementExperiments
      ).toBe(false);
    });

    it("should round-trip runAgentEnhancementExperiments through parseSettings", () => {
      const raw = {
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        runAgentEnhancementExperiments: true,
      };
      const parsed = parseSettings(raw);
      expect(parsed.runAgentEnhancementExperiments).toBe(true);
      const roundTripped = parseSettings(parsed);
      expect(roundTripped.runAgentEnhancementExperiments).toBe(true);
    });
  });
});

describe("getDefaultDeploymentTarget", () => {
  it("returns first isDefault target when targets exist", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [
        { name: "staging", isDefault: false },
        { name: "production", isDefault: true },
      ],
    };
    expect(getDefaultDeploymentTarget(config)).toBe("production");
  });

  it("returns first target when no isDefault and targets exist", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [{ name: "staging" }, { name: "production" }],
    };
    expect(getDefaultDeploymentTarget(config)).toBe("staging");
  });

  it("returns config.target when no targets array", () => {
    const config: DeploymentConfig = { mode: "custom", target: "staging" };
    expect(getDefaultDeploymentTarget(config)).toBe("staging");
  });

  it("returns production when no targets and no target", () => {
    const config: DeploymentConfig = { mode: "custom" };
    expect(getDefaultDeploymentTarget(config)).toBe("production");
  });
});

describe("getDeploymentTargetConfig", () => {
  it("returns target config by name", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [
        { name: "staging", command: "echo staging" },
        { name: "production", webhookUrl: "https://example.com/deploy" },
      ],
    };
    expect(getDeploymentTargetConfig(config, "staging")).toMatchObject({
      name: "staging",
      command: "echo staging",
    });
    expect(getDeploymentTargetConfig(config, "production")).toMatchObject({
      name: "production",
      webhookUrl: "https://example.com/deploy",
    });
  });

  it("returns undefined when target not found", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [{ name: "staging" }],
    };
    expect(getDeploymentTargetConfig(config, "production")).toBeUndefined();
  });

  it("returns undefined when no targets", () => {
    const config: DeploymentConfig = { mode: "custom" };
    expect(getDeploymentTargetConfig(config, "staging")).toBeUndefined();
  });
});

describe("getTargetsForDeployEvent", () => {
  it("returns targets with matching autoDeployTrigger", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [
        { name: "staging", autoDeployTrigger: "each_task" },
        { name: "production", autoDeployTrigger: "each_epic" },
        { name: "preview", autoDeployTrigger: "each_task" },
      ],
    };
    expect(getTargetsForDeployEvent(config, "each_task")).toEqual(["staging", "preview"]);
    expect(getTargetsForDeployEvent(config, "each_epic")).toEqual(["production"]);
    expect(getTargetsForDeployEvent(config, "eval_resolution")).toEqual([]);
  });

  it("treats missing autoDeployTrigger as none", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [{ name: "staging" }, { name: "production", autoDeployTrigger: "each_task" }],
    };
    expect(getTargetsForDeployEvent(config, "each_task")).toEqual(["production"]);
    expect(getTargetsForDeployEvent(config, "each_epic")).toEqual([]);
  });

  it("returns empty array when no targets", () => {
    const config: DeploymentConfig = { mode: "custom" };
    expect(getTargetsForDeployEvent(config, "each_task")).toEqual([]);
    expect(getTargetsForDeployEvent(config, "each_epic")).toEqual([]);
    expect(getTargetsForDeployEvent(config, "eval_resolution")).toEqual([]);
  });

  it("returns empty array when targets is empty", () => {
    const config: DeploymentConfig = { mode: "custom", targets: [] };
    expect(getTargetsForDeployEvent(config, "each_task")).toEqual([]);
  });
});

describe("getTargetsForNightlyDeploy", () => {
  it("returns targets with autoDeployTrigger nightly", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [
        { name: "staging", autoDeployTrigger: "nightly" },
        { name: "production", autoDeployTrigger: "each_epic" },
        { name: "preview", autoDeployTrigger: "nightly" },
      ],
    };
    expect(getTargetsForNightlyDeploy(config)).toEqual(["staging", "preview"]);
  });

  it("returns empty array when no nightly targets", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [
        { name: "staging", autoDeployTrigger: "each_task" },
        { name: "production", autoDeployTrigger: "none" },
      ],
    };
    expect(getTargetsForNightlyDeploy(config)).toEqual([]);
  });

  it("returns empty array when targets is empty", () => {
    const config: DeploymentConfig = { mode: "custom", targets: [] };
    expect(getTargetsForNightlyDeploy(config)).toEqual([]);
  });

  it("returns empty array when targets are omitted", () => {
    const config: DeploymentConfig = { mode: "custom" };
    expect(getTargetsForNightlyDeploy(config)).toEqual([]);
  });
});

describe("parseSettings deployment migration", () => {
  it("migrates autoDeployOnEpicCompletion to default target autoDeployTrigger", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "custom",
        target: "production",
        autoDeployOnEpicCompletion: true,
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment).not.toHaveProperty("autoDeployOnEpicCompletion");
    expect(parsed.deployment.targets).toHaveLength(1);
    expect(parsed.deployment.targets?.[0]).toMatchObject({
      name: "production",
      autoDeployTrigger: "each_epic",
    });
  });

  it("migrates autoDeployOnEvalResolution to default target autoDeployTrigger", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "custom",
        target: "staging",
        autoDeployOnEvalResolution: true,
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment).not.toHaveProperty("autoDeployOnEvalResolution");
    expect(parsed.deployment.targets).toHaveLength(1);
    expect(parsed.deployment.targets?.[0]).toMatchObject({
      name: "staging",
      autoDeployTrigger: "eval_resolution",
    });
  });

  it("migrates both flags: autoDeployOnEpicCompletion takes precedence", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "custom",
        autoDeployOnEpicCompletion: true,
        autoDeployOnEvalResolution: true,
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment).not.toHaveProperty("autoDeployOnEpicCompletion");
    expect(parsed.deployment).not.toHaveProperty("autoDeployOnEvalResolution");
    expect(parsed.deployment.targets).toHaveLength(1);
    expect(parsed.deployment.targets?.[0]).toMatchObject({
      name: "production",
      autoDeployTrigger: "each_epic",
    });
  });

  it("migrates to existing default target in targets array", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "custom",
        targets: [
          { name: "staging", isDefault: false },
          { name: "production", isDefault: true, webhookUrl: "https://example.com" },
        ],
        autoDeployOnEpicCompletion: true,
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment.targets).toHaveLength(2);
    const prod = parsed.deployment.targets?.find((t) => t.name === "production");
    expect(prod).toMatchObject({
      name: "production",
      isDefault: true,
      webhookUrl: "https://example.com",
      autoDeployTrigger: "each_epic",
    });
  });

  it("does not add migration when legacy flags are false or absent", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment).not.toHaveProperty("autoDeployOnEpicCompletion");
    expect(parsed.deployment).not.toHaveProperty("autoDeployOnEvalResolution");
    expect(parsed.deployment.targets).toBeUndefined();
  });

  it("migrates top-level envVars into default target when targets exist", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "custom",
        envVars: { A: "1", B: "2" },
        targets: [{ name: "staging", isDefault: true }, { name: "production" }],
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment.targets).toHaveLength(2);
    const defaultTarget =
      parsed.deployment.targets?.find((t) => t.isDefault) ?? parsed.deployment.targets?.[0];
    expect(defaultTarget?.envVars).toEqual({ A: "1", B: "2" });
  });

  it("migrates top-level envVars into staging and production targets when no targets (Expo)", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "expo",
        envVars: { API_KEY: "secret" },
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment.targets).toHaveLength(2);
    const staging = parsed.deployment.targets?.find((t) => t.name === "staging");
    const production = parsed.deployment.targets?.find((t) => t.name === "production");
    expect(staging?.envVars).toEqual({ API_KEY: "secret" });
    expect(production?.envVars).toEqual({ API_KEY: "secret" });
  });

  it("accepts and persists easProjectId when mode is expo", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "expo",
        easProjectId: "abc123-eas-project-id",
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment.easProjectId).toBe("abc123-eas-project-id");
    expect(parsed.deployment.mode).toBe("expo");
  });

  it("migrates legacy expoConfig.projectId to easProjectId when mode is expo", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "expo",
        expoConfig: { projectId: "legacy-project-id", channel: "preview" },
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment.easProjectId).toBe("legacy-project-id");
    expect(parsed.deployment.expoConfig?.projectId).toBe("legacy-project-id");
  });

  it("prefers easProjectId over expoConfig.projectId when both present", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {
        mode: "expo",
        easProjectId: "new-eas-id",
        expoConfig: { projectId: "legacy-id", channel: "preview" },
      },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.deployment.easProjectId).toBe("new-eas-id");
  });
});

describe("getDeploymentTargetsForUi", () => {
  it("returns synthetic staging and production for expo mode with no targets", () => {
    const config: DeploymentConfig = { mode: "expo" };
    const targets = getDeploymentTargetsForUi(config);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ name: "staging", autoDeployTrigger: "none" });
    expect(targets[1]).toMatchObject({ name: "production", autoDeployTrigger: "none" });
  });

  it("returns targets array for custom mode", () => {
    const config: DeploymentConfig = {
      mode: "custom",
      targets: [
        { name: "staging", autoDeployTrigger: "each_task" },
        { name: "production", autoDeployTrigger: "none" },
      ],
    };
    const targets = getDeploymentTargetsForUi(config);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ name: "staging", autoDeployTrigger: "each_task" });
    expect(targets[1]).toMatchObject({ name: "production", autoDeployTrigger: "none" });
  });

  it("returns empty array for custom mode with no targets", () => {
    const config: DeploymentConfig = { mode: "custom" };
    const targets = getDeploymentTargetsForUi(config);
    expect(targets).toEqual([]);
  });

  it("returns synthetic expo targets when mode is expo and targets is an empty array", () => {
    const config: DeploymentConfig = { mode: "expo", targets: [] };
    const targets = getDeploymentTargetsForUi(config);
    expect(targets).toEqual([
      { name: "staging", autoDeployTrigger: "none" },
      { name: "production", autoDeployTrigger: "none" },
    ]);
  });
});

describe("mergeDeploymentConfigPatch / deploymentConfigForApiResponse", () => {
  it("preserves expoToken when patch omits it", () => {
    const current: DeploymentConfig = { mode: "expo", expoToken: "secret" };
    const merged = mergeDeploymentConfigPatch(current, { expoConfig: { channel: "preview" } });
    expect(merged.expoToken).toBe("secret");
    expect(merged.expoConfig).toEqual({ channel: "preview" });
  });

  it("clears expoToken when patch sets empty string", () => {
    const current: DeploymentConfig = { mode: "expo", expoToken: "secret" };
    const merged = mergeDeploymentConfigPatch(current, { expoToken: "" });
    expect(merged.expoToken).toBeUndefined();
  });

  it("drops expoToken when mode becomes custom", () => {
    const current: DeploymentConfig = { mode: "expo", expoToken: "secret" };
    const merged = mergeDeploymentConfigPatch(current, { mode: "custom" });
    expect(merged.mode).toBe("custom");
    expect(merged.expoToken).toBeUndefined();
  });

  it("redacts expoToken in API response", () => {
    const api = deploymentConfigForApiResponse({
      mode: "expo",
      expoToken: "tok",
    });
    expect(api.expoToken).toBeUndefined();
    expect(api.expoTokenConfigured).toBe(true);
  });
});

describe("parseSettings — deployment mode inference from Expo fields", () => {
  it("infers mode='expo' when mode is missing but easProjectId is present", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { easProjectId: "abc123" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    });
    expect(parsed.deployment.mode).toBe("expo");
    expect(parsed.deployment.easProjectId).toBe("abc123");
  });

  it("infers mode='expo' when mode is missing but expoConfig.projectId is present", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { expoConfig: { projectId: "proj-1" } },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    });
    expect(parsed.deployment.mode).toBe("expo");
  });

  it("infers mode='expo' when mode is missing but expoToken is present", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { expoToken: "my-token" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    });
    expect(parsed.deployment.mode).toBe("expo");
    expect(parsed.deployment.expoToken).toBe("my-token");
  });

  it("defaults to mode='custom' when mode and all Expo fields are missing", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: {},
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    });
    expect(parsed.deployment.mode).toBe("custom");
  });

  it("preserves explicit mode='expo' through round-trip", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "expo", expoConfig: { channel: "preview" } },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    });
    expect(parsed.deployment.mode).toBe("expo");

    const reparsed = parseSettings({
      ...parsed,
      deployment: parsed.deployment,
    });
    expect(reparsed.deployment.mode).toBe("expo");
  });

  it("preserves explicit mode='custom' even when Expo fields are present", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom", easProjectId: "abc123" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    });
    expect(parsed.deployment.mode).toBe("custom");
  });
});

describe("parseSettings validation timing helpers", () => {
  it("preserves valid timeout overrides and sanitizes timing samples", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      validationTimeoutMsOverride: 90_400,
      validationTimingProfile: {
        scoped: [1200.2, "bad", -5, Number.POSITIVE_INFINITY, 800],
        full: [5000.9, 3000.1],
        updatedAt: " 2026-03-18T00:00:00.000Z ",
      },
    });

    expect(parsed.validationTimeoutMsOverride).toBe(90_400);
    expect(parsed.validationTimingProfile).toEqual({
      scoped: [1200, 800],
      full: [5001, 3000],
      updatedAt: "2026-03-18T00:00:00.000Z",
    });
  });

  it("drops invalid timeout overrides and empty timing profiles", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      validationTimeoutMsOverride: 10,
      validationTimingProfile: {
        scoped: ["bad", -1],
        full: [],
        updatedAt: "   ",
      },
    });

    expect(parsed.validationTimeoutMsOverride).toBeUndefined();
    expect(parsed.validationTimingProfile).toBeUndefined();
  });

  it("preserves explicit null timeout overrides", () => {
    const parsed = parseSettings({
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      validationTimeoutMsOverride: null,
    });

    expect(parsed.validationTimeoutMsOverride).toBeNull();
  });
});

describe("getProviderForAgentType", () => {
  it("returns ANTHROPIC_API_KEY for claude", () => {
    expect(getProviderForAgentType("claude")).toBe("ANTHROPIC_API_KEY");
  });
  it("returns CURSOR_API_KEY for cursor", () => {
    expect(getProviderForAgentType("cursor")).toBe("CURSOR_API_KEY");
  });
  it("returns OPENAI_API_KEY for openai", () => {
    expect(getProviderForAgentType("openai")).toBe("OPENAI_API_KEY");
  });
  it("returns GOOGLE_API_KEY for google", () => {
    expect(getProviderForAgentType("google")).toBe("GOOGLE_API_KEY");
  });
  it("returns null for claude-cli and custom", () => {
    expect(getProviderForAgentType("claude-cli")).toBe(null);
    expect(getProviderForAgentType("custom")).toBe(null);
  });
  it("returns null for lmstudio (excluded from API key provider resolution)", () => {
    expect(getProviderForAgentType("lmstudio")).toBe(null);
  });
});

describe("API_KEY_PROVIDERS", () => {
  it("includes ANTHROPIC_API_KEY, CURSOR_API_KEY, OPENAI_API_KEY, and GOOGLE_API_KEY", () => {
    expect(API_KEY_PROVIDERS).toContain("ANTHROPIC_API_KEY");
    expect(API_KEY_PROVIDERS).toContain("CURSOR_API_KEY");
    expect(API_KEY_PROVIDERS).toContain("OPENAI_API_KEY");
    expect(API_KEY_PROVIDERS).toContain("GOOGLE_API_KEY");
    expect(API_KEY_PROVIDERS).toHaveLength(4);
  });
});

describe("validateApiKeyEntry", () => {
  it("accepts valid entry with id and value", () => {
    const entry = validateApiKeyEntry({ id: "a1", value: "sk-ant-xxx" });
    expect(entry).toEqual({ id: "a1", value: "sk-ant-xxx" });
  });

  it("accepts entry with limitHitAt", () => {
    const entry = validateApiKeyEntry({
      id: "b2",
      value: "key",
      limitHitAt: "2025-02-25T12:00:00Z",
    });
    expect(entry).toEqual({
      id: "b2",
      value: "key",
      limitHitAt: "2025-02-25T12:00:00Z",
    });
  });

  it("accepts entry with invalidAt", () => {
    const entry = validateApiKeyEntry({
      id: "b3",
      value: "key",
      invalidAt: "2025-02-25T12:00:00Z",
    });
    expect(entry).toEqual({
      id: "b3",
      value: "key",
      invalidAt: "2025-02-25T12:00:00Z",
    });
  });

  it("trims id", () => {
    const entry = validateApiKeyEntry({ id: "  x  ", value: "v" });
    expect(entry.id).toBe("x");
  });

  it("throws when entry is not an object", () => {
    expect(() => validateApiKeyEntry(null)).toThrow("API key entry must be an object");
    expect(() => validateApiKeyEntry("string")).toThrow("API key entry must be an object");
  });

  it("throws when id is missing or empty", () => {
    expect(() => validateApiKeyEntry({ value: "v" })).toThrow("non-empty string id");
    expect(() => validateApiKeyEntry({ id: "", value: "v" })).toThrow("non-empty string id");
    expect(() => validateApiKeyEntry({ id: "   ", value: "v" })).toThrow("non-empty string id");
  });

  it("throws when value is not a string", () => {
    expect(() => validateApiKeyEntry({ id: "x", value: 123 })).toThrow("string value");
  });

  it("throws when limitHitAt is present but not a string", () => {
    expect(() => validateApiKeyEntry({ id: "x", value: "secret", limitHitAt: 123 })).toThrow(
      "limitHitAt must be a string"
    );
  });

  it("throws when invalidAt is present but not a string", () => {
    expect(() => validateApiKeyEntry({ id: "x", value: "secret", invalidAt: 123 })).toThrow(
      "invalidAt must be a string"
    );
  });

  it("accepts optional label and includes it in output", () => {
    const entry = validateApiKeyEntry({
      id: "k1",
      value: "sk-ant-xxx",
      label: "Production",
    });
    expect(entry).toMatchObject({ id: "k1", value: "sk-ant-xxx", label: "Production" });
  });

  it("throws when label is present but not a string", () => {
    expect(() => validateApiKeyEntry({ id: "x", value: "secret", label: 123 })).toThrow(
      "API key label must be a string"
    );
  });
});

describe("mergeApiKeysWithCurrent", () => {
  it("returns current when incoming is null or invalid", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "secret" }],
    };
    expect(mergeApiKeysWithCurrent(null, current)).toEqual(current);
    expect(mergeApiKeysWithCurrent("string", current)).toEqual(current);
    expect(mergeApiKeysWithCurrent([], current)).toEqual(current);
  });

  it("preserves value when id exists and value omitted (masked)", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret", invalidAt: "2025-02-25T12:00:00Z" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "sk-ant-secret", invalidAt: "2025-02-25T12:00:00Z" },
    ]);
  });

  it("preserves limitHitAt when value omitted (masked)", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret", limitHitAt: "2025-03-01T00:00:00Z" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "sk-ant-secret", limitHitAt: "2025-03-01T00:00:00Z" },
    ]);
  });

  it("uses incoming limitHitAt when masked and provided as string", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret", limitHitAt: "2025-01-01T00:00:00Z" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••", limitHitAt: "2025-06-01T00:00:00Z" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "sk-ant-secret", limitHitAt: "2025-06-01T00:00:00Z" },
    ]);
  });

  it("preserves invalidAt when value omitted (masked)", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk", invalidAt: "2025-04-01T00:00:00Z" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "sk", invalidAt: "2025-04-01T00:00:00Z" },
    ]);
  });

  it("uses incoming invalidAt when masked and provided as string", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk", invalidAt: "2025-01-01T00:00:00Z" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••", invalidAt: "2025-08-01T00:00:00Z" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "sk", invalidAt: "2025-08-01T00:00:00Z" },
    ]);
  });

  it("replaces value when new value provided", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "old", invalidAt: "2025-02-25T12:00:00Z" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "new-secret" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([{ id: "k1", value: "new-secret" }]);
  });

  it("removes providers not in incoming (replace semantics)", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "a1", value: "anth" }],
      CURSOR_API_KEY: [{ id: "c1", value: "cursor" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "a1", value: "anth-updated" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([{ id: "a1", value: "anth-updated" }]);
    expect(result?.CURSOR_API_KEY).toBeUndefined();
  });

  it("adds new entry with new id", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "v1" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [
        { id: "k1", value: "v1" },
        { id: "k2", value: "v2" },
      ],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toHaveLength(2);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "v1" },
      { id: "k2", value: "v2" },
    ]);
  });

  it("merges OPENAI_API_KEY entries", () => {
    const current: ApiKeys = {
      OPENAI_API_KEY: [{ id: "o1", value: "sk-old" }],
    };
    const incoming = {
      OPENAI_API_KEY: [{ id: "o1", masked: "••••••••" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.OPENAI_API_KEY).toEqual([{ id: "o1", value: "sk-old" }]);
  });

  it("preserves label when value omitted (masked)", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret", label: "Production" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "sk-ant-secret", label: "Production" },
    ]);
  });

  it("uses incoming label when provided", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret", label: "Old" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••", label: "Staging" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "sk-ant-secret", label: "Staging" },
    ]);
  });

  it("preserves order of incoming array (drag-to-reorder)", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [
        { id: "k1", value: "v1" },
        { id: "k2", value: "v2" },
        { id: "k3", value: "v3" },
      ],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [
        { id: "k3", masked: "••••••••" },
        { id: "k1", masked: "••••••••" },
        { id: "k2", masked: "••••••••" },
      ],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY?.map((e) => e.id)).toEqual(["k3", "k1", "k2"]);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k3", value: "v3" },
      { id: "k1", value: "v1" },
      { id: "k2", value: "v2" },
    ]);
  });
});

describe("sanitizeApiKeys", () => {
  it("returns undefined for null", () => {
    expect(sanitizeApiKeys(null)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(sanitizeApiKeys("string")).toBeUndefined();
    expect(sanitizeApiKeys([])).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(sanitizeApiKeys({})).toBeUndefined();
  });

  it("sanitizes valid apiKeys for known providers", () => {
    const raw = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx" }],
      CURSOR_API_KEY: [{ id: "k2", value: "cursor-key" }],
      OPENAI_API_KEY: [{ id: "k3", value: "sk-xxx" }],
    };
    const result = sanitizeApiKeys(raw) as ApiKeys;
    expect(result?.ANTHROPIC_API_KEY).toEqual([{ id: "k1", value: "sk-ant-xxx" }]);
    expect(result?.CURSOR_API_KEY).toEqual([{ id: "k2", value: "cursor-key" }]);
    expect(result?.OPENAI_API_KEY).toEqual([{ id: "k3", value: "sk-xxx" }]);
  });

  it("preserves label when present", () => {
    const raw = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx", label: "Staging" }],
    };
    const result = sanitizeApiKeys(raw) as ApiKeys;
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", value: "sk-ant-xxx", label: "Staging" },
    ]);
  });

  it("ignores unknown provider keys", () => {
    const raw = {
      UNKNOWN_KEY: [{ id: "x", value: "v" }],
    };
    expect(sanitizeApiKeys(raw)).toBeUndefined();
  });

  it("skips invalid entries within array", () => {
    const raw = {
      ANTHROPIC_API_KEY: [
        { id: "valid", value: "v" },
        { id: "", value: "bad" },
        { value: "no-id" },
        { id: "ok", value: "v2" },
      ],
    };
    const result = sanitizeApiKeys(raw) as ApiKeys;
    expect(result?.ANTHROPIC_API_KEY).toHaveLength(2);
    expect(result?.ANTHROPIC_API_KEY).toEqual([
      { id: "valid", value: "v" },
      { id: "ok", value: "v2" },
    ]);
  });
});

describe("isLimitHitExpired", () => {
  it("returns true when limitHitAt is undefined", () => {
    expect(isLimitHitExpired(undefined)).toBe(true);
  });

  it("returns true when limitHitAt is older than 24h", () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(isLimitHitExpired(old)).toBe(true);
  });

  it("returns false when limitHitAt is within 24h", () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    expect(isLimitHitExpired(recent)).toBe(false);
  });

  it("returns true for invalid ISO string", () => {
    expect(isLimitHitExpired("not-a-date")).toBe(true);
  });

  it("returns true when date coercion throws", () => {
    const throwingDate = {
      [Symbol.toPrimitive]() {
        throw new Error("boom");
      },
    };

    expect(isLimitHitExpired(throwingDate as unknown as string)).toBe(true);
  });
});

describe("parseSettings — apiKeys ignored (stored in global settings only)", () => {
  it("does not include apiKeys in output (project-level keys removed)", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx" }],
      },
    };
    const parsed = parseSettings(raw);
    expect(parsed).not.toHaveProperty("apiKeys");
  });

  it("does not include apiKeys when absent", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed).not.toHaveProperty("apiKeys");
  });
});

describe("maskApiKeysForResponse", () => {
  it("returns undefined for undefined apiKeys", () => {
    expect(maskApiKeysForResponse(undefined)).toBeUndefined();
  });

  it("returns undefined for empty apiKeys", () => {
    expect(maskApiKeysForResponse({})).toBeUndefined();
  });

  it("masks values and preserves id and marker timestamps", () => {
    const apiKeys: ApiKeys = {
      ANTHROPIC_API_KEY: [
        { id: "k1", value: "sk-ant-secret" },
        {
          id: "k2",
          value: "sk-ant-other",
          limitHitAt: "2025-02-25T12:00:00Z",
          invalidAt: "2025-02-26T12:00:00Z",
        },
      ],
    };
    const masked = maskApiKeysForResponse(apiKeys);
    expect(masked).toEqual({
      ANTHROPIC_API_KEY: [
        { id: "k1", masked: "••••••••" },
        {
          id: "k2",
          masked: "••••••••",
          limitHitAt: "2025-02-25T12:00:00Z",
          invalidAt: "2025-02-26T12:00:00Z",
        },
      ],
    });
  });

  it("never includes value in output", () => {
    const apiKeys: ApiKeys = {
      CURSOR_API_KEY: [{ id: "c1", value: "cursor-secret-key" }],
    };
    const masked = maskApiKeysForResponse(apiKeys);
    expect(masked?.CURSOR_API_KEY?.[0]).not.toHaveProperty("value");
    expect(masked?.CURSOR_API_KEY?.[0]).toEqual({ id: "c1", masked: "••••••••" });
  });

  it("preserves label in masked output", () => {
    const apiKeys: ApiKeys = {
      ANTHROPIC_API_KEY: [
        { id: "k1", value: "sk-ant-secret", label: "Production" },
        { id: "k2", value: "sk-ant-other", label: "Staging" },
      ],
    };
    const masked = maskApiKeysForResponse(apiKeys);
    expect(masked?.ANTHROPIC_API_KEY).toEqual([
      { id: "k1", masked: "••••••••", label: "Production" },
      { id: "k2", masked: "••••••••", label: "Staging" },
    ]);
  });
});

describe("DEFAULT_DATABASE_URL", () => {
  it("is the local Docker Postgres URL (deprecated, use getDefaultDatabaseUrl for default)", () => {
    expect(DEFAULT_DATABASE_URL).toBe(
      "postgresql://opensprint:opensprint@localhost:5432/opensprint"
    );
  });
});

describe("validateDatabaseUrl", () => {
  it("accepts valid postgresql URL", () => {
    const url = "postgresql://opensprint:opensprint@localhost:5432/opensprint";
    expect(validateDatabaseUrl(url)).toBe(url);
  });

  it("accepts valid postgres URL", () => {
    const url = "postgres://user:pass@host.example.com:5432/mydb";
    expect(validateDatabaseUrl(url)).toBe(url);
  });

  it("accepts remote Supabase-style URL", () => {
    const url =
      "postgresql://postgres.xxx:password@aws-0-us-west-1.pooler.supabase.com:6543/postgres";
    expect(validateDatabaseUrl(url)).toBe(url);
  });

  it("trims whitespace", () => {
    const url = "  postgresql://localhost/db  ";
    expect(validateDatabaseUrl(url)).toBe("postgresql://localhost/db");
  });

  it("throws when empty or not a string", () => {
    expect(() => validateDatabaseUrl("")).toThrow("databaseUrl must be a non-empty string");
    expect(() => validateDatabaseUrl("   ")).toThrow("databaseUrl must be a non-empty string");
    expect(() => validateDatabaseUrl(null as unknown as string)).toThrow(
      "databaseUrl must be a non-empty string"
    );
  });

  it("throws when scheme is not postgres/postgresql or SQLite path", () => {
    expect(() => validateDatabaseUrl("mysql://localhost/db")).toThrow(
      /databaseUrl must start with postgres:\/\/ or postgresql:\/\//
    );
    expect(() => validateDatabaseUrl("https://localhost/db")).toThrow(
      /databaseUrl must start with postgres:\/\/ or postgresql:\/\//
    );
  });

  it("accepts SQLite URLs and paths", () => {
    expect(validateDatabaseUrl("sqlite:///path/to/db.sqlite")).toBe("sqlite:///path/to/db.sqlite");
    expect(validateDatabaseUrl("file:///abs/path/db.sqlite")).toBe("file:///abs/path/db.sqlite");
    expect(validateDatabaseUrl("./data/opensprint.sqlite")).toBe("./data/opensprint.sqlite");
    expect(validateDatabaseUrl("/var/lib/opensprint/db.db")).toBe("/var/lib/opensprint/db.db");
    expect(validateDatabaseUrl("file.db")).toBe("file.db");
  });

  it("normalizes legacy sqlite:/file: shorthand prefixes", () => {
    expect(validateDatabaseUrl("sqlite:./data/opensprint.sqlite")).toBe("./data/opensprint.sqlite");
    expect(validateDatabaseUrl("sqlite:sqlite:./data/opensprint.sqlite")).toBe(
      "./data/opensprint.sqlite"
    );
    expect(validateDatabaseUrl("file:/var/lib/opensprint/db.sqlite")).toBe(
      "/var/lib/opensprint/db.sqlite"
    );
    expect(validateDatabaseUrl("sqlite:file:///var/lib/opensprint/db.sqlite")).toBe(
      "file:///var/lib/opensprint/db.sqlite"
    );
    expect(validateDatabaseUrl("sqlite:C:\\Users\\me\\opensprint.sqlite")).toBe(
      "C:\\Users\\me\\opensprint.sqlite"
    );
  });

  it("throws for sqlite:// or file:// without path", () => {
    expect(() => validateDatabaseUrl("sqlite://")).toThrow(/path for SQLite/);
    expect(() => validateDatabaseUrl("file://")).toThrow(/path for SQLite/);
  });

  it("throws when URL is malformed (missing host)", () => {
    expect(() => validateDatabaseUrl("postgresql://")).toThrow("databaseUrl must have a host");
  });

  it("throws the generic parser error for malformed PostgreSQL URLs", () => {
    expect(() => validateDatabaseUrl("postgresql://exa mple.com/db")).toThrow(
      "databaseUrl must be a valid PostgreSQL connection URL"
    );
  });
});

describe("getDatabaseDialect", () => {
  it("returns postgres for postgres/postgresql URLs", () => {
    expect(getDatabaseDialect("postgresql://localhost/db")).toBe("postgres");
    expect(getDatabaseDialect("postgres://user:pass@host:5432/db")).toBe("postgres");
  });
  it("returns sqlite for sqlite/file URLs and paths", () => {
    expect(getDatabaseDialect("sqlite:///path/db.sqlite")).toBe("sqlite");
    expect(getDatabaseDialect("file:///abs/db.db")).toBe("sqlite");
    expect(getDatabaseDialect("./data/db.sqlite")).toBe("sqlite");
    expect(getDatabaseDialect("/var/db.sqlite")).toBe("sqlite");
    expect(getDatabaseDialect("file.db")).toBe("sqlite");
  });
});

describe("maskDatabaseUrl", () => {
  it("redacts password, keeps host and port visible", () => {
    const url = "postgresql://user:secret@localhost:5432/db";
    expect(maskDatabaseUrl(url)).toBe("postgresql://user:***@localhost:5432/db");
  });

  it("handles URL without password", () => {
    const url = "postgresql://user@localhost:5432/db";
    expect(maskDatabaseUrl(url)).toContain("localhost");
    expect(maskDatabaseUrl(url)).toContain("5432");
  });

  it("returns empty string for empty input", () => {
    expect(maskDatabaseUrl("")).toBe("");
    expect(maskDatabaseUrl("   ")).toBe("");
  });

  it("returns *** for invalid URL", () => {
    expect(maskDatabaseUrl("not-a-url")).toBe("***");
  });

  it("returns canonical SQLite URLs and paths unchanged", () => {
    expect(maskDatabaseUrl("sqlite:///path/to/db.sqlite")).toBe("sqlite:///path/to/db.sqlite");
    expect(maskDatabaseUrl("file:///abs/db.db")).toBe("file:///abs/db.db");
    expect(maskDatabaseUrl("./data/db.sqlite")).toBe("./data/db.sqlite");
  });

  it("normalizes legacy SQLite shorthand to canonical path/URL", () => {
    expect(maskDatabaseUrl("sqlite:./data/db.sqlite")).toBe("./data/db.sqlite");
    expect(maskDatabaseUrl("sqlite:sqlite:./data/db.sqlite")).toBe("./data/db.sqlite");
    expect(maskDatabaseUrl("file:/var/lib/db.sqlite")).toBe("/var/lib/db.sqlite");
  });
});

describe("isLocalDatabaseUrl", () => {
  it("returns true for localhost", () => {
    expect(isLocalDatabaseUrl("postgresql://opensprint:opensprint@localhost:5432/opensprint")).toBe(
      true
    );
    expect(isLocalDatabaseUrl("postgres://localhost/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgresql://user:pass@localhost:5433/mydb")).toBe(true);
  });

  it("returns true for 127.0.0.1", () => {
    expect(isLocalDatabaseUrl("postgresql://opensprint@127.0.0.1:5432/opensprint")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://127.0.0.1/db")).toBe(true);
  });

  it("returns false for remote hosts", () => {
    expect(isLocalDatabaseUrl("postgresql://user:pass@remote.example.com:5432/mydb")).toBe(false);
    expect(isLocalDatabaseUrl("postgresql://user@db.supabase.com:5432/postgres")).toBe(false);
  });

  it("returns false for invalid URL", () => {
    expect(isLocalDatabaseUrl("")).toBe(false);
    expect(isLocalDatabaseUrl("not-a-url")).toBe(false);
  });
});

describe("getProvidersInUse", () => {
  it("returns ANTHROPIC_API_KEY when claude in use", () => {
    const settings = makeSettings({
      simpleComplexityAgent: { type: "claude", model: "x", cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
    });
    expect(getProvidersInUse(settings)).toEqual(["ANTHROPIC_API_KEY", "CURSOR_API_KEY"]);
  });

  it("returns CURSOR_API_KEY only when both agents are cursor", () => {
    const settings = makeSettings({
      simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
    });
    expect(getProvidersInUse(settings)).toEqual(["CURSOR_API_KEY"]);
  });

  it("returns ANTHROPIC_API_KEY for claude-cli", () => {
    const settings = makeSettings({
      simpleComplexityAgent: { type: "claude-cli", model: null, cliCommand: "claude" },
      complexComplexityAgent: { type: "claude-cli", model: null, cliCommand: null },
    });
    expect(getProvidersInUse(settings)).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("returns OPENAI_API_KEY when openai in use", () => {
    const settings = makeSettings({
      simpleComplexityAgent: { type: "openai", model: "gpt-4o", cliCommand: null },
      complexComplexityAgent: { type: "openai", model: "gpt-4o", cliCommand: null },
    });
    expect(getProvidersInUse(settings)).toEqual(["OPENAI_API_KEY"]);
  });

  it("returns OPENAI_API_KEY with other providers when mixed", () => {
    const settings = makeSettings({
      simpleComplexityAgent: { type: "openai", model: "gpt-4o", cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
    });
    const result = getProvidersInUse(settings);
    expect(result).toHaveLength(2);
    expect(result).toContain("OPENAI_API_KEY");
    expect(result).toContain("CURSOR_API_KEY");
  });

  it("does not add a provider for lmstudio (excluded from API key resolution)", () => {
    const settings = makeSettings({
      simpleComplexityAgent: {
        type: "lmstudio",
        model: "local-model",
        cliCommand: null,
        baseUrl: "http://localhost:1234",
      },
      complexComplexityAgent: {
        type: "lmstudio",
        model: "local-model",
        cliCommand: null,
      },
    });
    expect(getProvidersInUse(settings)).toEqual([]);
  });
});

describe("getProvidersRequiringApiKeys", () => {
  it("returns ANTHROPIC_API_KEY for claude only (not claude-cli)", () => {
    const agents = [
      { type: "claude" as const, model: "x", cliCommand: null },
      { type: "claude-cli" as const, model: null, cliCommand: "claude" },
    ];
    expect(getProvidersRequiringApiKeys(agents)).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("returns CURSOR_API_KEY when cursor in use", () => {
    const agents = [
      { type: "cursor" as const, model: null, cliCommand: null },
      { type: "cursor" as const, model: null, cliCommand: null },
    ];
    expect(getProvidersRequiringApiKeys(agents)).toEqual(["CURSOR_API_KEY"]);
  });

  it("returns both when claude and cursor in use", () => {
    const agents = [
      { type: "claude" as const, model: "x", cliCommand: null },
      { type: "cursor" as const, model: null, cliCommand: null },
    ];
    expect(getProvidersRequiringApiKeys(agents)).toEqual(["ANTHROPIC_API_KEY", "CURSOR_API_KEY"]);
  });

  it("returns empty for claude-cli and custom only", () => {
    const agents = [
      { type: "claude-cli" as const, model: null, cliCommand: "claude" },
      { type: "custom" as const, model: null, cliCommand: "my-agent" },
    ];
    expect(getProvidersRequiringApiKeys(agents)).toEqual([]);
  });

  it("returns OPENAI_API_KEY when openai in use", () => {
    const agents = [
      { type: "openai" as const, model: "gpt-4o", cliCommand: null },
      { type: "openai" as const, model: "gpt-4o-mini", cliCommand: null },
    ];
    expect(getProvidersRequiringApiKeys(agents)).toEqual(["OPENAI_API_KEY"]);
  });

  it("returns OPENAI_API_KEY with other providers when mixed", () => {
    const agents = [
      { type: "openai" as const, model: "gpt-4o", cliCommand: null },
      { type: "claude" as const, model: "x", cliCommand: null },
    ];
    const result = getProvidersRequiringApiKeys(agents);
    expect(result).toHaveLength(2);
    expect(result).toContain("ANTHROPIC_API_KEY");
    expect(result).toContain("OPENAI_API_KEY");
  });

  it("does not add a provider for lmstudio (excluded from API key resolution)", () => {
    const agents = [
      { type: "lmstudio" as const, model: "local-model", cliCommand: null },
      {
        type: "lmstudio" as const,
        model: "other-model",
        cliCommand: null,
        baseUrl: "http://localhost:1234",
      },
    ];
    expect(getProvidersRequiringApiKeys(agents)).toEqual([]);
  });
});

describe("self-improvement reviewer agent settings", () => {
  describe("parseSettings — selfImprovementReviewerAgents", () => {
    it("should be undefined when missing", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
      });
      expect(parsed.selfImprovementReviewerAgents).toBeUndefined();
    });

    it("should parse valid selfImprovementReviewerAgents", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementReviewerAgents: ["security", "performance"],
      });
      expect(parsed.selfImprovementReviewerAgents).toEqual(["security", "performance"]);
    });

    it("should filter invalid selfImprovementReviewerAgents", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementReviewerAgents: ["security", "bogus", "test_coverage"],
      });
      expect(parsed.selfImprovementReviewerAgents).toEqual(["security", "test_coverage"]);
    });

    it("should be undefined when selfImprovementReviewerAgents is empty array (same as reviewAngles)", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementReviewerAgents: [],
      });
      expect(parsed.selfImprovementReviewerAgents).toBeUndefined();
    });

    it("should read legacy selfImprovementReviewAngles when new key is absent", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementReviewAngles: ["code_quality"],
      });
      expect(parsed.selfImprovementReviewerAgents).toEqual(["code_quality"]);
      expect((parsed as Record<string, unknown>).selfImprovementReviewAngles).toBeUndefined();
    });

    it("should prefer selfImprovementReviewerAgents over legacy selfImprovementReviewAngles", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementReviewerAgents: ["security"],
        selfImprovementReviewAngles: ["performance"],
      });
      expect(parsed.selfImprovementReviewerAgents).toEqual(["security"]);
    });
  });

  describe("parseSettings — selfImprovementIncludeGeneralReview", () => {
    it("should be undefined when missing", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
      });
      expect(parsed.selfImprovementIncludeGeneralReview).toBeUndefined();
    });

    it("should preserve true", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementIncludeGeneralReview: true,
      });
      expect(parsed.selfImprovementIncludeGeneralReview).toBe(true);
    });

    it("should normalize false to undefined", () => {
      const parsed = parseSettings({
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementIncludeGeneralReview: false,
      });
      expect(parsed.selfImprovementIncludeGeneralReview).toBeUndefined();
    });
  });

  describe("parseSettings — round-trip", () => {
    it("should round-trip self-improvement reviewer settings through parseSettings", () => {
      const raw = {
        simpleComplexityAgent: lowAgent,
        complexComplexityAgent: highAgent,
        selfImprovementReviewerAgents: ["security", "code_quality"] as ReviewAngle[],
        selfImprovementIncludeGeneralReview: true,
      };
      const parsed = parseSettings(raw);
      expect(parsed.selfImprovementReviewerAgents).toEqual(["security", "code_quality"]);
      expect(parsed.selfImprovementIncludeGeneralReview).toBe(true);

      const roundTripped = parseSettings(parsed);
      expect(roundTripped.selfImprovementReviewerAgents).toEqual(["security", "code_quality"]);
      expect(roundTripped.selfImprovementIncludeGeneralReview).toBe(true);
    });
  });

  describe("getSelfImprovementReviewerAgents", () => {
    it("returns selfImprovementReviewerAgents when set", () => {
      const settings = makeSettings({
        reviewAngles: ["security"],
        selfImprovementReviewerAgents: ["performance", "test_coverage"],
      });
      expect(getSelfImprovementReviewerAgents(settings)).toEqual(["performance", "test_coverage"]);
    });

    it("falls back to reviewAngles when selfImprovementReviewerAgents is unset", () => {
      const settings = makeSettings({ reviewAngles: ["security", "code_quality"] });
      expect(getSelfImprovementReviewerAgents(settings)).toEqual(["security", "code_quality"]);
    });

    it("returns undefined when both are unset", () => {
      const settings = makeSettings({});
      expect(getSelfImprovementReviewerAgents(settings)).toBeUndefined();
    });

    it("falls back to reviewAngles when selfImprovementReviewerAgents is undefined (parseSettings normalizes empty to undefined)", () => {
      const settings = makeSettings({
        reviewAngles: ["security"],
      });
      expect(getSelfImprovementReviewerAgents(settings)).toEqual(["security"]);
    });

    it("getSelfImprovementReviewAngles matches getSelfImprovementReviewerAgents", () => {
      const settings = makeSettings({
        selfImprovementReviewerAgents: ["security"],
      });
      expect(getSelfImprovementReviewAngles(settings)).toEqual(
        getSelfImprovementReviewerAgents(settings)
      );
    });
  });

  describe("getSelfImprovementIncludeGeneralReview", () => {
    it("returns selfImprovementIncludeGeneralReview when set", () => {
      const settings = makeSettings({
        includeGeneralReview: false,
        selfImprovementIncludeGeneralReview: true,
      });
      expect(getSelfImprovementIncludeGeneralReview(settings)).toBe(true);
    });

    it("falls back to includeGeneralReview when selfImprovementIncludeGeneralReview is unset", () => {
      const settings = makeSettings({ includeGeneralReview: true });
      expect(getSelfImprovementIncludeGeneralReview(settings)).toBe(true);
    });

    it("returns false when both are unset", () => {
      const settings = makeSettings({});
      expect(getSelfImprovementIncludeGeneralReview(settings)).toBe(false);
    });
  });

  describe("parsePreferredEditor", () => {
    it("accepts valid literals", () => {
      for (const v of VALID_PREFERRED_EDITORS) {
        expect(parsePreferredEditor(v)).toBe(v);
      }
    });

    it("returns undefined for invalid or absent values", () => {
      expect(parsePreferredEditor(undefined)).toBeUndefined();
      expect(parsePreferredEditor("vim")).toBeUndefined();
      expect(parsePreferredEditor(1)).toBeUndefined();
    });
  });

  describe("maskTodoistOAuthForResponse", () => {
    it("returns undefined for undefined input", () => {
      expect(maskTodoistOAuthForResponse(undefined)).toBeUndefined();
    });

    it("returns undefined when all fields are empty", () => {
      expect(
        maskTodoistOAuthForResponse({ clientId: "", clientSecret: "", redirectUri: "" })
      ).toBeUndefined();
    });

    it("masks clientSecret and preserves clientId/redirectUri", () => {
      const result = maskTodoistOAuthForResponse({
        clientId: "abc123",
        clientSecret: "supersecret",
        redirectUri: "http://localhost:3000/callback",
      });
      expect(result).toEqual({
        clientId: "abc123",
        clientSecretMasked: "••••••••",
        redirectUri: "http://localhost:3000/callback",
        configured: true,
      });
    });

    it("sets configured to false when clientId or clientSecret is missing", () => {
      const result = maskTodoistOAuthForResponse({
        clientId: "abc",
        clientSecret: "",
        redirectUri: "http://localhost:3000/callback",
      });
      expect(result?.configured).toBe(false);
      expect(result?.clientSecretMasked).toBe("");
    });
  });

  describe("parseTodoistOAuthCredentials", () => {
    it("returns undefined for non-objects", () => {
      expect(parseTodoistOAuthCredentials(null)).toBeUndefined();
      expect(parseTodoistOAuthCredentials(undefined)).toBeUndefined();
      expect(parseTodoistOAuthCredentials("string")).toBeUndefined();
      expect(parseTodoistOAuthCredentials([])).toBeUndefined();
    });

    it("returns undefined when all fields are empty", () => {
      expect(
        parseTodoistOAuthCredentials({ clientId: "", clientSecret: "", redirectUri: "" })
      ).toBeUndefined();
    });

    it("parses valid credentials and trims whitespace", () => {
      const result = parseTodoistOAuthCredentials({
        clientId: "  abc123  ",
        clientSecret: " secret ",
        redirectUri: " http://localhost ",
      });
      expect(result).toEqual({
        clientId: "abc123",
        clientSecret: "secret",
        redirectUri: "http://localhost",
      });
    });

    it("returns partial credentials when some fields are present", () => {
      const result = parseTodoistOAuthCredentials({ clientId: "abc" });
      expect(result).toEqual({ clientId: "abc", clientSecret: "", redirectUri: "" });
    });
  });
});

it("recovers malformed stored target containers and filters bad neighbors without losing valid targets", () => {
  const valid = {
    name: "production",
    command: "",
    autoDeployTrigger: "nightly",
    envVars: { SAFE: "value" },
  };
  for (const targets of [
    { production: valid },
    [null],
    [null, { name: 42 }, { name: "bad", envVars: { X: 1 } }, valid],
  ]) {
    const settings = parseSettings({
      deployment: { mode: "custom", targets, envVars: { LEGACY: "kept" } },
    });
    expect(Array.isArray(settings.deployment.targets)).toBe(true);
    expect(() => getDefaultDeploymentTarget(settings.deployment)).not.toThrow();
    expect(() => getTargetsForNightlyDeploy(settings.deployment)).not.toThrow();
    if (Array.isArray(targets) && targets.includes(valid)) {
      expect(settings.deployment.targets).toEqual([
        { ...valid, envVars: { SAFE: "value", LEGACY: "kept" } },
      ]);
    }
  }
});
