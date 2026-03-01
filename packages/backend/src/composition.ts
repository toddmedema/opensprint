import { ProjectService } from "./services/project.service.js";
import { taskStore } from "./services/task-store.service.js";
import { FeedbackService } from "./services/feedback.service.js";
import { SessionManager } from "./services/session-manager.js";
import { ContextAssembler } from "./services/context-assembler.js";
import { BranchManager } from "./services/branch-manager.js";
import { TaskService } from "./services/task.service.js";

export interface AppServices {
  taskService: TaskService;
  projectService: ProjectService;
}

/**
 * Build or obtain single instances of services used by the app.
 * TaskService receives its dependencies via constructor.
 */
export function createAppServices(): AppServices {
  const projectService = new ProjectService();
  const feedbackService = new FeedbackService();
  const sessionManager = new SessionManager();
  const contextAssembler = new ContextAssembler();
  const branchManager = new BranchManager();

  const taskService = new TaskService(
    projectService,
    taskStore,
    feedbackService,
    sessionManager,
    contextAssembler,
    branchManager
  );

  return {
    taskService,
    projectService,
  };
}
