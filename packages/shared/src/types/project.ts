/** The five lifecycle phases of an OpenSprint project (SPEED) */
export type ProjectPhase = "sketch" | "plan" | "execute" | "eval" | "deliver";

/** Core project entity */
export interface Project {
  id: string;
  name: string;
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
  repoPath: string;
  /** @deprecated Use simpleComplexityAgent. Accepted for backward compat. */
  lowComplexityAgent?: AgentConfigInput;
  /** @deprecated Use complexComplexityAgent. Accepted for backward compat. */
  highComplexityAgent?: AgentConfigInput;
  simpleComplexityAgent?: AgentConfigInput;
  complexComplexityAgent?: AgentConfigInput;
  deployment: DeploymentConfigInput;
  hilConfig: HilConfigInput;
  /** Detected or user-selected test framework (PRD §10.2) */
  testFramework?: string | null;
  /** Max concurrent coder agents (default 1). Stored in project settings. */
  maxConcurrentCoders?: number;
  /** How to handle tasks with unknown file scope when maxConcurrentCoders > 1. Stored in project settings. */
  unknownScopeStrategy?: "conservative" | "optimistic";
  /** Git working mode: "worktree" or "branches". Stored in project settings. Default: "worktree". */
  gitWorkingMode?: "worktree" | "branches";
  /** Per-project API keys. When absent, backend falls back to process.env (from .env). Project keys take precedence. */
  apiKeys?: ApiKeys;
}

/** Project update request (partial fields) */
export interface UpdateProjectRequest {
  name?: string;
  repoPath?: string;
}

/** Scaffold project request (Create New wizard) */
export interface ScaffoldProjectRequest {
  name: string;
  parentPath: string;
  template: "web-app-expo-react";
  simpleComplexityAgent?: AgentConfigInput;
  complexComplexityAgent?: AgentConfigInput;
}

/** Scaffold project response */
export interface ScaffoldProjectResponse {
  project: Project;
  runCommand: string;
}

// Forward references for agent/deployment config — defined in settings.ts
import type {
  AgentConfigInput,
  DeploymentConfigInput,
  HilConfigInput,
  ApiKeys,
} from "./settings.js";
