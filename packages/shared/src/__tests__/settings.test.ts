import { describe, it, expect } from "vitest";
import {
  getCodingAgentForComplexity,
  getDefaultDeploymentTarget,
  getDeploymentTargetConfig,
} from "../types/settings.js";
import type { ProjectSettings, AgentConfig, DeploymentConfig } from "../types/settings.js";

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
