/**
 * Project index file operations for ~/.opensprint/projects.json.
 * Handles read/write with missing directory creation.
 * Schema: { projects: [{ id, name, description?, repoPath, createdAt }] }
 */
import fs from "fs/promises";
import path from "path";
import type { ProjectIndex, ProjectIndexEntry } from "@opensprint/shared";

function getProjectIndexPaths(): { dir: string; file: string } {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const dir = path.join(home, ".opensprint");
  return { dir, file: path.join(dir, "projects.json") };
}

/** Load the project index from disk. Returns empty array if file missing or corrupt. */
async function loadIndex(): Promise<ProjectIndex> {
  const { file } = getProjectIndexPaths();
  try {
    const data = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(data) as ProjectIndex;
    if (!Array.isArray(parsed?.projects)) {
      return { projects: [] };
    }
    return parsed;
  } catch {
    return { projects: [] };
  }
}

/** Save the project index (atomic write). Creates ~/.opensprint if missing. */
async function saveIndex(index: ProjectIndex): Promise<void> {
  const { dir, file } = getProjectIndexPaths();
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = file + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), "utf-8");
  await fs.rename(tmpPath, file);
}

/**
 * Get all projects from the index.
 */
export async function getProjects(): Promise<ProjectIndexEntry[]> {
  const index = await loadIndex();
  return index.projects;
}

/**
 * Add a project to the index.
 */
export async function addProject(entry: ProjectIndexEntry): Promise<void> {
  const index = await loadIndex();
  index.projects.push(entry);
  await saveIndex(index);
}

/**
 * Remove a project from the index by id.
 */
export async function removeProject(id: string): Promise<void> {
  const index = await loadIndex();
  index.projects = index.projects.filter((p) => p.id !== id);
  await saveIndex(index);
}

/**
 * Update a project in the index. Merges partial updates.
 */
export async function updateProject(
  id: string,
  updates: Partial<Omit<ProjectIndexEntry, "id">>,
): Promise<ProjectIndexEntry | null> {
  const index = await loadIndex();
  const idx = index.projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  const current = index.projects[idx];
  const updated: ProjectIndexEntry = {
    ...current,
    ...updates,
    id: current.id,
  };
  index.projects[idx] = updated;
  await saveIndex(index);
  return updated;
}
