import { describe, it, expect } from "vitest";
import { getRunInstructions } from "./runInstructions";

describe("getRunInstructions", () => {
  it("returns pushd + npm run web for native Windows runtimes", () => {
    expect(
      getRunInstructions("C:\\Users\\Todd\\My App", {
        platform: "win32",
        isWsl: false,
        wslDistroName: null,
        repoPathPolicy: "any",
      })
    ).toEqual([
      'pushd "C:\\Users\\Todd\\My App"',
      "npm run web",
    ]);
  });

  it("returns cd + npm run web for WSL runtimes even when the user is on Windows", () => {
    expect(
      getRunInstructions("/home/todd/My App", {
        platform: "linux",
        isWsl: true,
        wslDistroName: "Ubuntu",
        repoPathPolicy: "linux_fs_only",
      })
    ).toEqual([
      'cd "/home/todd/My App"',
      "npm run web",
    ]);
  });

  it("returns cd + npm run web for macOS paths with spaces", () => {
    expect(
      getRunInstructions("/Users/todd/My App", {
        platform: "darwin",
        isWsl: false,
        wslDistroName: null,
        repoPathPolicy: "any",
      })
    ).toEqual([
      'cd "/Users/todd/My App"',
      "npm run web",
    ]);
  });

  it("returns cd + npm run web for native Linux runtimes", () => {
    expect(
      getRunInstructions("/workspace/My App", {
        platform: "linux",
        isWsl: false,
        wslDistroName: null,
        repoPathPolicy: "any",
      })
    ).toEqual([
      'cd "/workspace/My App"',
      "npm run web",
    ]);
  });

  it("never includes shell chaining", () => {
    const commands = getRunInstructions("C:\\Users\\Todd\\My App", {
      platform: "win32",
      isWsl: false,
      wslDistroName: null,
      repoPathPolicy: "any",
    });
    expect(commands.join("\n")).not.toContain("&&");
  });
});
