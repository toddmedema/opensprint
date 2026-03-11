#!/usr/bin/env node
"use strict";

const path = require("path");
const { execFileSync, execSync } = require("child_process");

const scriptDir = __dirname;
const packageDir = path.resolve(scriptDir, "..");
const prepareScriptPath = path.join(scriptDir, "prepare-desktop-resources.js");

function parseCliOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const [flag, inlineValue] = raw.split("=", 2);
    const nextValue = inlineValue ?? argv[i + 1];
    if ((flag === "--platform" || flag === "--arch") && nextValue) {
      if (inlineValue == null) {
        i += 1;
      }
      if (flag === "--platform") options.platform = String(nextValue).trim();
      if (flag === "--arch") options.arch = String(nextValue).trim();
    }
  }
  return options;
}

function resolveTargetPlatform(cliOptions = {}) {
  const targetPlatform = cliOptions.platform || process.platform;
  if (!["win32", "darwin", "linux"].includes(targetPlatform)) {
    throw new Error(
      `Unsupported target platform '${targetPlatform}'. Use one of: win32, darwin, linux.`
    );
  }
  return targetPlatform;
}

function resolveTargetArch(cliOptions = {}) {
  const targetArch =
    cliOptions.arch?.trim() || process.env.OPENSPRINT_ELECTRON_ARCH?.trim() || process.arch;
  if (!["x64", "arm64"].includes(targetArch)) {
    throw new Error(
      `Unsupported target arch '${targetArch}'. Use one of: x64, arm64.`
    );
  }
  return targetArch;
}

function resolveBuilderPlatformFlag(platform) {
  if (platform === "win32") return "--win";
  if (platform === "darwin") return "--mac";
  return "--linux";
}

function run() {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const targetPlatform = resolveTargetPlatform(cliOptions);
  const targetArch = resolveTargetArch(cliOptions);
  const platformFlag = resolveBuilderPlatformFlag(targetPlatform);
  const archFlag = `--${targetArch}`;

  console.log(
    `Building Electron desktop package (platform=${targetPlatform}, arch=${targetArch})`
  );

  execFileSync(
    process.execPath,
    [
      prepareScriptPath,
      "--platform",
      targetPlatform,
      "--arch",
      targetArch,
    ],
    {
      cwd: packageDir,
      env: process.env,
      stdio: "inherit",
    }
  );

  execSync("npm run compile", {
    cwd: packageDir,
    env: process.env,
    stdio: "inherit",
  });

  execSync(`electron-builder ${platformFlag} ${archFlag}`, {
    cwd: packageDir,
    env: process.env,
    stdio: "inherit",
  });
}

run();
