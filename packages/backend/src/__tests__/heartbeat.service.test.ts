import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { heartbeatService, type HeartbeatData } from "../services/heartbeat.service.js";
import { HEARTBEAT_STALE_MS } from "@opensprint/shared";

describe("HeartbeatService", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `heartbeat-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe("writeHeartbeat", () => {
    it("writes heartbeat file with correct structure", async () => {
      const taskId = "task-1";
      const data: HeartbeatData = {
        processGroupLeaderPid: 12345,
        lastOutputTimestamp: 1000,
        heartbeatTimestamp: 2000,
      };

      await heartbeatService.writeHeartbeat(tmpDir, taskId, data);

      const heartbeatPath = path.join(tmpDir, ".opensprint", "active", taskId, "heartbeat.json");
      const raw = await fs.readFile(heartbeatPath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(data);
    });
  });

  describe("readHeartbeat", () => {
    it("reads valid heartbeat", async () => {
      const taskId = "task-2";
      const data: HeartbeatData = {
        processGroupLeaderPid: 999,
        lastOutputTimestamp: 5000,
        heartbeatTimestamp: 6000,
      };
      const dir = path.join(tmpDir, ".opensprint", "active", taskId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "heartbeat.json"), JSON.stringify(data));

      const result = await heartbeatService.readHeartbeat(tmpDir, taskId);
      expect(result).toEqual(data);
    });

    it("returns null for missing file", async () => {
      const result = await heartbeatService.readHeartbeat(tmpDir, "nonexistent");
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", async () => {
      const taskId = "task-invalid";
      const dir = path.join(tmpDir, ".opensprint", "active", taskId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "heartbeat.json"), "not json");

      const result = await heartbeatService.readHeartbeat(tmpDir, taskId);
      expect(result).toBeNull();
    });

    it("returns null for incomplete heartbeat", async () => {
      const taskId = "task-incomplete";
      const dir = path.join(tmpDir, ".opensprint", "active", taskId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "heartbeat.json"),
        JSON.stringify({ processGroupLeaderPid: 1 }) // missing lastOutputTimestamp, heartbeatTimestamp
      );

      const result = await heartbeatService.readHeartbeat(tmpDir, taskId);
      expect(result).toBeNull();
    });
  });

  describe("isStale", () => {
    it("returns true when heartbeat is older than maxAge", () => {
      const heartbeat: HeartbeatData = {
        processGroupLeaderPid: 1,
        lastOutputTimestamp: 0,
        heartbeatTimestamp: Date.now() - HEARTBEAT_STALE_MS - 1000,
      };
      expect(heartbeatService.isStale(heartbeat)).toBe(true);
    });

    it("returns false when heartbeat is recent", () => {
      const heartbeat: HeartbeatData = {
        processGroupLeaderPid: 1,
        lastOutputTimestamp: Date.now(),
        heartbeatTimestamp: Date.now(),
      };
      expect(heartbeatService.isStale(heartbeat)).toBe(false);
    });

    it("respects custom maxAgeMs", () => {
      const heartbeat: HeartbeatData = {
        processGroupLeaderPid: 1,
        lastOutputTimestamp: 0,
        heartbeatTimestamp: Date.now() - 5000,
      };
      expect(heartbeatService.isStale(heartbeat, 10000)).toBe(false);
      expect(heartbeatService.isStale(heartbeat, 1000)).toBe(true);
    });
  });

  describe("deleteHeartbeat", () => {
    it("removes heartbeat file", async () => {
      const taskId = "task-delete";
      await heartbeatService.writeHeartbeat(tmpDir, taskId, {
        processGroupLeaderPid: 1,
        lastOutputTimestamp: 0,
        heartbeatTimestamp: Date.now(),
      });

      await heartbeatService.deleteHeartbeat(tmpDir, taskId);

      const heartbeatPath = path.join(tmpDir, ".opensprint", "active", taskId, "heartbeat.json");
      await expect(fs.access(heartbeatPath)).rejects.toThrow();
    });

    it("does not throw when file does not exist", async () => {
      await expect(heartbeatService.deleteHeartbeat(tmpDir, "nonexistent")).resolves.not.toThrow();
    });
  });

  describe("findStaleHeartbeats", () => {
    it("finds worktrees with stale heartbeats", async () => {
      const worktreeBase = path.join(tmpDir, "worktrees");
      await fs.mkdir(worktreeBase, { recursive: true });

      // Task 1: stale heartbeat
      const task1Dir = path.join(worktreeBase, "task-stale");
      await fs.mkdir(path.join(task1Dir, ".opensprint", "active", "task-stale"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(task1Dir, ".opensprint", "active", "task-stale", "heartbeat.json"),
        JSON.stringify({
          processGroupLeaderPid: 1,
          lastOutputTimestamp: 0,
          heartbeatTimestamp: Date.now() - HEARTBEAT_STALE_MS - 1000,
        })
      );

      // Task 2: fresh heartbeat
      const task2Dir = path.join(worktreeBase, "task-fresh");
      await fs.mkdir(path.join(task2Dir, ".opensprint", "active", "task-fresh"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(task2Dir, ".opensprint", "active", "task-fresh", "heartbeat.json"),
        JSON.stringify({
          processGroupLeaderPid: 2,
          lastOutputTimestamp: Date.now(),
          heartbeatTimestamp: Date.now(),
        })
      );

      const stale = await heartbeatService.findStaleHeartbeats(worktreeBase);
      expect(stale).toHaveLength(1);
      expect(stale[0].taskId).toBe("task-stale");
    });

    it("returns empty array when worktree base does not exist", async () => {
      const stale = await heartbeatService.findStaleHeartbeats(
        path.join(tmpDir, "nonexistent-worktrees")
      );
      expect(stale).toEqual([]);
    });
  });
});
