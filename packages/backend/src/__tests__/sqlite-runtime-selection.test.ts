import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openSqliteDatabase } from "../db/sqlite-client.js";

const require = createRequire(import.meta.url);
let fixtureDir: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe("SQLite runtime selection", () => {
  it("opens the database through the configured runtime even when the default module imports", async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-runtime-selection-"));
    const modulePath = path.join(fixtureDir, "configured-sqlite.cjs");
    const receiptPath = path.join(fixtureDir, "opened.json");
    await fs.writeFile(
      modulePath,
      `
      const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
      module.exports = function(file) {
        require("node:fs").writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({file}));
        return new Database(file);
      };
    `
    );
    vi.stubEnv("OPENSPRINT_SQLITE_MODULE_PATH", modulePath);
    const { db, close } = await openSqliteDatabase(":memory:");
    try {
      expect(db.prepare("SELECT 42 AS answer").get()).toEqual({ answer: 42 });
      expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toEqual({ file: ":memory:" });
    } finally {
      close();
    }
  });

  it("reports an unavailable configured runtime instead of silently using another installation", async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-runtime-selection-"));
    vi.stubEnv("OPENSPRINT_SQLITE_MODULE_PATH", path.join(fixtureDir, "missing-runtime"));
    await expect(openSqliteDatabase(":memory:")).rejects.toThrow(
      "Configured SQLite module path does not exist"
    );
  });
});
