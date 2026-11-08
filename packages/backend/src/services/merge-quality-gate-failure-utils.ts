/**
 * Pure helpers for merge / quality-gate failure formatting and MergeJobError inspection.
 * Extracted from MergeCoordinatorService for isolation and tests.
 */

import { MergeJobError } from "./git-commit-queue.service.js";
import { compactExecutionText } from "./task-execution-summary.js";

export const QUALITY_GATE_OUTPUT_SNIPPET_LIMIT = 1800;

/** Structural input compatible with MergeCoordinatorService.MergeQualityGateFailure. */
export type QualityGateFailureForHelpers = {
  preserveWork?: boolean;
  recoveryIncidentId?: string;
  command: string;
  reason?: string;
  output?: string;
  outputSnippet?: string;
  firstErrorLine?: string;
  worktreePath?: string;
  validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root";
  category?: "environment_setup" | "quality_gate";
  autoRepairAttempted?: boolean;
  autoRepairSucceeded?: boolean;
  autoRepairCommands?: string[];
  autoRepairOutput?: string;
  executable?: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
  classificationConfidence?: "high" | "low";
  classificationReason?: string;
  gateNodeVersion?: string;
  gateNpmVersion?: string;
  gateDependencyStrategy?: string;
  gateHermeticNodeModules?: boolean;
};

export type MergeJobQualityGateAttachment = NonNullable<MergeJobError["qualityGateFailure"]>;

export type QualityGateStructuredDetails = {
  failedGateCommand: string | null;
  failedGateReason: string | null;
  failedGateOutputSnippet: string | null;
  worktreePath: string | null;
  qualityGateCategory: "quality_gate" | "environment_setup" | null;
  qualityGateValidationWorkspace:
    | "baseline"
    | "merged_candidate"
    | "task_worktree"
    | "repo_root"
    | null;
  qualityGateRepairAttempted: boolean;
  qualityGateRepairSucceeded: boolean;
  qualityGateExecutable: string | null;
  qualityGateCwd: string | null;
  qualityGateExitCode: number | null;
  qualityGateSignal: string | null;
  qualityGateClassificationConfidence: "high" | "low" | null;
  qualityGateClassificationReason: string | null;
  qualityGateDetail: {
    command: string | null;
    reason: string | null;
    outputSnippet: string | null;
    worktreePath: string | null;
    firstErrorLine: string | null;
    category: "quality_gate" | "environment_setup" | null;
    validationWorkspace: "baseline" | "merged_candidate" | "task_worktree" | "repo_root" | null;
    repairAttempted: boolean;
    repairSucceeded: boolean;
    executable: string | null;
    cwd: string | null;
    exitCode: number | null;
    signal: string | null;
    classificationConfidence: "high" | "low" | null;
    classificationReason: string | null;
    gateNodeVersion: string | null;
    gateNpmVersion: string | null;
    gateDependencyStrategy: string | null;
    gateHermeticNodeModules: boolean | null;
  } | null;
};

export function getFirstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export function getQualityGateFirstErrorLine(failure: QualityGateFailureForHelpers): string {
  const explicit = failure.firstErrorLine?.trim();
  if (explicit) return explicit;
  return (
    (failure.output != null ? getFirstNonEmptyLine(failure.output) : null) ??
    (failure.reason != null ? getFirstNonEmptyLine(failure.reason) : null) ??
    "Unknown quality gate failure"
  );
}

export function toQualityGateOutputSnippet(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return compactExecutionText(trimmed, QUALITY_GATE_OUTPUT_SNIPPET_LIMIT);
}

export function getQualityGateFailureDetailsFromMergeError(
  mergeErr: Error
): MergeJobQualityGateAttachment | null {
  if (!(mergeErr instanceof MergeJobError) || mergeErr.stage !== "quality_gate") return null;
  return mergeErr.qualityGateFailure ?? null;
}

export function buildQualityGateStructuredDetails(
  qualityGateFailure: MergeJobQualityGateAttachment | null | undefined,
  fallbackWorktreePath?: string | null,
  fallback?: {
    command?: string | null;
    reason?: string | null;
    firstErrorLine?: string | null;
    category?: "quality_gate" | "environment_setup" | null;
    validationWorkspace?: "baseline" | "merged_candidate" | "task_worktree" | "repo_root" | null;
  }
): QualityGateStructuredDetails {
  const failedGateCommand =
    qualityGateFailure?.command?.trim() || fallback?.command?.trim() || null;
  const failedGateReason = qualityGateFailure?.reason?.trim() || fallback?.reason?.trim() || null;
  const firstErrorLine =
    qualityGateFailure?.firstErrorLine?.trim() || fallback?.firstErrorLine?.trim() || null;
  const failedGateOutputSnippet = toQualityGateOutputSnippet(
    qualityGateFailure?.outputSnippet ??
      qualityGateFailure?.firstErrorLine ??
      fallback?.firstErrorLine ??
      fallback?.reason ??
      null
  );
  const worktreePath =
    qualityGateFailure?.worktreePath?.trim() || fallbackWorktreePath?.trim() || null;
  const qualityGateCategory = qualityGateFailure?.category ?? fallback?.category ?? null;
  const qualityGateValidationWorkspace =
    qualityGateFailure?.validationWorkspace ?? fallback?.validationWorkspace ?? null;
  const qualityGateRepairAttempted = qualityGateFailure?.autoRepairAttempted ?? false;
  const qualityGateRepairSucceeded = qualityGateFailure?.autoRepairSucceeded ?? false;
  const qualityGateExecutable = qualityGateFailure?.executable?.trim() || null;
  const qualityGateCwd = qualityGateFailure?.cwd?.trim() || null;
  const qualityGateExitCode = qualityGateFailure?.exitCode ?? null;
  const qualityGateSignal = qualityGateFailure?.signal?.trim() || null;
  const qualityGateClassificationConfidence = qualityGateFailure?.classificationConfidence ?? null;
  const qualityGateClassificationReason = qualityGateFailure?.classificationReason?.trim() || null;
  const gateNodeVersion = qualityGateFailure?.gateNodeVersion?.trim() || null;
  const gateNpmVersion = qualityGateFailure?.gateNpmVersion?.trim() || null;
  const gateDependencyStrategy = qualityGateFailure?.gateDependencyStrategy?.trim() || null;
  const gateHermeticNodeModules = qualityGateFailure?.gateHermeticNodeModules ?? null;
  const hasDetail =
    failedGateCommand != null ||
    failedGateReason != null ||
    failedGateOutputSnippet != null ||
    worktreePath != null ||
    firstErrorLine != null ||
    qualityGateCategory != null ||
    qualityGateValidationWorkspace != null ||
    qualityGateRepairAttempted ||
    qualityGateRepairSucceeded ||
    qualityGateExecutable != null ||
    qualityGateCwd != null ||
    qualityGateExitCode != null ||
    qualityGateSignal != null ||
    qualityGateClassificationConfidence != null ||
    qualityGateClassificationReason != null ||
    gateNodeVersion != null ||
    gateNpmVersion != null ||
    gateDependencyStrategy != null ||
    gateHermeticNodeModules != null;
  return {
    failedGateCommand,
    failedGateReason,
    failedGateOutputSnippet,
    worktreePath,
    qualityGateCategory,
    qualityGateValidationWorkspace,
    qualityGateRepairAttempted,
    qualityGateRepairSucceeded,
    qualityGateExecutable,
    qualityGateCwd,
    qualityGateExitCode,
    qualityGateSignal,
    qualityGateClassificationConfidence,
    qualityGateClassificationReason,
    qualityGateDetail: hasDetail
      ? {
          command: failedGateCommand,
          reason: failedGateReason,
          outputSnippet: failedGateOutputSnippet,
          worktreePath,
          firstErrorLine,
          category: qualityGateCategory,
          validationWorkspace: qualityGateValidationWorkspace,
          repairAttempted: qualityGateRepairAttempted,
          repairSucceeded: qualityGateRepairSucceeded,
          executable: qualityGateExecutable,
          cwd: qualityGateCwd,
          exitCode: qualityGateExitCode,
          signal: qualityGateSignal,
          classificationConfidence: qualityGateClassificationConfidence,
          classificationReason: qualityGateClassificationReason,
          gateNodeVersion,
          gateNpmVersion,
          gateDependencyStrategy,
          gateHermeticNodeModules,
        }
      : null,
  };
}

export function buildMergeQualityGateJobError(
  failure: QualityGateFailureForHelpers,
  fallbackWorktreePath: string
): MergeJobError {
  const reason = (failure.reason ?? "").trim().slice(0, 500) || "Unknown quality gate failure";
  const outputSnippet =
    toQualityGateOutputSnippet(failure.outputSnippet ?? failure.output) ?? "No output captured";
  const detail = outputSnippet.length > 0 ? ` | ${outputSnippet}` : "";
  const firstErrorLine = getQualityGateFirstErrorLine(failure).slice(0, 300);
  return new MergeJobError(
    `Quality gate failed (${failure.command}): ${reason}${detail}`,
    "quality_gate",
    [],
    "requeued",
    {
      preserveWork: failure.preserveWork,
      recoveryIncidentId: failure.recoveryIncidentId,
      command: failure.command,
      reason,
      outputSnippet,
      worktreePath: failure.worktreePath ?? fallbackWorktreePath,
      firstErrorLine,
      validationWorkspace: failure.validationWorkspace,
      category: failure.category ?? "quality_gate",
      autoRepairAttempted: failure.autoRepairAttempted ?? false,
      autoRepairSucceeded: failure.autoRepairSucceeded ?? false,
      autoRepairCommands: failure.autoRepairCommands,
      autoRepairOutput: failure.autoRepairOutput,
      executable: failure.executable,
      cwd: failure.cwd,
      exitCode: failure.exitCode ?? null,
      signal: failure.signal ?? null,
      classificationConfidence: failure.classificationConfidence,
      classificationReason: failure.classificationReason,
      gateNodeVersion: failure.gateNodeVersion,
      gateNpmVersion: failure.gateNpmVersion,
      gateDependencyStrategy: failure.gateDependencyStrategy,
      gateHermeticNodeModules: failure.gateHermeticNodeModules,
    }
  );
}

export function isEnvironmentSetupQualityGateMergeError(mergeErr: Error): boolean {
  return getQualityGateFailureDetailsFromMergeError(mergeErr)?.category === "environment_setup";
}

export function buildEnvironmentSetupRemediationMessage(params: {
  command?: string | null;
  worktreePath?: string | null;
  validationWorkspace?: string | null;
}): string {
  const command = params.command?.trim();
  const worktreePath = params.worktreePath?.trim();
  const validationWorkspace = params.validationWorkspace?.trim();
  const commandStep = command
    ? `then rerun ${command} before retrying merge.`
    : "then rerun the failing quality gate before retrying merge.";
  const isValidationWorkspace =
    validationWorkspace === "baseline" || validationWorkspace === "merged_candidate";
  const relinkStep = isValidationWorkspace
    ? ""
    : ", refresh worktree dependency workspace if required by this project";
  return compactExecutionText(
    `Run the project dependency install command${worktreePath ? ` in ${worktreePath}` : " in the repository root"}${relinkStep}, ${commandStep}`,
    500
  );
}

export function buildQualityGateSummaryDetailFromMergeError(mergeErr: Error): string | null {
  const qualityGateFailure = getQualityGateFailureDetailsFromMergeError(mergeErr);
  if (!qualityGateFailure) return null;

  const command = qualityGateFailure.command?.trim();
  const firstErrorLine = qualityGateFailure.firstErrorLine?.trim();

  const details: string[] = [];
  if (command) details.push(`cmd: ${command}`);
  if (firstErrorLine) details.push(`error: ${compactExecutionText(firstErrorLine, 220)}`);
  if (qualityGateFailure.autoRepairAttempted) {
    const commands =
      qualityGateFailure.autoRepairCommands && qualityGateFailure.autoRepairCommands.length > 0
        ? qualityGateFailure.autoRepairCommands.join(" -> ")
        : "auto-repair";
    const result = qualityGateFailure.autoRepairSucceeded
      ? "succeeded; retry still failed"
      : "failed";
    details.push(`repair: ${commands} (${result})`);
  }
  if (qualityGateFailure.category === "environment_setup") {
    details.push("category: environment_setup");
  }
  if (qualityGateFailure.validationWorkspace) {
    details.push(`workspace: ${qualityGateFailure.validationWorkspace}`);
  }
  if (qualityGateFailure.classificationConfidence) {
    details.push(`classification: ${qualityGateFailure.classificationConfidence}`);
  }
  if (details.length === 0) return null;
  return details.join(" | ");
}

export function buildBaselineFailureFingerprint(failure: QualityGateFailureForHelpers): string {
  const command = failure.command.trim().toLowerCase();
  const firstError = getQualityGateFirstErrorLine(failure).trim().toLowerCase();
  const workspace = (failure.validationWorkspace ?? "unknown").trim().toLowerCase();
  const category = (failure.category ?? "quality_gate").trim().toLowerCase();
  return `${command}|${firstError}|${workspace}|${category}`.slice(0, 700);
}

export function buildBaselineQualityGateNotificationDetail(
  failure: QualityGateFailureForHelpers
): string {
  const firstErrorLine = getQualityGateFirstErrorLine(failure);
  const classificationDetail =
    failure.classificationConfidence === "low"
      ? " | classification: low-confidence environment signal"
      : "";
  return compactExecutionText(
    `cmd: ${failure.command} | error: ${compactExecutionText(firstErrorLine, 220)}${classificationDetail}`,
    380
  );
}
