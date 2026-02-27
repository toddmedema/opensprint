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

describe("AgentService", () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService();
    vi.clearAllMocks();
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
      const result = await service.runMergerAgentAndWait("proj-123", "/tmp/repo", config);

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
    });

    it("returns false when merger agent exits with non-zero code", async () => {
      mockSpawnWithTaskFile.mockImplementation(
        (_config: unknown, _path: unknown, _cwd: unknown, _onOutput: unknown, onExit: (code: number | null) => void) => {
          setImmediate(() => onExit(1));
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      const config: AgentConfig = { type: "claude", model: "claude-sonnet-4", cliCommand: null };
      const result = await service.runMergerAgentAndWait("proj-123", "/tmp/repo", config);

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
});
