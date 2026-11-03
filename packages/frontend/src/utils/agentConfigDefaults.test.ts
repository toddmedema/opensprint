import { describe, it, expect } from "vitest";
import {
  getDefaultProviderFromEnvKeys,
  getInitialAgentConfig,
  getMissingApiKeyRequirements,
  hasNoApiKeys,
} from "./agentConfigDefaults";

describe("subscription CLI setup defaults", () => {
  const noKeys = { anthropic: false, cursor: false, openai: false, google: false, codexCli: true };
  it("defaults to an installed Codex CLI when no API keys exist", () => {
    expect(getDefaultProviderFromEnvKeys(noKeys)).toBe("codex");
    expect(getMissingApiKeyRequirements(noKeys, ["codex", "claude-cli", "custom"])).toEqual([]);
  });
  it("uses Ollama's own default port when hydrating an unpinned local provider", () => {
    expect(
      getInitialAgentConfig({ type: "ollama", model: "local", cliCommand: null }, noKeys).baseUrl
    ).toBe("http://localhost:11434");
  });
  it("preserves the saved provider, model and custom command in project setup", () => {
    expect(
      getInitialAgentConfig(
        { type: "custom", model: null, cliCommand: "/usr/local/bin/my-cli" },
        noKeys
      )
    ).toMatchObject({ type: "custom", model: "", cliCommand: "/usr/local/bin/my-cli" });
    expect(
      getInitialAgentConfig(
        { type: "codex", model: "gpt-6.1-sol", cliCommand: null, timeoutMs: 3600000 },
        noKeys
      )
    ).toMatchObject({ type: "codex", model: "gpt-6.1-sol", cliCommand: "", timeoutMs: 3600000 });
  });
});

describe("getDefaultProviderFromEnvKeys", () => {
  it("returns claude when anthropic has keys", () => {
    expect(
      getDefaultProviderFromEnvKeys({
        anthropic: true,
        cursor: false,
        openai: false,
      })
    ).toBe("claude");
  });

  it("returns openai when only openai has keys", () => {
    expect(
      getDefaultProviderFromEnvKeys({
        anthropic: false,
        cursor: false,
        openai: true,
        google: false,
      })
    ).toBe("openai");
  });

  it("returns google when only google has keys", () => {
    expect(
      getDefaultProviderFromEnvKeys({
        anthropic: false,
        cursor: false,
        openai: false,
        google: true,
      })
    ).toBe("google");
  });

  it("returns cursor when only cursor has keys", () => {
    expect(
      getDefaultProviderFromEnvKeys({
        anthropic: false,
        cursor: true,
        openai: false,
        google: false,
      })
    ).toBe("cursor");
  });

  it("returns claude first when multiple providers have keys", () => {
    expect(
      getDefaultProviderFromEnvKeys({
        anthropic: true,
        cursor: true,
        openai: true,
        google: true,
      })
    ).toBe("claude");
  });

  it("returns google before cursor when both have keys", () => {
    expect(
      getDefaultProviderFromEnvKeys({
        anthropic: false,
        cursor: true,
        openai: false,
        google: true,
      })
    ).toBe("google");
  });

  it("returns openai before cursor when both have keys", () => {
    expect(
      getDefaultProviderFromEnvKeys({
        anthropic: false,
        cursor: true,
        openai: true,
        google: false,
      })
    ).toBe("openai");
  });

  it("returns claude when no keys (first in order)", () => {
    expect(
      getDefaultProviderFromEnvKeys({
        anthropic: false,
        cursor: false,
        openai: false,
        google: false,
      })
    ).toBe("claude");
  });

  it("returns claude when envKeys is null", () => {
    expect(getDefaultProviderFromEnvKeys(null)).toBe("claude");
  });
});

describe("hasNoApiKeys", () => {
  it("returns true when all keys are false", () => {
    expect(
      hasNoApiKeys({
        anthropic: false,
        cursor: false,
        openai: false,
        google: false,
      })
    ).toBe(true);
  });

  it("returns false when anthropic has keys", () => {
    expect(
      hasNoApiKeys({
        anthropic: true,
        cursor: false,
        openai: false,
        google: false,
      })
    ).toBe(false);
  });

  it("returns false when cursor has keys", () => {
    expect(
      hasNoApiKeys({
        anthropic: false,
        cursor: true,
        openai: false,
        google: false,
      })
    ).toBe(false);
  });

  it("returns false when openai has keys", () => {
    expect(
      hasNoApiKeys({
        anthropic: false,
        cursor: false,
        openai: true,
        google: false,
      })
    ).toBe(false);
  });

  it("returns false when google has keys", () => {
    expect(
      hasNoApiKeys({
        anthropic: false,
        cursor: false,
        openai: false,
        google: true,
      })
    ).toBe(false);
  });

  it("returns false when envKeys is null", () => {
    expect(hasNoApiKeys(null)).toBe(false);
  });
});
