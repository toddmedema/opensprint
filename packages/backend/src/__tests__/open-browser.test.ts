import { describe, it, expect, vi } from "vitest";
import { openBrowser } from "../utils/open-browser.js";

describe("open-browser", () => {
  it("prefers wslview inside WSL when available", async () => {
    const hasCommand = vi.fn().mockResolvedValue(true);
    const runCommand = vi.fn().mockResolvedValue(undefined);

    const result = await openBrowser("http://localhost:5173", {
      runtime: {
        platform: "linux",
        isWsl: true,
        wslDistroName: "Ubuntu",
        repoPathPolicy: "linux_fs_only",
      },
      hasCommand,
      runCommand,
    });

    expect(result).toEqual({ status: "opened", command: "wslview" });
    expect(runCommand).toHaveBeenCalledWith("wslview", ["http://localhost:5173"]);
  });

  it("falls back to cmd.exe inside WSL when wslview is unavailable", async () => {
    const hasCommand = vi.fn().mockResolvedValue(false);
    const runCommand = vi.fn().mockResolvedValue(undefined);

    const result = await openBrowser("http://localhost:5173", {
      runtime: {
        platform: "linux",
        isWsl: true,
        wslDistroName: "Ubuntu",
        repoPathPolicy: "linux_fs_only",
      },
      hasCommand,
      runCommand,
    });

    expect(result).toEqual({ status: "opened", command: "cmd.exe" });
    expect(runCommand).toHaveBeenCalledWith("cmd.exe", ["/c", "start", "", "http://localhost:5173"]);
  });

  it("logs only when all WSL browser-open strategies fail", async () => {
    const hasCommand = vi.fn().mockResolvedValue(false);
    const runCommand = vi.fn().mockRejectedValue(new Error("cmd.exe not found"));

    const result = await openBrowser("http://localhost:5173", {
      runtime: {
        platform: "linux",
        isWsl: true,
        wslDistroName: "Ubuntu",
        repoPathPolicy: "linux_fs_only",
      },
      hasCommand,
      runCommand,
    });

    expect(result).toEqual({ status: "logged", error: "cmd.exe not found" });
  });
});
