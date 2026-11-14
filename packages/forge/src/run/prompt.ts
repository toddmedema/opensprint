import { PLATFORM_PROMPT, type RunRecord, type WorkItemRecord } from "../domain.js";
import type { FrameRecord } from "../domain.js";

export function platformPrompt(): string {
  return PLATFORM_PROMPT;
}

export function buildPrompt(input: {
  role: RunRecord["role"];
  frame: FrameRecord | null;
  item: WorkItemRecord | null;
  guidance: string[];
  answers: string[];
  failureNote: string | null;
  instruction?: string;
}): string {
  const parts = [PLATFORM_PROMPT];
  if (input.role === "discovery") {
    parts.push(
      "Role: discovery. Read the repository. Return a runbookProposal on the result. Do not modify files. If you cannot propose a valid runbook, finish needs_human."
    );
  } else if (input.role === "planner") {
    parts.push(
      "Role: planner. Return workItems: title, body, and dependsOn titles. Do not modify files."
    );
    if (input.instruction) parts.push(`Instruction: ${input.instruction}`);
  } else {
    parts.push("Role: worker. Implement the work item in this worktree.");
    if (input.item) {
      parts.push(`Work item ${input.item.id}: ${input.item.title}`);
      parts.push(input.item.body);
    }
  }
  if (input.frame) {
    parts.push(`Frame version ${input.frame.version}:`);
    parts.push(input.frame.markdown);
  }
  if (input.guidance.length > 0) {
    parts.push("Submitted guidance:");
    for (const note of input.guidance) parts.push(`- ${note}`);
  }
  if (input.answers.length > 0) {
    parts.push("Answers from a person:");
    for (const answer of input.answers) parts.push(`- ${answer}`);
  }
  if (input.failureNote) {
    parts.push("Previous verification excerpt:");
    parts.push(input.failureNote);
  }
  return parts.join("\n\n");
}
