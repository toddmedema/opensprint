import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentService } from "../services/agent.service.js";
import type { AgentConfig } from "@opensprint/shared";

const { mockSpawnWithTaskFile } = vi.hoisted(() => ({
  mockSpawnWithTaskFile: vi.fn(),
}));

const { mockGetNextKey, mockRecordLimitHit, mockClearLimitHit } = vi.hoisted(() => ({
  mockGetNextKey: vi.fn(),
  mockRecordLimitHit: vi.fn(),
  mockClearLimitHit: vi.fn(),
}));

const { mockMessagesCreate, mockMessagesStream } = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockMessagesStream: vi.fn(),
}));

const { mockOpenAICreate, mockOpenAIResponsesCreate } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
  mockOpenAIResponsesCreate: vi.fn(),
}));

const { mockShellExec } = vi.hoisted(() => ({
  mockShellExec: vi.fn(),
}));

vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    spawnWithTaskFile: mockSpawnWithTaskFile,
  })),
}));

vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: (...args: unknown[]) => mockGetNextKey(...args),
  recordLimitHit: (...args: unknown[]) => mockRecordLimitHit(...args),
  clearLimitHit: (...args: unknown[]) => mockClearLimitHit(...args),
  ENV_FALLBACK_KEY_ID: "__env__",
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: (...args: unknown[]) => mockMessagesCreate(...args),
      stream: (...args: unknown[]) => mockMessagesStream(...args),
    },
  })),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockOpenAICreate(...args),
      },
    },
    responses: {
      create: (...args: unknown[]) => mockOpenAIResponsesCreate(...args),
    },
  })),
}));

vi.mock("../utils/shell-exec.js", () => ({
  shellExec: (...args: unknown[]) => mockShellExec(...args),
}));

describe("AgentService", () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService();
    vi.clearAllMocks();
    mockShellExec.mockResolvedValue({ stdout: "", stderr: "" });
  });

  describe("invokeReviewAgent", () => {
    it("should invoke review agent with code reviewer role per PRD §12.3", () => {
      const mockHandle = { kill: vi.fn(), pid: 12345 };
      mockSpawnWithTaskFile.mockReturnValue(mockHandle);

      const config: AgentConfig = { type: "claude", model: "claude-sonnet-4", cliCommand: null };
      const promptPath = "/proj/.opensprint/active/bd-a3f8.2/prompt.md";
      const onOutput = vi.fn();
      const onExit = vi.fn();

      const handle = service.invokeReviewAgent(promptPath, config, {
        cwd: "/proj",
        onOutput,
        onExit,
      });

      expect(mockSpawnWithTaskFile).toHaveBeenCalledWith(
        config,
        promptPath,
        "/proj",
        onOutput,
        onExit,
        "code reviewer",
        undefined,
        undefined
      );
      expect(handle).toBe(mockHandle);
    });

    it("should allow override of agentRole when provided", () => {
      const mockHandle = { kill: vi.fn(), pid: 12345 };
      mockSpawnWithTaskFile.mockReturnValue(mockHandle);

      const config: AgentConfig = { type: "cursor", model: null, cliCommand: null };
      const promptPath = "/proj/.opensprint/active/task-1/prompt.md";

      service.invokeReviewAgent(promptPath, config, {
        cwd: "/proj",
        onOutput: vi.fn(),
        onExit: vi.fn(),
        agentRole: "senior reviewer",
      });

      expect(mockSpawnWithTaskFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        "senior reviewer",
        undefined,
        undefined
      );
    });
  });

  describe("runMergerAgentAndWait", () => {
    it("returns true when merger agent exits with code 0", async () => {
      mockSpawnWithTaskFile.mockImplementation(
        (_config: unknown, _path: unknown, _cwd: unknown, _onOutput: unknown, onExit: (code: number | null) => void) => {
          setImmediate(() => onExit(0));
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      const config: AgentConfig = { type: "cursor", model: null, cliCommand: null };
      const result = await service.runMergerAgentAndWait({
        projectId: "proj-123",
        cwd: "/tmp/repo",
        config,
        phase: "merge_to_main",
        taskId: "os-1",
        branchName: "opensprint/os-1",
        conflictedFiles: ["src/conflict.ts"],
        testCommand: "npm test",
      });

      expect(result).toBe(true);
      expect(mockSpawnWithTaskFile).toHaveBeenCalledWith(
        config,
        expect.stringContaining("opensprint-merger-"),
        "/tmp/repo",
        expect.any(Function),
        expect.any(Function),
        "merger",
        undefined,
        "proj-123"
      );
      expect(mockShellExec).toHaveBeenCalledWith("git diff --check", {
        cwd: "/tmp/repo",
        timeout: 10_000,
      });
    });

    it("returns false when merger agent exits with non-zero code", async () => {
      mockSpawnWithTaskFile.mockImplementation(
        (_config: unknown, _path: unknown, _cwd: unknown, _onOutput: unknown, onExit: (code: number | null) => void) => {
          setImmediate(() => onExit(1));
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      const config: AgentConfig = { type: "claude", model: "claude-sonnet-4", cliCommand: null };
      const result = await service.runMergerAgentAndWait({
        projectId: "proj-123",
        cwd: "/tmp/repo",
        config,
        phase: "rebase_before_merge",
        taskId: "os-2",
        branchName: "opensprint/os-2",
        conflictedFiles: ["src/conflict.ts"],
      });

      expect(result).toBe(false);
    });
  });

  describe("invokePlanningAgent (Claude + ApiKeyResolver)", () => {
    const projectId = "proj-123";
    const claudeConfig: AgentConfig = { type: "claude", model: "claude-sonnet-4", cliCommand: null };

    it("uses getNextKey and clearLimitHit on success", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-ant-test", keyId: "k1", source: "global" });
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: "Hello" }],
      });

      const result = await service.invokePlanningAgent({
        projectId,
        config: claudeConfig,
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockGetNextKey).toHaveBeenCalledWith(projectId, "ANTHROPIC_API_KEY");
      expect(mockClearLimitHit).toHaveBeenCalledWith(projectId, "ANTHROPIC_API_KEY", "k1", "global");
      expect(mockRecordLimitHit).not.toHaveBeenCalled();
      expect(result.content).toBe("Hello");
    });

    it("on limit error: recordLimitHit, retry with next key, succeeds on second key", async () => {
      mockGetNextKey
        .mockResolvedValueOnce({ key: "sk-ant-key1", keyId: "k1", source: "project" })
        .mockResolvedValueOnce({ key: "sk-ant-key2", keyId: "k2", source: "project" });
      mockMessagesCreate
        .mockRejectedValueOnce(new Error("Rate limit exceeded"))
        .mockResolvedValueOnce({ content: [{ type: "text", text: "Success" }] });

      const result = await service.invokePlanningAgent({
        projectId,
        config: claudeConfig,
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockGetNextKey).toHaveBeenCalledTimes(2);
      expect(mockRecordLimitHit).toHaveBeenCalledWith(projectId, "ANTHROPIC_API_KEY", "k1", "project");
      expect(mockClearLimitHit).toHaveBeenCalledWith(projectId, "ANTHROPIC_API_KEY", "k2", "project");
      expect(result.content).toBe("Success");
    });

    it("on limit error with env fallback: throws without retry", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-ant-env", keyId: "__env__", source: "env" });
      mockMessagesCreate.mockRejectedValue(new Error("Rate limit exceeded"));

      await expect(
        service.invokePlanningAgent({
          projectId,
          config: claudeConfig,
          messages: [{ role: "user", content: "Hi" }],
        })
      ).rejects.toThrow(/rate limit|API key/);

      expect(mockRecordLimitHit).not.toHaveBeenCalled();
      expect(mockGetNextKey).toHaveBeenCalledTimes(1);
    });

    it("when no keys available: throws ANTHROPIC_API_KEY_MISSING", async () => {
      mockGetNextKey.mockResolvedValue(null);

      await expect(
        service.invokePlanningAgent({
          projectId,
          config: claudeConfig,
          messages: [{ role: "user", content: "Hi" }],
        })
      ).rejects.toMatchObject({
        code: "ANTHROPIC_API_KEY_MISSING",
      });
    });

    it("streaming path: uses getNextKey and clearLimitHit on success", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-ant-test", keyId: "k1", source: "global" });
      const onChunk = vi.fn();
      mockMessagesStream.mockImplementation(() => {
        const stream = {
          on: (ev: string, fn: (t: string) => void) => {
            if (ev === "text") setImmediate(() => fn("Hello world"));
            return stream;
          },
          finalMessage: () =>
            Promise.resolve({ content: [{ type: "text", text: "Hello world" }] }),
        };
        return stream;
      });

      const result = await service.invokePlanningAgent({
        projectId,
        config: claudeConfig,
        messages: [{ role: "user", content: "Hi" }],
        onChunk,
      });

      expect(mockGetNextKey).toHaveBeenCalledWith(projectId, "ANTHROPIC_API_KEY");
      expect(mockClearLimitHit).toHaveBeenCalledWith(projectId, "ANTHROPIC_API_KEY", "k1", "global");
      expect(result.content).toBe("Hello world");
    });
  });

  describe("invokePlanningAgent (OpenAI + ApiKeyResolver)", () => {
    const projectId = "proj-456";
    const openaiConfig: AgentConfig = { type: "openai", model: "gpt-4o", cliCommand: null };

    it("uses getNextKey and clearLimitHit on success", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-openai-test", keyId: "k1", source: "global" });
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: "Hello from OpenAI" } }],
      });

      const result = await service.invokePlanningAgent({
        projectId,
        config: openaiConfig,
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockGetNextKey).toHaveBeenCalledWith(projectId, "OPENAI_API_KEY");
      expect(mockClearLimitHit).toHaveBeenCalledWith(projectId, "OPENAI_API_KEY", "k1", "global");
      expect(mockRecordLimitHit).not.toHaveBeenCalled();
      expect(result.content).toBe("Hello from OpenAI");
    });

    it("routes codex planning models through the Responses API", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-openai-test", keyId: "k1", source: "global" });
      mockOpenAIResponsesCreate.mockResolvedValue({
        output_text: "Hello from Codex",
      });

      const result = await service.invokePlanningAgent({
        projectId,
        config: { type: "openai", model: "gpt-5.3-codex", cliCommand: null },
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockOpenAICreate).not.toHaveBeenCalled();
      expect(mockOpenAIResponsesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.3-codex",
          input: [expect.objectContaining({ role: "user", content: "Hi" })],
          max_output_tokens: 8192,
        })
      );
      expect(result.content).toBe("Hello from Codex");
    });

    it("on limit error: recordLimitHit, retry with next key, succeeds on second key", async () => {
      mockGetNextKey
        .mockResolvedValueOnce({ key: "sk-openai-key1", keyId: "k1", source: "global" })
        .mockResolvedValueOnce({ key: "sk-openai-key2", keyId: "k2", source: "global" });
      mockOpenAICreate
        .mockRejectedValueOnce(new Error("rate_limit_exceeded"))
        .mockResolvedValueOnce({ choices: [{ message: { content: "Success" } }] });

      const result = await service.invokePlanningAgent({
        projectId,
        config: openaiConfig,
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockGetNextKey).toHaveBeenCalledTimes(2);
      expect(mockRecordLimitHit).toHaveBeenCalledWith(projectId, "OPENAI_API_KEY", "k1", "global");
      expect(mockClearLimitHit).toHaveBeenCalledWith(projectId, "OPENAI_API_KEY", "k2", "global");
      expect(result.content).toBe("Success");
    });

    it("when no keys available: throws OPENAI_API_ERROR", async () => {
      mockGetNextKey.mockResolvedValue(null);

      await expect(
        service.invokePlanningAgent({
          projectId,
          config: openaiConfig,
          messages: [{ role: "user", content: "Hi" }],
        })
      ).rejects.toMatchObject({
        code: "OPENAI_API_ERROR",
      });
    });

    it("streaming path: uses getNextKey and clearLimitHit on success", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-openai-test", keyId: "k1", source: "global" });
      const onChunk = vi.fn();
      mockOpenAICreate.mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: { content: "Hello " } }] };
          yield { choices: [{ delta: { content: "world" } }] };
        })()
      );

      const result = await service.invokePlanningAgent({
        projectId,
        config: openaiConfig,
        messages: [{ role: "user", content: "Hi" }],
        onChunk,
      });

      expect(mockGetNextKey).toHaveBeenCalledWith(projectId, "OPENAI_API_KEY");
      expect(mockClearLimitHit).toHaveBeenCalledWith(projectId, "OPENAI_API_KEY", "k1", "global");
      expect(result.content).toBe("Hello world");
    });

    it("streams codex planning models through the Responses API", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-openai-test", keyId: "k1", source: "global" });
      const onChunk = vi.fn();
      mockOpenAIResponsesCreate.mockResolvedValue(
        (async function* () {
          yield { type: "response.output_text.delta", delta: "Hello " };
          yield { type: "response.output_text.delta", delta: "codex" };
        })()
      );

      const result = await service.invokePlanningAgent({
        projectId,
        config: { type: "openai", model: "gpt-5.3-codex", cliCommand: null },
        messages: [{ role: "user", content: "Hi" }],
        onChunk,
      });

      expect(mockOpenAICreate).not.toHaveBeenCalled();
      expect(mockOpenAIResponsesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.3-codex",
          input: [expect.objectContaining({ role: "user", content: "Hi" })],
          max_output_tokens: 8192,
          stream: true,
        })
      );
      expect(onChunk).toHaveBeenCalledWith("Hello ");
      expect(onChunk).toHaveBeenCalledWith("codex");
      expect(result.content).toBe("Hello codex");
    });
  });
});
