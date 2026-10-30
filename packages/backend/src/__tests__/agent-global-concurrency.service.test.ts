import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectSettings } from "@opensprint/shared";
import {
  acquireGlobalAgentSlot,
  resetGlobalAgentConcurrencyForTests,
  updateGlobalAgentConcurrencyLimit,
  trackExistingGlobalAgentSlot,
} from "../services/agent-global-concurrency.service.js";
import * as settingsStore from "../services/settings-store.service.js";

vi.mock("../services/settings-store.service.js", () => ({
  getSettingsFromStore: vi.fn(),
}));

const mockGetSettings = vi.mocked(settingsStore.getSettingsFromStore);

function minimalSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
    complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
    deployment: { mode: "custom" },
    aiAutonomyLevel: "full",
    hilConfig: {
      scopeChanges: "automated",
      architectureDecisions: "automated",
      dependencyModifications: "automated",
    },
    testFramework: null,
    maxConcurrentCoders: 1,
    unknownScopeStrategy: "optimistic",
    gitWorkingMode: "worktree",
    mergeStrategy: "per_task",
    worktreeBaseBranch: "main",
    enableHumanTeammates: false,
    selfImprovementFrequency: "never",
    autoExecutePlans: false,
    runAgentEnhancementExperiments: false,
    ...overrides,
  };
}

describe("agent-global-concurrency.service", () => {
  beforeEach(() => {
    resetGlobalAgentConcurrencyForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetGlobalAgentConcurrencyForTests();
  });

  it("returns no-op release when maxTotalConcurrentAgents is unset", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings());
    const r = await acquireGlobalAgentSlot("proj-a");
    expect(typeof r).toBe("function");
    r();
  });

  it("allows at most N concurrent holders for the same project", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 2 }));

    let peak = 0;
    let current = 0;

    const hold = async () => {
      const release = await acquireGlobalAgentSlot("proj-b");
      current += 1;
      peak = Math.max(peak, current);
      await new Promise((r) => setTimeout(r, 20));
      current -= 1;
      release();
    };

    await Promise.all([hold(), hold(), hold()]);

    expect(peak).toBe(2);
  });

  it("does not throttle across different project ids", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 1 }));

    const track = async (pid: string, ref: { peak: number; cur: number }) => {
      const release = await acquireGlobalAgentSlot(pid);
      ref.cur += 1;
      ref.peak = Math.max(ref.peak, ref.cur);
      await new Promise((r) => setTimeout(r, 15));
      ref.cur -= 1;
      release();
    };

    const x = { peak: 0, cur: 0 };
    const y = { peak: 0, cur: 0 };
    await Promise.all([track("p-x", x), track("p-x", x), track("p-y", y), track("p-y", y)]);

    expect(x.peak).toBe(1);
    expect(y.peak).toBe(1);
  });

  it("removes aborted waiters without stranding the next waiter", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 1 }));
    const first = await acquireGlobalAgentSlot("cancel");
    const controller = new AbortController();
    const cancelled = acquireGlobalAgentSlot("cancel", controller.signal);
    const rejected = expect(cancelled).rejects.toThrow();
    const next = acquireGlobalAgentSlot("cancel");
    await Promise.resolve();
    controller.abort();
    await rejected;
    first();
    (await next)();
  });

  it("keeps live accounting when reducing a limit and reserves FIFO admission", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 2 }));
    const first = await acquireGlobalAgentSlot("resize");
    const second = await acquireGlobalAgentSlot("resize");
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 1 }));
    const order: number[] = [];
    const third = acquireGlobalAgentSlot("resize").then((release) => {
      order.push(3);
      return release;
    });
    const fourth = acquireGlobalAgentSlot("resize").then((release) => {
      order.push(4);
      return release;
    });
    await Promise.resolve();
    first();
    await Promise.resolve();
    expect(order).toEqual([]);
    second();
    const releaseThird = await third;
    expect(order).toEqual([3]);
    releaseThird();
    releaseThird();
    (await fourth)();
    expect(order).toEqual([3, 4]);
  });

  it("accounts for unlimited holders when a finite cap is applied", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings());
    const first = await acquireGlobalAgentSlot("unlimited");
    const second = await acquireGlobalAgentSlot("unlimited");
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 1 }));
    let admitted = false;
    const third = acquireGlobalAgentSlot("unlimited").then((release) => {
      admitted = true;
      return release;
    });
    await Promise.resolve();
    first();
    await Promise.resolve();
    expect(admitted).toBe(false);
    second();
    (await third)();
  });

  it("wakes existing waiters when settings increase or remove the limit", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 1 }));
    const first = await acquireGlobalAgentSlot("wake");
    const second = acquireGlobalAgentSlot("wake");
    const third = acquireGlobalAgentSlot("wake");
    await Promise.resolve();
    await Promise.resolve();
    updateGlobalAgentConcurrencyLimit("wake", 2);
    const releaseSecond = await second;
    updateGlobalAgentConcurrencyLimit("wake");
    const releaseThird = await third;
    first();
    releaseSecond();
    releaseThird();
  });

  it("counts reattached processes before admitting new work", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 1 }));
    const recovered = trackExistingGlobalAgentSlot("recovered");
    let admitted = false;
    const next = acquireGlobalAgentSlot("recovered").then((release) => {
      admitted = true;
      return release;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(admitted).toBe(false);
    recovered();
    (await next)();
  });

  it("does not overwrite a newer settings notification with an older disk read", async () => {
    mockGetSettings.mockResolvedValue(minimalSettings({ maxTotalConcurrentAgents: 1 }));
    const first = await acquireGlobalAgentSlot("stale-settings");
    let finishRead!: (settings: ProjectSettings) => void;
    mockGetSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        })
    );
    const second = acquireGlobalAgentSlot("stale-settings");
    updateGlobalAgentConcurrencyLimit("stale-settings", 2);
    finishRead(minimalSettings({ maxTotalConcurrentAgents: 1 }));
    const releaseSecond = await second;
    first();
    releaseSecond();
  });
});
