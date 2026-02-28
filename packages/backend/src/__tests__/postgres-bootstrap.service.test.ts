/**
 * Unit tests for postgres-bootstrap.service: isLocalDatabaseUrl, ensureDockerPostgresRunning.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import {
  isLocalDatabaseUrl,
  ensureDockerPostgresRunning,
} from "../services/postgres-bootstrap.service.js";

describe("postgres-bootstrap.service", () => {
  describe("isLocalDatabaseUrl", () => {
    it("returns true for localhost", () => {
      expect(isLocalDatabaseUrl("postgresql://opensprint:opensprint@localhost:5432/opensprint")).toBe(
        true
      );
      expect(isLocalDatabaseUrl("postgres://localhost/db")).toBe(true);
      expect(isLocalDatabaseUrl("postgresql://user:pass@localhost:5433/mydb")).toBe(true);
    });

    it("returns true for 127.0.0.1", () => {
      expect(isLocalDatabaseUrl("postgresql://opensprint@127.0.0.1:5432/opensprint")).toBe(true);
      expect(isLocalDatabaseUrl("postgres://127.0.0.1/db")).toBe(true);
    });

    it("returns false for remote hosts", () => {
      expect(isLocalDatabaseUrl("postgresql://user:pass@remote.example.com:5432/mydb")).toBe(
        false
      );
      expect(isLocalDatabaseUrl("postgresql://user@db.supabase.com:5432/postgres")).toBe(false);
      expect(isLocalDatabaseUrl("postgresql://user@aws-0-us-west-1.pooler.supabase.com:6543/postgres")).toBe(
        false
      );
    });

    it("returns false for invalid URL", () => {
      expect(isLocalDatabaseUrl("")).toBe(false);
      expect(isLocalDatabaseUrl("not-a-url")).toBe(false);
    });
  });

  describe("ensureDockerPostgresRunning", () => {
    it("returns immediately for remote database URL", async () => {
      const remoteUrl = "postgresql://user:pass@remote.example.com:5432/mydb";
      await expect(ensureDockerPostgresRunning(remoteUrl)).resolves.toBeUndefined();
    });

    it("returns immediately for invalid URL (treated as non-local)", async () => {
      await expect(ensureDockerPostgresRunning("")).resolves.toBeUndefined();
    });

    it("throws when local URL and docker-compose.yml not found", async () => {
      const localUrl = "postgresql://opensprint:opensprint@localhost:5432/opensprint";
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-pg-bootstrap-"));
      const originalCwd = process.cwd();

      try {
        process.chdir(tempDir);
        await expect(ensureDockerPostgresRunning(localUrl)).rejects.toThrow(
          "docker-compose.yml not found"
        );
      } finally {
        process.chdir(originalCwd);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("when local URL and compose exists but Postgres not ready, eventually fails", async () => {
      const localUrl = "postgresql://opensprint:opensprint@localhost:5432/opensprint";
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-pg-bootstrap-"));
      const originalCwd = process.cwd();
      const originalMaxWait = process.env.OPENSPRINT_POSTGRES_MAX_WAIT_MS;

      await fs.writeFile(
        path.join(tempDir, "docker-compose.yml"),
        "services:\n  postgres:\n    image: postgres:16-alpine\n",
        "utf-8"
      );

      try {
        process.chdir(tempDir);
        process.env.OPENSPRINT_POSTGRES_MAX_WAIT_MS = "5000";
        const promise = ensureDockerPostgresRunning(localUrl);
        await expect(promise).rejects.toThrow();
      } finally {
        process.env.OPENSPRINT_POSTGRES_MAX_WAIT_MS = originalMaxWait;
        process.chdir(originalCwd);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15_000);
  });
});
