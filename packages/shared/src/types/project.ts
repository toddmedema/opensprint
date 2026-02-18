/** The five lifecycle phases of an OpenSprint project (SPEED) */
export type ProjectPhase = "sketch" | "plan" | "execute" | "eval" | "deliver";

/** Core project entity */
export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  currentPhase: ProjectPhase;
  createdAt: string;
  updatedAt: string;
  /** Overall progress 0–100 (build tasks done / total). PRD §6.1 */
  progressPercent?: number;
}

/** Entry in the global project index (~/.opensprint/projects.json) */
export interface ProjectIndexEntry {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  createdAt: string;
}

/** Global project index file structure */
export interface ProjectIndex {
  projects: ProjectIndexEntry[];
}

/** Project creation request */
export interface CreateProjectRequest {
  name: string;
  description: string;
  repoPath: string;
  planningAgent: AgentConfigInput;
  codingAgent: AgentConfigInput;
  deployment: DeploymentConfigInput;
  hilConfig: HilConfigInput;
  /** Detected or user-selected test framework (PRD §10.2) */
  testFramework?: string | null;
}

/** Project update request (partial fields) */
export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  repoPath?: string;
}

// Forward references for agent/deployment config — defined in settings.ts
import type { AgentConfigInput, DeploymentConfigInput, HilConfigInput } from "./settings.js";
