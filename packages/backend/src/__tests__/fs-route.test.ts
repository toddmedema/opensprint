import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  let originalHome: string | undefined;
  let originalFsRoot: string | undefined;
  let originalUserProfile: string | undefined;
  let originalHomeDrive: string | undefined;
  let originalHomePath: string | undefined;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(async () => {
    app = createMinimalFsApp();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-fs-route-test-"));
    originalHome = process.env.HOME;
    originalFsRoot = process.env.OPENSPRINT_FS_ROOT;
    originalUserProfile = process.env.USERPROFILE;
    originalHomeDrive = process.env.HOMEDRIVE;
    originalHomePath = process.env.HOMEPATH;
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    process.env.HOME = tempDir;
    delete process.env.OPENSPRINT_FS_ROOT;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalFsRoot === undefined) {
      delete process.env.OPENSPRINT_FS_ROOT;
    } else {
      process.env.OPENSPRINT_FS_ROOT = originalFsRoot;
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
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("browses the user's home directory by default when no path is provided", async () => {
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

  it("allows browsing anywhere under HOME by default", async () => {
    const nestedDir = path.join(tempDir, "workspace", "demo");
    await fs.mkdir(nestedDir, { recursive: true });

    const res = await request(app).get(`${API_PREFIX}/fs/browse`).query({ path: nestedDir });

    expect(res.status).toBe(200);
    expect(res.body.data.current).toBe(nestedDir);
  });

  it("rejects paths outside HOME by default", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-fs-outside-"));

    try {
      const res = await request(app).get(`${API_PREFIX}/fs/browse`).query({ path: outsideDir });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toBe("Path is outside the allowed directory.");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
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

  it("prefers USERPROFILE over HOME on Windows when loading the default folder", async () => {
    const windowsHome = path.join(tempDir, "windows-home");
    await fs.mkdir(windowsHome, { recursive: true });
    process.env.HOME = "/nonexistent-posix-home";
    process.env.USERPROFILE = windowsHome;
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
});
