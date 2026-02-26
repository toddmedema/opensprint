/**
 * Auditor agent service — PRD §12.3.6.
 * Audits current app capabilities from codebase snapshot and completed task history,
 * then compares old and new Plan versions to generate only the delta tasks needed.
 */

import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { JSON_OUTPUT_PREAMBLE } from "../utils/agent-prompts.js";

/** Delta task format — same as Planner (PRD §12.3.2) */
export interface DeltaTask {
  index: number;
  title: string;
  description: string;
  priority?: number;
  depends_on?: number[];
  /** Task-level complexity (simple|complex). When absent, inferred from plan. */
  complexity?: "simple" | "complex";
}

/** Auditor result.json format per PRD 12.3.6 */
export interface AuditorResult {
  status: "success" | "no_changes_needed" | "failed";
  capability_summary?: string;
  tasks?: DeltaTask[];
}

/** Build the Auditor prompt per PRD 12.3.6 */
export function buildAuditorPrompt(planId: string, epicId: string): string {
  return `# Auditor: Audit capabilities and generate delta tasks for Re-execute

## Purpose
You are the Auditor agent for OpenSprint (PRD §12.3.6). Your task is two-fold:
1. Produce a structured summary of the application's current capabilities relevant to the Plan epic being re-built.
2. Compare the original Plan with the updated Plan using that capability summary to determine what delta work is needed.

## Context
- Plan ID: ${planId}
- Epic ID: ${epicId}

## Input Files
You have been provided:
- \`context/file_tree.txt\` — the project's file/directory structure (excluding node_modules, .git, etc.)
- \`context/key_files/\` — contents of key source files (e.g. .ts, .tsx, .js, .jsx, .py, etc.)
- \`context/completed_tasks.json\` — the list of completed (closed) tasks for this epic with their titles, descriptions, and close reasons
- \`context/plan_old.md\` — the Plan as it was when last executed (produced the current implementation)
- \`context/plan_new.md\` — the updated Plan (current file, user may have edited)

## Task

### Step 1: Capability Audit
Analyze the codebase and completed task history. When key_files/ is large, focus on files most relevant to the Plan epic (e.g., routes, components mentioned in the plan). Build a mental model of:
1. **Implemented features** — what functionality exists in the codebase
2. **Data models** — schemas, types, entities
3. **API surface** — endpoints, routes, handlers
4. **UI components** — pages, screens, key components
5. **Integration points** — external services, config, environment

capability_summary should enable a human to understand what exists without reading the codebase. Use ## headers for: Implemented Features, Data Models, API Surface, UI Components.

### Step 2: Delta Analysis
1. Compare plan_old and plan_new to identify what changed
2. Cross-reference with your capability audit and completed_tasks.json to determine what already exists
3. Do NOT produce tasks that duplicate already-implemented work
4. Produce an indexed task list for ONLY the delta work — tasks needed to go from current state to the new Plan requirements
5. If the new Plan adds requirements, create tasks for them
6. If the new Plan removes or simplifies requirements, do NOT create tasks to remove code — just omit them. Delta = additions and modifications only.
7. If nothing has changed or the new Plan is fully satisfied by current capabilities, return no_changes_needed

For depends_on: use 0-based indices into YOUR tasks array. Ensure no circular dependencies.

## Output
${JSON_OUTPUT_PREAMBLE}

**If delta tasks are needed:**
{"status":"success","capability_summary":"<markdown>","tasks":[{"index":0,"title":"Task title","description":"Detailed spec","priority":1,"depends_on":[],"complexity":"simple"}]}

- capability_summary: markdown summary of current capabilities (use ## headers for sections)
- tasks: array of delta tasks
  - index: 0-based ordinal for dependency resolution
  - title: Clear, specific action
  - description: Detailed spec with acceptance criteria
  - priority: 0 (highest) to 4 (lowest)
  - depends_on: array of indices (0-based) this task depends on — use [] if none
  - complexity: simple or complex — assign per task based on implementation difficulty (simple: routine; complex: challenging)

**If no work is needed (plan unchanged or fully satisfied):**
{"status":"no_changes_needed","capability_summary":"<markdown>"}

Tasks must be atomic and implementable in one agent session. Resolve depends_on by index (e.g. depends_on: [0, 2] means this task blocks on tasks at index 0 and 2).`;
}

/** Normalize task deps: accept both camelCase (dependsOn) and snake_case (depends_on) from Planner/Auditor. */
function normalizeTaskDeps(t: Record<string, unknown>): number[] {
  const arr = (t.depends_on ?? t.dependsOn ?? []) as unknown;
  return Array.isArray(arr) ? arr.filter((d): d is number => typeof d === "number") : [];
}

/** Parse Auditor result from agent response. Accepts both camelCase and snake_case from Planner. */
export function parseAuditorResult(content: string): AuditorResult | null {
  const parsed = extractJsonFromAgentResponse<AuditorResult & { task_list?: unknown[] }>(
    content,
    "status"
  );
  if (!parsed) return null;
  const status = parsed.status?.toLowerCase();

  if (status === "no_changes_needed") {
    return {
      status: "no_changes_needed",
      capability_summary:
        typeof parsed.capability_summary === "string"
          ? parsed.capability_summary.trim()
          : undefined,
    };
  }

  if (status === "failed") {
    return { status: "failed" };
  }

  const rawTasks = (parsed.tasks ?? parsed.task_list ?? []) as Array<Record<string, unknown>>;
  if (status === "success" && typeof parsed.capability_summary === "string") {
    const result: AuditorResult = {
      status: "success",
      capability_summary: parsed.capability_summary.trim(),
    };

    if (Array.isArray(rawTasks) && rawTasks.length > 0) {
      result.tasks = rawTasks.map((t) => {
        const rawComplexity = typeof t.complexity === "string" ? t.complexity : undefined;
        const complexity =
          rawComplexity === "simple" || rawComplexity === "complex"
            ? rawComplexity
            : rawComplexity === "low"
              ? "simple"
              : rawComplexity === "high"
                ? "complex"
                : undefined;
        const task: DeltaTask = {
          index: typeof t.index === "number" ? t.index : 0,
          title: String(t.title ?? t.task_title ?? "").trim(),
          description: String(t.description ?? t.task_description ?? "").trim(),
          priority:
            typeof (t.priority ?? t.task_priority) === "number"
              ? Math.min(4, Math.max(0, (t.priority ?? t.task_priority) as number))
              : 2,
          depends_on: normalizeTaskDeps(t),
        };
        if (complexity) task.complexity = complexity;
        return task;
      });
    }

    return result;
  }

  if (status === "success" && (!rawTasks || rawTasks.length === 0)) {
    return { status: "no_changes_needed" };
  }

  return null;
}
