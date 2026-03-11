import type {
  Plan,
  PlanDependencyGraph,
  PlanDependencyEdge,
  CrossEpicDependenciesResponse,
  GeneratePlanResult,
  Notification,
} from "@opensprint/shared";
import { getCodebaseContextFromRepo, hasExistingCode as hasExistingCodeInRepo } from "./plan/plan-codebase-context.js";
import { assembleReExecuteContext as assembleReExecuteContextFromModule } from "./plan/plan-codebase-context.js";
import { ProjectService } from "./project.service.js";
import { taskStore as taskStoreSingleton, type TaskStoreService, type StoredTask } from "./task-store.service.js";
import { ChatService } from "./chat.service.js";
import { notificationService } from "./notification.service.js";
import { PrdService } from "./prd.service.js";
import { maybeAutoRespond } from "./open-question-autoresolve.service.js";
import { PlanCrudService } from "./plan-crud.service.js";
import { PlanDecomposeGenerateService } from "./plan-decompose-generate.service.js";
import { PlanShipService } from "./plan-ship.service.js";
import { PlanPlanningRunService } from "./plan-planning-run.service.js";
import { PlanComplexityEvaluationService } from "./plan-complexity-evaluation.service.js";

export class PlanService {
  private readonly projectService: ProjectService;
  private readonly taskStore: TaskStoreService;

  constructor(
    projectService?: ProjectService,
    taskStore?: TaskStoreService
  ) {
    this.projectService = projectService ?? new ProjectService();
    this.taskStore = taskStore ?? taskStoreSingleton;
  }

  private chatService = new ChatService();
  private prdService = new PrdService();

  private _planComplexityEvaluationService: PlanComplexityEvaluationService | null = null;
  private get planComplexityEvaluationService(): PlanComplexityEvaluationService {
    if (!this._planComplexityEvaluationService) {
      this._planComplexityEvaluationService = new PlanComplexityEvaluationService({
        projectService: this.projectService,
      });
    }
    return this._planComplexityEvaluationService;
  }

  private _planPlanningRunService: PlanPlanningRunService | null = null;
  private get planPlanningRunService(): PlanPlanningRunService {
    if (!this._planPlanningRunService) {
      this._planPlanningRunService = new PlanPlanningRunService({
        store: this.taskStore,
        projectService: this.projectService,
        getPrd: (projectId) => this.prdService.getPrd(projectId),
      });
    }
    return this._planPlanningRunService;
  }

  private _planCrudService: PlanCrudService | null = null;
  private get planCrudService(): PlanCrudService {
    if (!this._planCrudService) {
      this._planCrudService = new PlanCrudService(this.taskStore, this.projectService, {
        evaluateComplexity: (p, t, c) =>
          this.planComplexityEvaluationService.evaluateComplexity(p, t, c),
      });
    }
    return this._planCrudService;
  }

  private _planDecomposeGenerateService: PlanDecomposeGenerateService | null = null;
  private get planDecomposeGenerateService(): PlanDecomposeGenerateService {
    if (!this._planDecomposeGenerateService) {
      this._planDecomposeGenerateService = new PlanDecomposeGenerateService(
        {
          taskStore: this.taskStore,
          projectService: this.projectService,
          prdService: this.prdService,
          createPlan: (projectId, body) => this.planCrudService.createPlan(projectId, body as Parameters<PlanCrudService["createPlan"]>[1]),
          getPlan: (
            projectId,
            planId,
            opts?: { allIssues?: StoredTask[]; edges?: PlanDependencyEdge[] }
          ) => this.planCrudService.getPlan(projectId, planId, opts),
        },
        {
          chatService: this.chatService,
          notificationService,
          maybeAutoRespond: maybeAutoRespond
            ? (p, n) => maybeAutoRespond(p, n as Notification)
            : undefined,
        }
      );
    }
    return this._planDecomposeGenerateService;
  }

  private _planShipService: PlanShipService | null = null;
  private get planShipService(): PlanShipService {
    if (!this._planShipService) {
      this._planShipService = new PlanShipService({
        crudService: this.planCrudService,
        decomposeService: this.planDecomposeGenerateService,
        taskStore: this.taskStore,
        projectService: this.projectService,
        chatService: this.chatService,
        shipPlanDelegate: (p, id, o) => this.shipPlan(p, id, o),
        assembleReExecuteContext: assembleReExecuteContextFromModule,
      });
    }
    return this._planShipService;
  }

  /** Get repo path for a project */
  private async getRepoPath(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return project.repoPath;
  }

  /** List all Plans with dependency graph in one call. */
  async listPlansWithDependencyGraph(projectId: string): Promise<PlanDependencyGraph> {
    return this.planCrudService.listPlansWithDependencyGraph(projectId);
  }

  /** List all Plans for a project */
  async listPlans(projectId: string): Promise<Plan[]> {
    return this.planCrudService.listPlans(projectId);
  }

  /** Get a single Plan by ID. */
  async getPlan(
    projectId: string,
    planId: string,
    opts?: { allIssues?: StoredTask[]; edges?: import("@opensprint/shared").PlanDependencyEdge[] }
  ): Promise<Plan> {
    return this.planCrudService.getPlan(projectId, planId, opts);
  }

  /** Ensure the plan has at least one version. */
  async ensurePlanHasAtLeastOneVersion(projectId: string, planId: string): Promise<void> {
    return this.planCrudService.ensurePlanHasAtLeastOneVersion(projectId, planId);
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
      mockups?: import("@opensprint/shared").PlanMockup[];
      dependsOnPlans?: string[];
      depends_on_plans?: string[];
      tasks?: Array<Record<string, unknown>>;
    }
  ): Promise<Plan> {
    return this.planCrudService.createPlan(projectId, body);
  }

  /** Update a Plan's markdown. Creates a new plan version on each save. */
  async updatePlan(projectId: string, planId: string, body: { content: string }): Promise<Plan> {
    return this.planCrudService.updatePlan(projectId, planId, body);
  }

  /** Plan Tasks — create epic if missing, then generate and create tasks. */
  async planTasks(projectId: string, planId: string): Promise<Plan> {
    return this.planDecomposeGenerateService.planTasks(projectId, planId);
  }

  /** Build It! — auto-generate tasks if needed, unblock epic. */
  async shipPlan(
    projectId: string,
    planId: string,
    options?: { version_number?: number }
  ): Promise<Plan> {
    return this.planShipService.shipPlan(projectId, planId, options);
  }

  /** Rebuild an updated Plan (Re-execute): Auditor audit and delta tasks. */
  async reshipPlan(
    projectId: string,
    planId: string,
    options?: { version_number?: number }
  ): Promise<Plan> {
    return this.planShipService.reshipPlan(projectId, planId, options);
  }

  /** Lightweight check: repo has at least one source file. */
  async hasExistingCode(projectId: string): Promise<boolean> {
    const repoPath = await this.getRepoPath(projectId);
    return hasExistingCodeInRepo(repoPath);
  }

  /** Get codebase context (file tree + key file contents) for a project. Used by sketch generate-from-codebase and plan auto-review. */
  async getCodebaseContext(
    projectId: string
  ): Promise<{ fileTree: string; keyFilesContent: string }> {
    const repoPath = await this.getRepoPath(projectId);
    return getCodebaseContextFromRepo(repoPath);
  }

  /** Get the dependency graph for all Plans */
  async getDependencyGraph(projectId: string): Promise<PlanDependencyGraph> {
    return this.planCrudService.listPlansWithDependencyGraph(projectId);
  }

  /**
   * Get cross-epic dependencies: plans that must be executed first (still in Planning state).
   */
  async getCrossEpicDependencies(
    projectId: string,
    planId: string
  ): Promise<CrossEpicDependenciesResponse> {
    return this.planCrudService.getCrossEpicDependencies(projectId, planId);
  }

  /** Execute a plan and its prerequisites in dependency order. */
  async shipPlanWithPrerequisites(
    projectId: string,
    planId: string,
    prerequisitePlanIds: string[],
    options?: { version_number?: number }
  ): Promise<Plan> {
    return this.planShipService.shipPlanWithPrerequisites(
      projectId,
      planId,
      prerequisitePlanIds,
      options
    );
  }

  /** Get plan status for Sketch CTA (plan/replan/none). PRD §7.1.5 */
  async getPlanStatus(projectId: string) {
    return this.planPlanningRunService.getPlanStatus(projectId);
  }

  /** Create a planning run with PRD snapshot. Called after decompose or replan. */
  async createPlanningRun(
    projectId: string,
    plansCreated: Plan[]
  ): Promise<{ id: string; created_at: string }> {
    return this.planPlanningRunService.createPlanningRun(projectId, plansCreated);
  }

  /** Mark plan complete when all epic tasks are closed. */
  async markPlanComplete(projectId: string, planId: string): Promise<Plan> {
    return this.planCrudService.markPlanComplete(projectId, planId);
  }

  /** Clear reviewedAt when new tasks are added to an epic whose plan was complete. */
  async clearReviewedAtIfNewTasksAdded(projectId: string, epicId: string): Promise<void> {
    return this.planCrudService.clearReviewedAtIfNewTasksAdded(projectId, epicId);
  }

  /** Archive a plan: close all ready/open tasks to done. */
  async archivePlan(projectId: string, planId: string): Promise<Plan> {
    return this.planCrudService.archivePlan(projectId, planId);
  }

  /** Delete a plan, its epic, and all tasks under that epic. */
  async deletePlan(projectId: string, planId: string): Promise<void> {
    return this.planCrudService.deletePlan(projectId, planId);
  }

  /** Generate a plan from a freeform feature description. */
  async generatePlanFromDescription(
    projectId: string,
    description: string
  ): Promise<GeneratePlanResult> {
    return this.planDecomposeGenerateService.generatePlanFromDescription(projectId, description);
  }

  /** AI-assisted decomposition (suggest only): returns suggested plans, does not create. */
  async suggestPlans(projectId: string): Promise<{ plans: import("@opensprint/shared").SuggestedPlan[] }> {
    return this.planDecomposeGenerateService.suggestPlans(projectId);
  }

  /** AI-assisted decomposition: creates Plans from PRD. */
  async decomposeFromPrd(projectId: string): Promise<{ created: number; plans: Plan[] }> {
    const result = await this.planDecomposeGenerateService.decomposeFromPrd(projectId);
    await this.createPlanningRun(projectId, result.plans);
    return result;
  }
}
