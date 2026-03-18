/**
 * Declarative workflow definitions for task execution.
 *
 * Workflows define the steps a task goes through (e.g. code -> review -> merge)
 * as a DAG of steps with dependencies, success conditions, and retry policies.
 * This replaces the hardcoded state machine in the orchestrator.
 */
import type { AgentRole } from "./agent.js";
/** Condition that must be met for a step to be considered successful */
export type SuccessCondition =
  | "tests_pass"
  | "review_approved"
  | "manual_approval"
  | "merge_clean"
  | "always";
/** Retry policy for a workflow step */
export interface StepRetryPolicy {
  /** Maximum total attempts before escalation (default: 6 = 2 cycles of backoff threshold 3) */
  maxAttempts: number;
  /** Whether to try a more capable model on repeated same-type failures */
  escalateModel: boolean;
}
/** A single step in a workflow definition */
export interface WorkflowStep {
  /** Unique step identifier within this workflow */
  id: string;
  /** Display name for this step */
  name: string;
  /** Which agent role executes this step */
  agentRole: AgentRole;
  /** IDs of steps that must complete before this one can start */
  dependsOn: string[];
  /** What condition determines success */
  successCondition: SuccessCondition;
  /** Retry behavior for this step */
  retryPolicy: StepRetryPolicy;
  /** Optional: template name for prompt generation (defaults to role-based template) */
  promptTemplate?: string;
}
/** Complete workflow definition */
export interface WorkflowDefinition {
  /** Unique workflow ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Schema version for forward compatibility */
  version: number;
  /** Ordered list of steps (topological order preferred but not required) */
  steps: WorkflowStep[];
}
/** Runtime state of a step within a workflow execution */
export type StepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";
/** Runtime state for tracking workflow execution progress */
export interface WorkflowExecutionState {
  workflowId: string;
  taskId: string;
  stepStates: Record<string, StepStatus>;
  currentStepId: string | null;
}
//# sourceMappingURL=workflow.d.ts.map
