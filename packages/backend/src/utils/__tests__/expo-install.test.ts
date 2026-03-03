import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { isExpoInstalled, installExpo, ensureExpoInstalled } from "../expo-install.js";

vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

const { exec } = await import("child_process");
const execMock = exec as unknown as ReturnType<typeof vi.fn>;

describe("expo-install", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "expo-install-test-"));
    vi.clearAllMocks();
    // Default: exec fails (for isExpoInstalled eas-cli check when no deps)
    execMock.mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        cb(new Error("command not found"));
      }
    );
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("isExpoInstalled", () => {
    it("returns true when package.json has expo dependency", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { expo: "^52.0.0" } })
      );
      expect(await isExpoInstalled(tempDir)).toBe(true);
    });

    it("returns true when package.json has eas-cli in devDependencies", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ devDependencies: { "eas-cli": "^12.0.0" } })
      );
      expect(await isExpoInstalled(tempDir)).toBe(true);
    });

    it("returns false when package.json has no expo or eas-cli", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { react: "^18.0.0" } })
      );
      expect(await isExpoInstalled(tempDir)).toBe(false);
    });
  });

  describe("installExpo", () => {
    it("returns installed: true when npm install succeeds", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "test", dependencies: {} })
      );
      execMock.mockImplementation(
        (
          cmd: string,
          opts: unknown,
          cb: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          cb(null, "added 1 package", "");
        }
      );
      const result = await installExpo(tempDir);
      expect(result.installed).toBe(true);
      expect(execMock).toHaveBeenCalledWith(
        "npm install expo --save",
        expect.objectContaining({ cwd: tempDir, timeout: 120000 }),
        expect.any(Function)
      );
    });

    it("returns installed: false with error when npm install fails", async () => {
      await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
      execMock.mockImplementation(
        (
          cmd: string,
          opts: unknown,
          cb: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          cb(new Error("npm ERR! network timeout"), "stdout", "npm ERR! network timeout");
        }
      );
      const result = await installExpo(tempDir);
      expect(result.installed).toBe(false);
      expect(result.error).toContain("Expo installation failed");
      expect(result.error).toContain("network timeout");
    });
  });

  describe("ensureExpoInstalled", () => {
    it("returns ok: true when expo is already installed", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { expo: "^52.0.0" } })
      );
      const result = await ensureExpoInstalled(tempDir);
      expect(result).toEqual({ ok: true });
      expect(execMock).not.toHaveBeenCalled();
    });

    it("returns ok: true when install succeeds after detection", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "test", dependencies: {} })
      );
      execMock.mockImplementation(
        (
          cmd: string,
          opts: unknown,
          cb: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          cb(null, "added 1 package", "");
        }
      );
      const result = await ensureExpoInstalled(tempDir);
      expect(result).toEqual({ ok: true });
    });

    it("returns ok: false with clear error when install fails", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "test", dependencies: {} })
      );
      execMock.mockImplementation(
        (
          cmd: string,
          opts: unknown,
          cb: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          cb(new Error("EACCES: permission denied"), "", "EACCES: permission denied");
        }
      );
      const result = await ensureExpoInstalled(tempDir);
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error).toContain("Expo installation failed");
        expect(result.error).toContain("permission denied");
      }
    });

    it("calls emit callback when installing (expo not present)", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "test", dependencies: {} })
      );
      execMock.mockImplementation(
        (
          cmd: string,
          opts: unknown,
          cb: (err: Error | null, stdout?: string, stderr?: string) => void
        ) => {
          cb(null, "added 1 package", "");
        }
      );
      const emit = vi.fn();
      const result = await ensureExpoInstalled(tempDir, emit);
      expect(result).toEqual({ ok: true });
      expect(emit).toHaveBeenCalledWith(
        "Expo not found. Installing Expo (this may take a minute)...\n"
      );
    });

    it("does not call emit when expo is already installed", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { expo: "^52.0.0" } })
      );
      const emit = vi.fn();
      const result = await ensureExpoInstalled(tempDir, emit);
      expect(result).toEqual({ ok: true });
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
