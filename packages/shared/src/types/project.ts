/** The five lifecycle phases of an Open Sprint project (SPEED) */
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
  /** AI Autonomy level. When provided, replaces hilConfig. Legacy hilConfig accepted for backward compat. */
  aiAutonomyLevel?: AiAutonomyLevel;
  deliveryMode?: "direct" | "pull_request";
  /** @deprecated Use aiAutonomyLevel. Accepted for backward compat. */
  hilConfig?: HilConfigInput;
  /** Detected or user-selected test framework (PRD §10.2) */
  testFramework?: string | null;
  /** Optional per-project toolchain profile for language-agnostic orchestration. */
  toolchainProfile?: ToolchainProfile;
  /** Max concurrent coder agents (default 1). Stored in project settings. */
  maxConcurrentCoders?: number;
  /** Optional cap on all concurrent agents (plan + execute + merger). Stored in project settings. */
  maxTotalConcurrentAgents?: number;
  /** How to handle tasks with unknown file scope when maxConcurrentCoders > 1. Stored in project settings. */
  unknownScopeStrategy?: "conservative" | "optimistic";
  /** Git working mode: "worktree" or "branches". Stored in project settings. Default: "worktree". */
  gitWorkingMode?: "worktree" | "branches";
  /** Project base branch used when creating task branches and merging completed work. */
  worktreeBaseBranch?: string;
  /** Explicit recovery after a checkout conflict; applies to all non-ignored changes. */
  gitChangesAction?: "stash" | "commit";
}

/** Project update request (partial fields) */
export interface UpdateProjectRequest {
  name?: string;
  repoPath?: string;
}

/** Supported scaffold templates for the Create New wizard */
export type ScaffoldTemplate = "web-app-expo-react" | "empty";

/** Scaffold project request (Create New wizard) */
export interface ScaffoldProjectRequest {
  name: string;
  parentPath: string;
  template: ScaffoldTemplate;
  simpleComplexityAgent?: AgentConfigInput;
  complexComplexityAgent?: AgentConfigInput;
}

/** Scaffold project response */
export interface ScaffoldProjectResponse {
  project: Project;
  /** Present when an init error was detected and recovery was attempted */
  recovery?: ScaffoldRecoveryInfo;
}

/** Details about an agent-driven recovery attempt during scaffolding */
export interface ScaffoldRecoveryInfo {
  attempted: boolean;
  success: boolean;
  errorCategory: string;
  errorSummary: string;
  agentOutput?: string;
}

// Forward references for agent/deployment config — defined in settings.ts
import type {
  AgentConfigInput,
  DeploymentConfigInput,
  HilConfigInput,
  AiAutonomyLevel,
  ToolchainProfile,
} from "./settings.js";
