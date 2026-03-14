import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, resetLogLevelCache } from "../utils/logger.js";

describe("createLogger", () => {
  const originalEnv = process.env.LOG_LEVEL;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetLogLevelCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.LOG_LEVEL = originalEnv;
    resetLogLevelCache();
  });

  it("prefixes messages with [namespace]", () => {
    process.env.LOG_LEVEL = "info";
    const log = createLogger("orchestrator");
    log.info("Test message");
    expect(console.log).toHaveBeenCalledWith("[orchestrator] Test message");
  });

  it("appends context as JSON when provided", () => {
    process.env.LOG_LEVEL = "info";
    const log = createLogger("plan");
    log.info("Task created", { taskId: "bd-a3f8.1", projectId: "proj-1" });
    expect(console.log).toHaveBeenCalledWith(
      '[plan] Task created {"taskId":"bd-a3f8.1","projectId":"proj-1"}'
    );
  });

  it("does not append empty context", () => {
    process.env.LOG_LEVEL = "info";
    const log = createLogger("feedback");
    log.info("No context", {});
    expect(console.log).toHaveBeenCalledWith("[feedback] No context");
  });

  it("warn uses console.warn", () => {
    process.env.LOG_LEVEL = "warn";
    resetLogLevelCache();
    const log = createLogger("orchestrator");
    log.warn("Warning message", { code: 42 });
    expect(console.warn).toHaveBeenCalledWith('[orchestrator] Warning message {"code":42}');
  });

  it("error uses console.error", () => {
    const log = createLogger("crash-recovery");
    log.error("Failed", { err: "something broke" });
    expect(console.error).toHaveBeenCalledWith('[crash-recovery] Failed {"err":"something broke"}');
  });

  it("debug uses console.log when LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    resetLogLevelCache();
    const log = createLogger("test");
    log.debug("Debug message");
    expect(console.log).toHaveBeenCalledWith("[test] Debug message");
  });

  it("debug is suppressed when LOG_LEVEL=info", () => {
    process.env.LOG_LEVEL = "info";
    resetLogLevelCache();
    const log = createLogger("test");
    log.debug("Debug message");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("info is suppressed when LOG_LEVEL=warn", () => {
    process.env.LOG_LEVEL = "warn";
    resetLogLevelCache();
    const log = createLogger("test");
    log.info("Info message");
    log.warn("Warn message");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[test] Warn message");
  });

  it("warn and error are suppressed when LOG_LEVEL=error", () => {
    process.env.LOG_LEVEL = "error";
    resetLogLevelCache();
    const log = createLogger("test");
    log.info("Info");
    log.warn("Warn");
    log.error("Error");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[test] Error");
  });

  it("handles invalid LOG_LEVEL by defaulting to info", () => {
    process.env.LOG_LEVEL = "invalid";
    resetLogLevelCache();
    const log = createLogger("test");
    log.debug("Debug");
    log.info("Info");
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("[test] Info");
  });
});
