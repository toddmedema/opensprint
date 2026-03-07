import { describe, it, expect, vi, beforeEach } from "vitest";
import OpenAI from "openai";
import { AgentClient } from "../services/agent-client.js";
import type { AgentConfig } from "@opensprint/shared";
import {
  registerAgentProcess,
  unregisterAgentProcess,
} from "../services/agent-process-registry.js";

// Mock child_process
const mockExec = vi.fn();
const mockSpawn = vi.fn();

vi.mock("child_process", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("../services/agent-process-registry.js", () => ({
  registerAgentProcess: vi.fn(),
  unregisterAgentProcess: vi.fn(),
}));

const { mockGetNextKey, mockRecordLimitHit, mockRecordInvalidKey, mockClearLimitHit } = vi.hoisted(() => ({
  mockGetNextKey: vi.fn(),
  mockRecordLimitHit: vi.fn(),
  mockRecordInvalidKey: vi.fn(),
  mockClearLimitHit: vi.fn(),
}));

const { mockOpenAICreate, mockOpenAIResponsesCreate } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
  mockOpenAIResponsesCreate: vi.fn(),
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

vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: (...args: unknown[]) => mockGetNextKey(...args),
  recordLimitHit: (...args: unknown[]) => mockRecordLimitHit(...args),
  recordInvalidKey: (...args: unknown[]) => mockRecordInvalidKey(...args),
  clearLimitHit: (...args: unknown[]) => mockClearLimitHit(...args),
  ENV_FALLBACK_KEY_ID: "__env__",
}));

const { mockGeminiGenerateContent, mockGeminiGenerateContentStream } = vi.hoisted(() => ({
  mockGeminiGenerateContent: vi.fn(),
  mockGeminiGenerateContentStream: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: (opts: { contents: unknown }) => mockGeminiGenerateContent(opts.contents),
      generateContentStream: (opts: { contents: unknown }) =>
        Promise.resolve(mockGeminiGenerateContentStream(opts.contents)),
    },
  })),
}));

vi.mock("util", () => ({
  promisify: (
    _fn: (
      cmd: string,
      opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => void
  ) => {
    return (cmd: string, opts?: unknown) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        mockExec(cmd, opts, (err: Error | null, stdout?: string, stderr?: string) => {
          if (err) reject(err);
          else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        });
      });
  },
}));

describe("AgentClient", () => {
  let client: AgentClient;

  beforeEach(() => {
    client = new AgentClient();
    vi.clearAllMocks();
  });

  describe("invoke", () => {
    it("should route claude config to Claude CLI via spawn (not exec)", async () => {
      const mockChild = {
        killed: false,
        kill: vi.fn(),
        pid: 12345,
        stdout: {
          on: vi.fn((_ev: string, fn: (d: Buffer) => void) => fn(Buffer.from("Claude response"))),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((ev: string, fn: (code: number) => void) => {
          if (ev === "close") setTimeout(() => fn(0), 0);
          if (ev === "error") return;
          return { on: vi.fn() };
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      const result = await client.invoke({
        config: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          "--model",
          "claude-sonnet-4",
          "--print",
          expect.stringContaining("Human: Hello"),
        ]),
        expect.objectContaining({ cwd: "/tmp", stdio: ["ignore", "pipe", "pipe"], detached: true })
      );
      expect(mockExec).not.toHaveBeenCalled();
      expect(result.content).toContain("Claude response");
      expect(registerAgentProcess).toHaveBeenCalledWith(12345, { processGroup: true });
      expect(unregisterAgentProcess).toHaveBeenCalledWith(12345, { processGroup: true });
    });

    it("should route claude config without model", async () => {
      const mockChild = {
        killed: false,
        kill: vi.fn(),
        pid: 12346,
        stdout: {
          on: vi.fn((_ev: string, fn: (d: Buffer) => void) => fn(Buffer.from("Claude no-model"))),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((ev: string, fn: (code: number) => void) => {
          if (ev === "close") setTimeout(() => fn(0), 0);
          return { on: vi.fn() };
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      const result = await client.invoke({
        config: { type: "claude", model: null, cliCommand: null },
        prompt: "Test",
        cwd: "/work",
      });

      const args = mockSpawn.mock.calls[0][1];
      expect(args[0]).toBe("--print");
      expect(args).not.toContain("--model");
      expect(result.content).toContain("Claude no-model");
    });

    it("should route cursor config to Cursor CLI", async () => {
      const mockChild = {
        killed: false,
        kill: vi.fn(),
        stdout: {
          on: vi.fn((_ev: string, fn: (d: Buffer) => void) => fn(Buffer.from("Cursor response"))),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((ev: string, fn: (code: number) => void) => {
          if (ev === "close") setTimeout(() => fn(0), 0);
          if (ev === "error") return;
          return { on: vi.fn() };
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      const result = await client.invoke({
        config: { type: "cursor", model: "gpt-4", cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "agent",
        expect.any(Array),
        expect.objectContaining({ cwd: "/tmp" })
      );
      expect(result.content).toContain("Cursor response");
    });

    it("should map cursor null model to explicit auto", async () => {
      const mockChild = {
        killed: false,
        kill: vi.fn(),
        stdout: {
          on: vi.fn((_ev: string, fn: (d: Buffer) => void) => fn(Buffer.from("Cursor response"))),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((ev: string, fn: (code: number) => void) => {
          if (ev === "close") setTimeout(() => fn(0), 0);
          return { on: vi.fn() };
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      const result = await client.invoke({
        config: { type: "cursor", model: null, cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
      });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const modelIndex = args.indexOf("--model");
      expect(modelIndex).toBeGreaterThanOrEqual(0);
      expect(args[modelIndex + 1]).toBe("auto");
      expect(result.content).toContain("Cursor response");
    });

    it("should use ApiKeyResolver when projectId provided for cursor", async () => {
      mockGetNextKey.mockResolvedValue({
        key: "cursor-key-from-resolver",
        keyId: "k1",
        source: "global",
      });
      const mockChild = {
        killed: false,
        kill: vi.fn(),
        stdout: {
          on: vi.fn((_ev: string, fn: (d: Buffer) => void) => fn(Buffer.from("Cursor response"))),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((ev: string, fn: (code: number) => void) => {
          if (ev === "close") setTimeout(() => fn(0), 0);
          return { on: vi.fn() };
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      const result = await client.invoke({
        config: { type: "cursor", model: "gpt-4", cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
        projectId: "proj-123",
      });

      expect(mockGetNextKey).toHaveBeenCalledWith("proj-123", "CURSOR_API_KEY");
      expect(mockClearLimitHit).toHaveBeenCalledWith("proj-123", "CURSOR_API_KEY", "k1", "global");
      expect(mockSpawn).toHaveBeenCalledWith(
        "agent",
        expect.any(Array),
        expect.objectContaining({
          cwd: "/tmp",
          env: expect.objectContaining({ CURSOR_API_KEY: "cursor-key-from-resolver" }),
        })
      );
      expect(result.content).toContain("Cursor response");
    });

    it("should recordLimitHit and retry on limit error when projectId provided", async () => {
      mockGetNextKey
        .mockResolvedValueOnce({ key: "key1", keyId: "k1", source: "project" })
        .mockResolvedValueOnce({ key: "key2", keyId: "k2", source: "project" });
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const mockChild = {
          killed: false,
          kill: vi.fn(),
          stdout: { on: vi.fn() },
          stderr: {
            on: vi.fn((_ev: string, fn: (d: Buffer) => void) =>
              fn(Buffer.from("rate limit exceeded"))
            ),
          },
          on: vi.fn((ev: string, fn: (code: number) => void) => {
            if (ev === "close") setTimeout(() => fn(1), 0);
            return { on: vi.fn() };
          }),
        };
        if (callCount === 1) {
          return mockChild;
        }
        return {
          ...mockChild,
          stdout: {
            on: vi.fn((_ev: string, fn: (d: Buffer) => void) => fn(Buffer.from("Success"))),
          },
          on: vi.fn((ev: string, fn: (code: number) => void) => {
            if (ev === "close") setTimeout(() => fn(0), 0);
            return { on: vi.fn() };
          }),
        };
      });

      const result = await client.invoke({
        config: { type: "cursor", model: null, cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
        projectId: "proj-123",
      });

      expect(mockGetNextKey).toHaveBeenCalledTimes(2);
      expect(mockRecordLimitHit).toHaveBeenCalledWith(
        "proj-123",
        "CURSOR_API_KEY",
        "k1",
        "project"
      );
      expect(mockClearLimitHit).toHaveBeenCalledWith("proj-123", "CURSOR_API_KEY", "k2", "project");
      expect(result.content).toContain("Success");
    });

    it("should route openai config to OpenAI API", async () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: "OpenAI coding response" } }],
      });

      const result = await client.invoke({
        config: { type: "openai", model: "gpt-4o", cliCommand: null },
        prompt: "Implement login",
        cwd: "/tmp",
      });

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-4o",
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "user", content: "Implement login" }),
          ]),
          max_tokens: 8192,
        })
      );
      expect(result.content).toBe("OpenAI coding response");
      delete process.env.OPENAI_API_KEY;
    });

    it("should route codex OpenAI models to the Responses API", async () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      mockOpenAIResponsesCreate.mockResolvedValue({
        output_text: "Codex coding response",
      });

      const result = await client.invoke({
        config: { type: "openai", model: "gpt-5.3-codex", cliCommand: null },
        prompt: "Implement login",
        cwd: "/tmp",
      });

      expect(mockOpenAICreate).not.toHaveBeenCalled();
      expect(mockOpenAIResponsesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.3-codex",
          input: [expect.objectContaining({ role: "user", content: "Implement login" })],
          max_output_tokens: 8192,
        })
      );
      expect(result.content).toBe("Codex coding response");
      delete process.env.OPENAI_API_KEY;
    });

    it("should use ApiKeyResolver when projectId provided for openai", async () => {
      mockGetNextKey.mockResolvedValue({ key: "sk-openai-key", keyId: "k1", source: "global" });
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: "OpenAI response" } }],
      });

      const result = await client.invoke({
        config: { type: "openai", model: "gpt-4o-mini", cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
        projectId: "proj-456",
      });

      expect(mockGetNextKey).toHaveBeenCalledWith("proj-456", "OPENAI_API_KEY");
      expect(mockClearLimitHit).toHaveBeenCalledWith("proj-456", "OPENAI_API_KEY", "k1", "global");
      expect(result.content).toBe("OpenAI response");
    });

    it("should recordLimitHit and retry on limit error for openai", async () => {
      mockGetNextKey
        .mockResolvedValueOnce({ key: "sk-key1", keyId: "k1", source: "global" })
        .mockResolvedValueOnce({ key: "sk-key2", keyId: "k2", source: "global" });
      mockOpenAICreate
        .mockRejectedValueOnce(new Error("rate_limit_exceeded"))
        .mockResolvedValueOnce({
          choices: [{ message: { content: "Retry success" } }],
        });

      const result = await client.invoke({
        config: { type: "openai", model: "gpt-4o", cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
        projectId: "proj-789",
      });

      expect(mockGetNextKey).toHaveBeenCalledTimes(2);
      expect(mockRecordLimitHit).toHaveBeenCalledWith("proj-789", "OPENAI_API_KEY", "k1", "global");
      expect(mockClearLimitHit).toHaveBeenCalledWith("proj-789", "OPENAI_API_KEY", "k2", "global");
      expect(result.content).toBe("Retry success");
    });

    it("should route google config to Gemini API", async () => {
      mockGetNextKey.mockResolvedValue({ key: "gemini-key", keyId: "k1", source: "global" });
      mockGeminiGenerateContent.mockResolvedValue({ text: "Gemini planning response" });

      const result = await client.invoke({
        config: { type: "google", model: "gemini-1.5-flash", cliCommand: null },
        prompt: "Plan the feature",
        systemPrompt: "You are a planner.",
        cwd: "/tmp",
        projectId: "proj-gemini",
      });

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockGetNextKey).toHaveBeenCalledWith("proj-gemini", "GOOGLE_API_KEY");
      expect(mockGeminiGenerateContent).toHaveBeenCalled();
      expect(mockClearLimitHit).toHaveBeenCalledWith(
        "proj-gemini",
        "GOOGLE_API_KEY",
        "k1",
        "global"
      );
      expect(result.content).toBe("Gemini planning response");
    });

    it("should use safeGeminiText when Gemini response has no text (blocked)", async () => {
      mockGetNextKey.mockResolvedValue({ key: "gemini-key", keyId: "k1", source: "global" });
      const responseWithNoText = {
        text: () => {
          throw new Error(
            "The `response.text` quick accessor requires the response to contain a valid `Part`"
          );
        },
      };
      mockGeminiGenerateContent.mockResolvedValue(responseWithNoText);

      const result = await client.invoke({
        config: { type: "google", model: "gemini-1.5-pro", cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
        projectId: "proj-blocked",
      });

      expect(result.content).toBe("");
    });

    it("should route custom config to Custom CLI", async () => {
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (err: null, stdout: string) => void) => {
          cb(null, "Custom agent response");
        }
      );

      const result = await client.invoke({
        config: { type: "custom", model: null, cliCommand: "my-agent" },
        prompt: "Hello",
        cwd: "/tmp",
      });

      expect(mockExec).toHaveBeenCalled();
      expect(result.content).toBe("Custom agent response");
    });

    it("should throw for custom agent when cliCommand is missing", async () => {
      await expect(
        client.invoke({
          config: { type: "custom", model: null, cliCommand: null },
          prompt: "Hello",
        })
      ).rejects.toThrow("Custom agent requires a CLI command");
    });

    it("should throw for unsupported agent type", async () => {
      await expect(
        client.invoke({
          config: { type: "invalid" as AgentConfig["type"], model: null, cliCommand: null },
          prompt: "Hello",
        })
      ).rejects.toThrow("Unsupported agent type");
    });

    it("should route lmstudio config to LM Studio API with default baseURL and model", async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: "LM Studio response" } }],
      });

      const result = await client.invoke({
        config: { type: "lmstudio", model: null, cliCommand: null },
        prompt: "Hello",
        cwd: "/tmp",
      });

      expect(mockGetNextKey).not.toHaveBeenCalled();
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "http://localhost:1234/v1",
          apiKey: "lm-studio",
        })
      );
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "local",
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "user", content: "Hello" }),
          ]),
          max_tokens: 8192,
        })
      );
      expect(result.content).toBe("LM Studio response");
    });

    it("should route lmstudio config with custom baseUrl and model", async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: "Custom LM Studio" } }],
      });

      await client.invoke({
        config: {
          type: "lmstudio",
          model: "my-model",
          cliCommand: null,
          baseUrl: "http://127.0.0.1:5678",
        },
        prompt: "Hi",
        cwd: "/tmp",
      });

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "http://127.0.0.1:5678/v1",
          apiKey: "lm-studio",
        })
      );
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: "my-model" })
      );
    });

    it("should throw user-facing message when LM Studio is unreachable", async () => {
      mockOpenAICreate.mockRejectedValue(Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }));

      await expect(
        client.invoke({
          config: { type: "lmstudio", model: "local", cliCommand: null },
          prompt: "Hello",
        })
      ).rejects.toThrow("LM Studio is not running");

      expect(mockGetNextKey).not.toHaveBeenCalled();
    });

    it("should stream LM Studio response when onChunk is provided", async () => {
      mockOpenAICreate.mockImplementation(async (opts: { stream?: boolean }) => {
        if (opts?.stream) {
          async function* stream() {
            yield { choices: [{ delta: { content: "Streamed " } }] };
            yield { choices: [{ delta: { content: "response" } }] };
          }
          return stream();
        }
        return { choices: [{ message: { content: "fallback" } }] };
      });

      const onChunk = vi.fn();
      const result = await client.invoke({
        config: { type: "lmstudio", model: "local", cliCommand: null },
        prompt: "Hi",
        onChunk,
      });

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: "local", stream: true, max_tokens: 8192 })
      );
      expect(onChunk).toHaveBeenCalledWith("Streamed ");
      expect(onChunk).toHaveBeenCalledWith("response");
      expect(result.content).toBe("Streamed response");
    });
  });

  describe("spawnWithTaskFile", () => {
    it("should spawn Cursor agent with task content and workspace", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-cursor-${Date.now()}`);
      await fs.mkdir(path.dirname(path.join(tmpDir, ".opensprint/active/bd-a3f8.1/prompt.md")), {
        recursive: true,
      });
      const taskFilePath = path.join(tmpDir, ".opensprint/active/bd-a3f8.1/prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nImplement login", "utf-8");

      const mockChild = {
        killed: false,
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(() => ({ on: vi.fn() })),
      };
      mockSpawn.mockReturnValue(mockChild);

      const config: AgentConfig = { type: "cursor", model: "gpt-4", cliCommand: null };
      const cwd = tmpDir;
      const onOutput = vi.fn();
      const onExit = vi.fn();

      const { kill } = client.spawnWithTaskFile(config, taskFilePath, cwd, onOutput, onExit);

      expect(mockSpawn).toHaveBeenCalledWith(
        "agent",
        expect.arrayContaining(["--print", "--workspace", cwd, "--trust"]),
        expect.any(Object)
      );
      expect(kill).toBeDefined();

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should pass --model auto for Cursor task-file spawn when model is null", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-cursor-auto-${Date.now()}`);
      await fs.mkdir(path.dirname(path.join(tmpDir, ".opensprint/active/bd-a3f8.1/prompt.md")), {
        recursive: true,
      });
      const taskFilePath = path.join(tmpDir, ".opensprint/active/bd-a3f8.1/prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nImplement login", "utf-8");

      const mockChild = {
        killed: false,
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(() => ({ on: vi.fn() })),
      };
      mockSpawn.mockReturnValue(mockChild);

      const config: AgentConfig = { type: "cursor", model: null, cliCommand: null };
      client.spawnWithTaskFile(config, taskFilePath, tmpDir, vi.fn(), vi.fn());

      const args = mockSpawn.mock.calls[0][1] as string[];
      const modelIndex = args.indexOf("--model");
      expect(modelIndex).toBeGreaterThanOrEqual(0);
      expect(args[modelIndex + 1]).toBe("auto");

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should spawn custom agent with cliCommand and task file path", () => {
      const mockChild = {
        killed: false,
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(() => ({ on: vi.fn() })),
      };
      mockSpawn.mockReturnValue(mockChild);

      const config: AgentConfig = { type: "custom", model: null, cliCommand: "my-cli --verbose" };
      const taskFilePath = "/proj/.opensprint/active/bd-a3f8.1/prompt.md";
      const cwd = "/proj";
      const onOutput = vi.fn();
      const onExit = vi.fn();

      client.spawnWithTaskFile(config, taskFilePath, cwd, onOutput, onExit);

      expect(mockSpawn).toHaveBeenCalledWith(
        "my-cli",
        ["--verbose", taskFilePath],
        expect.objectContaining({ cwd })
      );
    });

    it("should throw for custom agent when cliCommand is missing", () => {
      const config: AgentConfig = { type: "custom", model: null, cliCommand: null };
      const taskFilePath = "/proj/.opensprint/active/bd-a3f8.1/prompt.md";
      const cwd = "/proj";
      const onOutput = vi.fn();
      const onExit = vi.fn();

      expect(() => client.spawnWithTaskFile(config, taskFilePath, cwd, onOutput, onExit)).toThrow(
        "Custom agent requires a CLI command"
      );
    });

    it("should run OpenAI in-process for spawnWithTaskFile (no subprocess)", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-openai-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/os-abc.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nAdd a button", "utf-8");

      mockGetNextKey.mockResolvedValue({ key: "sk-openai-spawn", keyId: "k1", source: "global" });
      mockOpenAICreate.mockImplementation(async () => {
        async function* stream() {
          yield { choices: [{ delta: { content: "Here " } }] };
          yield { choices: [{ delta: { content: "is " } }] };
          yield { choices: [{ delta: { content: "the code." } }] };
        }
        return stream();
      });

      const onOutput = vi.fn();
      const onExit = vi.fn();
      const config: AgentConfig = { type: "openai", model: "gpt-4o-mini", cliCommand: null };

      const { kill, pid } = client.spawnWithTaskFile(
        config,
        taskFilePath,
        tmpDir,
        onOutput,
        onExit,
        "coder",
        undefined,
        "proj-openai"
      );

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(pid).toBeNull();
      expect(kill).toBeDefined();

      await vi.waitFor(
        () => {
          expect(onExit).toHaveBeenCalledWith(0);
        },
        { timeout: 2000 }
      );
      expect(onOutput).toHaveBeenCalled();
      expect(mockClearLimitHit).toHaveBeenCalledWith(
        "proj-openai",
        "OPENAI_API_KEY",
        "k1",
        "global"
      );

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("rotates to next OpenAI key when first key is invalid in spawnWithTaskFile", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-openai-auth-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/os-auth.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nHandle auth retry", "utf-8");

      mockGetNextKey
        .mockResolvedValueOnce({ key: "sk-openai-bad", keyId: "k1", source: "global" })
        .mockResolvedValueOnce({ key: "sk-openai-good", keyId: "k2", source: "global" });
      mockOpenAICreate
        .mockRejectedValueOnce(new Error("401 invalid_api_key"))
        .mockImplementationOnce(async () => {
          async function* stream() {
            yield { choices: [{ delta: { content: "Recovered output" } }] };
          }
          return stream();
        });

      const onOutput = vi.fn();
      const onExit = vi.fn();
      const config: AgentConfig = { type: "openai", model: "gpt-4o-mini", cliCommand: null };

      client.spawnWithTaskFile(
        config,
        taskFilePath,
        tmpDir,
        onOutput,
        onExit,
        "coder",
        undefined,
        "proj-openai-auth"
      );

      await vi.waitFor(
        () => {
          expect(onExit).toHaveBeenCalledWith(0);
        },
        { timeout: 2000 }
      );

      expect(mockGetNextKey).toHaveBeenCalledTimes(2);
      expect(mockRecordInvalidKey).toHaveBeenCalledWith(
        "proj-openai-auth",
        "OPENAI_API_KEY",
        "k1",
        "global"
      );
      expect(mockClearLimitHit).toHaveBeenCalledWith(
        "proj-openai-auth",
        "OPENAI_API_KEY",
        "k2",
        "global"
      );

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should run Google Gemini in-process for spawnWithTaskFile (no subprocess)", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-google-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/os-xyz.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nImplement login", "utf-8");

      mockGetNextKey.mockResolvedValue({ key: "gemini-spawn-key", keyId: "k1", source: "global" });
      async function* geminiStream() {
        yield { text: "First " };
        yield { text: "chunk." };
      }
      mockGeminiGenerateContentStream.mockReturnValue(geminiStream());

      const onOutput = vi.fn();
      const onExit = vi.fn();
      const config: AgentConfig = { type: "google", model: "gemini-1.5-flash", cliCommand: null };

      const { kill, pid } = client.spawnWithTaskFile(
        config,
        taskFilePath,
        tmpDir,
        onOutput,
        onExit,
        "coder",
        undefined,
        "proj-google"
      );

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(pid).toBeNull();
      expect(kill).toBeDefined();

      await vi.waitFor(
        () => {
          expect(onExit).toHaveBeenCalledWith(0);
        },
        { timeout: 2000 }
      );
      expect(mockGeminiGenerateContentStream).toHaveBeenCalledWith("# Task\n\nImplement login");
      expect(onOutput).toHaveBeenCalledWith("First ");
      expect(onOutput).toHaveBeenCalledWith("chunk.");
      expect(mockClearLimitHit).toHaveBeenCalledWith(
        "proj-google",
        "GOOGLE_API_KEY",
        "k1",
        "global"
      );

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should run LM Studio in-process for spawnWithTaskFile (no subprocess, no API key)", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-lmstudio-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/os-lm.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nUse LM Studio", "utf-8");

      mockOpenAICreate.mockImplementation(async () => {
        async function* stream() {
          yield { choices: [{ delta: { content: "LM " } }] };
          yield { choices: [{ delta: { content: "Studio " } }] };
          yield { choices: [{ delta: { content: "stream." } }] };
        }
        return stream();
      });

      const onOutput = vi.fn();
      const onExit = vi.fn();
      const config: AgentConfig = {
        type: "lmstudio",
        model: "local",
        cliCommand: null,
        baseUrl: "http://localhost:1234",
      };

      const { kill, pid } = client.spawnWithTaskFile(
        config,
        taskFilePath,
        tmpDir,
        onOutput,
        onExit,
        "coder",
        undefined,
        undefined
      );

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockGetNextKey).not.toHaveBeenCalled();
      expect(pid).toBeNull();
      expect(kill).toBeDefined();

      await vi.waitFor(
        () => {
          expect(onExit).toHaveBeenCalledWith(0);
        },
        { timeout: 2000 }
      );
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "http://localhost:1234/v1",
          apiKey: "lm-studio",
        })
      );
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "local",
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "user", content: "# Task\n\nUse LM Studio" }),
          ]),
          stream: true,
          max_tokens: 16384,
        })
      );
      expect(onOutput).toHaveBeenCalledWith("LM ");
      expect(onOutput).toHaveBeenCalledWith("Studio ");
      expect(onOutput).toHaveBeenCalledWith("stream.");

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should run codex OpenAI models in-process via the Responses API", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-openai-codex-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/os-abc.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nAdd a button", "utf-8");

      mockGetNextKey.mockResolvedValue({ key: "sk-openai-spawn", keyId: "k1", source: "global" });
      mockOpenAIResponsesCreate.mockImplementation(async () => {
        async function* stream() {
          yield { type: "response.output_text.delta", delta: "Here " };
          yield { type: "response.output_text.delta", delta: "is " };
          yield { type: "response.output_text.delta", delta: "the code." };
        }
        return stream();
      });

      const onOutput = vi.fn();
      const onExit = vi.fn();
      const config: AgentConfig = { type: "openai", model: "gpt-5.3-codex", cliCommand: null };

      const { pid } = client.spawnWithTaskFile(
        config,
        taskFilePath,
        tmpDir,
        onOutput,
        onExit,
        "coder",
        undefined,
        "proj-openai"
      );

      expect(pid).toBeNull();

      await vi.waitFor(
        () => {
          expect(onExit).toHaveBeenCalledWith(0);
        },
        { timeout: 2000 }
      );
      expect(mockOpenAICreate).not.toHaveBeenCalled();
      expect(mockOpenAIResponsesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.3-codex",
          instructions: expect.stringContaining("coding agent"),
          input: [expect.objectContaining({ role: "user", content: "# Task\n\nAdd a button" })],
          max_output_tokens: 16384,
          stream: true,
        })
      );

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should use outputLogPath and pass file fd to spawn for streaming to file", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-output-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/bd-a3f8.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nFix bug", "utf-8");
      const outputLogPath = path.join(taskDir, "output.log");

      const mockChild = {
        killed: false,
        kill: vi.fn(),
        pid: 9999,
        stdout: { on: vi.fn(), removeAllListeners: vi.fn() },
        stderr: { on: vi.fn(), removeAllListeners: vi.fn() },
        on: vi.fn((ev: string, fn: () => void) => {
          if (ev === "close") setTimeout(() => fn(), 10);
          return { on: vi.fn(), removeAllListeners: vi.fn() };
        }),
        removeAllListeners: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockChild);

      const config: AgentConfig = { type: "cursor", model: "gpt-4", cliCommand: null };
      const onOutput = vi.fn();
      const onExit = vi.fn();

      client.spawnWithTaskFile(
        config,
        taskFilePath,
        tmpDir,
        onOutput,
        onExit,
        "coder",
        outputLogPath
      );

      expect(mockSpawn).toHaveBeenCalledWith(
        "agent",
        expect.any(Array),
        expect.objectContaining({
          cwd: tmpDir,
          stdio: ["ignore", expect.any(Number), expect.any(Number)],
        })
      );
      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.stdio[1]).toBe(spawnOpts.stdio[2]);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("does not recordLimitHit when detached output only mentions rate limits in normal text", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-output-fp-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/bd-a3f8.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nFix bug", "utf-8");
      const outputLogPath = path.join(taskDir, "output.log");

      mockGetNextKey.mockResolvedValue({ key: "cursor-key", keyId: "k1", source: "global" });

      const mockChild = {
        killed: false,
        kill: vi.fn(),
        pid: 10001,
        stdout: { on: vi.fn(), removeAllListeners: vi.fn() },
        stderr: { on: vi.fn(), removeAllListeners: vi.fn() },
        on: vi.fn((ev: string, fn: (code?: number) => void) => {
          if (ev === "close") setTimeout(() => fn(1), 20);
          return { on: vi.fn(), removeAllListeners: vi.fn() };
        }),
        removeAllListeners: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockChild);

      const onOutput = vi.fn();
      const onExit = vi.fn();
      const config: AgentConfig = { type: "cursor", model: "gpt-4", cliCommand: null };

      client.spawnWithTaskFile(
        config,
        taskFilePath,
        tmpDir,
        onOutput,
        onExit,
        "coder",
        outputLogPath,
        "proj-123"
      );

      await fs.writeFile(
        outputLogPath,
        '{"type":"text","text":"We should handle rate limits gracefully in this feature."}\n',
        "utf-8"
      );

      await vi.waitFor(
        () => {
          expect(onExit).toHaveBeenCalledWith(1);
        },
        { timeout: 2000 }
      );

      expect(mockRecordLimitHit).not.toHaveBeenCalled();
      expect(mockGetNextKey).toHaveBeenCalledTimes(1);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("records limit hits for detached Cursor usage-limit messages emitted as plain text", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-output-limit-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/bd-a3f8.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task\n\nFix bug", "utf-8");
      const outputLogPath = path.join(taskDir, "output.log");

      mockGetNextKey
        .mockResolvedValueOnce({ key: "cursor-key-1", keyId: "k1", source: "global" })
        .mockResolvedValueOnce({ key: "cursor-key-2", keyId: "k2", source: "project" })
        .mockResolvedValue({ key: "cursor-key-2", keyId: "k2", source: "project" });

      const makeChild = (exitCode: number) => ({
        killed: false,
        kill: vi.fn(),
        pid: 10010 + exitCode,
        stdout: { on: vi.fn(), removeAllListeners: vi.fn() },
        stderr: { on: vi.fn(), removeAllListeners: vi.fn() },
        on: vi.fn((ev: string, fn: (code?: number) => void) => {
          if (ev === "close") setTimeout(() => fn(exitCode), 20);
          return { on: vi.fn(), removeAllListeners: vi.fn() };
        }),
        removeAllListeners: vi.fn(),
      });

      mockSpawn.mockReturnValueOnce(makeChild(1)).mockReturnValueOnce(makeChild(0));

      const onOutput = vi.fn();
      const onExit = vi.fn();
      const config: AgentConfig = { type: "cursor", model: "composer-1.5", cliCommand: null };

      client.spawnWithTaskFile(
        config,
        taskFilePath,
        tmpDir,
        onOutput,
        onExit,
        "coder",
        outputLogPath,
        "proj-123"
      );

      await fs.writeFile(
        outputLogPath,
        "S: You've hit your usage limit. Switch to Auto for more usage or set a Spend Limit to continue with this model.\n",
        "utf-8"
      );

      await vi.waitFor(
        () => {
          expect(onExit).toHaveBeenCalledWith(0);
        },
        { timeout: 2000 }
      );

      expect(mockRecordLimitHit).toHaveBeenCalledWith("proj-123", "CURSOR_API_KEY", "k1", "global");
      expect(mockGetNextKey).toHaveBeenCalledTimes(3);
      expect(mockClearLimitHit).toHaveBeenCalledWith("proj-123", "CURSOR_API_KEY", "k2", "project");
      expect(onOutput).toHaveBeenCalledWith(
        expect.stringContaining(
          "[Agent error: You've hit your usage limit. Switch to Auto for more usage or set a Spend Limit to continue with this model.]"
        )
      );

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should return kill that terminates process with process group", async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `agent-client-kill-${Date.now()}`);
      const taskDir = path.join(tmpDir, ".opensprint/active/bd-a3f8.1");
      await fs.mkdir(taskDir, { recursive: true });
      const taskFilePath = path.join(taskDir, "prompt.md");
      await fs.writeFile(taskFilePath, "# Task", "utf-8");

      const mockKill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const mockChild = {
        killed: false,
        kill: vi.fn(),
        pid: 7777,
        stdout: { on: vi.fn(), removeAllListeners: vi.fn() },
        stderr: { on: vi.fn(), removeAllListeners: vi.fn() },
        on: vi.fn(() => ({ on: vi.fn(), removeAllListeners: vi.fn() })),
        removeAllListeners: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockChild);

      const config: AgentConfig = { type: "cursor", model: null, cliCommand: null };
      const { kill } = client.spawnWithTaskFile(config, taskFilePath, tmpDir, vi.fn(), vi.fn());

      kill();
      expect(mockKill).toHaveBeenCalledWith(-7777, "SIGTERM");
      mockKill.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});
