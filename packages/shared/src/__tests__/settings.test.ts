import { describe, it, expect } from "vitest";
import { getCodingAgentForComplexity } from "../types/settings.js";
import type { ProjectSettings, AgentConfig } from "../types/settings.js";

const defaultAgent: AgentConfig = { type: "claude", model: "claude-sonnet-4", cliCommand: null };
const highAgent: AgentConfig = { type: "claude", model: "claude-opus-5", cliCommand: null };
const lowAgent: AgentConfig = { type: "cursor", model: "fast-model", cliCommand: null };

function makeSettings(overrides?: Partial<ProjectSettings>): ProjectSettings {
  return {
    planningAgent: defaultAgent,
    codingAgent: defaultAgent,
    deployment: { mode: "custom" },
    hilConfig: {
      scopeChanges: "requires_approval",
      architectureDecisions: "requires_approval",
      dependencyModifications: "automated",
    },
    testFramework: null,
    ...overrides,
  };
}

describe("getCodingAgentForComplexity", () => {
  it("should return the default coding agent when no overrides exist", () => {
    const settings = makeSettings();
    expect(getCodingAgentForComplexity(settings, "medium")).toBe(defaultAgent);
  });

  it("should return the default coding agent when complexity is undefined", () => {
    const settings = makeSettings({
      codingAgentByComplexity: { high: highAgent },
    });
    expect(getCodingAgentForComplexity(settings, undefined)).toBe(defaultAgent);
  });

  it("should return the override agent for a matching complexity level", () => {
    const settings = makeSettings({
      codingAgentByComplexity: { high: highAgent, low: lowAgent },
    });
    expect(getCodingAgentForComplexity(settings, "high")).toBe(highAgent);
    expect(getCodingAgentForComplexity(settings, "low")).toBe(lowAgent);
  });

  it("should fall back to default when no override exists for the given complexity", () => {
    const settings = makeSettings({
      codingAgentByComplexity: { high: highAgent },
    });
    expect(getCodingAgentForComplexity(settings, "low")).toBe(defaultAgent);
    expect(getCodingAgentForComplexity(settings, "medium")).toBe(defaultAgent);
  });

  it("should handle empty codingAgentByComplexity object", () => {
    const settings = makeSettings({ codingAgentByComplexity: {} });
    expect(getCodingAgentForComplexity(settings, "high")).toBe(defaultAgent);
  });
});
