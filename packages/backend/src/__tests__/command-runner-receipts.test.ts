import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../utils/command-runner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.skipIf(process.platform === "win32")("supervised command ownership receipts", () => {
  let root: string;
  const descendants: number[] = [];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "command-receipt-"));
  });
  afterEach(async () => {
    for (const pid of descendants.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /*already observed stopped*/
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  it("cannot execute project code before its durable receipt is accepted", async () => {
    const receipt = deferred<number>();
    const admit = deferred<void>();
    const marker = path.join(root, "started");
    const pending = runCommand(
      {
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'executed')", marker],
      },
      {
        cwd: root,
        onSpawn: async (pid) => {
          receipt.resolve(pid);
          await admit.promise;
        },
      }
    );
    expect(await receipt.promise).toBeGreaterThan(0);
    await expect(fs.access(marker)).rejects.toThrow();
    admit.resolve();
    expect((await pending).exitCode).toBe(0);
    expect(await fs.readFile(marker, "utf8")).toBe("executed");
  });
  it("does not launch after a receipt write fails", async () => {
    const marker = path.join(root, "must-not-exist");
    await expect(
      runCommand(
        {
          command: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'bad')", marker],
        },
        {
          cwd: root,
          onSpawn: async () => {
            throw new Error("Receipt authority withdrawn");
          },
        }
      )
    ).rejects.toThrow("Receipt authority withdrawn");
    await expect(fs.access(marker)).rejects.toThrow();
  });
  it("cancels during admission without starting the proposed command", async () => {
    const ready = deferred<void>(),
      admit = deferred<void>();
    const abort = new AbortController();
    const marker = path.join(root, "never-launched");
    const pending = runCommand(
      {
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'bad')", marker],
      },
      {
        cwd: root,
        signal: abort.signal,
        onSpawn: async () => {
          ready.resolve();
          await admit.promise;
        },
      }
    );
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    await ready.promise;
    abort.abort();
    await rejected;
    admit.resolve();
    await expect(fs.access(marker)).rejects.toThrow();
  });
  it("stops background descendants even when the declared command exits successfully", async () => {
    const pidFile = path.join(root, "background-pid");
    const fixture = path.join(root, "parent.cjs");
    await fs.writeFile(
      fixture,
      `const {spawn}=require('node:child_process');const fs=require('node:fs');
const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
c.once('message',()=>{fs.writeFileSync(process.argv[2],String(c.pid));process.exit(0)});`
    );
    const result = await runCommand(
      { command: process.execPath, args: [fixture, pidFile] },
      { cwd: root, onSpawn: async () => {} }
    );
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    descendants.push(pid);
    expect(result.exitCode).toBe(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
  it("preserves a failing check's real exit status through supervised cleanup", async () => {
    await expect(
      runCommand(
        { command: process.execPath, args: ["-e", "process.exit(7)"] },
        { cwd: root, onSpawn: async () => {} }
      )
    ).rejects.toMatchObject({ exitCode: 7, message: expect.stringContaining("Command failed") });
  });
  it("resolves a relative executable against its declared working directory", async () => {
    await fs.writeFile(path.join(root, "check-fixture"), "#!/bin/sh\nprintf verified", {
      mode: 0o755,
    });
    const result = await runCommand(
      { command: "./check-fixture" },
      { cwd: root, onSpawn: async () => {} }
    );
    expect(result.stdout).toBe("verified");
  });
});
