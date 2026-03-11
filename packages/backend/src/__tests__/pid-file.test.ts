import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { acquirePidFile, removePidFile } from "../pid-file.js";

describe("pid-file", () => {
  const TEST_PORT = 59999; // Unlikely to conflict with real server
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensprint-pid-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch {
      // Best effort
    }
  });

  it("creates PID file on acquire", () => {
    acquirePidFile(TEST_PORT);
    const pidDir = path.join(tempDir, ".opensprint");
    const pidFile = path.join(pidDir, `server-${TEST_PORT}.pid`);
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(fs.readFileSync(pidFile, "utf-8").trim()).toBe(String(process.pid));
  });

  it("removes PID file on removePidFile when it contains our PID", () => {
    acquirePidFile(TEST_PORT);
    const pidDir = path.join(tempDir, ".opensprint");
    const pidFile = path.join(pidDir, `server-${TEST_PORT}.pid`);
    expect(fs.existsSync(pidFile)).toBe(true);

    removePidFile(TEST_PORT);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("does not remove PID file when it contains a different PID", () => {
    const pidDir = path.join(tempDir, ".opensprint");
    fs.mkdirSync(pidDir, { recursive: true });
    const pidFile = path.join(pidDir, `server-${TEST_PORT}.pid`);
    const otherPid = process.pid + 10000; // Ensure different from current
    fs.writeFileSync(pidFile, String(otherPid), "utf-8");

    removePidFile(TEST_PORT);
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(fs.readFileSync(pidFile, "utf-8").trim()).toBe(String(otherPid));
  });

  it("removes stale PID file and writes our PID when file contains dead process PID", () => {
    const pidDir = path.join(tempDir, ".opensprint");
    fs.mkdirSync(pidDir, { recursive: true });
    const pidFile = path.join(pidDir, `server-${TEST_PORT}.pid`);
    const deadPid = 999999; // Non-existent process
    fs.writeFileSync(pidFile, String(deadPid), "utf-8");

    acquirePidFile(TEST_PORT);
    expect(fs.readFileSync(pidFile, "utf-8").trim()).toBe(String(process.pid));
  });
});
