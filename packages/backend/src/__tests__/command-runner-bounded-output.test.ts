import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../utils/command-runner.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", () => ({ spawn: spawnMock }));

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  spawnMock.mockReturnValueOnce(child);
  return child;
}
afterEach(() => vi.useRealTimers());

describe("bounded command output while terminating", () => {
  it.each(["stdout", "stderr"] as const)(
    "caps UTF-8 %s and ignores later data while draining",
    async (stream) => {
      vi.useFakeTimers();
      const child = childProcess();
      const result = runCommand(
        { command: process.execPath },
        {
          cwd: process.cwd(),
          timeout: 15_000,
          [stream === "stdout" ? "maxStdoutBytes" : "maxStderrBytes"]: 7,
        }
      );
      const rejected = expect(result).rejects.toMatchObject({
        message: expect.stringMatching(/output exceeded limit/),
        [stream]: "abc🙂",
      });
      child[stream].write("abc");
      child[stream].write("🙂🙂");
      child.stdout.write("later".repeat(1000));
      child.stderr.write("later".repeat(1000));
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      vi.advanceTimersByTime(5000);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      child.emit("close", null, "SIGKILL");
      await rejected;
      vi.advanceTimersByTime(30_000);
      expect(child.kill).toHaveBeenCalledTimes(2);
    }
  );

  it("keeps exactly-at-limit Unicode and uncapped stderr on successful commands", async () => {
    const child = childProcess();
    const result = runCommand(
      { command: process.execPath },
      { cwd: process.cwd(), maxStdoutBytes: 4 }
    );
    child.stdout.write("🙂");
    child.stderr.write("uncapped ".repeat(500));
    child.emit("close", 0, null);
    expect(await result).toMatchObject({ stdout: "🙂", stderr: "uncapped ".repeat(500) });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
