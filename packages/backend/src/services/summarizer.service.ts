/**
 * Summarizer agent service — PRD §12.3.5.
 * Condenses context when thresholds are exceeded (>2 dependencies or >2000-word Plan).
 * Used in context assembly pipeline before passing to Coder.
 */

import type { TaskContext } from "./context-assembler.js";
import {
  SUMMARIZER_DEPENDENCY_THRESHOLD,
  SUMMARIZER_PLAN_WORD_THRESHOLD,
} from "@opensprint/shared";

/** Summarizer result.json format per PRD 12.3.5 */
export interface SummarizerResult {
  status: "success" | "failed";
  summary?: string;
}

/** Count words in a string (whitespace-separated) */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Check if Summarizer should be invoked per PRD §7.3.2, §12.3.5.
 * Thresholds: >2 dependencies OR >2000-word Plan.
 */
export function shouldInvokeSummarizer(context: TaskContext): boolean {
  const dependencyCount = context.dependencyOutputs.length;
  const planWordCount = countWords(context.planContent);
  return (
    dependencyCount > SUMMARIZER_DEPENDENCY_THRESHOLD ||
    planWordCount > SUMMARIZER_PLAN_WORD_THRESHOLD
  );
}

/** Build the Summarizer prompt per PRD 12.3.5 */
export function buildSummarizerPrompt(
  taskId: string,
  context: TaskContext,
  dependencyCount: number,
  planWordCount: number,
): string {
  const depsSection =
    context.dependencyOutputs.length > 0
      ? `## Dependency Outputs\n\n${context.dependencyOutputs
          .map(
            (d) =>
              `### Task ${d.taskId}\n\n**Summary:** ${d.summary}\n\n**Diff:**\n\`\`\`\n${d.diff.slice(0, 4000)}${d.diff.length > 4000 ? "\n... (truncated)" : ""}\n\`\`\``,
          )
          .join("\n\n")}`
      : "";

  return `# Summarizer: Condense context for Coder

## Task
You are condensing context for task ${taskId} because thresholds are exceeded:
- Dependencies: ${dependencyCount} (threshold: >${SUMMARIZER_DEPENDENCY_THRESHOLD})
- Plan word count: ${planWordCount} (threshold: >${SUMMARIZER_PLAN_WORD_THRESHOLD})

Produce a focused summary that preserves:
- Architectural decisions and interface contracts
- Key implementation details from the Plan
- Relevant PRD requirements
- Critical information from dependency task outputs

## Plan

${context.planContent}

## PRD Excerpt

${context.prdExcerpt}
${depsSection}

## Output
Respond with ONLY valid JSON. No other text.

**On success:**
{"status":"success","summary":"<markdown summary preserving key context>"}

**On failure:**
{"status":"failed"}

The summary should be concise but complete enough for the Coder to implement the task without the full raw context.`;
}
