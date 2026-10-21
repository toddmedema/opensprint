import fs from "node:fs/promises";
import path from "node:path";

/** Git for Windows traverses junction targets when deleting a worktree. */
export async function unlinkWorktreeLinks(worktreePath: string): Promise<void> {
  if (process.platform !== "win32") return;
  let root;
  try {
    root = await fs.lstat(worktreePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`Refusing to traverse a linked worktree root: ${worktreePath}`);
  }
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // Unlink the junction itself; never recurse through it into shared dependencies.
        await fs.unlink(entryPath);
      } else if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  };
  await visit(worktreePath);
}
