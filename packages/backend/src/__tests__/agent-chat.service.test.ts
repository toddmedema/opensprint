import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import os from "node:os";
import { AgentChatService } from "../services/agent-chat.service.js";
import { ActiveAgentsService } from "../services/active-agents.service.js";
import { PendingMessageQueue, runAgenticLoop } from "../services/agentic-loop.js";

describe("durable correlated Execute guidance", () => {
  let tmpDir: string;
  let registry: ActiveAgentsService;
  let service: AgentChatService;
  let queue: PendingMessageQueue;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-"));
    registry = new ActiveAgentsService();
    service = new AgentChatService(registry, tmpDir);
    queue = new PendingMessageQueue(2);
    registry.registerChannel("task", queue, "openai", {
      projectId: "project",
      attempt: 3,
      attemptId: "run-3",
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const options = { clientMessageId: "client-1", actorId: "alice" };
  it("keeps the default journal in writable user data across working-directory changes", () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    vi.spyOn(process, "cwd").mockReturnValue(path.join(tmpDir, "installed-readonly-resources"));
    const writer = new AgentChatService(registry);
    writer.sendMessage("project", "task", "Stable history", undefined, options);
    vi.mocked(process.cwd).mockReturnValue(path.join(tmpDir, "different-working-directory"));
    expect(new AgentChatService(registry).getHistory("project", "task")[0].content).toBe(
      "Stable history"
    );
    expect(fs.existsSync(path.join(tmpDir, ".opensprint", "guidance"))).toBe(true);
  });
  it("persists queued receipt and exact model-turn inclusion using server attempt identity", () => {
    const sent = service.sendMessage("project", "task", "Fix tests", undefined, options);
    expect(sent).toMatchObject({
      status: "queued",
      clientMessageId: "client-1",
      attemptId: "run-3",
    });
    expect(service.getHistory("project", "task")[0]).toMatchObject({
      status: "queued",
      attempt: 3,
      actorId: "alice",
    });
    expect(queue.drain()[0]).toMatchObject({ messageId: sent.messageId, message: "Fix tests" });
    expect(service.getHistory("project", "task")[0].status).toBe("included");
  });
  it("scopes history and active channels by project even for the same task id", () => {
    service.sendMessage("project", "task", "A", undefined, options);
    expect(service.getHistory("other", "task")).toEqual([]);
    expect(service.sendMessage("other", "task", "B").delivered).toBe(false);
    expect(service.getActiveRun("other", "task")).toBeNull();
    expect(queue.size).toBe(1);
  });
  it("deduplicates client retries without confusing separate senders", () => {
    const first = service.sendMessage("project", "task", "A", undefined, options);
    expect(service.sendMessage("project", "task", "A", undefined, options).messageId).toBe(
      first.messageId
    );
    service.sendMessage("project", "task", "A", undefined, { ...options, actorId: "bob" });
    expect(queue.size).toBe(2);
    expect(service.getHistory("project", "task")).toHaveLength(2);
    expect(() => service.sendMessage("project", "task", "changed", undefined, options)).toThrow(
      /different guidance/
    );
  });
  it("records capacity failure without claiming inclusion", () => {
    queue.push("one");
    queue.push("two");
    expect(service.sendMessage("project", "task", "overflow", undefined, options)).toMatchObject({
      delivered: false,
      status: "failed",
    });
    expect(service.getHistory("project", "task")[0].status).toBe("failed");
  });
  it("does not enqueue when durable acceptance fails", () => {
    vi.spyOn(service, "appendMessage").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => service.sendMessage("project", "task", "A", undefined, options)).toThrow(
      "disk full"
    );
    expect(queue.size).toBe(0);
  });
  it("does not enqueue when durable queue intent fails", () => {
    const original = service.appendMessage.bind(service);
    vi.spyOn(service, "appendMessage").mockImplementation((task, message, project) => {
      if (message.status === "queued") throw new Error("disk full");
      original(task, message, project);
    });
    expect(() => service.sendMessage("project", "task", "A", undefined, options)).toThrow(
      "disk full"
    );
    expect(queue.size).toBe(0);
  });
  it("ends undrained messages on unregister and rejects further queue pushes", () => {
    service.sendMessage("project", "task", "A", undefined, options);
    registry.unregister("task");
    expect(service.getHistory("project", "task")[0].status).toBe("run-ended");
    expect(queue.push("late")).toBe(false);
  });
  it("records uncertain terminal disposition after restart without replaying to a new attempt", () => {
    service.sendMessage("project", "task", "A", undefined, options);
    const restarted = new AgentChatService(new ActiveAgentsService(), tmpDir);
    expect(restarted.getHistory("project", "task")[0]).toMatchObject({
      status: "run-ended",
      attemptId: "run-3",
    });
    expect(restarted.getHistory("project", "task")[0].error).toMatch(
      /before inclusion could be confirmed/
    );
  });
  it("never drains guidance after the last allowed model turn", async () => {
    service.sendMessage("project", "task", "A", undefined, options);
    const adapter = {
      send: vi
        .fn()
        .mockResolvedValue({ text: "", toolCalls: [{ id: "noop", name: "unknown", args: {} }] }),
    };
    await runAgenticLoop(adapter, "task", { cwd: tmpDir, maxTurns: 1, pendingMessages: queue });
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(service.getHistory("project", "task")[0].status).toBe("run-ended");
  });
  it("marks only messages submitted in the next model request included", async () => {
    service.sendMessage("project", "task", "A", undefined, options);
    const adapter = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ text: "", toolCalls: [{ id: "noop", name: "unknown", args: {} }] })
        .mockImplementationOnce(async (content: string) => {
          expect(content).toBe("A");
          expect(service.getHistory("project", "task")[0].status).toBe("included");
          service.sendMessage("project", "task", "late", undefined, { clientMessageId: "late" });
          return { text: "done", toolCalls: [] };
        }),
    };
    await runAgenticLoop(adapter, "task", { cwd: tmpDir, maxTurns: 2, pendingMessages: queue });
    expect(service.getHistory("project", "task").map((m) => m.status)).toEqual([
      "included",
      "run-ended",
    ]);
  });
  it("closes queued guidance when the provider throws", async () => {
    service.sendMessage("project", "task", "A", undefined, options);
    await expect(
      runAgenticLoop({ send: vi.fn().mockRejectedValue(new Error("offline")) }, "task", {
        cwd: tmpDir,
        pendingMessages: queue,
      })
    ).rejects.toThrow("offline");
    expect(service.getHistory("project", "task")[0].status).toBe("run-ended");
  });
  it.each(["claude-cli", "cursor", "custom"])("rejects CLI backend %s", (backend) => {
    registry.registerChannel("task", new PendingMessageQueue(), backend, { projectId: "project" });
    expect(service.sendMessage("project", "task", "A").error).toMatch(/CLI-based/);
  });
});
