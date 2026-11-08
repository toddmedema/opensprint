import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../utils/command-runner.js";

describe.skipIf(process.platform === "win32")("command cancellation", () => {
  const directories: string[] = [];
  const descendants: number[] = [];

  afterEach(async () => {
    for (const pid of descendants.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The command runner should already have stopped this fixture process.
      }
    }
    await Promise.all(
      directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it.each(["timeout", "output limit"])(
    "stops descendants after %s even when the parent exits first",
    async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-tree-"));
      directories.push(root);
      const pidFile = path.join(root, "descendant.json");
      const script = path.join(root, "parent.cjs");
      await fs.writeFile(
        script,
        `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', \
        "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], \
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      process.on('SIGTERM', () => process.exit(0));
      child.once('message', () => {
        fs.writeFileSync(process.argv[2], JSON.stringify({ pid: child.pid }));
        if (process.argv[3] === 'output limit') process.stdout.write('x'.repeat(100));
      });
    `
      );
      const result = runCommand(
        { command: process.execPath, args: [script, pidFile, mode] },
        { cwd: root, timeout: 2000, ...(mode === "output limit" ? { maxStdoutBytes: 10 } : {}) }
      );
      const rejection = expect(result).rejects.toMatchObject({
        message: expect.stringContaining(
          mode === "timeout" ? "timed out" : "output exceeded limit"
        ),
      });
      let pid = 0;
      await vi.waitFor(async () => {
        pid = JSON.parse(await fs.readFile(pidFile, "utf8")).pid;
      });
      descendants.push(pid);
      await rejection;
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      });
    }
  );
});
