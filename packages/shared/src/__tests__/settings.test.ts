import { describe, it, expect } from "vitest";
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
  API_KEY_PROVIDERS,
  validateApiKeyEntry,
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
} from "../types/settings.js";
import type { ProjectSettings, AgentConfig, DeploymentConfig, ApiKeys } from "../types/settings.js";

const defaultAgent: AgentConfig = { type: "claude", model: "claude-sonnet-4", cliCommand: null };
const highAgent: AgentConfig = { type: "claude", model: "claude-opus-5", cliCommand: null };
const lowAgent: AgentConfig = { type: "cursor", model: "fast-model", cliCommand: null };

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
    const settings = makeSettings({ simpleComplexityAgent: lowAgent, complexComplexityAgent: highAgent });
    expect(getAgentForComplexity(settings, "low")).toBe(lowAgent);
  });

  it("should return simpleComplexityAgent for medium", () => {
    const settings = makeSettings({ simpleComplexityAgent: lowAgent, complexComplexityAgent: highAgent });
    expect(getAgentForComplexity(settings, "medium")).toBe(lowAgent);
  });

  it("should return complexComplexityAgent for high", () => {
    const settings = makeSettings({ simpleComplexityAgent: lowAgent, complexComplexityAgent: highAgent });
    expect(getAgentForComplexity(settings, "high")).toBe(highAgent);
  });

  it("should return complexComplexityAgent for very_high", () => {
    const settings = makeSettings({ simpleComplexityAgent: lowAgent, complexComplexityAgent: highAgent });
    expect(getAgentForComplexity(settings, "very_high")).toBe(highAgent);
  });

  it("should return simpleComplexityAgent when complexity is undefined", () => {
    const settings = makeSettings({ simpleComplexityAgent: lowAgent, complexComplexityAgent: highAgent });
    expect(getAgentForComplexity(settings, undefined)).toBe(lowAgent);
  });
});

describe("getAgentForPlanningRole", () => {
  it("Dreamer always returns complexComplexityAgent", () => {
    const settings = makeSettings({ simpleComplexityAgent: lowAgent, complexComplexityAgent: highAgent });
    expect(getAgentForPlanningRole(settings, "dreamer")).toBe(highAgent);
    expect(getAgentForPlanningRole(settings, "dreamer", "low")).toBe(highAgent);
    expect(getAgentForPlanningRole(settings, "dreamer", "high")).toBe(highAgent);
  });

  it("Analyst always returns simpleComplexityAgent", () => {
    const settings = makeSettings({ simpleComplexityAgent: lowAgent, complexComplexityAgent: highAgent });
    expect(getAgentForPlanningRole(settings, "analyst")).toBe(lowAgent);
    expect(getAgentForPlanningRole(settings, "analyst", "high")).toBe(lowAgent);
    expect(getAgentForPlanningRole(settings, "analyst", "very_high")).toBe(lowAgent);
  });

  it("Planner/Harmonizer/Auditor/Summarizer inherit plan complexity", () => {
    const settings = makeSettings({ simpleComplexityAgent: lowAgent, complexComplexityAgent: highAgent });
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
  it("returns null for claude-cli and custom", () => {
    expect(getProviderForAgentType("claude-cli")).toBe(null);
    expect(getProviderForAgentType("custom")).toBe(null);
  });
});

describe("API_KEY_PROVIDERS", () => {
  it("includes ANTHROPIC_API_KEY, CURSOR_API_KEY, and OPENAI_API_KEY", () => {
    expect(API_KEY_PROVIDERS).toContain("ANTHROPIC_API_KEY");
    expect(API_KEY_PROVIDERS).toContain("CURSOR_API_KEY");
    expect(API_KEY_PROVIDERS).toContain("OPENAI_API_KEY");
    expect(API_KEY_PROVIDERS).toHaveLength(3);
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
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-secret" }],
    };
    const incoming = {
      ANTHROPIC_API_KEY: [{ id: "k1", masked: "••••••••" }],
    };
    const result = mergeApiKeysWithCurrent(incoming, current);
    expect(result?.ANTHROPIC_API_KEY).toEqual([{ id: "k1", value: "sk-ant-secret" }]);
  });

  it("replaces value when new value provided", () => {
    const current: ApiKeys = {
      ANTHROPIC_API_KEY: [{ id: "k1", value: "old" }],
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

  it("masks values and preserves id and limitHitAt", () => {
    const apiKeys: ApiKeys = {
      ANTHROPIC_API_KEY: [
        { id: "k1", value: "sk-ant-secret" },
        { id: "k2", value: "sk-ant-other", limitHitAt: "2025-02-25T12:00:00Z" },
      ],
    };
    const masked = maskApiKeysForResponse(apiKeys);
    expect(masked).toEqual({
      ANTHROPIC_API_KEY: [
        { id: "k1", masked: "••••••••" },
        { id: "k2", masked: "••••••••", limitHitAt: "2025-02-25T12:00:00Z" },
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
});

describe("DEFAULT_DATABASE_URL", () => {
  it("is the local Docker Postgres URL", () => {
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

  it("throws when scheme is not postgres/postgresql", () => {
    expect(() => validateDatabaseUrl("mysql://localhost/db")).toThrow(
      "databaseUrl must start with postgres:// or postgresql://"
    );
    expect(() => validateDatabaseUrl("https://localhost/db")).toThrow(
      "databaseUrl must start with postgres:// or postgresql://"
    );
  });

  it("throws when URL is malformed (missing host)", () => {
    expect(() => validateDatabaseUrl("postgresql://")).toThrow("databaseUrl must have a host");
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
});
