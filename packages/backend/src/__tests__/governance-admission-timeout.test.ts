import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentService } from "../services/agent.service.js";
import {
  acquireGlobalAgentSlot,
  resetGlobalAgentConcurrencyForTests,
} from "../services/agent-global-concurrency.service.js";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), key: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/settings-store.service.js", () => ({ getSettingsFromStore: mocks.settings }));
vi.mock("../services/agent-client.js", () => ({ AgentClient: class {} }));
vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: mocks.key,
  clearLimitHit: vi.fn(),
  recordLimitHit: vi.fn(),
}));
afterEach(() => resetGlobalAgentConcurrencyForTests());

describe("bounded governance model admission", () => {
  it("expires a queued judge before its global slot opens and never invokes a provider", async () => {
    mocks.settings.mockResolvedValue({ maxTotalConcurrentAgents: 1 });
    const release = await acquireGlobalAgentSlot("bounded-judge");
    const controller = new AbortController();
    const result = new AgentService().invokePlanningAgent({
      projectId: "bounded-judge",
      role: "judge",
      config: { type: "openai", model: "bounded", cliCommand: null },
      messages: [{ role: "user", content: "Evidence" }],
      abortSignal: controller.signal,
      governanceBounded: true,
    });
    // Attach rejection handling immediately; a failed assertion must not leave a queued request behind.
    const observed = result.then(
      () => null,
      (error: unknown) => error
    );
    try {
      await vi.waitFor(() => expect(mocks.settings).toHaveBeenCalledTimes(2));
      controller.abort(new Error("Adjudication elapsed-time budget exhausted"));
      const outcome = await Promise.race([
        observed,
        new Promise<"still-queued">((resolve) => setTimeout(() => resolve("still-queued"), 250)),
      ]);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("elapsed-time budget exhausted");
      expect(mocks.key).not.toHaveBeenCalled();
    } finally {
      release();
      await observed;
    }
    const next = await acquireGlobalAgentSlot("bounded-judge");
    next();
  });
});
