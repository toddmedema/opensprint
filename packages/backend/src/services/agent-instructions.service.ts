import fs from "fs/promises";
import path from "path";
import { AGENT_ROLE_CANONICAL_ORDER, OPENSPRINT_PATHS } from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { taskStore } from "./task-store.service.js";
import { assertMigrationCompleteForResource } from "./migration-guard.service.js";
import {
  getOpenSprintDefaultInstructions,
  OPENSPRINT_DEFAULT_INSTRUCTIONS_HEADING,
} from "./agent-default-instructions.js";

const projectService = new ProjectService();

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

export class AgentInstructionsService {
  async getGeneralInstructions(projectId: string): Promise<string> {
    const project = await projectService.getProject(projectId);
    return readFileOrEmpty(path.join(project.repoPath, "AGENTS.md"));
  }

  async setGeneralInstructions(projectId: string, content: string): Promise<void> {
    const project = await projectService.getProject(projectId);
    await fs.writeFile(path.join(project.repoPath, "AGENTS.md"), content, "utf-8");
  }

  async getRoleInstructions(projectId: string, role: AgentRole): Promise<string> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT content FROM agent_instructions WHERE project_id = $1 AND role = $2",
      [projectId, role]
    );
    if (row) {
      return String(row.content ?? "");
    }

    const project = await projectService.getProject(projectId);
    await assertMigrationCompleteForResource({
      hasDbRecord: false,
      resource: "Agent instructions",
      legacyPaths: [path.join(project.repoPath, OPENSPRINT_PATHS.agents, `${role}.md`)],
      projectId,
    });
    return "";
  }

  async setRoleInstructions(projectId: string, role: AgentRole, content: string): Promise<void> {
    const existing = await taskStore
      .getDb()
      .then((client) =>
        client.queryOne("SELECT 1 FROM agent_instructions WHERE project_id = $1 AND role = $2", [
          projectId,
          role,
        ])
      );
    if (!existing) {
      const project = await projectService.getProject(projectId);
      await assertMigrationCompleteForResource({
        hasDbRecord: false,
        resource: "Agent instructions",
        legacyPaths: [path.join(project.repoPath, OPENSPRINT_PATHS.agents, `${role}.md`)],
        projectId,
      });
    }

    const now = new Date().toISOString();
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO agent_instructions (project_id, role, content, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(project_id, role) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`,
        [projectId, role, content, now]
      );
    });
  }
}

export const agentInstructionsService = new AgentInstructionsService();

/**
 * Returns combined agent instructions: Open Sprint defaults, project general (AGENTS.md),
 * and optional project role-specific content.
 * Role must be in AGENT_ROLE_CANONICAL_ORDER.
 *
 * Format:
 * - `## Open Sprint Defaults\n\n` + shared + role defaults
 * - `## Agent Instructions\n\n` + general content
 * - If role content exists: `\n\n## Role-specific Instructions\n\n` + role content
 */
export async function getCombinedInstructions(repoPath: string, role: AgentRole): Promise<string> {
  if (!AGENT_ROLE_CANONICAL_ORDER.includes(role)) {
    throw new Error(
      `Invalid agent role: ${role}. Must be one of: ${AGENT_ROLE_CANONICAL_ORDER.join(", ")}`
    );
  }

  const generalPath = path.join(repoPath, "AGENTS.md");
  const rolePath = path.join(repoPath, OPENSPRINT_PATHS.agents, `${role}.md`);
  let generalContent = await readFileOrEmpty(generalPath);

  let roleContent = "";
  const lookupProjectByRepo =
    typeof (projectService as unknown as { getProjectByRepoPath?: unknown })
      .getProjectByRepoPath === "function"
      ? (
          projectService as unknown as {
            getProjectByRepoPath: (repoPath: string) => Promise<{ id: string } | null>;
          }
        ).getProjectByRepoPath
      : null;

  const project = lookupProjectByRepo ? await lookupProjectByRepo(repoPath) : null;
  if (project) {
    const { governanceService } = await import("./governance.service.js");
    const governance = await governanceService.getConfig(project.id);
    if (governance.mode !== "disabled" && ["coder", "reviewer", "judge"].includes(role)) {
      const release = await governanceService.getActiveRelease(project.id);
      if (!release || typeof release.instructions[role] !== "string") {
        throw new Error(`Approved policy has no complete ${role} instruction snapshot.`);
      }
      return release.instructions[role]!;
    }
    if (governance.mode === "disabled") {
      const { readActiveBehaviorInstructionContent } =
        await import("./behavior-version-store.service.js");
      const promoted = await readActiveBehaviorInstructionContent(project.id, role);
      if (promoted) {
        generalContent = promoted.general;
        roleContent = promoted.role;
      } else roleContent = await agentInstructionsService.getRoleInstructions(project.id, role);
    } else roleContent = await agentInstructionsService.getRoleInstructions(project.id, role);
  } else {
    roleContent = await readFileOrEmpty(rolePath);
  }

  const defaultInstructions = getOpenSprintDefaultInstructions(role);

  let result =
    `${OPENSPRINT_DEFAULT_INSTRUCTIONS_HEADING}\n\n${defaultInstructions}` +
    `\n\n## Agent Instructions\n\n${generalContent}`;
  if (roleContent.trim()) {
    result += `\n\n## Role-specific Instructions\n\n${roleContent.trim()}`;
  }
  return result;
}
