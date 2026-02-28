/**
 * Deploy fix epic service — PRD §7.5.2.
 * When pre-deploy tests fail, invokes the planning-slot agent (Planner role)
 * with test output to create a structured fix epic + task list.
 * Epic is created with status "open" (auto-approved, no gate) so fix tasks
 * appear in taskStore.ready() immediately.
 */

import { taskStore } from "./task-store.service.js";
import { AgentClient } from "./agent-client.js";
import { ProjectService } from "./project.service.js";
import { getAgentForPlanningRole } from "@opensprint/shared";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deploy-fix-epic");
const projectService = new ProjectService();
// taskStore imported as singleton from task-store.service.js
const agentClient = new AgentClient();

const FIX_EPIC_SYSTEM_PROMPT = `You are the Planner agent for OpenSprint (PRD §12.3.2). Your task is to analyze failed test output and produce a structured list of fix tasks.

Focus on failure messages and stack traces; skip verbose setup logs when possible.

Given the raw test output from a pre-deployment test run, create an indexed task list to fix all errors and failures. Each task should:
1. Address a specific failing test or error — cite the specific failing test name or error message in the description
2. Be atomic (implementable in one coding session)
3. Have clear acceptance criteria (the test must pass after the fix)
4. Order tasks so root-cause fixes (e.g., missing env var, schema migration) come first; dependent fixes (e.g., API that uses the schema) come after
5. Include dependencies where one fix blocks another (e.g., fix data model before API)

If the test output shows multiple independent failures (different files/modules), create separate tasks. If failures share a root cause, one task may fix several.

Respond with ONLY valid JSON in this exact format (you may wrap in a markdown json code block):
{
  "status": "success",
  "tasks": [
    {
      "index": 0,
      "title": "Fix task title",
      "description": "Detailed spec: what to fix, which files, acceptance criteria",
      "priority": 1,
      "depends_on": [],
      "complexity": "simple"
    },
    {
      "index": 1,
      "title": "Another fix task",
      "description": "...",
      "priority": 1,
      "depends_on": [0],
      "complexity": "simple"
    }
  ]
}

priority: 0 (highest) to 4 (lowest). depends_on: array of task indices (0-based) this task is blocked by. complexity: simple or complex — assign per task based on fix difficulty (simple: routine; complex: challenging).
If you cannot parse meaningful fix tasks from the output, return: {"status": "failed", "tasks": []}`;

export interface CreateFixEpicResult {
  epicId: string;
  taskCount: number;
}

/**
 * Invoke planning agent with test output, create fix epic and sub-tasks via task store.
 * Fix epics are auto-approved (epic status open) so tasks appear in taskStore.ready().
 * Returns epic ID and metadata, or null on failure.
 */
export async function createFixEpicFromTestOutput(
  projectId: string,
  repoPath: string,
  testOutput: string
): Promise<CreateFixEpicResult | null> {
  const settings = await projectService.getSettings(projectId);

  const prompt = `# Pre-deployment test failures — create fix tasks

The following test output was produced when running the test suite before deployment. All tests must pass before deployment can proceed.

Analyze the failures and create a structured list of fix tasks. Each task should address a specific failing test or error. Order tasks so that foundational fixes (e.g., schema, types) come before dependent fixes (e.g., API, components).

## Test output

\`\`\`
${testOutput.slice(0, 30000)}
\`\`\`

Output your response as JSON with status and tasks array.`;

  let response;
  try {
    response = await agentClient.invoke({
      config: getAgentForPlanningRole(settings, "planner"),
      prompt,
      systemPrompt: FIX_EPIC_SYSTEM_PROMPT,
      cwd: repoPath,
      projectId,
    });
  } catch (err) {
    log.error("Planning agent invocation failed", { err });
    return null;
  }

  const parsed = extractJsonFromAgentResponse<{
    status?: string;
    tasks?: Array<{
      index?: number;
      title: string;
      description?: string;
      priority?: number;
      depends_on?: number[];
      complexity?: "simple" | "complex";
    }>;
  }>(response.content, "tasks");
  if (!parsed) {
    log.warn("Agent did not return valid JSON with tasks");
    return null;
  }

  if (parsed.status !== "success" || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    log.warn("Agent returned no tasks or failed status");
    return null;
  }

  const tasks = parsed.tasks;

  // Create epic with status open (fix epics are auto-approved)
  const epicTitle = "Fix: pre-deploy test failures";
  const epicResult = await taskStore.create(projectId, epicTitle, {
    type: "epic",
    complexity: 3, // medium
  });
  if (!epicResult) {
    log.error("Failed to create fix epic");
    return null;
  }
  const epicId = epicResult.id;
  await taskStore.update(projectId, epicId, { status: "open" });

  const planId = `fix-deploy-${Date.now()}`;
  const planContent = `# Fix: Pre-deploy Test Failures

## Overview

Pre-deployment tests failed. Fix each failing test or error as specified in the task descriptions.

## Test Output (reference)

\`\`\`
${testOutput.slice(0, 15000)}
\`\`\`

## Acceptance Criteria

- All tests pass (run \`npm test\` or project test command)
- No regressions in previously passing tests
`;
  await taskStore.planInsert(projectId, planId, {
    epic_id: epicId,
    content: planContent,
    metadata: JSON.stringify({
      planId,
      epicId,
      shippedAt: null,
      complexity: "medium",
    }),
  });
  await taskStore.update(projectId, epicId, { description: planId });

  // Create child tasks (no gate — epic is open so tasks appear in ready)
  const taskIdMap = new Map<number, string>();

  const { clampTaskComplexity } = await import("@opensprint/shared");
  for (const task of tasks) {
    const idx = task.index ?? tasks.indexOf(task);
    const priority = Math.min(4, Math.max(0, task.priority ?? 2));
    const raw = task.complexity;
    const taskComplexity =
      clampTaskComplexity(raw) ??
      (raw === "simple" || raw === "low" ? 3 : raw === "complex" || raw === "high" ? 7 : 3);
    const taskResult = await taskStore.createWithRetry(projectId, task.title, {
      type: "task",
      description: task.description ?? "",
      priority,
      parentId: epicId,
      complexity: taskComplexity,
    });
    if (!taskResult) {
      log.error("Failed to create fix task after retries", { title: task.title });
      return null;
    }
    taskIdMap.set(idx, taskResult.id);
  }

  // Add inter-task dependencies (depends_on/dependsOn uses indices; accept both camelCase and snake_case)
  for (const task of tasks) {
    const idx = task.index ?? tasks.indexOf(task);
    const childId = taskIdMap.get(idx);
    const deps =
      (task as { depends_on?: number[]; dependsOn?: number[] }).depends_on ??
      (task as { depends_on?: number[]; dependsOn?: number[] }).dependsOn ??
      [];
    if (childId) {
      for (const parentIdx of deps) {
        const parentId = taskIdMap.get(parentIdx);
        if (parentId) {
          await taskStore.addDependency(projectId, childId, parentId);
        }
      }
    }
  }

  return {
    epicId,
    taskCount: tasks.length,
  };
}
