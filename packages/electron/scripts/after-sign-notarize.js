#!/usr/bin/env node
"use strict";
/* global module, process */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : "";
}

function getNotarizationArgs() {
  const apiKey = requiredEnv("APPLE_API_KEY");
  const apiKeyId = requiredEnv("APPLE_API_KEY_ID");
  const issuer = requiredEnv("APPLE_API_ISSUER");

  if (!apiKey && !apiKeyId && !issuer) {
    return null;
  }

  if (!apiKey || !apiKeyId || !issuer) {
    throw new Error(
      "APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER must all be set for macOS notarization."
    );
  }

  return ["--key", apiKey, "--key-id", apiKeyId, "--issuer", issuer];
}

module.exports = async function afterSign(context) {
  if (process.platform !== "darwin" || context.electronPlatformName !== "darwin") {
    return;
  }

  const authArgs = getNotarizationArgs();
  if (authArgs == null) {
    console.log("Skipping macOS notarization: APPLE_API_KEY credentials were not provided.");
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error(`Expected signed app bundle at ${appPath}`);
  }

  const timeout = requiredEnv("OPENSPRINT_NOTARY_TIMEOUT") || "30m";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensprint-notary-"));
  const zipPath = path.join(tempDir, `${context.packager.appInfo.productFilename}.zip`);

  try {
    console.log(`Compressing app for notarization: ${appPath}`);
    execFileSync(
      "/usr/bin/ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", path.basename(appPath), zipPath],
      {
        cwd: path.dirname(appPath),
        stdio: "inherit",
      }
    );

    console.log(`Submitting app to Apple notarization service (timeout=${timeout})...`);
    execFileSync(
      "/usr/bin/xcrun",
      ["notarytool", "submit", zipPath, ...authArgs, "--wait", "--timeout", timeout, "--progress"],
      {
        stdio: "inherit",
      }
    );

    console.log(`Stapling notarization ticket to ${appPath}...`);
    execFileSync("/usr/bin/xcrun", ["stapler", "staple", "-v", appPath], {
      stdio: "inherit",
    });

    console.log(`Validating stapled notarization ticket on ${appPath}...`);
    execFileSync("/usr/bin/xcrun", ["stapler", "validate", appPath], {
      stdio: "inherit",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};
