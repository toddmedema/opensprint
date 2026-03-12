/**
 * Plan task generation: break down a plan into implementation tasks via agent and persist to task store.
 * Internal module used by PlanDecomposeGenerateService.
 */
import type { Plan, ProjectSettings } from "@opensprint/shared";
import { getAgentForPlanningRole } from "@opensprint/shared";
import {
  normalizePlannerTask,
  findPlannerTaskArray,
} from "./planner-normalize.js";
import {
  TASK_GENERATION_SYSTEM_PROMPT,
  TASK_GENERATION_RETRY_PROMPT,
} from "./plan-prompts.js";
import { agentService } from "../agent.service.js";
import { buildAutonomyDescription } from "../autonomy-description.js";
import { getCombinedInstructions } from "../agent-instructions.service.js";
import { broadcastToProject } from "../../websocket/index.js";
import { extractJsonFromAgentResponse } from "../../utils/json-extract.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("plan-task-generation");

export interface PlanTaskGenerationDeps {
  projectId: string;
  repoPath: string;
  plan: Plan;
  prdContext: string;
  settings: { aiAutonomyLevel?: string; hilConfig?: unknown };
  taskStore: {
    createMany(projectId: string, inputs: Array<Record<string, unknown>>): Promise<Array<{ id: string }>>;
    addDependencies(projectId: string, deps: Array<{ childId: string; parentId: string; type?: string }>): Promise<void>;
    addLabel(projectId: string, taskId: string, label: string): Promise<void>;
  };
}

function parseTaskGenerationContent(
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

/**
 * Generate implementation tasks for a plan via agent and persist to task store.
 */
export async function generateAndCreateTasks(deps: PlanTaskGenerationDeps): Promise<{
  count: number;
  taskRefs: Array<{ id: string; title: string }>;
  parseFailureReason?: string;
}> {
  const { projectId, repoPath, plan, prdContext, settings, taskStore } = deps;
  const epicId = plan.metadata.epicId;

  if (!epicId) {
    return {
      count: 0,
      taskRefs: [],
      parseFailureReason: "Plan has no epic to attach generated tasks.",
    };
  }

  const prompt = `Break down the following feature plan into implementation tasks.\n\n## Feature Plan\n\n${plan.content}\n\n## PRD Context\n\n${prdContext}`;

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
  const taskGenSystemPrompt = `${taskGenPrompt}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
  const plannerConfig = getAgentForPlanningRole(
    settings as ProjectSettings,
    "planner",
    plan.metadata.complexity
  );

  const initialMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: prompt },
  ];
  const response = await agentService.invokePlanningAgent({
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
  });

  let parsedOutput = parseTaskGenerationContent(response?.content);
  const firstParseFailureReason = !parsedOutput.ok ? parsedOutput.parseFailureReason : undefined;
  if (!parsedOutput.ok) {
    log.warn("Task generation parse failed on first attempt; retrying once", {
      planId: plan.metadata.planId,
      reason: parsedOutput.parseFailureReason,
    });

    const retryMessages: Array<{ role: "user" | "assistant"; content: string }> = [
      ...initialMessages,
    ];
    if (typeof response?.content === "string" && response.content.trim().length > 0) {
      retryMessages.push({ role: "assistant", content: response.content });
    }
    retryMessages.push({
      role: "user",
      content:
        `${TASK_GENERATION_RETRY_PROMPT}\n\n` +
        `Previous parse failure: ${parsedOutput.parseFailureReason}`,
    });

    const retryResponse = await agentService.invokePlanningAgent({
      projectId,
      role: "planner",
      config: plannerConfig,
      messages: retryMessages,
      systemPrompt: taskGenSystemPrompt,
      cwd: repoPath,
      tracking: {
        id: `${agentId}-retry`,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Task generation",
        planId: plan.metadata.planId,
      },
    });
    parsedOutput = parseTaskGenerationContent(retryResponse?.content);
  }

  if (!parsedOutput.ok) {
    const finalParseFailureReason =
      parsedOutput.parseFailureReason === "Planner returned no text content." &&
      firstParseFailureReason
        ? firstParseFailureReason
        : parsedOutput.parseFailureReason;
    log.warn("Task generation agent did not return valid task JSON after retry", {
      planId: plan.metadata.planId,
      reason: finalParseFailureReason,
      retryReason: parsedOutput.parseFailureReason,
    });
    return {
      count: 0,
      taskRefs: [],
      parseFailureReason: finalParseFailureReason,
    };
  }

  const rawTasks = parsedOutput.rawTasks;
  const tasks = rawTasks.map((t) => normalizePlannerTask(t, rawTasks));

  const inputs = tasks.map((task) => ({
    title: task.title,
    type: "task" as const,
    description: task.description || "",
    priority: Math.min(4, Math.max(0, task.priority ?? 2)),
    parentId: epicId,
    ...(task.complexity != null && { complexity: task.complexity }),
  }));
  const created = await taskStore.createMany(projectId, inputs);
  const taskIdMap = new Map<string, string>();
  created.forEach((t, i) => taskIdMap.set(tasks[i]!.title, t.id));

  const interDeps: Array<{ childId: string; parentId: string; type?: string }> = [];
  for (const task of tasks) {
    const childId = taskIdMap.get(task.title);
    if (!childId || !task.dependsOn.length) continue;
    for (const depTitle of task.dependsOn) {
      const parentId = taskIdMap.get(depTitle);
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
