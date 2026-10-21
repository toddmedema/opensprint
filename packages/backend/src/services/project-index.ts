/**
 * SQL project catalog with a one-time import from ~/.opensprint/projects.json.
 * Handles read/write with missing directory creation.
 * Schema: { projects: [{ id, name, repoPath, createdAt }] }
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { ProjectIndex, ProjectIndexEntry } from "@opensprint/shared";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { createLogger } from "../utils/logger.js";
import { fireAndForget } from "../utils/fire-and-forget.js";
import { projectCatalogService } from "./project-catalog.service.js";

const log = createLogger("project-index");

let projectIndexPathForTesting: string | null = null;

function getProjectIndexPaths(): { dir: string; file: string } {
  if (projectIndexPathForTesting) {
    return {
      dir: path.dirname(projectIndexPathForTesting),
      file: projectIndexPathForTesting,
    };
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const dir = path.join(home, ".opensprint");
  return { dir, file: path.join(dir, "projects.json") };
}

export function setProjectIndexPathForTesting(testPath: string | null): void {
  projectIndexPathForTesting = testPath;
}

/** Validate that a project entry has the minimum required fields. */
function isValidEntry(entry: unknown): entry is ProjectIndexEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as ProjectIndexEntry).id === "string" &&
    typeof (entry as ProjectIndexEntry).repoPath === "string" &&
    (entry as ProjectIndexEntry).repoPath.length > 0
  );
}

/**
 * Detect entries whose repoPath lives inside the OS temp directory.
 * These are test artifacts that leaked into the real project index
 * (e.g. due to process.env.HOME races in threaded test runners).
 */
function isInTempDir(repoPath: string): boolean {
  const tmp = os.tmpdir();
  const resolved = path.resolve(repoPath);
  return resolved.startsWith(tmp + path.sep) || resolved === tmp;
}

/** Load the project index from disk. Returns empty array if file missing or corrupt. */
async function loadIndex(): Promise<ProjectIndex> {
  const { dir, file } = getProjectIndexPaths();
  try {
    const data = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(data) as ProjectIndex;
    if (!Array.isArray(parsed?.projects)) {
      return { projects: [] };
    }
    const valid = parsed.projects
      .filter(isValidEntry)
      .map((e) => toCanonicalEntry(e as ProjectIndexEntry & Record<string, unknown>));
    if (valid.length < parsed.projects.length) {
      log.warn("Filtered corrupt entries from project index", {
        filtered: parsed.projects.length - valid.length,
      });
    }
    // Only prune temp-dir entries from the real (non-temp) index.
    // When tests redirect HOME to a temp dir, their index IS in temp
    // and entries with temp paths are expected.
    const indexIsReal = !isInTempDir(dir);
    if (indexIsReal) {
      const clean = valid.filter((e) => !isInTempDir(e.repoPath));
      if (clean.length < valid.length) {
        log.warn("Pruned test artifacts from project index", {
          pruned: valid.length - clean.length,
        });
        fireAndForget(saveIndex({ projects: clean }), "project-index:save-pruned-index");
      }
      return { projects: clean };
    }
    return { projects: valid };
  } catch {
    return { projects: [] };
  }
}

/** Save the project index (atomic write). Creates ~/.opensprint if missing. */
async function saveIndex(index: ProjectIndex): Promise<void> {
  const { dir, file } = getProjectIndexPaths();
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(file, index);
}

/**
 * Get all projects from the index.
 */
export async function getProjects(): Promise<ProjectIndexEntry[]> {
  if (!projectIndexPathForTesting) {
    await ensureCatalogImported();
    return projectCatalogService.list();
  }
  const index = await loadIndex();
  return index.projects;
}

/**
 * Add a project to the index.
 */
export async function addProject(entry: ProjectIndexEntry): Promise<void> {
  if (!projectIndexPathForTesting) {
    await ensureCatalogImported();
    await projectCatalogService.add(toCanonicalEntry(entry));
    return;
  }
  const index = await loadIndex();
  index.projects.push(entry);
  await saveIndex(index);
}

/**
 * Remove a project from the index by id.
 */
export async function removeProject(id: string): Promise<void> {
  if (!projectIndexPathForTesting) {
    await ensureCatalogImported();
    await projectCatalogService.remove(id);
    return;
  }
  const index = await loadIndex();
  index.projects = index.projects.filter((p) => p.id !== id);
  await saveIndex(index);
}

/** Strip to canonical ProjectIndexEntry (no description or other legacy fields). */
function toCanonicalEntry(entry: ProjectIndexEntry): ProjectIndexEntry {
  return {
    id: entry.id,
    name: entry.name ?? "",
    repoPath: entry.repoPath,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Update a project in the index. Merges partial updates. Only the current canonical shape (id, name, repoPath, createdAt) is persisted; other fields are stripped.
 */
export async function updateProject(
  id: string,
  updates: Partial<Omit<ProjectIndexEntry, "id">>
): Promise<ProjectIndexEntry | null> {
  if (!projectIndexPathForTesting) {
    await ensureCatalogImported();
    return projectCatalogService.update(id, updates);
  }
  const index = await loadIndex();
  const idx = index.projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  const current = index.projects[idx] as ProjectIndexEntry & Record<string, unknown>;
  const updated = toCanonicalEntry({
    ...current,
    ...updates,
    id: current.id,
  });
  index.projects[idx] = updated;
  await saveIndex(index);
  return updated;
}

async function ensureCatalogImported(): Promise<void> {
  const { file } = getProjectIndexPaths();
  const source = os.hostname() + ":" + file;
  if (await projectCatalogService.hasImported(source)) return;
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await projectCatalogService.importLegacy(source, []);
    return;
  }
  const parsed: unknown = JSON.parse(content);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("projects" in parsed) ||
    !Array.isArray(parsed.projects)
  )
    throw new Error(
      "Legacy project index must contain a projects array; migration left the original file intact"
    );
  if (!parsed.projects.every(isValidEntry))
    throw new Error(
      "Legacy project index contains an invalid project; migration left the original file intact"
    );
  await projectCatalogService.importLegacy(
    source,
    parsed.projects.map((project) => toCanonicalEntry(project))
  );
}

/** Shared SQL catalog revision for callers that need a discovery invalidation token. */
export async function getProjectIndexRevision(): Promise<number | null> {
  if (projectIndexPathForTesting) return null;
  await ensureCatalogImported();
  return projectCatalogService.revision();
}
