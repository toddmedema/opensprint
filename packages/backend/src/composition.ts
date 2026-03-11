import { ProjectService } from "./services/project.service.js";
import { taskStore } from "./services/task-store.service.js";
import { FeedbackService } from "./services/feedback.service.js";
import { SessionManager } from "./services/session-manager.js";
import { PlanService } from "./services/plan.service.js";
import { ContextAssembler } from "./services/context-assembler.js";
import { BranchManager } from "./services/branch-manager.js";
import { TaskService } from "./services/task.service.js";
import { orchestratorService } from "./services/orchestrator.service.js";

export interface AppServices {
  taskService: TaskService;
  projectService: ProjectService;
  planService: PlanService;
  sessionManager: SessionManager;
}

/**
 * Build or obtain single instances of services used by the app.
 * TaskService and routes receive dependencies via this composition root.
 */
export function createAppServices(): AppServices {
  const projectService = new ProjectService();
  const feedbackService = new FeedbackService();
  const contextAssembler = new ContextAssembler();
  const branchManager = new BranchManager();
  const planService = new PlanService(projectService, taskStore);
  const sessionManager = new SessionManager(projectService);

  if (typeof orchestratorService.setSessionManager === "function") {
    orchestratorService.setSessionManager(sessionManager);
  }

  const taskService = new TaskService(
    projectService,
    taskStore,
    feedbackService,
    sessionManager,
    contextAssembler,
    branchManager,
    orchestratorService
  );

  return {
    taskService,
    projectService,
    planService,
    sessionManager,
  };
}
