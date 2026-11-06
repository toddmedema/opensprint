/**
 * Plan task generation: break down a plan into implementation tasks via agent and persist to task store.
 * Internal module used by PlanDecomposeGenerateService.
 */
import type { Plan, ProjectSettings } from "@opensprint/shared";
import { getAgentForPlanningRole } from "@opensprint/shared";
import {
  normalizePlannerTask,
  findPlannerTaskArray,
  MAX_TASKS_PER_PLAN,
  type NormalizedPlannerTask,
} from "./planner-normalize.js";
import {
  TASK_GENERATION_SYSTEM_PROMPT,
  TASK_GENERATION_RETRY_PROMPT,
  buildTaskCountRepairPrompt,
} from "./plan-prompts.js";
import { runPlannerWithRepoGuard } from "./plan-repo-guard.js";
import { buildAutonomyDescription } from "../autonomy-description.js";
import { getCombinedInstructions } from "../agent-instructions.service.js";
import { broadcastToProject } from "../../websocket/index.js";
import { extractJsonFromAgentResponse } from "../../utils/json-extract.js";
import { createLogger } from "../../utils/logger.js";
import { invokeStructuredPlanningAgent } from "../structured-agent-output.service.js";

import { buildPlanningTaskPolicy, type PlanningTaskSettings } from "./plan-task-policy.js";

const log = createLogger("plan-task-generation");

/** One ancestor plan from root toward the parent of the node receiving task generation. */
export interface PlanTaskHierarchyAncestorEntry {
  title: string;
  overview: string;
}

/** A sibling sub-plan that already has generated implementation tasks (recursive flow). */
export interface PlanTaskHierarchySiblingEntry {
  title: string;
  /** Output of `buildPlanTaskSummaryFromCreated` for that sibling’s plan + tasks. */
  taskSummary: string;
}

/** Structured hierarchy context for recursive task generation prompts. */
export interface PlanTaskHierarchyContext {
  ancestors: PlanTaskHierarchyAncestorEntry[];
  siblings: PlanTaskHierarchySiblingEntry[];
}

const HIERARCHY_TITLE_MAX = 120;
const HIERARCHY_OVERVIEW_MAX = 320;
const HIERARCHY_SCOPE_MAX = 900;

function truncateForPlanningSnippet(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Renders hierarchy context for the task-generation user message (prepended before the feature plan).
 */
export function formatPlanTaskHierarchyContextForPrompt(ctx: PlanTaskHierarchyContext): string {
  const parts: string[] = [];

  if (ctx.ancestors.length > 0) {
    parts.push("## Hierarchy: Ancestor chain (root → parent)\n");
    for (const a of ctx.ancestors) {
      const title = truncateForPlanningSnippet(a.title, HIERARCHY_TITLE_MAX);
      const overview = truncateForPlanningSnippet(a.overview, HIERARCHY_OVERVIEW_MAX);
      parts.push(`### ${title}\n**Overview:** ${overview}\n`);
    }
  }

  if (ctx.siblings.length > 0) {
    parts.push("\n## Hierarchy: Sibling sub-plans (tasks already generated)\n");
    for (const s of ctx.siblings) {
      const taskLines = s.taskSummary.split("\n").filter((line) => /^\s*-\s*\*\*/.test(line));
      const count = taskLines.length;
      const title = truncateForPlanningSnippet(s.title, HIERARCHY_TITLE_MAX);
      const scope = truncateForPlanningSnippet(
        s.taskSummary.replace(/\s+/g, " ").trim(),
        HIERARCHY_SCOPE_MAX
      );
      parts.push(
        `### ${title} — **${count}** implementation task${count === 1 ? "" : "s"}\n` +
          `**Scope (generated tasks):** ${scope || "(no task lines)"}\n`
      );
    }
    parts.push(
      "\n**Cross-epic dependencies:** If this plan’s Dependencies section orders it after a sibling sub-plan, you may add that sibling’s implementation tasks to `dependsOn` using the **exact task title** strings shown above (same spelling as in **Scope**). The system resolves those titles to task IDs across epics. Still use exact titles from your own task list for dependencies within this plan.\n"
    );
  }

  return parts.join("\n").trim();
}

export interface PlanTaskGenerationDeps {
  projectId: string;
  repoPath: string;
  plan: Plan;
  prdContext: string;
  /**
   * Rich hierarchy for recursive sub-plan task generation. When set, string-based
   * `ancestorChainSummary` / `siblingPlanSummaries` are omitted to avoid duplication.
   */
  hierarchyContext?: PlanTaskHierarchyContext;
  /** Oldest → newest plan titles on the path to this node (recursive planning). */
  ancestorChainSummary?: string;
  /** One line per sibling plan under the same parent (excludes this plan). */
  siblingPlanSummaries?: string;
  /** Appended to the user message (e.g. max-depth consolidation). */
  extraUserPromptSuffix?: string;
  /**
   * Task titles from sibling sub-plan epics (already created) → task ids, for cross-epic
   * `dependsOn` in the same planner batch. First title wins when duplicates exist.
   */
  crossEpicDependsTitleToId?: Readonly<Record<string, string>>;
  /** Validated task list from the decomposition call; avoids a second model invocation. */
  preGeneratedTasks?: NormalizedPlannerTask[];
  settings: { aiAutonomyLevel?: string; hilConfig?: unknown } & PlanningTaskSettings;
  taskStore: {
    createMany(
      projectId: string,
      inputs: Array<Record<string, unknown>>
    ): Promise<Array<{ id: string }>>;
    addDependencies(
      projectId: string,
      deps: Array<{ childId: string; parentId: string; type?: string }>
    ): Promise<void>;
    addLabel(projectId: string, taskId: string, label: string): Promise<void>;
  };
}

/**
 * Extract raw task objects from agent content without enforcing the count cap.
 * Used by both the validated parser and the onExhausted truncation fallback.
 */
export function extractRawTasks(
  content: unknown
):
  | { ok: true; rawTasks: Array<Record<string, unknown>> }
  | { ok: false; parseFailureReason: string } {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: false, parseFailureReason: "Planner returned no text content." };
  }

  const parsed =
    extractJsonFromAgentResponse<unknown>(content, "tasks") ??
    extractJsonFromAgentResponse<unknown>(content, "task_list") ??
    extractJsonFromAgentResponse<unknown>(content, "taskList") ??
    extractJsonFromAgentResponse<unknown>(content);
  if (!parsed) {
    return { ok: false, parseFailureReason: "Planner response was not valid JSON." };
  }

  const extractedTaskArray = findPlannerTaskArray(parsed);
  if (!extractedTaskArray) {
    return {
      ok: false,
      parseFailureReason: "Planner JSON did not include a tasks/task_list/taskList array.",
    };
  }

  const rawTasks = extractedTaskArray.value.filter(
    (t): t is Record<string, unknown> => t != null && typeof t === "object"
  );
  if (rawTasks.length === 0) {
    return {
      ok: false,
      parseFailureReason:
        `Planner ${extractedTaskArray.key} at ${extractedTaskArray.path} was empty ` +
        "or contained no task objects.",
    };
  }

  return { ok: true, rawTasks };
}

export function parseTaskGenerationContent(
  content: unknown
):
  | { ok: true; rawTasks: Array<Record<string, unknown>> }
  | { ok: false; parseFailureReason: string } {
  const result = extractRawTasks(content);
  if (!result.ok) return result;

  if (result.rawTasks.length > MAX_TASKS_PER_PLAN) {
    return {
      ok: false,
      parseFailureReason: `task-count-exceeded: Planner returned ${result.rawTasks.length} tasks, max is ${MAX_TASKS_PER_PLAN}.`,
    };
  }

  return result;
}

/**
 * Generate implementation tasks for a plan via agent and persist to task store.
 */
export async function generateAndCreateTasks(deps: PlanTaskGenerationDeps): Promise<{
  count: number;
  taskRefs: Array<{ id: string; title: string }>;
  parseFailureReason?: string;
}> {
  const {
    projectId,
    repoPath,
    plan,
    prdContext,
    hierarchyContext,
    ancestorChainSummary,
    siblingPlanSummaries,
    extraUserPromptSuffix,
    settings,
  } = deps;
  const epicId = plan.metadata.epicId;

  if (!epicId) {
    return {
      count: 0,
      taskRefs: [],
      parseFailureReason: "Plan has no epic to attach generated tasks.",
    };
  }

  if (deps.preGeneratedTasks !== undefined) {
    if (deps.preGeneratedTasks.length === 0 || deps.preGeneratedTasks.length > MAX_TASKS_PER_PLAN) {
      return {
        count: 0,
        taskRefs: [],
        parseFailureReason: "Expected 1–15 tasks; no tasks were discarded.",
      };
    }
    return persistGeneratedTasks(deps, deps.preGeneratedTasks);
  }

  const hierarchyBlock =
    hierarchyContext != null
      ? formatPlanTaskHierarchyContextForPrompt(hierarchyContext).trim()
      : "";

  const promptSections: string[] = ["## Feature Plan", plan.content, "## PRD Context", prdContext];
  if (hierarchyContext == null) {
    const ancestor = ancestorChainSummary?.trim();
    if (ancestor) {
      promptSections.push("## Ancestor chain (root → parent)", ancestor);
    }
    const siblings = siblingPlanSummaries?.trim();
    if (siblings) {
      promptSections.push("## Sibling plans (same parent)", siblings);
    }
  }

  const body = promptSections.join("\n\n");
  const suffix = extraUserPromptSuffix?.trim();
  const prompt =
    (hierarchyBlock ? `${hierarchyBlock}\n\n` : "") +
    "Break down the following feature plan into implementation tasks.\n\n" +
    body +
    (suffix ? `\n\n${suffix}` : "");

  const agentId = `plan-task-gen-${projectId}-${Date.now()}`;

  const taskGenPrompt = (() => {
    const autonomyDesc = buildAutonomyDescription(
      settings.aiAutonomyLevel as "full" | "confirm_all" | "major_only" | undefined,
      settings.hilConfig as
        | { scopeChanges: string; architectureDecisions: string; dependencyModifications: string }
        | undefined
    );
    return autonomyDesc
      ? `${TASK_GENERATION_SYSTEM_PROMPT}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : TASK_GENERATION_SYSTEM_PROMPT;
  })();
  const taskGenSystemPrompt = `${taskGenPrompt}\n\n${buildPlanningTaskPolicy(settings)}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
  const plannerConfig = getAgentForPlanningRole(
    settings as ProjectSettings,
    "planner",
    plan.metadata.complexity
  );

  const initialMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: prompt },
  ];
  const response = await runPlannerWithRepoGuard({
    repoPath,
    label: "Task generation",
    run: () =>
      invokeStructuredPlanningAgent({
        projectId,
        role: "planner",
        config: plannerConfig,
        messages: initialMessages,
        systemPrompt: taskGenSystemPrompt,
        cwd: repoPath,
        tracking: {
          id: agentId,
          projectId,
          phase: "plan",
          role: "planner",
          label: "Task generation",
          planId: plan.metadata.planId,
        },
        contract: {
          parse: (content) => {
            const parsed = parseTaskGenerationContent(content);
            return parsed.ok ? parsed.rawTasks : null;
          },
          repairPrompt: (invalidReason) => {
            if (invalidReason?.startsWith("task-count-exceeded:")) {
              const countMatch = invalidReason.match(/returned (\d+) tasks/);
              const count = countMatch ? Number(countMatch[1]) : 0;
              return buildTaskCountRepairPrompt(count);
            }
            return TASK_GENERATION_RETRY_PROMPT;
          },
          invalidReason: (content) => {
            const parsed = parseTaskGenerationContent(content);
            return parsed.ok ? undefined : parsed.parseFailureReason;
          },
        },
      }),
  });

  if (!response.parsed) {
    const finalParseFailureReason = response.invalidReason;
    log.warn("Task generation agent did not return valid task JSON after retry", {
      planId: plan.metadata.planId,
      reason: finalParseFailureReason,
    });
    return {
      count: 0,
      taskRefs: [],
      parseFailureReason: finalParseFailureReason,
    };
  }

  const rawTasks = response.parsed;
  const tasks = rawTasks.map((t) => normalizePlannerTask(t, rawTasks));
  return persistGeneratedTasks(deps, tasks);
}

/** Both generation paths share versioning, dependency resolution, and file scope persistence. */
async function persistGeneratedTasks(deps: PlanTaskGenerationDeps, tasks: NormalizedPlannerTask[]) {
  const { projectId, plan, taskStore, crossEpicDependsTitleToId } = deps;
  const epicId = plan.metadata.epicId!;
  const sourceVersion = plan.currentVersionNumber ?? 1;
  const inputs = tasks.map((task) => ({
    title: task.title,
    type: "task" as const,
    description: task.description || "",
    priority: Math.min(4, Math.max(0, task.priority ?? 2)),
    parentId: epicId,
    ...(task.complexity != null && { complexity: task.complexity }),
    extra: { sourcePlanVersionNumber: sourceVersion },
  }));
  const created = await taskStore.createMany(projectId, inputs);
  const taskIdMap = new Map<string, string>();
  created.forEach((t, i) => taskIdMap.set(tasks[i]!.title, t.id));

  const resolveDepTaskId = (depTitle: string): string | undefined => {
    const local = taskIdMap.get(depTitle);
    if (local) return local;
    const external = crossEpicDependsTitleToId?.[depTitle];
    return typeof external === "string" && external.trim() ? external.trim() : undefined;
  };

  const interDeps: Array<{ childId: string; parentId: string; type?: string }> = [];
  for (const task of tasks) {
    const childId = taskIdMap.get(task.title);
    if (!childId || !task.dependsOn.length) continue;
    for (const depTitle of task.dependsOn) {
      const parentId = resolveDepTaskId(depTitle);
      if (parentId) interDeps.push({ childId, parentId, type: "blocks" });
    }
  }
  if (interDeps.length > 0) {
    await taskStore.addDependencies(projectId, interDeps);
  }

  for (let i = 0; i < tasks.length; i++) {
    const files = tasks[i]!.files;
    if (files && (files.modify?.length || files.create?.length || files.test?.length)) {
      const filesJson = JSON.stringify(files);
      await taskStore.addLabel(projectId, created[i]!.id, `files:${filesJson}`);
    }
  }

  broadcastToProject(projectId, { type: "plan.updated", planId: plan.metadata.planId });

  log.info("Generated tasks for plan", {
    count: tasks.length,
    planId: plan.metadata.planId,
  });

  const taskRefs = tasks
    .filter((t) => taskIdMap.has(t.title))
    .map((t) => ({ id: taskIdMap.get(t.title)!, title: t.title }));
  return { count: tasks.length, taskRefs };
}
