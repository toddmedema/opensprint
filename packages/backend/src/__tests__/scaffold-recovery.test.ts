import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyInitError, attemptRecovery } from "../services/scaffold-recovery.service.js";
import type { InitErrorClassification } from "../services/scaffold-recovery.service.js";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    exec: vi.fn(
      (
        cmd: string,
        opts: unknown,
        cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        if (typeof opts === "function") {
          cb = opts as typeof cb;
        }
        cb(null, { stdout: "v20.0.0", stderr: "" });
      }
    ),
  };
});

const mockInvoke = vi.fn();
vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: mockInvoke,
  })),
}));

describe("classifyInitError", () => {
  it("classifies missing node", () => {
    const result = classifyInitError("node: command not found");
    expect(result.category).toBe("missing_node");
    expect(result.recoverable).toBe(true);
    expect(result.tool).toBe("node");
    expect(result.summary).toContain("Node.js");
  });

  it("classifies missing node (ENOENT)", () => {
    const result = classifyInitError("Error: ENOENT: no such file or directory, spawn node");
    expect(result.category).toBe("missing_node");
    expect(result.recoverable).toBe(true);
  });

  it("classifies missing npm", () => {
    const result = classifyInitError("npm: command not found");
    expect(result.category).toBe("missing_npm");
    expect(result.recoverable).toBe(true);
    expect(result.tool).toBe("npm");
    expect(result.summary).toContain("npm");
  });

  it("classifies npm ENOENT error", () => {
    const result = classifyInitError("npm ERR! code ENOENT some path not found");
    expect(result.category).toBe("missing_npm");
    expect(result.recoverable).toBe(true);
  });

  it("classifies missing npx", () => {
    const result = classifyInitError("npx: command not found");
    expect(result.category).toBe("missing_npx");
    expect(result.recoverable).toBe(true);
    expect(result.tool).toBe("npx");
    expect(result.summary).toContain("npx");
  });

  it("classifies missing expo CLI", () => {
    const result = classifyInitError("expo: command not found");
    expect(result.category).toBe("missing_expo_cli");
    expect(result.recoverable).toBe(true);
    expect(result.tool).toBe("expo");
    expect(result.summary).toContain("Expo");
  });

  it("classifies create-expo-app not found", () => {
    const result = classifyInitError("create-expo-app not found in path");
    expect(result.category).toBe("missing_expo_cli");
    expect(result.recoverable).toBe(true);
  });

  it("classifies permission denied (EACCES)", () => {
    const result = classifyInitError("Error: EACCES: permission denied, mkdir '/usr/lib'");
    expect(result.category).toBe("permission_denied");
    expect(result.recoverable).toBe(true);
    expect(result.summary).toContain("Permission denied");
  });

  it("classifies permission denied (EPERM)", () => {
    const result = classifyInitError("Error: EPERM: operation not permitted");
    expect(result.category).toBe("permission_denied");
    expect(result.recoverable).toBe(true);
  });

  it("classifies network error (ENOTFOUND)", () => {
    const result = classifyInitError("Error: getaddrinfo ENOTFOUND registry.npmjs.org");
    expect(result.category).toBe("network_error");
    expect(result.recoverable).toBe(false);
    expect(result.summary).toContain("Network");
  });

  it("classifies network error (ETIMEDOUT)", () => {
    const result = classifyInitError("Error: connect ETIMEDOUT 104.16.0.35:443");
    expect(result.category).toBe("network_error");
    expect(result.recoverable).toBe(false);
  });

  it("classifies network error (EAI_AGAIN)", () => {
    const result = classifyInitError("Error: getaddrinfo EAI_AGAIN registry.npmjs.org");
    expect(result.category).toBe("network_error");
    expect(result.recoverable).toBe(false);
  });

  it("classifies unknown errors", () => {
    const result = classifyInitError("Some totally unexpected error");
    expect(result.category).toBe("unknown");
    expect(result.recoverable).toBe(false);
    expect(result.summary).toContain("unexpected");
  });

  it("truncates long error output", () => {
    const longError = "x".repeat(5000) + " node: command not found";
    const result = classifyInitError(longError);
    expect(result.rawError.length).toBeLessThanOrEqual(2000);
  });

  it("returns rawError from input", () => {
    const result = classifyInitError("npm: command not found\nsome extra context");
    expect(result.rawError).toContain("npm: command not found");
    expect(result.rawError).toContain("some extra context");
  });
});

describe("attemptRecovery", () => {
  const agentConfig = { type: "cursor" as const, model: "gpt-4", cliCommand: null };

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("returns failure for non-recoverable errors", async () => {
    const classification: InitErrorClassification = {
      category: "network_error",
      recoverable: false,
      summary: "Network error — check your internet connection",
      rawError: "ENOTFOUND registry.npmjs.org",
    };

    const result = await attemptRecovery(classification, "/tmp/project", agentConfig);
    expect(result.success).toBe(false);
    expect(result.category).toBe("network_error");
    expect(result.errorMessage).toContain("manual intervention");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes agent for recoverable errors", async () => {
    mockInvoke.mockResolvedValue({ content: "Installed node successfully" });

    const classification: InitErrorClassification = {
      category: "missing_node",
      recoverable: true,
      tool: "node",
      summary: "Node.js is not installed or not in PATH",
      rawError: "node: command not found",
    };

    const result = await attemptRecovery(classification, "/tmp/project", agentConfig);
    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.category).toBe("missing_node");
    expect(result.agentOutput).toBe("Installed node successfully");
  });

  it("passes correct prompt context to agent", async () => {
    mockInvoke.mockResolvedValue({ content: "Fixed" });

    const classification: InitErrorClassification = {
      category: "missing_npm",
      recoverable: true,
      tool: "npm",
      summary: "npm is not installed or not in PATH",
      rawError: "npm: command not found",
    };

    await attemptRecovery(classification, "/tmp/my-project", agentConfig);

    const call = mockInvoke.mock.calls[0][0];
    expect(call.prompt).toContain("missing_npm");
    expect(call.prompt).toContain("/tmp/my-project");
    expect(call.prompt).toContain("npm: command not found");
    expect(call.cwd).toBe("/tmp/my-project");
    expect(call.config).toBe(agentConfig);
  });

  it("returns failure when agent invocation throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Agent crashed"));

    const classification: InitErrorClassification = {
      category: "missing_npx",
      recoverable: true,
      tool: "npx",
      summary: "npx is not installed or not in PATH",
      rawError: "npx: command not found",
    };

    const result = await attemptRecovery(classification, "/tmp/project", agentConfig);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("Agent crashed");
  });

  it("returns failure when verification fails after agent runs", async () => {
    mockInvoke.mockResolvedValue({ content: "Tried to fix it" });

    const { exec: mockExec } = await import("child_process");
    (mockExec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, opts: unknown, cb: (err: Error | null) => void) => {
        if (typeof opts === "function") {
          cb = opts as typeof cb;
        }
        if (typeof cmd === "string" && cmd.includes("--version")) {
          cb(new Error("still not found"));
        } else {
          cb(null);
        }
      }
    );

    const classification: InitErrorClassification = {
      category: "missing_node",
      recoverable: true,
      tool: "node",
      summary: "Node.js is not installed or not in PATH",
      rawError: "node: command not found",
    };

    const result = await attemptRecovery(classification, "/tmp/project", agentConfig);
    expect(result.success).toBe(false);
    expect(result.agentOutput).toBe("Tried to fix it");
    expect(result.errorMessage).toContain("verification failed");
  });

  it("handles permission_denied errors (no verification command)", async () => {
    mockInvoke.mockResolvedValue({ content: "Fixed permissions" });

    const classification: InitErrorClassification = {
      category: "permission_denied",
      recoverable: true,
      summary: "Permission denied while running command",
      rawError: "EACCES: permission denied, mkdir '/tmp/project'",
    };

    const result = await attemptRecovery(classification, "/tmp/project", agentConfig);
    expect(result.success).toBe(true);
    expect(result.agentOutput).toBe("Fixed permissions");
  });
});
