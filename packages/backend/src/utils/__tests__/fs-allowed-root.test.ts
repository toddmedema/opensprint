import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import {
  getFsBrowsePolicyRuntimeInfo,
  getLogicalFsAllowedRoot,
  getResolvedFsAllowedRoot,
  isHomeBrowseEffective,
  isPathUnderAllowedRoot,
} from "../fs-allowed-root.js";

describe("fs-allowed-root", () => {
  let orig: Record<string, string | undefined>;

  beforeEach(() => {
    orig = {
      OPENSPRINT_FS_ROOT: process.env.OPENSPRINT_FS_ROOT,
      OPENSPRINT_ALLOW_HOME_BROWSE: process.env.OPENSPRINT_ALLOW_HOME_BROWSE,
      OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI: process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI,
      CI: process.env.CI,
      HOME: process.env.HOME,
      OPENSPRINT_DESKTOP: process.env.OPENSPRINT_DESKTOP,
    };
    delete process.env.OPENSPRINT_DESKTOP;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("isHomeBrowseEffective is false in CI unless OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI is set", () => {
    delete process.env.OPENSPRINT_FS_ROOT;
    process.env.OPENSPRINT_ALLOW_HOME_BROWSE = "1";
    process.env.CI = "true";
    delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI;
    expect(isHomeBrowseEffective()).toBe(false);

    process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI = "1";
    expect(isHomeBrowseEffective()).toBe(true);
  });

  it("defaults desktop to home while keeping explicit roots and opt-outs", () => {
    process.env.OPENSPRINT_DESKTOP = "1";
    process.env.HOME = path.join(os.tmpdir(), "desktop-user-home");
    delete process.env.OPENSPRINT_FS_ROOT;
    delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE;
    delete process.env.CI;
    expect(getLogicalFsAllowedRoot()).toBe(process.env.HOME);
    expect(getFsBrowsePolicyRuntimeInfo()).toMatchObject({
      homeBrowseEffective: true,
      homeBrowseEnvRequested: false,
      adminWarning: null,
    });
    process.env.OPENSPRINT_FS_ROOT = path.join(os.tmpdir(), "explicit-root");
    expect(getLogicalFsAllowedRoot()).toBe(process.env.OPENSPRINT_FS_ROOT);
    expect(getFsBrowsePolicyRuntimeInfo().homeBrowseEffective).toBe(false);
    delete process.env.OPENSPRINT_FS_ROOT;
    process.env.OPENSPRINT_ALLOW_HOME_BROWSE = "0";
    expect(getLogicalFsAllowedRoot()).toBe(process.cwd());
  });

  it("does not expand desktop browsing in CI without an explicit override", () => {
    process.env.OPENSPRINT_DESKTOP = "1";
    process.env.CI = "true";
    delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE;
    delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI;
    expect(isHomeBrowseEffective()).toBe(false);
  });

  it("getFsBrowsePolicyRuntimeInfo reports suppression when CI blocks home browse", () => {
    delete process.env.OPENSPRINT_FS_ROOT;
    process.env.OPENSPRINT_ALLOW_HOME_BROWSE = "true";
    process.env.CI = "true";
    delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI;

    const info = getFsBrowsePolicyRuntimeInfo();
    expect(info.homeBrowseEnvRequested).toBe(true);
    expect(info.homeBrowseEffective).toBe(false);
    expect(info.homeBrowseSuppressedByCi).toBe(true);
    expect(info.adminWarning).toMatch(/ignored.*CI/i);
  });

  it("when OPENSPRINT_FS_ROOT and OPENSPRINT_ALLOW_HOME_BROWSE are both set (non-CI), caps win and homeBrowseEffective is false", () => {
    process.env.OPENSPRINT_FS_ROOT = path.join(os.tmpdir(), "fs-cap-root");
    process.env.OPENSPRINT_ALLOW_HOME_BROWSE = "1";
    delete process.env.CI;
    delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI;

    const info = getFsBrowsePolicyRuntimeInfo();
    expect(info.fsRootConfigured).toBe(true);
    expect(info.homeBrowseEnvRequested).toBe(true);
    expect(info.homeBrowseEffective).toBe(false);
    expect(info.homeBrowseSuppressedByCi).toBe(false);
    expect(info.adminWarning).toMatch(/OPENSPRINT_FS_ROOT/);
    expect(info.adminWarning).toMatch(/does not widen the tree beyond this root/i);
    expect(info.adminWarning).not.toMatch(/entire user home directory/i);
  });

  it("rejects paths that realpath-resolve outside OPENSPRINT_FS_ROOT via symlink", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const base = await fs.mkdtemp(path.join(os.tmpdir(), "fs-root-symlink-"));
    const secret = await fs.mkdtemp(path.join(os.tmpdir(), "fs-root-secret-"));
    const junction = path.join(base, "out");
    await fs.symlink(secret, junction, "dir");
    process.env.OPENSPRINT_FS_ROOT = base;

    try {
      const resolvedRoot = getResolvedFsAllowedRoot();
      expect(resolvedRoot).toBe(await fs.realpath(base));
      expect(isPathUnderAllowedRoot(junction)).toBe(false);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
      await fs.rm(secret, { recursive: true, force: true });
    }
  });

  it("uses realpath boundary so a path under the logical root stays allowed when canonical", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const base = await fs.mkdtemp(path.join(os.tmpdir(), "fs-root-canonical-"));
    const sub = path.join(base, "sub");
    await fs.mkdir(sub, { recursive: true });
    process.env.OPENSPRINT_FS_ROOT = base;

    try {
      expect(isPathUnderAllowedRoot(sub)).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
