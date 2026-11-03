import fs from "node:fs/promises";
import path from "node:path";
export interface GovernanceContextArtifacts {
  complete: boolean;
  files: Record<string, string>;
  error?: string;
}
/** Store exact bytes, including dependency diffs, before active directories or sessions are pruned. */
export async function captureGovernanceContextArtifacts(
  contextDir: string
): Promise<GovernanceContextArtifacts> {
  const files: Record<string, string> = {};
  let bytes = 0;
  try {
    async function visit(relative = ""): Promise<void> {
      for (const entry of await fs.readdir(path.join(contextDir, relative), {
        withFileTypes: true,
      })) {
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink())
          throw new Error("Linked context artifacts cannot be independently retained");
        if (entry.isDirectory()) await visit(key);
        else if (entry.isFile()) {
          const body = await fs.readFile(path.join(contextDir, key));
          bytes += body.length;
          if (bytes > 20 * 1024 * 1024 || Object.keys(files).length >= 1000)
            throw new Error("Original context exceeds replay artifact retention limits");
          files[key] = body.toString("base64");
        } else throw new Error("Unsupported original context artifact");
      }
    }
    await visit();
    if (!("spec.md" in files) || !("plan.md" in files))
      throw new Error("Original task requirement artifacts are missing");
    return { complete: true, files };
  } catch (err) {
    return { complete: false, files: {}, error: err instanceof Error ? err.message : String(err) };
  }
}
