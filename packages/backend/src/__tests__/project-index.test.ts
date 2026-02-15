import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import * as projectIndex from "../services/project-index.js";

describe("project-index", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-project-index-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("getProjects", () => {
    it("returns empty array when file does not exist", async () => {
      const projects = await projectIndex.getProjects();
      expect(projects).toEqual([]);
    });

    it("returns empty array when file is corrupt", async () => {
      const dir = path.join(tempDir, ".opensprint");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "projects.json"), "invalid json{", "utf-8");

      const projects = await projectIndex.getProjects();
      expect(projects).toEqual([]);
    });

    it("returns empty array when projects is not an array", async () => {
      const dir = path.join(tempDir, ".opensprint");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "projects.json"),
        JSON.stringify({ projects: "not-array" }),
        "utf-8",
      );

      const projects = await projectIndex.getProjects();
      expect(projects).toEqual([]);
    });

    it("returns projects from existing file", async () => {
      const projects = await projectIndex.getProjects();
      expect(projects).toEqual([]);

      await projectIndex.addProject({
        id: "proj-1",
        name: "Project One",
        description: "First project",
        repoPath: "/path/to/proj1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const loaded = await projectIndex.getProjects();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual({
        id: "proj-1",
        name: "Project One",
        description: "First project",
        repoPath: "/path/to/proj1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });
  });

  describe("addProject", () => {
    it("creates ~/.opensprint directory if missing", async () => {
      const opensprintDir = path.join(tempDir, ".opensprint");
      await projectIndex.addProject({
        id: "p1",
        name: "Test",
        description: "",
        repoPath: "/tmp/repo",
        createdAt: new Date().toISOString(),
      });

      const stat = await fs.stat(opensprintDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("writes project to projects.json", async () => {
      const entry = {
        id: "uuid-123",
        name: "My Project",
        description: "A test project",
        repoPath: "/home/user/repos/my-project",
        createdAt: "2026-02-15T12:00:00.000Z",
      };

      await projectIndex.addProject(entry);

      const filePath = path.join(tempDir, ".opensprint", "projects.json");
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.projects).toHaveLength(1);
      expect(parsed.projects[0]).toEqual(entry);
    });

    it("appends to existing projects", async () => {
      await projectIndex.addProject({
        id: "p1",
        name: "First",
        description: "",
        repoPath: "/a",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await projectIndex.addProject({
        id: "p2",
        name: "Second",
        description: "",
        repoPath: "/b",
        createdAt: "2026-01-02T00:00:00.000Z",
      });

      const projects = await projectIndex.getProjects();
      expect(projects).toHaveLength(2);
      expect(projects[0].id).toBe("p1");
      expect(projects[1].id).toBe("p2");
    });
  });

  describe("removeProject", () => {
    it("removes project by id", async () => {
      await projectIndex.addProject({
        id: "to-remove",
        name: "Remove Me",
        description: "",
        repoPath: "/x",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await projectIndex.addProject({
        id: "keep",
        name: "Keep Me",
        description: "",
        repoPath: "/y",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      await projectIndex.removeProject("to-remove");

      const projects = await projectIndex.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe("keep");
    });

    it("is idempotent when project does not exist", async () => {
      await projectIndex.addProject({
        id: "p1",
        name: "One",
        description: "",
        repoPath: "/a",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      await projectIndex.removeProject("nonexistent");

      const projects = await projectIndex.getProjects();
      expect(projects).toHaveLength(1);
    });
  });

  describe("updateProject", () => {
    it("updates project by id", async () => {
      await projectIndex.addProject({
        id: "to-update",
        name: "Original",
        description: "First",
        repoPath: "/path",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const updated = await projectIndex.updateProject("to-update", {
        name: "Updated Name",
        description: "New description",
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated Name");
      expect(updated!.description).toBe("New description");
      expect(updated!.repoPath).toBe("/path");
      expect(updated!.id).toBe("to-update");

      const projects = await projectIndex.getProjects();
      expect(projects[0].name).toBe("Updated Name");
    });

    it("returns null when project does not exist", async () => {
      const result = await projectIndex.updateProject("nonexistent", { name: "X" });
      expect(result).toBeNull();
    });

    it("merges partial updates", async () => {
      await projectIndex.addProject({
        id: "p1",
        name: "Original",
        description: "Desc",
        repoPath: "/path",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      await projectIndex.updateProject("p1", { name: "New Name" });

      const projects = await projectIndex.getProjects();
      expect(projects[0].name).toBe("New Name");
      expect(projects[0].description).toBe("Desc");
      expect(projects[0].repoPath).toBe("/path");
    });
  });

  describe("integration", () => {
    it("full CRUD cycle", async () => {
      const projects = await projectIndex.getProjects();
      expect(projects).toEqual([]);

      await projectIndex.addProject({
        id: "crud-1",
        name: "CRUD Project",
        description: "For testing",
        repoPath: "/tmp/crud",
        createdAt: "2026-02-15T00:00:00.000Z",
      });

      let all = await projectIndex.getProjects();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe("CRUD Project");

      const updated = await projectIndex.updateProject("crud-1", {
        name: "CRUD Project (Updated)",
        description: "Updated desc",
      });
      expect(updated!.name).toBe("CRUD Project (Updated)");

      await projectIndex.removeProject("crud-1");
      all = await projectIndex.getProjects();
      expect(all).toEqual([]);
    });
  });
});
