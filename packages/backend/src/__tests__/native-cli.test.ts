import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCodexArgs, buildNativeCliEnv, resolveNativeCliCommand } from "../utils/native-cli.js";
import { CLAUDE_CLI_MODELS, parseCodexModelCatalog } from "../services/cli-models.js";

afterEach(() => vi.unstubAllEnvs());

describe("native subscription CLIs", () => {
  it("finds a local Claude installation when GUI PATH omits it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "opensprint-cli-home-"));
    try {
      const binary = path.join(home, ".local", "bin", "claude");
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, "#!/bin/sh\n");
      fs.chmodSync(binary, 0o700);
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", "");
      expect(resolveNativeCliCommand("claude-cli")).toBe(binary);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it("removes API-key billing and gateway overrides from Codex", () => {
    vi.stubEnv("OPENAI_API_KEY", "secret");
    vi.stubEnv("CODEX_API_KEY", "secret");
    vi.stubEnv("OPENAI_BASE_URL", "https://example.invalid");
    const env = buildNativeCliEnv("codex");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBe("secret");
  });

  it("removes Anthropic API billing and alternate cloud-provider overrides", () => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ])
      vi.stubEnv(key, "secret");
    const env = buildNativeCliEnv("claude-cli");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
  });

  it("passes large prompts through stdin and confines coding to the workspace", () => {
    const args = buildCodexArgs("gpt-6.1-sol", true);
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain("workspace-write");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.slice(-3)).toEqual(["--model", "gpt-6.1-sol", "-"]);
    expect(buildCodexArgs("default", false)).toContain("read-only");
    expect(buildCodexArgs("default", false)).not.toContain("--model");
  });

  it("reads current CLI catalog fields and excludes hidden or duplicate models", () => {
    expect(
      parseCodexModelCatalog({
        models: [
          { slug: "older", display_name: "Older", priority: 4 },
          { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", priority: 1 },
          { slug: "hidden", visibility: "hide" },
          { slug: "gpt-6.1-sol" },
        ],
      })
    ).toEqual([
      { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
      { id: "older", displayName: "Older" },
    ]);
  });

  it("uses Claude Code's rolling aliases without requiring an API model ID", () => {
    expect(CLAUDE_CLI_MODELS.map((model) => model.id)).toEqual([
      "default",
      "sonnet",
      "opus",
      "haiku",
      "fable",
    ]);
  });
});
