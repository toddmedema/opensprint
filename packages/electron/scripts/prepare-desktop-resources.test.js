import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const {
  bundleBackendRuntime,
  buildElectronRebuildArgs,
  generateIconComposerAssets,
  normalizeElectronVersion,
  resolveConfiguredElectronVersion,
  resolveElectronVersion,
  resolveInstalledElectronVersion,
} = require("./prepare-desktop-resources.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("prepare-desktop-resources", () => {
  it("runs bundled CommonJS dependencies that require Node built-ins", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensprint-backend-bundle-"));
    try {
      const entryPoint = path.join(tempDir, "entry.cjs");
      const dataPath = path.join(tempDir, "message.txt");
      fs.writeFileSync(dataPath, "backend bundle started");
      fs.writeFileSync(
        entryPoint,
        `const fs = require("node:fs");
console.log(fs.readFileSync(${JSON.stringify(dataPath)}, "utf8"));`
      );
      const backendOut = path.join(tempDir, "backend");
      await bundleBackendRuntime(backendOut, entryPoint);

      const output = execFileSync(
        process.execPath,
        [path.join(backendOut, "dist", "services", "index.mjs")],
        { encoding: "utf8" }
      );
      expect(output.trim()).toBe("backend bundle started");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("initializes a fresh SQLite database from the packaged migrations", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensprint-schema-bundle-"));
    try {
      const entryPoint = path.join(tempDir, "entry.mjs");
      const schemaPath = path.resolve(__dirname, "../../backend/src/db/schema.ts");
      fs.writeFileSync(
        entryPoint,
        `import { runSchema } from ${JSON.stringify(schemaPath)};
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
await runSchema({ query: async (sql, params = []) => db.prepare(sql).all(...params) }, "sqlite");
console.log(JSON.stringify({
  plans: db.prepare("SELECT COUNT(*) AS count FROM plans").get().count,
  tasks: db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count
}));
db.close();`
      );
      const backendOut = path.join(tempDir, "backend");
      await bundleBackendRuntime(backendOut, entryPoint);

      const output = execFileSync(
        process.execPath,
        [path.join(backendOut, "dist", "services", "index.mjs")],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
      expect(JSON.parse(output)).toEqual({ plans: 0, tasks: 0 });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes semver prefixes", () => {
    expect(normalizeElectronVersion("^41.0.0")).toBe("41.0.0");
    expect(normalizeElectronVersion("  ~41.0.2 ")).toBe("41.0.2");
  });

  it("prefers the installed Electron version for native rebuilds", () => {
    const installed = resolveInstalledElectronVersion();
    expect(installed).toMatch(/^\d+\.\d+\.\d+$/);
    expect(resolveElectronVersion({})).toBe(installed);
  });

  it("lets explicit environment overrides win", () => {
    const previous = process.env.OPENSPRINT_ELECTRON_VERSION;
    process.env.OPENSPRINT_ELECTRON_VERSION = "99.0.0";
    try {
      expect(resolveElectronVersion({})).toBe("99.0.0");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSPRINT_ELECTRON_VERSION;
      } else {
        process.env.OPENSPRINT_ELECTRON_VERSION = previous;
      }
    }
  });

  it("resolves a configured fallback version from package.json", () => {
    expect(resolveConfiguredElectronVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses a real source rebuild for forced native recovery", () => {
    expect(
      buildElectronRebuildArgs({
        electronVersion: "41.0.2",
        moduleDir: "/tmp/backend",
        targetArch: "arm64",
        force: true,
        buildFromSource: true,
      })
    ).toEqual([
      "electron-rebuild",
      "--version",
      "41.0.2",
      "--module-dir",
      "/tmp/backend",
      "--arch",
      "arm64",
      "--force",
      "--build-from-source",
    ]);
  });

  it("includes light, dark, and tinted Icon Composer variants for macOS builds", async () => {
    await generateIconComposerAssets();
    const iconJsonPath = path.join(__dirname, "..", "build", "OpenSprint.icon", "icon.json");
    const iconJson = JSON.parse(fs.readFileSync(iconJsonPath, "utf8"));
    const layer = iconJson.groups[0].layers[0];
    const specializations = layer["image-name-specializations"];

    expect(specializations).toEqual([
      { value: "Assets/light.png" },
      { appearance: "dark", value: "Assets/dark.png" },
      { appearance: "tinted", value: "Assets/tinted.png" },
    ]);
    expect(layer.position["translation-in-points"]).toEqual([0, 0]);
  });

  it("keeps the rasterized artwork optically shifted toward center", async () => {
    await generateIconComposerAssets();
    const sharp = require("sharp");
    const lightIconPath = path.join(
      __dirname,
      "..",
      "build",
      "OpenSprint.icon",
      "Assets",
      "light.png"
    );
    const { data, info } = await sharp(lightIconPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let minX = info.width;
    let maxX = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const alpha = data[(y * info.width + x) * 4 + 3];
        if (alpha <= 10) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }

    const centerX = (minX + maxX) / 2;
    expect(centerX).toBeGreaterThan(525);
    expect(centerX).toBeLessThan(540);
  });
});
