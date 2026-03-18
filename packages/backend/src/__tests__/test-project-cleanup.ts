import { activeAgentsService } from "../services/active-agents.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import type { ProjectService } from "../services/project.service.js";

interface CleanupTestProjectOptions {
  projectService?: ProjectService | null;
  projectId?: string | null;
}

/**
 * Best-effort cleanup for tests that create real projects.
 * Ensures background orchestrator state is cleared before the temp HOME is removed.
 */
export async function cleanupTestProject(
  options: CleanupTestProjectOptions
): Promise<void> {
  const projectId = options.projectId?.trim();
  if (!projectId) return;

  orchestratorService.stopProject(projectId);

  for (const agent of activeAgentsService.listEntries(projectId)) {
    activeAgentsService.unregister(agent.id);
  }

  if (!options.projectService) return;

  try {
    await options.projectService.deleteProject(projectId);
  } catch {
    // Ignore cleanup failures in tests; temp HOME removal handles leftovers.
  }
}
