import fs from "fs/promises";
import path from "path";
import { AGENT_ROLE_CANONICAL_ORDER, OPENSPRINT_PATHS } from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";

/** Read file content or return empty string if missing. */
async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Returns combined agent instructions: general (AGENTS.md) plus optional role-specific content.
 * Role must be in AGENT_ROLE_CANONICAL_ORDER.
 *
 * Format:
 * - `## Agent Instructions\n\n` + general content
 * - If role content exists: `\n\n## Role-specific Instructions\n\n` + role content
 */
export async function getCombinedInstructions(
  repoPath: string,
  role: AgentRole
): Promise<string> {
  if (!AGENT_ROLE_CANONICAL_ORDER.includes(role)) {
    throw new Error(`Invalid agent role: ${role}. Must be one of: ${AGENT_ROLE_CANONICAL_ORDER.join(", ")}`);
  }

  const generalPath = path.join(repoPath, "AGENTS.md");
  const rolePath = path.join(repoPath, OPENSPRINT_PATHS.agents, `${role}.md`);

  const [generalContent, roleContent] = await Promise.all([
    readFileOrEmpty(generalPath),
    readFileOrEmpty(rolePath),
  ]);

  let result = `## Agent Instructions\n\n${generalContent}`;
  if (roleContent.trim()) {
    result += `\n\n## Role-specific Instructions\n\n${roleContent.trim()}`;
  }
  return result;
}
