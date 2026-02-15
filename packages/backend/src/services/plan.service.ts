import fs from 'fs/promises';
import path from 'path';
import type { Plan, PlanMetadata, PlanDependencyGraph, PlanDependencyEdge } from '@opensprint/shared';
import { OPENSPRINT_PATHS } from '@opensprint/shared';
import { ProjectService } from './project.service.js';
import { BeadsService, type BeadsIssue } from './beads.service.js';
import { ChatService } from './chat.service.js';
import { AppError } from '../middleware/error-handler.js';

export class PlanService {
  private projectService = new ProjectService();
  private beads = new BeadsService();
  private chatService = new ChatService();

  /** Get the plans directory for a project */
  private async getPlansDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.plans);
  }

  /** Get repo path for a project */
  private async getRepoPath(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return project.repoPath;
  }

  /** Atomic JSON write */
  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  /** Count tasks under an epic from beads */
  private async countTasks(repoPath: string, epicId: string): Promise<{ total: number; completed: number }> {
    try {
      const allIssues = await this.beads.list(repoPath);
      // Filter for child tasks of this epic (ID pattern: epicId.N)
      const children = allIssues.filter((issue: BeadsIssue) =>
        issue.id.startsWith(epicId + '.') && issue.type !== 'epic',
      );
      const completed = children.filter((issue: BeadsIssue) => issue.status === 'closed').length;
      return { total: children.length, completed };
    } catch {
      return { total: 0, completed: 0 };
    }
  }

  /** List all Plans for a project */
  async listPlans(projectId: string): Promise<Plan[]> {
    const plansDir = await this.getPlansDir(projectId);
    const plans: Plan[] = [];

    try {
      const files = await fs.readdir(plansDir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const planId = file.replace('.md', '');
          try {
            const plan = await this.getPlan(projectId, planId);
            plans.push(plan);
          } catch {
            // Skip broken plans
          }
        }
      }
    } catch {
      // No plans directory yet
    }

    return plans;
  }

  /** Get a single Plan by ID */
  async getPlan(projectId: string, planId: string): Promise<Plan> {
    const plansDir = await this.getPlansDir(projectId);
    const repoPath = await this.getRepoPath(projectId);
    const mdPath = path.join(plansDir, `${planId}.md`);
    const metaPath = path.join(plansDir, `${planId}.meta.json`);

    let content: string;
    try {
      content = await fs.readFile(mdPath, 'utf-8');
    } catch {
      throw new AppError(404, 'PLAN_NOT_FOUND', `Plan '${planId}' not found`);
    }

    let metadata: PlanMetadata;
    try {
      const metaData = await fs.readFile(metaPath, 'utf-8');
      metadata = JSON.parse(metaData) as PlanMetadata;
    } catch {
      metadata = {
        planId,
        beadEpicId: '',
        gateTaskId: '',
        shippedAt: null,
        complexity: 'medium',
      };
    }

    // Derive status from beads state
    let status: Plan['status'] = 'planning';
    const { total, completed } = metadata.beadEpicId
      ? await this.countTasks(repoPath, metadata.beadEpicId)
      : { total: 0, completed: 0 };

    if (metadata.shippedAt) {
      status = total > 0 && completed === total ? 'complete' : 'shipped';
    }

    return {
      metadata,
      content,
      status,
      taskCount: total,
      completedTaskCount: completed,
      dependencyCount: 0, // Will be computed from dependency graph
    };
  }

  /** Create a new Plan with beads epic and gating task */
  async createPlan(
    projectId: string,
    body: { title: string; content: string; complexity?: string; tasks?: Array<{ title: string; description: string; priority?: number; dependsOn?: string[] }> },
  ): Promise<Plan> {
    const repoPath = await this.getRepoPath(projectId);
    const plansDir = await this.getPlansDir(projectId);
    await fs.mkdir(plansDir, { recursive: true });

    // Generate plan ID from title
    const planId = body.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Write markdown
    await fs.writeFile(path.join(plansDir, `${planId}.md`), body.content);

    // Create beads epic
    const epicResult = await this.beads.create(repoPath, body.title, {
      type: 'epic',
      description: `.opensprint/plans/${planId}.md`,
    });
    const epicId = epicResult.id;

    // Create gating task
    const gateResult = await this.beads.create(repoPath, 'Plan approval gate', {
      type: 'task',
      parentId: epicId,
    });
    const gateTaskId = gateResult.id;

    // Create child tasks if provided
    if (body.tasks && body.tasks.length > 0) {
      const taskIdMap = new Map<string, string>(); // title -> beads id

      for (const task of body.tasks) {
        const taskResult = await this.beads.create(repoPath, task.title, {
          type: 'task',
          description: task.description,
          priority: task.priority as any,
          parentId: epicId,
        });
        taskIdMap.set(task.title, taskResult.id);

        // Add blocks dependency on gating task
        await this.beads.addDependency(repoPath, taskResult.id, gateTaskId);
      }

      // Add inter-task dependencies
      for (const task of body.tasks) {
        if (task.dependsOn) {
          const childId = taskIdMap.get(task.title);
          if (childId) {
            for (const depTitle of task.dependsOn) {
              const parentId = taskIdMap.get(depTitle);
              if (parentId) {
                await this.beads.addDependency(repoPath, childId, parentId);
              }
            }
          }
        }
      }
    }

    // Write metadata
    const metadata: PlanMetadata = {
      planId,
      beadEpicId: epicId,
      gateTaskId,
      shippedAt: null,
      complexity: (body.complexity as PlanMetadata['complexity']) || 'medium',
    };

    await this.writeJson(path.join(plansDir, `${planId}.meta.json`), metadata);

    return {
      metadata,
      content: body.content,
      status: 'planning',
      taskCount: body.tasks?.length ?? 0,
      completedTaskCount: 0,
      dependencyCount: 0,
    };
  }

  /** Update a Plan's markdown */
  async updatePlan(
    projectId: string,
    planId: string,
    body: { content: string },
  ): Promise<Plan> {
    const plansDir = await this.getPlansDir(projectId);
    await fs.writeFile(path.join(plansDir, `${planId}.md`), body.content);
    return this.getPlan(projectId, planId);
  }

  /** Ship a Plan — close the gating task to unblock child tasks */
  async shipPlan(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);
    const plansDir = await this.getPlansDir(projectId);

    if (!plan.metadata.gateTaskId) {
      throw new AppError(400, 'NO_GATE_TASK', 'Plan has no gating task to close');
    }

    // Close the gating task
    await this.beads.close(repoPath, plan.metadata.gateTaskId, 'Plan shipped');

    // Update metadata
    plan.metadata.shippedAt = new Date().toISOString();
    await this.writeJson(
      path.join(plansDir, `${planId}.meta.json`),
      plan.metadata,
    );

    // Living PRD sync: invoke planning agent to review Plan vs PRD and update affected sections (PRD §15.1)
    try {
      await this.chatService.syncPrdFromPlanShip(projectId, planId, plan.content);
    } catch (err) {
      console.error('[plan] PRD sync on ship failed:', err);
      // Ship succeeds even if PRD sync fails; user can manually update PRD
    }

    return { ...plan, status: 'shipped' };
  }

  /** Re-ship an updated Plan */
  async reshipPlan(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);

    // Verify all existing tasks are Done or none started
    if (plan.metadata.beadEpicId) {
      const allIssues = await this.beads.list(repoPath);
      const children = allIssues.filter((issue: BeadsIssue) =>
        issue.id.startsWith(plan.metadata.beadEpicId + '.') &&
        issue.id !== plan.metadata.gateTaskId,
      );

      const hasInProgress = children.some(
        (issue: BeadsIssue) => issue.status === 'in_progress',
      );
      if (hasInProgress) {
        throw new AppError(
          400,
          'TASKS_IN_PROGRESS',
          'Cannot re-ship while tasks are In Progress or In Review',
        );
      }

      const allDone = children.every((issue: BeadsIssue) => issue.status === 'closed');
      const noneStarted = children.every((issue: BeadsIssue) => issue.status === 'open');

      if (noneStarted && children.length > 0) {
        // Delete all existing sub-tasks
        for (const child of children) {
          await this.beads.delete(repoPath, child.id);
        }
      } else if (!allDone && children.length > 0) {
        throw new AppError(
          400,
          'TASKS_NOT_COMPLETE',
          'All tasks must be Done before re-shipping (or none started)',
        );
      }
    }

    return this.shipPlan(projectId, planId);
  }

  /** Get the dependency graph for all Plans */
  async getDependencyGraph(projectId: string): Promise<PlanDependencyGraph> {
    const plans = await this.listPlans(projectId);
    const edges: PlanDependencyEdge[] = [];

    // Build edges from beads dependency data
    const repoPath = await this.getRepoPath(projectId);
    try {
      const allIssues = await this.beads.list(repoPath);
      const epicIds = new Set(plans.map((p) => p.metadata.beadEpicId));

      // Look for cross-epic dependencies
      for (const issue of allIssues) {
        if (issue.type === 'epic' && epicIds.has(issue.id)) {
          // Check if any dependency links exist between epics
          // This is simplified — a full implementation would parse dependency data
        }
      }
    } catch {
      // If beads is not available, return empty edges
    }

    return { plans, edges };
  }
}
