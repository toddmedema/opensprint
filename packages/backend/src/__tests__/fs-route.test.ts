import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fsRouter } from "../routes/fs.js";
import { API_PREFIX } from "@opensprint/shared";
import { errorHandler } from "../middleware/error-handler.js";

function createMinimalFsApp() {
  const app = express();
  app.use(express.json());
  app.use(`${API_PREFIX}/fs`, fsRouter);
  app.use(errorHandler);
  return app;
}

describe("Filesystem API", () => {
  let app: ReturnType<typeof createMinimalFsApp>;
  let tempDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  let originalFsRoot: string | undefined;
  let originalAllowHomeBrowse: string | undefined;
  let originalUserProfile: string | undefined;
  let originalHomeDrive: string | undefined;
  let originalHomePath: string | undefined;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalCi: string | undefined;
  let originalAllowHomeInCi: string | undefined;

  beforeEach(async () => {
    vi.useRealTimers();
    app = createMinimalFsApp();
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-fs-route-test-"));
    tempDir = await fs.realpath(created);
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    originalFsRoot = process.env.OPENSPRINT_FS_ROOT;
    originalAllowHomeBrowse = process.env.OPENSPRINT_ALLOW_HOME_BROWSE;
    originalUserProfile = process.env.USERPROFILE;
    originalHomeDrive = process.env.HOMEDRIVE;
    originalHomePath = process.env.HOMEPATH;
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    originalCi = process.env.CI;
    originalAllowHomeInCi = process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI;
    process.env.HOME = tempDir;
    delete process.env.OPENSPRINT_FS_ROOT;
    delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE;
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    if (originalFsRoot === undefined) {
      delete process.env.OPENSPRINT_FS_ROOT;
    } else {
      process.env.OPENSPRINT_FS_ROOT = originalFsRoot;
    }
    if (originalAllowHomeBrowse === undefined) {
      delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE;
    } else {
      process.env.OPENSPRINT_ALLOW_HOME_BROWSE = originalAllowHomeBrowse;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalHomeDrive === undefined) {
      delete process.env.HOMEDRIVE;
    } else {
      process.env.HOMEDRIVE = originalHomeDrive;
    }
    if (originalHomePath === undefined) {
      delete process.env.HOMEPATH;
    } else {
      process.env.HOMEPATH = originalHomePath;
    }
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    if (originalAllowHomeInCi === undefined) {
      delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI;
    } else {
      process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI = originalAllowHomeInCi;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function enableHomeBrowseForTest(): void {
    process.env.OPENSPRINT_ALLOW_HOME_BROWSE = "1";
    if (process.env.CI === "true" || process.env.CI === "1") {
      process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI = "1";
    }
  }

  it("browses cwd by default when no path is provided and FS root is not configured", async () => {
    const childDir = path.join(tempDir, "projects");
    await fs.mkdir(childDir);

    const res = await request(app).get(`${API_PREFIX}/fs/browse`);

    expect(res.status).toBe(200);
    expect(res.body.data.current).toBe(tempDir);
    expect(res.body.data.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "projects",
          path: childDir,
          isDirectory: true,
        }),
      ])
    );
  });

  it("allows browsing anywhere under the default cwd root", async () => {
    const nestedDir = path.join(tempDir, "workspace", "demo");
    await fs.mkdir(nestedDir, { recursive: true });

    const res = await request(app).get(`${API_PREFIX}/fs/browse`).query({ path: nestedDir });

    expect(res.status).toBe(200);
    expect(res.body.data.current).toBe(nestedDir);
  });

  it("rejects browse outside cwd when OPENSPRINT_FS_ROOT and home opt-in are unset", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-fs-outside-"));

    try {
      const res = await request(app).get(`${API_PREFIX}/fs/browse`).query({ path: outsideDir });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toBe("Path is outside the allowed directory.");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects create-folder outside cwd when OPENSPRINT_FS_ROOT and home opt-in are unset", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-fs-create-outside-"));

    try {
      const res = await request(app)
        .post(`${API_PREFIX}/fs/create-folder`)
        .send({ parentPath: outsideDir, name: "new-project" });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toBe("Path is outside the allowed directory.");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects detect-test-framework outside cwd when OPENSPRINT_FS_ROOT and home opt-in are unset", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-fs-detect-outside-"));

    try {
      const res = await request(app)
        .get(`${API_PREFIX}/fs/detect-test-framework`)
        .query({ path: outsideDir });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toBe("Path is outside the allowed directory.");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("uses the platform home directory as allowed root when OPENSPRINT_ALLOW_HOME_BROWSE is set", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-fs-home-opt-in-"));
    const underHome = path.join(homeDir, "allowed-project");
    await fs.mkdir(underHome, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    enableHomeBrowseForTest();

    try {
      const allowedRes = await request(app)
        .get(`${API_PREFIX}/fs/browse`)
        .query({ path: underHome });
      expect(allowedRes.status).toBe(200);
      expect(allowedRes.body.data.current).toBe(underHome);

      const blockedRes = await request(app).get(`${API_PREFIX}/fs/browse`).query({ path: tempDir });
      expect(blockedRes.status).toBe(400);
      expect(blockedRes.body.error?.message).toBe("Path is outside the allowed directory.");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("honors OPENSPRINT_FS_ROOT when it is configured", async () => {
    const configuredRoot = path.join(tempDir, "restricted-root");
    const allowedDir = path.join(configuredRoot, "allowed");
    const blockedDir = path.join(tempDir, "outside-root");
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(blockedDir, { recursive: true });
    process.env.OPENSPRINT_FS_ROOT = configuredRoot;

    const allowedRes = await request(app)
      .get(`${API_PREFIX}/fs/browse`)
      .query({ path: allowedDir });
    expect(allowedRes.status).toBe(200);
    expect(allowedRes.body.data.current).toBe(allowedDir);

    const blockedRes = await request(app)
      .get(`${API_PREFIX}/fs/browse`)
      .query({ path: blockedDir });
    expect(blockedRes.status).toBe(400);
    expect(blockedRes.body.error?.message).toBe("Path is outside the allowed directory.");
  });

  it("prefers USERPROFILE over HOME on Windows when home browse opt-in is enabled", async () => {
    const windowsHome = path.join(tempDir, "windows-home");
    await fs.mkdir(windowsHome, { recursive: true });
    process.env.HOME = "/nonexistent-posix-home";
    process.env.USERPROFILE = windowsHome;
    enableHomeBrowseForTest();
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    const res = await request(app).get(`${API_PREFIX}/fs/browse`);

    expect(res.status).toBe(200);
    expect(res.body.data.current).toBe(windowsHome);
  });

  it("does not expand browse to HOME in CI unless OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI is set", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-fs-ci-home-"));
    const underHome = path.join(homeDir, "proj");
    await fs.mkdir(underHome, { recursive: true });
    process.env.HOME = homeDir;
    process.env.CI = "true";
    process.env.OPENSPRINT_ALLOW_HOME_BROWSE = "1";
    delete process.env.OPENSPRINT_ALLOW_HOME_BROWSE_IN_CI;

    try {
      const res = await request(app).get(`${API_PREFIX}/fs/browse`).query({ path: underHome });
      expect(res.status).toBe(400);
      expect(res.body.error?.message).toBe("Path is outside the allowed directory.");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
