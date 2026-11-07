import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDesktopSqliteModulePath } from "./sqlite-runtime-path";

const require = createRequire(import.meta.url);

describe("desktop SQLite runtime path", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-electron-sqlite-path-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeModule(backendDir: string, runtime: string): Promise<void> {
    const moduleDir = path.join(backendDir, "sqlite-runtime", "node_modules", "better-sqlite3");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, "package.json"), JSON.stringify({ main: "index.cjs" }));
    await fs.writeFile(
      path.join(moduleDir, "index.cjs"),
      `module.exports = ${JSON.stringify(runtime)};`
    );
  }

  it("loads the prepared Electron runtime during development even when a repository runtime exists", async () => {
    const backendDir = path.join(tempDir, "packages", "backend");
    const electronDir = path.join(tempDir, "packages", "electron");
    await writeModule(backendDir, "repository-node-runtime");
    await writeModule(
      path.join(electronDir, "desktop-resources", "backend"),
      "prepared-electron-runtime"
    );

    const modulePath = getDesktopSqliteModulePath({
      isPackaged: false,
      backendDir,
      electronDistDir: path.join(electronDir, "dist"),
    });

    expect(require(modulePath)).toBe("prepared-electron-runtime");
  });

  it("keeps packaged apps on the runtime shipped beside their backend", async () => {
    const backendDir = path.join(tempDir, "Open Sprint.app", "Contents", "Resources", "backend");
    const electronDistDir = path.join(tempDir, "unrelated", "dist");
    await writeModule(backendDir, "packaged-electron-runtime");
    await writeModule(
      path.resolve(electronDistDir, "..", "desktop-resources", "backend"),
      "dev-decoy"
    );

    const modulePath = getDesktopSqliteModulePath({
      isPackaged: true,
      backendDir,
      electronDistDir,
    });

    expect(require(modulePath)).toBe("packaged-electron-runtime");
  });
});
