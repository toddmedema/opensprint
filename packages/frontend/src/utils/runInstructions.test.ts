import { describe, it, expect } from "vitest";
import { getRunInstructions } from "./runInstructions";

describe("getRunInstructions", () => {
  it("returns pushd + npm run web for Windows paths with spaces", () => {
    expect(getRunInstructions("C:\\Users\\Todd\\My App", "windows")).toEqual([
      'pushd "C:\\Users\\Todd\\My App"',
      "npm run web",
    ]);
  });

  it("returns cd + npm run web for macOS paths with spaces", () => {
    expect(getRunInstructions("/Users/todd/My App", "mac")).toEqual([
      'cd "/Users/todd/My App"',
      "npm run web",
    ]);
  });

  it("returns cd + npm run web for unknown platforms", () => {
    expect(getRunInstructions("/workspace/My App", "unknown")).toEqual([
      'cd "/workspace/My App"',
      "npm run web",
    ]);
  });

  it("never includes shell chaining", () => {
    const commands = getRunInstructions("C:\\Users\\Todd\\My App", "windows");
    expect(commands.join("\n")).not.toContain("&&");
  });
});
