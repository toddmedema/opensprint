/**
 * Plan CRUD: create, read, update, delete, archive, mark complete, list.
 * Encapsulates plan entity lifecycle and dependency graph listing; used by PlanService and PlanShipService.
 */
import type {
  Plan,
  PlanMetadata,
  PlanMockup,
  PlanDependencyGraph,
  PlanDependencyEdge,
  PlanComplexity,
  CrossEpicDependenciesResponse,
} from "@opensprint/shared";
import { validatePlanContent } from "@opensprint/shared";
import { VALID_COMPLEXITIES } from "./plan/plan-prompts.js";
import {
  normalizePlannerTask,
  normalizeDependsOnPlans,
  ensureDependenciesSection,
} from "./plan/planner-normalize.js";
import {
  buildDependencyEdgesCore,
  listPlansWithEdges as listPlansWithEdgesFromModule,
  type PlanInfo,
} from "./plan/plan-dependency-graph.js";
import {
  ensurePlanHasAtLeastOneVersion as ensurePlanHasAtLeastOneVersionFn,
  createVersionOnUpdate,
  updateCurrentVersionInPlace,
  type PlanVersioningStore,
} from "./plan-versioning.service.js";
import { syncPlanTasksFromContent } from "./plan-task-sync.service.js";
import { ProjectService } from "./project.service.js";
import { planComplexityToTask } from "./plan-complexity.js";
import type { StoredTask } from "./task-store.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { triggerDeployForEvent } from "./deploy-trigger.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("plan-crud");

export interface PlanCrudStore extends PlanVersioningStore {
  planGet(
    projectId: string,
    planId: string
  ): Promise<{
    content: string;
    metadata: Record<string, unknown>;
    updated_at: string;
    current_version_number?: number;
    last_executed_version_number?: number | null;
  } | null>;
  planListIds(projectId: string): Promise<string[]>;
  listAll(projectId: string): Promise<StoredTask[]>;
  show(projectId: string, taskId: string): Promise<StoredTask>;
  create(projectId: string, title: string, opts?: Record<string, unknown>): Promise<{ id: string }>;
  createMany(
    projectId: string,
    inputs: Array<Record<string, unknown> & { title: string }>
  ): Promise<Array<{ id: string }>>;
  update(
    projectId: string,
    taskId: string,
    updates: Record<string, unknown>
  ): Promise<void | StoredTask>;
  addDependencies(
    projectId: string,
    deps: Array<{ childId: string; parentId: string; type?: string }>
  ): Promise<void>;
  addLabel(projectId: string, taskId: string, label: string): Promise<void>;
  planInsert(
    projectId: string,
    planId: string,
    data: { epic_id: string; content: string; metadata: string }
  ): Promise<void>;
  planUpdateContent(
    projectId: string,
    planId: string,
    content: string,
    currentVersionNumber?: number
  ): Promise<void>;
  planUpdateMetadata(
    projectId: string,
    planId: string,
    metadata: Record<string, unknown>
  ): Promise<void>;
  planGetByEpicId(
    projectId: string,
    epicId: string
  ): Promise<{ plan_id: string; metadata: Record<string, unknown> } | null>;
  delete(projectId: string, taskId: string): Promise<void>;
  closeMany(
    projectId: string,
    items: Array<{ id: string; reason: string }>
  ): Promise<void | StoredTask[]>;
  planDelete(projectId: string, planId: string): Promise<boolean>;
  listPlanVersions(projectId: string, planId: string): Promise<Array<{ version_number: number }>>;
}

export interface PlanCrudOptions {
  /** When createPlan does not receive complexity, use this to evaluate it (e.g. via planning agent). Defaults to "medium". */
  evaluateComplexity?: (
    projectId: string,
    title: string,
    content: string
  ) => Promise<PlanComplexity>;
}

export class PlanCrudService {
  constructor(
    private taskStore: PlanCrudStore,
    private projectService: ProjectService,
    private options: PlanCrudOptions = {}
  ) {}

  private async getRepoPath(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return project.repoPath;
  }

  /** Load plan infos (planId, epicId, content) from task store for building edges. */
  async getPlanInfosFromStore(projectId: string): Promise<PlanInfo[]> {
    const planIds = await this.taskStore.planListIds(projectId);
    const infos: PlanInfo[] = [];
    for (const planId of planIds) {
      const row = await this.taskStore.planGet(projectId, planId);
      if (!row) continue;
      const epicId = (row.metadata.epicId as string) ?? "";
      infos.push({ planId, epicId, content: row.content });
    }
    return infos;
  }

  /** Count tasks under an epic (implementation tasks only). */
  private async countTasks(
    projectId: string,
    epicId: string,
    allIssues?: StoredTask[]
  ): Promise<{ total: number; done: number }> {
    try {
      const issues = allIssues ?? (await this.taskStore.listAll(projectId));
      const children = issues.filter(
        (issue: StoredTask) =>
          issue.id.startsWith(epicId + ".") && (issue.issue_type ?? issue.type) !== "epic"
      );
      const done = children.filter(
        (issue: StoredTask) => (issue.status as string) === "closed"
      ).length;
      return { total: children.length, done };
    } catch (err) {
      log.warn("countTasks failed, using default", { err: getErrorMessage(err) });
      return { total: 0, done: 0 };
    }
  }

  private async buildDependencyEdgesFromProject(projectId: string): Promise<PlanDependencyEdge[]> {
    const planInfos = await this.getPlanInfosFromStore(projectId);
    const allIssues = await this.taskStore.listAll(projectId);
    return buildDependencyEdgesCore(planInfos, allIssues);
  }

  /** Get a single Plan by ID. Optionally pass allIssues/edges to avoid redundant store calls. */
  async getPlan(
    projectId: string,
    planId: string,
    opts?: { allIssues?: StoredTask[]; edges?: PlanDependencyEdge[] }
  ): Promise<Plan> {
    const row = await this.taskStore.planGet(projectId, planId);
    if (!row) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan '${planId}' not found`, { planId });
    }
    const content = row.content;
    const lastModified = row.updated_at;
    const metadata: PlanMetadata = {
      planId: (row.metadata.planId as string) ?? planId,
      epicId: (row.metadata.epicId as string) ?? "",
      shippedAt: (row.metadata.shippedAt as string | null) ?? null,
      reviewedAt:
        "reviewedAt" in row.metadata ? (row.metadata.reviewedAt as string | null) : undefined,
      complexity: (row.metadata.complexity as PlanMetadata["complexity"]) ?? "medium",
      mockups: (row.metadata.mockups as PlanMetadata["mockups"]) ?? undefined,
    };

    let status: Plan["status"] = "planning";
    const { total, done } = metadata.epicId
      ? opts?.allIssues
        ? await this.countTasks(projectId, metadata.epicId, opts.allIssues)
        : await this.countTasks(projectId, metadata.epicId, undefined)
      : { total: 0, done: 0 };

    const allTasksDone = total > 0 && done === total;
    const statusWhenAllDone: Plan["status"] =
      metadata.reviewedAt != null ? "complete" : "in_review";

    if (metadata.epicId && opts?.allIssues) {
      const epicIssue = opts.allIssues.find((i) => i.id === metadata.epicId);
      const epicStatus = (epicIssue?.status as string) ?? "open";
      if (epicStatus === "blocked") {
        status = "planning";
      } else {
        status = allTasksDone ? statusWhenAllDone : "building";
      }
    } else if (metadata.epicId) {
      try {
        const epicIssue = await this.taskStore.show(projectId, metadata.epicId);
        const epicStatus = (epicIssue.status as string) ?? "open";
        if (epicStatus === "blocked") {
          status = "planning";
        } else {
          status = allTasksDone ? statusWhenAllDone : "building";
        }
      } catch {
        status = metadata.shippedAt ? (allTasksDone ? statusWhenAllDone : "building") : "planning";
      }
    } else if (metadata.shippedAt) {
      status = allTasksDone ? statusWhenAllDone : "building";
    }

    const dependencyCount = opts?.edges
      ? opts.edges.filter((e) => e.to === planId).length
      : (await this.buildDependencyEdgesFromProject(projectId)).filter((e) => e.to === planId)
          .length;

    return {
      metadata,
      content,
      status,
      taskCount: total,
      doneTaskCount: done,
      dependencyCount,
      lastModified,
      currentVersionNumber: row.current_version_number ?? 1,
      lastExecutedVersionNumber: row.last_executed_version_number ?? undefined,
    };
  }

  async ensurePlanHasAtLeastOneVersion(projectId: string, planId: string): Promise<void> {
    await ensurePlanHasAtLeastOneVersionFn(projectId, planId, this.taskStore);
  }

  /** List all Plans with dependency graph in one call. */
  async listPlansWithDependencyGraph(projectId: string): Promise<PlanDependencyGraph> {
    return listPlansWithEdgesFromModule(projectId, {
      getPlanInfosFromStore: this.getPlanInfosFromStore.bind(this),
      listAll: this.taskStore.listAll.bind(this.taskStore),
      getPlan: this.getPlan.bind(this),
    });
  }

  /** List all Plans for a project. */
  async listPlans(projectId: string): Promise<Plan[]> {
    const { plans } = await this.listPlansWithDependencyGraph(projectId);
    return plans;
  }

  /**
   * Get cross-epic dependencies: plans that must be executed first (still in Planning state).
   */
  async getCrossEpicDependencies(
    projectId: string,
    planId: string
  ): Promise<CrossEpicDependenciesResponse> {
    const { plans, edges } = await this.listPlansWithDependencyGraph(projectId);
    const planById = new Map(plans.map((p) => [p.metadata.planId, p]));
    const targetPlan = planById.get(planId);
    if (!targetPlan) {
      return { prerequisitePlanIds: [] };
    }

    // Edges: (from, to) means "from blocks to" — so "to" depends on "from"
    // Collect all prerequisites (plans that block us) that are still in planning
    const inPlanning = new Set(
      plans.filter((p) => p.status === "planning").map((p) => p.metadata.planId)
    );
    const directPrereqs = new Set<string>();
    for (const edge of edges) {
      if (edge.to === planId && inPlanning.has(edge.from)) {
        directPrereqs.add(edge.from);
      }
    }

    // Transitive closure: include prerequisites of prerequisites
    const allPrereqs = new Set<string>();
    const visit = (p: string) => {
      if (allPrereqs.has(p)) return;
      allPrereqs.add(p);
      for (const e of edges) {
        if (e.to === p && inPlanning.has(e.from)) visit(e.from);
      }
    };
    for (const p of directPrereqs) visit(p);

    // Topological sort: for each prereq, all its dependencies must come first
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visitSort = (p: string) => {
      if (visited.has(p)) return;
      visited.add(p);
      for (const e of edges) {
        if (e.to === p && allPrereqs.has(e.from)) visitSort(e.from);
      }
      sorted.push(p);
    };
    for (const p of allPrereqs) visitSort(p);

    return { prerequisitePlanIds: sorted };
  }

  /** Create a new Plan with epic (epic-blocked model). */
  async createPlan(
    projectId: string,
    body: {
      title?: string;
      plan_title?: string;
      content?: string;
      plan_content?: string;
      complexity?: string;
      mockups?: PlanMockup[];
      dependsOnPlans?: string[];
      depends_on_plans?: string[];
      tasks?: Array<Record<string, unknown>>;
    }
  ): Promise<Plan> {
    await this.getRepoPath(projectId);

    const rawTitle = (body.title ?? body.plan_title) as string | undefined;
    const rawContent = (body.content ?? body.plan_content) as string | undefined;
    if (!rawTitle?.trim()) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Plan requires title or plan_title", {});
    }
    const title = rawTitle.trim();
    const content =
      typeof rawContent === "string" && rawContent.trim()
        ? rawContent.trim()
        : `# ${title}\n\nNo content.`;

    const dependsOn = normalizeDependsOnPlans(body as Record<string, unknown>);
    const contentToWrite =
      dependsOn.length > 0 ? ensureDependenciesSection(content, dependsOn) : content;

    let complexity: PlanComplexity;
    const provided = body.complexity as PlanComplexity | undefined;
    if (provided && VALID_COMPLEXITIES.includes(provided)) {
      complexity = provided;
    } else if (this.options.evaluateComplexity) {
      complexity = await this.options.evaluateComplexity(projectId, title, contentToWrite);
    } else {
      complexity = "medium";
    }

    const planId = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const validation = validatePlanContent(content);
    if (validation.warnings.length > 0) {
      if (process.env.VITEST) {
        log.debug("Plan validation", { planId, warnings: validation.warnings });
      } else {
        log.warn("Plan validation", { planId, warnings: validation.warnings });
      }
    }

    const epicComplexity = planComplexityToTask(complexity);
    const epicResult = await this.taskStore.create(projectId, title, {
      type: "epic",
      complexity: epicComplexity,
    });
    const epicId = epicResult.id;

    await this.taskStore.update(projectId, epicId, { description: planId });
    await this.taskStore.update(projectId, epicId, { status: "blocked" });

    const createdTaskIds: string[] = [];
    const createdTaskTitles: string[] = [];
    const rawTasksInput = (body.tasks ??
      (body as Record<string, unknown>).task_list ??
      []) as unknown[];
    const rawTasks = Array.isArray(rawTasksInput)
      ? rawTasksInput.filter(
          (t): t is Record<string, unknown> => t != null && typeof t === "object"
        )
      : [];
    if (rawTasks.length > 0) {
      const tasks = rawTasks.map((t) => normalizePlannerTask(t, rawTasks));
      const inputs = tasks.map((task) => ({
        title: task.title,
        type: "task" as const,
        description: task.description,
        priority: Math.min(4, Math.max(0, task.priority)),
        parentId: epicId,
        ...(task.complexity != null && { complexity: task.complexity }),
      }));
      const created = await this.taskStore.createMany(projectId, inputs);
      const taskIdMap = new Map<string, string>();
      created.forEach((t, i) => {
        taskIdMap.set(tasks[i]!.title, t.id);
        createdTaskIds.push(t.id);
        createdTaskTitles.push(tasks[i]!.title);
      });

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
        await this.taskStore.addDependencies(projectId, interDeps);
      }

      for (let i = 0; i < rawTasks.length; i++) {
        const files = tasks[i]!.files;
        if (files && (files.modify?.length || files.create?.length || files.test?.length)) {
          const filesJson = JSON.stringify(files);
          await this.taskStore.addLabel(projectId, created[i]!.id, `files:${filesJson}`);
        }
      }
    }

    const rawMockups = (body.mockups ??
      (body as Record<string, unknown>).mock_ups ??
      []) as PlanMockup[];
    const mockups: PlanMockup[] = Array.isArray(rawMockups)
      ? rawMockups.filter((m) => m && typeof m === "object" && m.title && m.content)
      : [];
    const metadata: PlanMetadata = {
      planId,
      epicId: epicId,
      shippedAt: null,
      reviewedAt: null,
      complexity,
      mockups: mockups.length > 0 ? mockups : undefined,
    };
    await this.taskStore.planInsert(projectId, planId, {
      epic_id: epicId,
      content: contentToWrite,
      metadata: JSON.stringify(metadata),
    });

    const plan: Plan & { _createdTaskIds?: string[]; _createdTaskTitles?: string[] } = {
      metadata,
      content: contentToWrite,
      status: "planning",
      taskCount: rawTasks.length,
      doneTaskCount: 0,
      dependencyCount: 0,
    };
    if (createdTaskIds.length > 0) {
      plan._createdTaskIds = createdTaskIds;
      plan._createdTaskTitles = createdTaskTitles;
    }
    return plan;
  }

  /** Update a Plan's markdown. Creates a new plan version only when the current version already has tasks; otherwise updates in place. */
  async updatePlan(projectId: string, planId: string, body: { content: string }): Promise<Plan> {
    const row = await this.taskStore.planGet(projectId, planId);
    if (!row) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan '${planId}' not found`, {
        planId,
      });
    }

    const epicId = (row.metadata?.epicId as string) ?? "";
    const { total: taskCount } = epicId ? await this.countTasks(projectId, epicId) : { total: 0 };
    const versioningRow = {
      content: row.content,
      metadata: row.metadata,
      current_version_number: row.current_version_number,
    };

    const nextVersion =
      taskCount > 0
        ? await createVersionOnUpdate(
            projectId,
            planId,
            versioningRow,
            body.content,
            this.taskStore
          )
        : await updateCurrentVersionInPlace(
            projectId,
            planId,
            versioningRow,
            body.content,
            this.taskStore
          );

    await this.taskStore.planUpdateContent(projectId, planId, body.content, nextVersion);

    const validation = validatePlanContent(body.content);
    if (validation.warnings.length > 0) {
      if (process.env.VITEST) {
        log.debug("Plan validation on update", { planId, warnings: validation.warnings });
      } else {
        log.warn("Plan validation on update", { planId, warnings: validation.warnings });
      }
    }

    await syncPlanTasksFromContent(projectId, planId, body.content);

    return this.getPlan(projectId, planId);
  }

  /** Mark plan complete: set reviewedAt when all epic tasks are closed. */
  async markPlanComplete(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);

    const epicId = plan.metadata.epicId;
    if (epicId) {
      const allIssues = await this.taskStore.listAll(projectId);
      const children = allIssues.filter(
        (issue: StoredTask) =>
          issue.id.startsWith(epicId + ".") && (issue.issue_type ?? issue.type) !== "epic"
      );
      const allClosed = children.every(
        (issue: StoredTask) => (issue.status as string) === "closed"
      );
      if (children.length > 0 && !allClosed) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          "Plan has open tasks; cannot mark complete",
          { planId }
        );
      }
    }

    if (plan.metadata.reviewedAt != null) {
      return this.getPlan(projectId, planId);
    }

    const updatedMetadata = { ...plan.metadata } as unknown as Record<string, unknown>;
    updatedMetadata.reviewedAt = new Date().toISOString();
    if (updatedMetadata.shippedAt == null) {
      updatedMetadata.shippedAt = new Date().toISOString();
    }
    await this.taskStore.planUpdateMetadata(projectId, planId, updatedMetadata);

    broadcastToProject(projectId, { type: "plan.updated", planId });
    triggerDeployForEvent(projectId, "each_epic").catch((err) =>
      log.warn("Deploy trigger after mark-complete failed", { projectId, planId, err })
    );
    return this.getPlan(projectId, planId);
  }

  /** Clear reviewedAt when new tasks are added to an epic whose plan was complete. */
  async clearReviewedAtIfNewTasksAdded(projectId: string, epicId: string): Promise<void> {
    const planRow = await this.taskStore.planGetByEpicId(projectId, epicId);
    if (!planRow || planRow.metadata.reviewedAt == null) return;
    const planId = planRow.plan_id;
    const updatedMetadata = { ...planRow.metadata, reviewedAt: null };
    await this.taskStore.planUpdateMetadata(projectId, planId, updatedMetadata);
    log.info("Cleared reviewedAt after new tasks added to epic", { projectId, planId, epicId });
    broadcastToProject(projectId, { type: "plan.updated", planId });
  }

  /** Archive a plan: close all ready/open tasks to done. */
  async archivePlan(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    await this.getRepoPath(projectId);

    if (!plan.metadata.epicId) {
      throw new AppError(400, ErrorCodes.NO_EPIC, "Plan has no epic; cannot archive");
    }

    const epicId = plan.metadata.epicId;
    const allIssues = await this.taskStore.listAll(projectId);
    const planTasks = allIssues.filter(
      (issue: StoredTask) =>
        issue.id.startsWith(epicId + ".") && (issue.issue_type ?? issue.type) !== "epic"
    );

    const toClose = planTasks.filter((task) => ((task.status as string) ?? "open") === "open");
    if (toClose.length > 0) {
      await this.taskStore.closeMany(
        projectId,
        toClose.map((task) => ({ id: task.id, reason: "Archived plan" }))
      );
    }

    return this.getPlan(projectId, planId);
  }

  /** Delete a plan, its epic, and all tasks under that epic. */
  async deletePlan(projectId: string, planId: string): Promise<void> {
    const plan = await this.getPlan(projectId, planId);

    const epicId = plan.metadata.epicId;
    if (epicId) {
      const allIssues = await this.taskStore.listAll(projectId);
      const planTaskIds = allIssues.filter(
        (issue: StoredTask) => issue.id === epicId || issue.id.startsWith(epicId + ".")
      );
      const sortedIds = [...planTaskIds].map((t) => t.id).sort((a, b) => b.length - a.length);
      for (const id of sortedIds) {
        await this.taskStore.delete(projectId, id);
      }
    }

    const deleted = await this.taskStore.planDelete(projectId, planId);
    if (!deleted) {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
    }
  }
}
