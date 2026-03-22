import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  parseCliOptions,
  resolveTargetPlatform,
  resolveTargetArch,
  resolveBuilderPlatformFlag,
  buildElectronBuilderArgs,
} = require("./build-target.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("build-target", () => {
  it("parses explicit platform/arch and --dir flag", () => {
    expect(parseCliOptions(["--platform", "win32", "--arch", "x64", "--dir"])).toEqual({
      platform: "win32",
      arch: "x64",
      dir: true,
    });
  });

  it("defaults --dir to false when omitted", () => {
    expect(parseCliOptions(["--platform=darwin", "--arch=arm64"])).toEqual({
      platform: "darwin",
      arch: "arm64",
      dir: false,
    });
  });

  it("resolves valid target platform and builder flag", () => {
    expect(resolveTargetPlatform({ platform: "linux" })).toBe("linux");
    expect(resolveBuilderPlatformFlag("linux")).toBe("--linux");
  });

  it("builds electron-builder args with publish disabled", () => {
    expect(
      buildElectronBuilderArgs({
        targetPlatform: "linux",
        targetArch: "x64",
      })
    ).toEqual(["--linux", "--x64", "--publish", "never"]);
  });

  it("includes --dir when building unpacked output", () => {
    expect(
      buildElectronBuilderArgs({
        targetPlatform: "darwin",
        targetArch: "arm64",
        dir: true,
      })
    ).toEqual(["--dir", "--mac", "--arm64", "--publish", "never"]);
  });

  it("throws for unsupported platform", () => {
    expect(() => resolveTargetPlatform({ platform: "freebsd" })).toThrow(
      /Unsupported target platform/
    );
  });

  it("resolves valid target arch and throws for unsupported arch", () => {
    expect(resolveTargetArch({ arch: "x64" })).toBe("x64");
    expect(() => resolveTargetArch({ arch: "ia32" })).toThrow(/Unsupported target arch/);
  });

  it("routes generic build scripts through build-target cleanup path", () => {
    const electronPackageJsonPath = path.join(__dirname, "..", "package.json");
    const electronPackageJson = JSON.parse(fs.readFileSync(electronPackageJsonPath, "utf8"));
    expect(electronPackageJson.scripts.build).toBe("node scripts/build-target.js");
    expect(electronPackageJson.scripts["build:dir"]).toBe("node scripts/build-target.js --dir");
  });
});
