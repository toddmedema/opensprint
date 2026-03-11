import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { AgentService, createProcessGroupHandle } from "../services/agent.service.js";
import type { AgentConfig } from "@opensprint/shared";
import { OPENSPRINT_PATHS } from "@opensprint/shared";

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

const { mockDbClient } = vi.hoisted(() => {
  const client = {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(0),
    runInTransaction: vi
      .fn()
      .mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client)),
  };
  return { mockDbClient: client };
});
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    init: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    listInProgressWithAgentAssignee: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue([]),
    addDependency: vi.fn().mockResolvedValue(undefined),
    syncForPush: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockResolvedValue(mockDbClient),
    runWrite: vi
      .fn()
      .mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(mockDbClient)),
  },
  TaskStoreService: vi.fn(),
  SCHEMA_SQL: "",
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

  describe("agent_stats recording", () => {
    it("records planning invocations with tracking role into agent_stats", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-ant-test", keyId: "k1", source: "global" });
      mockMessagesCreate.mockResolvedValue({
        content: [{ type: "text", text: "Plan response" }],
      });

      await service.invokePlanningAgent({
        projectId: "proj-plan-stats",
        config: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        messages: [{ role: "user", content: "Plan this" }],
        tracking: {
          id: "plan-run-1",
          projectId: "proj-plan-stats",
          phase: "plan",
          role: "planner",
          label: "Planner run",
        },
      });

      const insertCall = mockDbClient.execute.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO agent_stats")
      );
      expect(insertCall).toBeDefined();
      expect(insertCall?.[1]).toEqual(
        expect.arrayContaining([
          "proj-plan-stats",
          "plan-run-1",
          "planner-claude-claude-sonnet-4",
          "planner",
          "claude-sonnet-4",
          1,
          "success",
        ])
      );
    });

    it("records merger runs via invokeCodingAgent role tracking", () => {
      mockSpawnWithTaskFile.mockImplementation(
        (
          _config: unknown,
          _path: unknown,
          _cwd: unknown,
          _onOutput: unknown,
          onExit: (code: number | null) => void
        ) => {
          onExit(0);
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      service.invokeMergerAgent(
        "/tmp/prompt.md",
        { type: "cursor", model: null, cliCommand: null },
        {
          cwd: "/tmp/repo",
          onOutput: vi.fn(),
          onExit: vi.fn(),
          projectId: "proj-merge-stats",
          tracking: {
            id: "merge-run-1",
            projectId: "proj-merge-stats",
            phase: "execute",
            role: "merger",
            label: "Merger",
          },
        }
      );

      const insertCall = mockDbClient.execute.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO agent_stats")
      );
      expect(insertCall).toBeDefined();
      expect(insertCall?.[1]).toEqual(
        expect.arrayContaining([
          "proj-merge-stats",
          "merge-run-1",
          "merger-cursor-default",
          "merger",
          "unknown",
          1,
          "success",
        ])
      );
    });

    it("does not duplicate coder/reviewer task stats from invokeCodingAgent wrapper", () => {
      mockSpawnWithTaskFile.mockImplementation(
        (
          _config: unknown,
          _path: unknown,
          _cwd: unknown,
          _onOutput: unknown,
          onExit: (code: number | null) => void
        ) => {
          onExit(0);
          return { kill: vi.fn(), pid: 12345 };
        }
      );

      service.invokeCodingAgent(
        "/tmp/prompt.md",
        { type: "cursor", model: null, cliCommand: null },
        {
          cwd: "/tmp/repo",
          onOutput: vi.fn(),
          onExit: vi.fn(),
          projectId: "proj-coder-stats",
          tracking: {
            id: "coder-run-1",
            projectId: "proj-coder-stats",
            phase: "execute",
            role: "coder",
            label: "Coder",
          },
        }
      );

      const insertCalls = mockDbClient.execute.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO agent_stats")
      );
      expect(insertCalls).toHaveLength(0);
    });
  });

  describe("createProcessGroupHandle", () => {
    it("sends SIGTERM to the detached process group and escalates to SIGKILL", () => {
      vi.useFakeTimers();
      const mockKill = vi.spyOn(process, "kill").mockImplementation(() => true);

      const handle = createProcessGroupHandle(7777);
      handle.kill();

      expect(mockKill).toHaveBeenCalledWith(-7777, "SIGTERM");

      vi.advanceTimersByTime(5000);

      const sigkillCalls = mockKill.mock.calls.filter((call) => call[1] === "SIGKILL");
      expect(sigkillCalls).toContainEqual([-7777, "SIGKILL"]);

      mockKill.mockRestore();
      vi.useRealTimers();
    });

    it("falls back to positive PID signals on Windows", () => {
      vi.useFakeTimers();
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const mockKill = vi.spyOn(process, "kill").mockImplementation(() => true);

      const handle = createProcessGroupHandle(8888);
      handle.kill();

      expect(mockKill).toHaveBeenCalledWith(8888, "SIGTERM");

      vi.advanceTimersByTime(5000);

      const sigkillCalls = mockKill.mock.calls.filter((call) => call[1] === "SIGKILL");
      expect(sigkillCalls).toContainEqual([8888, "SIGKILL"]);

      mockKill.mockRestore();
      platformSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe("runMergerAgentAndWait", () => {
    it("includes destructive-command guardrails in merger prompts", async () => {
      const prompt = await (
        service as unknown as {
          buildMergerPrompt: (options: {
            projectId: string;
            cwd: string;
            config: AgentConfig;
            phase: "merge_to_main" | "push_rebase" | "rebase_before_merge";
            taskId: string;
            branchName: string;
            conflictedFiles: string[];
            testCommand?: string;
          }) => Promise<string>;
        }
      ).buildMergerPrompt({
        projectId: "proj-123",
        cwd: "/tmp/repo",
        config: { type: "cursor", model: null, cliCommand: null },
        phase: "merge_to_main",
        taskId: "os-1",
        branchName: "opensprint/os-1",
        conflictedFiles: ["src/conflict.ts"],
        testCommand: "npm test",
      });

      expect(prompt).toContain("Do NOT run destructive cleanup commands");
      expect(prompt).toContain("git clean -fdx");
    });

    it("returns true when merger agent exits with code 0", async () => {
      mockSpawnWithTaskFile.mockImplementation(
        (
          _config: unknown,
          _path: unknown,
          _cwd: unknown,
          onOutput: (chunk: string) => void,
          onExit: (code: number | null) => void
        ) => {
          setImmediate(() => {
            onOutput("Resolved conflict in src/conflict.ts\n");
            onExit(0);
          });
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
      const sessionInsert = mockDbClient.execute.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO agent_sessions")
      );
      expect(sessionInsert).toBeDefined();
      const sessionParams = sessionInsert?.[1] as unknown[];
      expect(sessionParams[0]).toBe("proj-123");
      expect(sessionParams[2]).toBe(1);
      expect(sessionParams[3]).toBe("cursor");
      expect(sessionParams[7]).toBe("success");
      expect(String(sessionParams[8])).toContain("Resolved conflict in src/conflict.ts");
    });

    it("returns false when merger agent exits with non-zero code", async () => {
      mockSpawnWithTaskFile.mockImplementation(
        (
          _config: unknown,
          _path: unknown,
          _cwd: unknown,
          _onOutput: unknown,
          onExit: (code: number | null) => void
        ) => {
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
      const sessionInsert = mockDbClient.execute.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO agent_sessions")
      );
      expect(sessionInsert).toBeDefined();
      const sessionParams = sessionInsert?.[1] as unknown[];
      expect(sessionParams[0]).toBe("proj-123");
      expect(sessionParams[3]).toBe("claude");
      expect(sessionParams[7]).toBe("failed");
      expect(String(sessionParams[8]).length).toBeGreaterThan(0);
    });

    it("uses baseBranch in merger prompt when provided", async () => {
      mockSpawnWithTaskFile.mockImplementation(
        (
          _config: unknown,
          _path: unknown,
          _cwd: unknown,
          _onOutput: unknown,
          onExit: (code: number | null) => void
        ) => {
          setImmediate(() => onExit(0));
          return { kill: vi.fn(), pid: 12345 };
        }
      );
      mockShellExec.mockResolvedValue({ stdout: "", stderr: "" });

      await service.runMergerAgentAndWait({
        projectId: "proj-123",
        cwd: "/tmp/repo",
        config: { type: "cursor", model: null, cliCommand: null },
        phase: "merge_to_main",
        taskId: "os-1",
        branchName: "opensprint/os-1",
        conflictedFiles: ["src/a.ts"],
        baseBranch: "develop",
      });

      const logCalls = mockShellExec.mock.calls.filter((c) => String(c[0]).includes("git log"));
      const diffCalls = mockShellExec.mock.calls.filter((c) => String(c[0]).includes("git diff"));
      expect(logCalls.some((c) => String(c[0]).includes("develop"))).toBe(true);
      expect(diffCalls.some((c) => String(c[0]).includes("develop"))).toBe(true);
    });

    it("prepends combined agent instructions for merger role to the merger prompt", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-merger-prompt-test-"));
      try {
        await fs.writeFile(path.join(tempDir, "AGENTS.md"), "General agent instructions.", "utf-8");
        await fs.mkdir(path.join(tempDir, OPENSPRINT_PATHS.agents), { recursive: true });
        await fs.writeFile(
          path.join(tempDir, OPENSPRINT_PATHS.agents, "merger.md"),
          "Merger-specific: prefer preserving both sides.",
          "utf-8"
        );

        let writtenPrompt = "";
        mockSpawnWithTaskFile.mockImplementation(
          (
            _config: unknown,
            promptPath: string,
            _cwd: unknown,
            _onOutput: unknown,
            onExit: (code: number | null) => void
          ) => {
            writtenPrompt = fsSync.readFileSync(promptPath, "utf-8");
            setImmediate(() => onExit(0));
            return { kill: vi.fn(), pid: 12345 };
          }
        );
        mockShellExec.mockResolvedValue({ stdout: "", stderr: "" });

        await service.runMergerAgentAndWait({
          projectId: "proj-123",
          cwd: tempDir,
          config: { type: "cursor", model: null, cliCommand: null },
          phase: "merge_to_main",
          taskId: "os-1",
          branchName: "opensprint/os-1",
          conflictedFiles: ["src/a.ts"],
        });

        expect(writtenPrompt).toContain("## Agent Instructions");
        expect(writtenPrompt).toContain("General agent instructions.");
        expect(writtenPrompt).toContain("## Role-specific Instructions");
        expect(writtenPrompt).toContain("Merger-specific: prefer preserving both sides.");
        expect(writtenPrompt).toContain("# Merger Agent: Resolve Git Conflicts");
        expect(writtenPrompt.indexOf("## Agent Instructions")).toBeLessThan(
          writtenPrompt.indexOf("# Merger Agent: Resolve Git Conflicts")
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("invokePlanningAgent (Claude + ApiKeyResolver)", () => {
    const projectId = "proj-123";
    const claudeConfig: AgentConfig = {
      type: "claude",
      model: "claude-sonnet-4",
      cliCommand: null,
    };

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
      expect(mockClearLimitHit).toHaveBeenCalledWith(
        projectId,
        "ANTHROPIC_API_KEY",
        "k1",
        "global"
      );
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
      expect(mockRecordLimitHit).toHaveBeenCalledWith(
        projectId,
        "ANTHROPIC_API_KEY",
        "k1",
        "project"
      );
      expect(mockClearLimitHit).toHaveBeenCalledWith(
        projectId,
        "ANTHROPIC_API_KEY",
        "k2",
        "project"
      );
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
          finalMessage: () => Promise.resolve({ content: [{ type: "text", text: "Hello world" }] }),
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
      expect(mockClearLimitHit).toHaveBeenCalledWith(
        projectId,
        "ANTHROPIC_API_KEY",
        "k1",
        "global"
      );
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
