import fs from 'fs/promises';
import path from 'path';
import type { Plan, PlanMetadata, PlanDependencyGraph, PlanDependencyEdge } from '@opensprint/shared';
import { OPENSPRINT_PATHS } from '@opensprint/shared';
import { ProjectService } from './project.service.js';
import { BeadsService, type BeadsIssue } from './beads.service.js';
import { ChatService } from './chat.service.js';
import { PrdService } from './prd.service.js';
import { AgentClient } from './agent-client.js';
import { AppError } from '../middleware/error-handler.js';

const DECOMPOSE_SYSTEM_PROMPT = `You are an AI planning assistant for OpenSprint. You analyze Product Requirements Documents (PRDs) and suggest a breakdown into discrete, implementable features (Plans).

Your task: Given the full PRD, produce a feature decomposition. For each feature:
1. Create a Plan with a clear title and full markdown specification
2. Break the Plan into granular, atomic tasks that an AI coding agent can implement
3. Specify task dependencies (dependsOn) where one task must complete before another
4. Recommend implementation order (foundational/risky first)

Plan markdown must follow this structure (PRD §7.2.3):
- Feature Title
- Overview
- Acceptance Criteria (testable conditions)
- Technical Approach
- Dependencies (references to other Plans if any)
- Data Model Changes
- API Specification
- UI/UX Requirements
- Edge Cases and Error Handling
- Testing Strategy
- Estimated Complexity (low/medium/high/very_high)

Tasks should be atomic, implementable in one agent session, with clear acceptance criteria in the description.

Respond with ONLY valid JSON in this exact format. You may use a markdown code block with language "json" for readability. The JSON structure:
{
  "plans": [
    {
      "title": "Feature Name",
      "content": "# Feature Name\\n\\n## Overview\\n...\\n\\n## Acceptance Criteria\\n...\\n\\n## Dependencies\\nReferences to other plans (e.g. user-authentication) if this feature depends on them.",
      "complexity": "medium",
      "dependsOnPlans": [],
      "tasks": [
        {"title": "Task title", "description": "Task spec", "priority": 1, "dependsOn": []}
      ]
    }
  ]
}

complexity: low, medium, high, or very_high. priority: 0=highest. dependsOn: array of task titles this task depends on (blocked by). dependsOnPlans: array of other plan titles (slugified, e.g. "user-auth") this plan depends on - use empty array if none.`;

export class PlanService {
  private projectService = new ProjectService();
  private beads = new BeadsService();
  private chatService = new ChatService();
  private prdService = new PrdService();
  private agentClient = new AgentClient();

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

  /** Build dependency edges between plans (from beads + markdown). */
  private async buildDependencyEdges(plans: Plan[], repoPath: string): Promise<PlanDependencyEdge[]> {
    const edges: PlanDependencyEdge[] = [];
    const epicToPlan = new Map(plans.map((p) => [p.metadata.beadEpicId, p.metadata.planId]));
    const seenEdges = new Set<string>();

    const addEdge = (fromPlanId: string, toPlanId: string) => {
      if (fromPlanId === toPlanId) return;
      const key = `${fromPlanId}->${toPlanId}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ from: fromPlanId, to: toPlanId, type: 'blocks' });
    };

    const getEpicId = (id: string): string => {
      const m = id.match(/^(.+)\.(\d+)$/);
      return m ? m[1] : id;
    };

    try {
      const allIssues = await this.beads.listAll(repoPath);
      for (const issue of allIssues) {
        const deps = (issue.dependencies as Array<{ depends_on_id: string; type: string }>) ?? [];
        const blockers = deps.filter((d) => d.type === 'blocks').map((d) => d.depends_on_id);
        const myEpicId = getEpicId(issue.id);
        const toPlanId = epicToPlan.get(myEpicId);
        if (!toPlanId) continue;
        for (const blockerId of blockers) {
          const blockerEpicId = getEpicId(blockerId);
          const fromPlanId = epicToPlan.get(blockerEpicId);
          if (fromPlanId && blockerEpicId !== myEpicId) {
            addEdge(fromPlanId, toPlanId);
          }
        }
      }
    } catch {
      // Beads may not be available
    }

    for (const plan of plans) {
      const depsSection = plan.content.match(/## Dependencies[\s\S]*?(?=##|$)/i);
      if (!depsSection) continue;
      const text = depsSection[0].toLowerCase();
      for (const other of plans) {
        if (other.metadata.planId === plan.metadata.planId) continue;
        const slug = other.metadata.planId.replace(/-/g, '[\\s-]*');
        if (new RegExp(slug, 'i').test(text)) {
          addEdge(other.metadata.planId, plan.metadata.planId);
        }
      }
    }

    return edges;
  }

  /** List all Plans for a project */
  async listPlans(projectId: string): Promise<Plan[]> {
    const plansDir = await this.getPlansDir(projectId);
    const repoPath = await this.getRepoPath(projectId);
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

    const edges = await this.buildDependencyEdges(plans, repoPath);
    for (const plan of plans) {
      plan.dependencyCount = edges.filter((e) => e.to === plan.metadata.planId).length;
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
    const repoPath = await this.getRepoPath(projectId);
    const edges = await this.buildDependencyEdges(plans, repoPath);
    return { plans, edges };
  }

  /** Build PRD context string for agent prompts */
  private async buildPrdContext(projectId: string): Promise<string> {
    try {
      const prd = await this.prdService.getPrd(projectId);
      let context = '';
      for (const [key, section] of Object.entries(prd.sections)) {
        if (section.content) {
          context += `### ${key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}\n`;
          context += `${section.content}\n\n`;
        }
      }
      return context || 'The PRD is currently empty.';
    } catch {
      return 'No PRD exists yet.';
    }
  }

  /**
   * AI-assisted decomposition: Planning agent analyzes PRD and suggests feature breakdown.
   * Creates Plans + tasks from AI. PRD §7.2.2
   */
  async decomposeFromPrd(projectId: string): Promise<{ created: number; plans: Plan[] }> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.projectService.getSettings(projectId);

    const prdContext = await this.buildPrdContext(projectId);

    const prompt = `Analyze the PRD below and produce a feature decomposition. Output valid JSON with a "plans" array. Each plan has: title, content (full markdown), complexity (low|medium|high|very_high), and tasks array. Each task has: title, description, priority (0-4), dependsOn (array of task titles it depends on).`;

    const response = await this.agentClient.invoke({
      config: settings.planningAgent,
      prompt,
      systemPrompt: DECOMPOSE_SYSTEM_PROMPT + '\n\n## Current PRD\n\n' + prdContext,
      cwd: repoPath,
    });

    // Extract JSON from response (may be wrapped in ```json ... ```)
    const jsonMatch = response.content.match(/\{[\s\S]*"plans"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new AppError(
        400,
        'DECOMPOSE_PARSE_FAILED',
        'Planning agent did not return valid decomposition JSON. Response: ' + response.content.slice(0, 500),
      );
    }

    let parsed: { plans?: Array<{
      title: string;
      content: string;
      complexity?: string;
      tasks?: Array<{ title: string; description: string; priority?: number; dependsOn?: string[] }>;
    }> };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new AppError(400, 'DECOMPOSE_JSON_INVALID', 'Could not parse decomposition JSON from agent response');
    }

    const planSpecs = parsed.plans ?? [];
    if (planSpecs.length === 0) {
      throw new AppError(400, 'DECOMPOSE_EMPTY', 'Planning agent returned no plans. Ensure the PRD has sufficient content.');
    }

    const created: Plan[] = [];
    for (const spec of planSpecs) {
      const plan = await this.createPlan(projectId, {
        title: spec.title || 'Untitled Feature',
        content: spec.content || '# Untitled Feature\n\nNo content.',
        complexity: (spec.complexity as PlanMetadata['complexity']) || 'medium',
        tasks: (spec.tasks ?? []).map((t) => ({
          title: t.title || 'Untitled task',
          description: t.description || '',
          priority: t.priority ?? 2,
          dependsOn: t.dependsOn ?? [],
        })),
      });
      created.push(plan);
    }

    return { created: created.length, plans: created };
  }
}
