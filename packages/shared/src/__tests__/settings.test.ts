import { describe, it, expect } from "vitest";
import {
  DEFAULT_HIL_CONFIG,
  getAgentForComplexity,
  getAgentForPlanningRole,
  parseSettings,
  getDefaultDeploymentTarget,
  getDeploymentTargetConfig,
  API_KEY_PROVIDERS,
  validateApiKeyEntry,
  sanitizeApiKeys,
  isLimitHitExpired,
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

describe("API_KEY_PROVIDERS", () => {
  it("includes ANTHROPIC_API_KEY and CURSOR_API_KEY", () => {
    expect(API_KEY_PROVIDERS).toContain("ANTHROPIC_API_KEY");
    expect(API_KEY_PROVIDERS).toContain("CURSOR_API_KEY");
    expect(API_KEY_PROVIDERS).toHaveLength(2);
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
    };
    const result = sanitizeApiKeys(raw) as ApiKeys;
    expect(result?.ANTHROPIC_API_KEY).toEqual([{ id: "k1", value: "sk-ant-xxx" }]);
    expect(result?.CURSOR_API_KEY).toEqual([{ id: "k2", value: "cursor-key" }]);
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

describe("parseSettings with apiKeys", () => {
  it("preserves apiKeys when valid", () => {
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
    expect(parsed.apiKeys).toEqual({
      ANTHROPIC_API_KEY: [{ id: "k1", value: "sk-ant-xxx" }],
    });
  });

  it("sets apiKeys to undefined when absent", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
    };
    const parsed = parseSettings(raw);
    expect(parsed.apiKeys).toBeUndefined();
  });

  it("sanitizes apiKeys and drops invalid entries", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "k1", value: "valid" }, { id: "", value: "invalid" }],
      },
    };
    const parsed = parseSettings(raw);
    expect(parsed.apiKeys?.ANTHROPIC_API_KEY).toHaveLength(1);
    expect(parsed.apiKeys?.ANTHROPIC_API_KEY?.[0]).toEqual({ id: "k1", value: "valid" });
  });

  it("sets apiKeys to undefined when all entries invalid", () => {
    const raw = {
      simpleComplexityAgent: lowAgent,
      complexComplexityAgent: highAgent,
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
      testFramework: null,
      apiKeys: {
        ANTHROPIC_API_KEY: [{ id: "", value: "x" }],
      },
    };
    const parsed = parseSettings(raw);
    expect(parsed.apiKeys).toBeUndefined();
  });
});
