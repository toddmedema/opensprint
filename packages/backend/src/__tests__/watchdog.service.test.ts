import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { WatchdogService } from "../services/watchdog.service.js";
import { resetLogLevelCache } from "../utils/logger.js";

vi.mock("../services/recovery.service.js", () => ({
  recoveryService: {
    runFullRecovery: vi.fn().mockResolvedValue({ reattached: [], requeued: [], cleaned: [] }),
  },
}));

vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: {
    list: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: {
    getRecoveryHost: vi.fn().mockReturnValue({
      getSlottedTaskIds: vi.fn().mockReturnValue([]),
      getActiveAgentIds: vi.fn().mockReturnValue([]),
    }),
  },
}));

import { recoveryService } from "../services/recovery.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";

describe("WatchdogService", () => {
  let tmpDir: string;
  let watchdog: WatchdogService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `watchdog-test-${Date.now()}`);
    await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });
    watchdog = new WatchdogService();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    watchdog.stop();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const getTargets = () => Promise.resolve([{ projectId: "proj-1", repoPath: tmpDir }]);

  it("should start and stop without errors", () => {
    watchdog.start(getTargets);
    watchdog.stop();
  });

  it("should not start twice", () => {
    watchdog.start(getTargets);
    watchdog.start(getTargets);
    watchdog.stop();
  });

  it("should call runFullRecovery for each target", async () => {
    watchdog.start(getTargets);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (watchdog as any).runChecks();

    expect(recoveryService.runFullRecovery).toHaveBeenCalledTimes(1);
    expect(recoveryService.runFullRecovery).toHaveBeenCalledWith(
      "proj-1",
      tmpDir,
      expect.objectContaining({
        getSlottedTaskIds: expect.any(Function),
        getActiveAgentIds: expect.any(Function),
      })
    );
  });

  it("should pass host that delegates to orchestrator and activeAgents services", async () => {
    vi.mocked(orchestratorService.getRecoveryHost).mockReturnValue({
      getSlottedTaskIds: vi.fn().mockReturnValue(["task-slotted"]),
      getActiveAgentIds: vi.fn().mockReturnValue(["task-active"]),
    });

    watchdog.start(getTargets);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (watchdog as any).runChecks();

    const host = vi.mocked(recoveryService.runFullRecovery).mock.calls[0][2];
    expect(host.getSlottedTaskIds("proj-1")).toEqual(["task-slotted"]);
    expect(host.getActiveAgentIds("proj-1")).toEqual(["task-active"]);
  });

  it("should not run checks for deleted projects (getTargets returns empty)", async () => {
    watchdog.start(() => Promise.resolve([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (watchdog as any).runChecks();

    expect(recoveryService.runFullRecovery).not.toHaveBeenCalled();
  });

  it("should handle multiple targets", async () => {
    const tmpDir2 = path.join(os.tmpdir(), `watchdog-test-2-${Date.now()}`);
    await fs.mkdir(path.join(tmpDir2, ".git"), { recursive: true });

    watchdog.start(() =>
      Promise.resolve([
        { projectId: "proj-1", repoPath: tmpDir },
        { projectId: "proj-2", repoPath: tmpDir2 },
      ])
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (watchdog as any).runChecks();

    expect(recoveryService.runFullRecovery).toHaveBeenCalledTimes(2);
    expect(recoveryService.runFullRecovery).toHaveBeenCalledWith(
      "proj-1",
      tmpDir,
      expect.any(Object)
    );
    expect(recoveryService.runFullRecovery).toHaveBeenCalledWith(
      "proj-2",
      tmpDir2,
      expect.any(Object)
    );

    await fs.rm(tmpDir2, { recursive: true, force: true }).catch(() => {});
  });

  it("should not throw when runFullRecovery fails for one target", async () => {
    vi.mocked(recoveryService.runFullRecovery).mockRejectedValueOnce(new Error("boom"));

    watchdog.start(getTargets);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((watchdog as any).runChecks()).resolves.toBeUndefined();
  });

  it("should not run checks when not started", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (watchdog as any).runChecks();
    expect(recoveryService.runFullRecovery).not.toHaveBeenCalled();
  });

  it("logs recovered tasks when runFullRecovery returns requeued (agent assignee no-process reset)", async () => {
    const originalLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    resetLogLevelCache();
    vi.mocked(recoveryService.runFullRecovery).mockResolvedValueOnce({
      reattached: [],
      requeued: ["task-orphan-1", "task-orphan-2"],
      cleaned: [],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    watchdog.start(getTargets);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (watchdog as any).runChecks();

    const logged = warnSpy.mock.calls.map((c) => c[0]).join(" ");
    expect(logged).toContain("Recovered tasks");
    expect(logged).toContain("proj-1");
    expect(logged).toContain("task-orphan-1");
    expect(logged).toContain("task-orphan-2");
    expect(logged).toContain("2");
    warnSpy.mockRestore();
    process.env.LOG_LEVEL = originalLogLevel;
    resetLogLevelCache();
  });
});
