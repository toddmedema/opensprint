/**
 * Plan ship: Execute (ship), Re-execute (reship), ship with prerequisites.
 * Encapsulates version resolution, epic unblock, PRD sync, and auditor-based reship; used by PlanService.
 */
import type { Plan, PlanComplexity } from "@opensprint/shared";
import { clampTaskComplexity, getAgentForPlanningRole } from "@opensprint/shared";
import {
  getContentAndVersionForShip,
  setExecutedVersion,
  type PlanVersioningStore,
} from "./plan-versioning.service.js";
import type { PlanCrudService } from "./plan-crud.service.js";
import type { PlanDecomposeGenerateService } from "./plan-decompose-generate.service.js";
import { ProjectService } from "./project.service.js";
import type { StoredTask } from "./task-store.service.js";
import { agentService } from "./agent.service.js";
import { buildAuditorPrompt, parseAuditorResult } from "./auditor.service.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { sendPlanAgentOutputToProject } from "../websocket/index.js";
import { appendPlanAgentOutput, clearPlanAgentOutput } from "./plan-agent-output-buffer.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("plan-ship");

export interface PlanShipStore extends PlanVersioningStore {
  planVersionGetByVersionNumber(
    projectId: string,
    planId: string,
    versionNumber: number
  ): Promise<{ content: string }>;
  planVersionList(projectId: string, planId: string): Promise<Array<{ version_number: number }>>;
  planVersionInsert(data: {
    project_id: string;
    plan_id: string;
    version_number: number;
    title: string | null;
    content: string;
    metadata: string;
    is_executed_version?: boolean;
  }): Promise<unknown>;
  planVersionSetExecutedVersion(projectId: string, planId: string, versionNumber: number): Promise<void>;
  planUpdateVersionNumbers(
    projectId: string,
    planId: string,
    updates: { current_version_number?: number; last_executed_version_number?: number | null }
  ): Promise<void>;
  planSetShippedContent(projectId: string, planId: string, content: string): Promise<void>;
  planUpdateMetadata(projectId: string, planId: string, metadata: Record<string, unknown>): Promise<void>;
  planGetShippedContent(projectId: string, planId: string): Promise<string | null>;
  listAll(projectId: string): Promise<StoredTask[]>;
  update(
    projectId: string,
    taskId: string,
    updates: Record<string, unknown>
  ): Promise<void | StoredTask>;
  delete(projectId: string, taskId: string): Promise<void>;
  createWithRetry(
    projectId: string,
    title: string,
    opts: Record<string, unknown>,
    options?: { fallbackToStandalone?: boolean }
  ): Promise<{ id: string } | null>;
  addDependency(projectId: string, childId: string, parentId: string): Promise<void>;
}

export interface PlanShipDeps {
  crudService: PlanCrudService;
  decomposeService: PlanDecomposeGenerateService;
  taskStore: PlanShipStore;
  projectService: ProjectService;
  chatService: {
    syncPrdFromPlanShip: (
      projectId: string,
      planId: string,
      content: string,
      complexity?: PlanComplexity
    ) => Promise<void>;
  };
  /** When set, reshipPlan uses this for the "none started" branch so the facade can be mocked in tests. */
  shipPlanDelegate?: (
    projectId: string,
    planId: string,
    options?: { version_number?: number }
  ) => Promise<Plan>;
  assembleReExecuteContext: (
    repoPath: string,
    projectId: string,
    epicId: string,
    listAll: (projectId: string) => Promise<StoredTask[]>
  ) => Promise<{ fileTree: string; keyFilesContent: string; completedTasksJson: string }>;
}

export class PlanShipService {
  constructor(private deps: PlanShipDeps) {}

  private async getRepoPath(projectId: string): Promise<string> {
    const project = await this.deps.projectService.getProject(projectId);
    return project.repoPath;
  }

  async shipPlan(
    projectId: string,
    planId: string,
    options?: { version_number?: number }
  ): Promise<Plan> {
    let plan = await this.deps.crudService.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);
    const versionNumberParam = options?.version_number;

    let versionContent: string;
    let versionToExecute: number;

    if (versionNumberParam != null) {
      const versionRow = await this.deps.taskStore.planVersionGetByVersionNumber(
        projectId,
        planId,
        versionNumberParam
      );
      versionContent = versionRow.content;
      versionToExecute = versionNumberParam;
    } else {
      versionContent = plan.content;
      versionToExecute = 0;
    }

    if (plan.taskCount === 0 && plan.metadata.epicId) {
      plan = await this.deps.decomposeService.planTasks(projectId, planId);
      if (versionNumberParam == null) {
        versionContent = plan.content;
      }
    }

    const epicId = plan.metadata.epicId;
    if (!epicId) {
      throw new AppError(400, ErrorCodes.NO_EPIC, "Plan has no epic");
    }

    let tasksGenerated = 0;
    if (plan.taskCount === 0) {
      const planForGen = versionNumberParam != null ? { ...plan, content: versionContent } : plan;
      try {
        const genResult = await this.deps.decomposeService.generateAndCreateTasks(
          projectId,
          repoPath,
          planForGen
        );
        tasksGenerated = genResult.count;
        if (tasksGenerated > 0) {
          const updatedPlan = await this.deps.crudService.getPlan(projectId, planId);
          await this.deps.decomposeService.autoReviewPlanAgainstRepo(projectId, [updatedPlan]);
        }
      } catch (err) {
        log.error("Task generation failed, shipping without tasks", { err });
      }
    }

    if (versionNumberParam == null) {
      const result = await getContentAndVersionForShip(
        projectId,
        planId,
        plan,
        undefined,
        this.deps.taskStore
      );
      versionContent = result.versionContent;
      versionToExecute = result.versionToExecute;
    }

    await setExecutedVersion(projectId, planId, versionToExecute, this.deps.taskStore);

    await this.deps.taskStore.update(projectId, epicId, { status: "open" });

    await this.deps.taskStore.planSetShippedContent(projectId, planId, versionContent);

    plan.metadata.shippedAt = new Date().toISOString();
    await this.deps.taskStore.planUpdateMetadata(
      projectId,
      planId,
      plan.metadata as unknown as Record<string, unknown>
    );

    try {
      await this.deps.chatService.syncPrdFromPlanShip(
        projectId,
        planId,
        versionContent,
        plan.metadata.complexity
      );
    } catch (err) {
      log.error("PRD sync on build approval failed", { err });
    }

    if (tasksGenerated > 0) {
      const finalPlan = await this.deps.crudService.getPlan(projectId, planId);
      return { ...finalPlan, status: "building" };
    }

    return { ...plan, status: "building" };
  }

  async reshipPlan(
    projectId: string,
    planId: string,
    options?: { version_number?: number }
  ): Promise<Plan> {
    const plan = await this.deps.crudService.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);
    const epicId = plan.metadata.epicId;
    const { taskStore, crudService } = this.deps;

    if (epicId) {
      const allIssues = await taskStore.listAll(projectId);
      const children = allIssues.filter(
        (issue: StoredTask) =>
          issue.id.startsWith(epicId + ".") && (issue.issue_type ?? issue.type) !== "epic"
      );

      const hasInProgress = children.some((issue: StoredTask) => issue.status === "in_progress");
      if (hasInProgress) {
        throw new AppError(
          400,
          ErrorCodes.TASKS_IN_PROGRESS,
          "Cannot rebuild while tasks are In Progress or In Review"
        );
      }

      const allDone = children.every((issue: StoredTask) => issue.status === "closed");
      const noneStarted = children.every((issue: StoredTask) => issue.status === "open");

      if (noneStarted && children.length > 0) {
        if (plan.status !== "complete") {
          throw new AppError(
            400,
            ErrorCodes.INVALID_INPUT,
            "Re-execute is only available for plans that have been marked complete."
          );
        }
        const toDelete = allIssues.filter(
          (i: StoredTask) => i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        );
        for (const child of toDelete) {
          await taskStore.delete(projectId, child.id);
        }
        const shipOptions =
          options?.version_number != null
            ? options
            : plan.lastExecutedVersionNumber != null
              ? { version_number: plan.lastExecutedVersionNumber }
              : undefined;
        const ship = this.deps.shipPlanDelegate ?? this.shipPlan.bind(this);
        return ship(projectId, planId, shipOptions);
      }
      if (!allDone && children.length > 0) {
        throw new AppError(
          400,
          ErrorCodes.TASKS_NOT_COMPLETE,
          "All tasks must be Done before rebuilding (or none started)"
        );
      }
    }

    if (plan.status !== "complete") {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "Re-execute is only available for plans that have been marked complete."
      );
    }

    const { fileTree, keyFilesContent, completedTasksJson } = await this.deps.assembleReExecuteContext(
      repoPath,
      projectId,
      epicId ?? "",
      taskStore.listAll.bind(taskStore)
    );

    let planOld: string;
    const versionForOld = options?.version_number ?? plan.lastExecutedVersionNumber;
    if (versionForOld != null) {
      try {
        const versionRow = await taskStore.planVersionGetByVersionNumber(
          projectId,
          planId,
          versionForOld
        );
        planOld = versionRow.content;
      } catch {
        planOld =
          (await taskStore.planGetShippedContent(projectId, planId)) ??
          "# Plan (no previous shipped version)";
      }
    } else {
      planOld =
        (await taskStore.planGetShippedContent(projectId, planId)) ??
        "# Plan (no previous shipped version)";
    }
    const planNew = plan.content;

    const auditorPrompt = buildAuditorPrompt(planId, epicId ?? "");
    const auditorFullPrompt = `${auditorPrompt}

## context/file_tree.txt

${fileTree}

## context/key_files/

${keyFilesContent}

## context/completed_tasks.json

${completedTasksJson}

## context/plan_old.md

${planOld}

## context/plan_new.md

${planNew}`;

    const agentIdAuditor = `auditor-${projectId}-${planId}-${Date.now()}`;

    const settings = await this.deps.projectService.getSettings(projectId);
    let auditorResponse: { content: string };
    try {
      const auditorSystemPrompt =
        "You are the Auditor agent for Open Sprint (PRD §12.3.6). Audit the app's current capabilities and generate delta tasks for re-execution.\n\n" +
        (await getCombinedInstructions(repoPath, "auditor"));
      auditorResponse = await agentService.invokePlanningAgent({
        projectId,
        role: "auditor",
        config: getAgentForPlanningRole(settings, "auditor", plan.metadata.complexity),
        messages: [{ role: "user", content: auditorFullPrompt }],
        systemPrompt: auditorSystemPrompt,
        cwd: repoPath,
        tracking: {
          id: agentIdAuditor,
          projectId,
          phase: "plan",
          role: "auditor",
          label: "Re-execute: audit & delta tasks",
          planId,
        },
        onChunk: (chunk) => {
          appendPlanAgentOutput(projectId, planId, chunk);
          sendPlanAgentOutputToProject(projectId, planId, chunk);
        },
      });
    } finally {
      clearPlanAgentOutput(projectId, planId);
    }

    const auditorResult = parseAuditorResult(auditorResponse.content);
    if (!auditorResult || auditorResult.status === "failed") {
      log.error("Auditor failed or returned invalid result, falling back to full rebuild");
      return this.shipPlan(projectId, planId, options);
    }

    if (
      auditorResult.status === "no_changes_needed" ||
      !auditorResult.tasks ||
      auditorResult.tasks.length === 0
    ) {
      return crudService.getPlan(projectId, planId);
    }

    if (epicId) {
      await taskStore.update(projectId, epicId, { status: "blocked" });
    }

    const taskIdMap = new Map<number, string>();
    for (const task of auditorResult.tasks) {
      const priority = Math.min(4, Math.max(0, task.priority ?? 2));
      const taskComplexity = clampTaskComplexity(task.complexity);
      const taskResult = await taskStore.createWithRetry(
        projectId,
        task.title,
        {
          type: "task",
          description: task.description || "",
          priority,
          parentId: epicId,
          ...(taskComplexity != null && { complexity: taskComplexity }),
        },
        { fallbackToStandalone: true }
      );
      if (!taskResult) {
        log.warn("Failed to create delta task after retries, skipping", {
          title: task.title,
          planId,
        });
        continue;
      }
      taskIdMap.set(task.index, taskResult.id);
    }

    for (const task of auditorResult.tasks) {
      if (task.depends_on && task.depends_on.length > 0) {
        const childId = taskIdMap.get(task.index);
        if (childId) {
          for (const depIndex of task.depends_on) {
            const parentId = taskIdMap.get(depIndex);
            if (parentId) {
              await taskStore.addDependency(projectId, childId, parentId);
            }
          }
        }
      }
    }

    if (epicId) {
      await crudService.clearReviewedAtIfNewTasksAdded(projectId, epicId);
    }
    return crudService.getPlan(projectId, planId);
  }

  async shipPlanWithPrerequisites(
    projectId: string,
    planId: string,
    prerequisitePlanIds: string[],
    options?: { version_number?: number }
  ): Promise<Plan> {
    for (const prereqId of prerequisitePlanIds) {
      await this.shipPlan(projectId, prereqId);
    }
    return this.shipPlan(projectId, planId, options);
  }
}
