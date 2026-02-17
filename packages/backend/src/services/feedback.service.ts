import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { FeedbackItem, FeedbackSubmitRequest, FeedbackCategory } from '@opensprint/shared';
import { OPENSPRINT_PATHS } from '@opensprint/shared';
import { AppError } from '../middleware/error-handler.js';
import { ErrorCodes } from '../middleware/error-codes.js';
import { ProjectService } from './project.service.js';
import { AgentClient } from './agent-client.js';
import { hilService } from './hil-service.js';
import { ChatService } from './chat.service.js';
import { PlanService } from './plan.service.js';
import { PrdService } from './prd.service.js';
import { BeadsService, type BeadsIssue } from './beads.service.js';
import { activeAgentsService } from './active-agents.service.js';
import { broadcastToProject } from '../websocket/index.js';
import { writeJsonAtomic } from '../utils/file-utils.js';

const FEEDBACK_CATEGORIZATION_PROMPT = `You are an AI assistant that categorizes user feedback about a software product.

Given the user's feedback text, the PRD (Product Requirements Document), and available plans, determine:
1. The category: "bug" (something broken), "feature" (new capability request), "ux" (usability improvement), or "scope" (fundamental change to requirements)
2. Which feature/plan it relates to (if identifiable) — use the planId from the available plans list
3. One or more suggested task titles to address the feedback (array of strings)

Respond in JSON format:
{
  "category": "bug" | "feature" | "ux" | "scope",
  "mappedPlanId": "plan-id-if-identifiable or null",
  "task_titles": ["Short task title 1", "Short task title 2"]
}`;

export class FeedbackService {
  private projectService = new ProjectService();
  private agentClient = new AgentClient();
  private hilService = hilService;
  private chatService = new ChatService();
  private planService = new PlanService();
  private prdService = new PrdService();
  private beadsService = new BeadsService();

  /** Get feedback directory for a project */
  private async getFeedbackDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.feedback);
  }

  /** List all feedback items */
  async listFeedback(projectId: string): Promise<FeedbackItem[]> {
    const feedbackDir = await this.getFeedbackDir(projectId);
    const items: FeedbackItem[] = [];

    try {
      const files = await fs.readdir(feedbackDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const data = await fs.readFile(path.join(feedbackDir, file), 'utf-8');
          items.push(JSON.parse(data) as FeedbackItem);
        }
      }
    } catch {
      // No feedback yet
    }

    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Submit new feedback with AI categorization and mapping */
  async submitFeedback(
    projectId: string,
    body: FeedbackSubmitRequest,
  ): Promise<FeedbackItem> {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, 'Feedback text is required');
    }
    const feedbackDir = await this.getFeedbackDir(projectId);
    await fs.mkdir(feedbackDir, { recursive: true });
    const id = uuid();

    // Validate and normalize image attachments (base64 strings)
    const images: string[] = [];
    if (Array.isArray(body?.images)) {
      for (const img of body.images) {
        if (typeof img === 'string' && img.length > 0) {
          // Accept data URLs (data:image/...;base64,...) or raw base64
          const base64 = img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
          images.push(base64);
        }
      }
    }

    // Create initial feedback item
    const item: FeedbackItem = {
      id,
      text,
      category: 'bug', // Default, will be updated by AI
      mappedPlanId: null,
      createdTaskIds: [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(images.length > 0 && { images }),
    };

    // Save immediately
    await writeJsonAtomic(path.join(feedbackDir, `${id}.json`), item);

    // Invoke planning agent for categorization (async)
    this.categorizeFeedback(projectId, item).catch((err) => {
      console.error(`Failed to categorize feedback ${id}:`, err);
    });

    return item;
  }

  /** Build PRD context for AI (relevant sections as markdown) */
  private async getPrdContextForCategorization(projectId: string): Promise<string> {
    try {
      const prd = await this.prdService.getPrd(projectId);
      const sections = prd.sections;
      const parts: string[] = [];
      const keys = [
        'executive_summary',
        'feature_list',
        'technical_architecture',
        'data_model',
      ] as const;
      for (const key of keys) {
        const section = sections[key];
        if (section?.content?.trim()) {
          parts.push(`## ${key}\n${section.content.trim()}`);
        }
      }
      if (parts.length === 0) return 'No PRD content available.';
      return `# PRD (Product Requirements Document)\n\n${parts.join('\n\n')}`;
    } catch {
      return 'No PRD available.';
    }
  }

  /** Build plan context for AI mapping (planId, title from first heading) */
  private async getPlanContextForCategorization(projectId: string): Promise<string> {
    try {
      const plans = await this.planService.listPlans(projectId);
      if (plans.length === 0) return 'No plans exist yet. Use mappedPlanId: null.';
      const lines = plans.map((p) => {
        const title = p.content.split('\n')[0]?.replace(/^#+\s*/, '').trim() || p.metadata.planId;
        return `- ${p.metadata.planId}: ${title}`;
      });
      return `Available plans (use planId for mappedPlanId):\n${lines.join('\n')}`;
    } catch {
      return 'No plans available. Use mappedPlanId: null.';
    }
  }

  /** AI categorization, mapping, and bead task creation */
  private async categorizeFeedback(projectId: string, item: FeedbackItem): Promise<void> {
    const agentId = `feedback-categorize-${projectId}-${item.id}-${Date.now()}`;
    activeAgentsService.register(agentId, projectId, 'validate', 'Feedback categorization', new Date().toISOString());

    try {
      await this.categorizeFeedbackImpl(projectId, item);
    } finally {
      activeAgentsService.unregister(agentId);
    }
  }

  private async categorizeFeedbackImpl(projectId: string, item: FeedbackItem): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const project = await this.projectService.getProject(projectId);
    const [prdContext, planContext] = await Promise.all([
      this.getPrdContextForCategorization(projectId),
      this.getPlanContextForCategorization(projectId),
    ]);

    let plans: { metadata: { planId: string } }[] = [];
    try {
      plans = await this.planService.listPlans(projectId);
    } catch {
      // Ignore
    }
    const firstPlanId = plans.length > 0 ? plans[0].metadata.planId : null;

    try {
      const response = await this.agentClient.invoke({
        config: settings.planningAgent,
        prompt: `# PRD\n\n${prdContext}\n\n# Plans\n\n${planContext}\n\n# Feedback to categorize\n\n"${item.text}"`,
        systemPrompt: FEEDBACK_CATEGORIZATION_PROMPT,
        cwd: project.repoPath,
      });

      // Parse AI response; fallback: default to bug, map to first plan (PRD §7.4.2 edge case)
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const validCategories: FeedbackCategory[] = ['bug', 'feature', 'ux', 'scope'];
        item.category = validCategories.includes(parsed.category)
          ? (parsed.category as FeedbackCategory)
          : 'bug';
        item.mappedPlanId = parsed.mappedPlanId || firstPlanId;

        // task_titles: array of strings; support legacy suggestedTitle
        item.taskTitles = Array.isArray(parsed.task_titles)
          ? parsed.task_titles.filter((t: unknown) => typeof t === 'string')
          : parsed.suggestedTitle
            ? [String(parsed.suggestedTitle)]
            : [item.text.slice(0, 80)];

        // Handle scope changes with HIL (PRD §7.4.2, §15.1)
        if (item.category === 'scope') {
          const { approved } = await this.hilService.evaluateDecision(
            projectId,
            'scopeChanges',
            `Scope change feedback: "${item.text}"`,
          );

          if (!approved) {
            item.status = 'mapped';
            await this.saveFeedback(projectId, item);
            broadcastToProject(projectId, {
              type: 'feedback.mapped',
              feedbackId: item.id,
              planId: item.mappedPlanId || '',
              taskIds: item.createdTaskIds,
            });
            return;
          }

          // After HIL approval, invoke the planning agent to update the PRD
          try {
            await this.chatService.syncPrdFromScopeChangeFeedback(projectId, item.text);
          } catch (err) {
            console.error('[feedback] PRD sync on scope-change approval failed:', err);
          }
        }
      } else {
        // Parse failed: default to bug, map to first plan
        item.category = 'bug';
        item.mappedPlanId = firstPlanId;
        item.taskTitles = [item.text.slice(0, 80)];
      }
    } catch (error) {
      console.error(`AI categorization failed for feedback ${item.id}:`, error);
      item.category = 'bug';
      item.mappedPlanId = firstPlanId;
      item.taskTitles = [item.text.slice(0, 80)];
    }

    // Create beads tasks from the generated task titles (best-effort)
    try {
      item.createdTaskIds = await this.createBeadTasksFromFeedback(projectId, item);
    } catch (err) {
      console.error(`[feedback] Failed to create beads tasks for ${item.id}:`, err);
    }
    item.status = 'mapped';

    await this.saveFeedback(projectId, item);

    broadcastToProject(projectId, {
      type: 'feedback.mapped',
      feedbackId: item.id,
      planId: item.mappedPlanId || '',
      taskIds: item.createdTaskIds,
    });
  }

  /**
   * Map feedback category to beads issue type (PRD §14).
   * bug → bug, feature → feature, ux → task.
   */
  private categoryToBeadType(category: FeedbackCategory): 'bug' | 'feature' | 'task' {
    switch (category) {
      case 'bug':
        return 'bug';
      case 'feature':
        return 'feature';
      case 'ux':
      case 'scope':
      default:
        return 'task';
    }
  }

  /** Create beads tasks from feedback task titles under the mapped plan's epic */
  private async createBeadTasksFromFeedback(
    projectId: string,
    item: FeedbackItem,
  ): Promise<string[]> {
    const taskTitles = item.taskTitles ?? [];
    if (taskTitles.length === 0) return [];

    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;

    // Look up the plan's beadEpicId if a plan is mapped
    let parentEpicId: string | undefined;
    if (item.mappedPlanId) {
      try {
        const plan = await this.planService.getPlan(projectId, item.mappedPlanId);
        if (plan.metadata.beadEpicId) {
          parentEpicId = plan.metadata.beadEpicId;
        }
      } catch {
        // Plan not found or no epic — create tasks without parent
      }
    }

    // Create feedback source bead for discovered-from provenance (PRD §14, §15.3)
    let feedbackSourceBeadId: string | undefined;
    try {
      const sourceTitle = `Feedback: ${item.text.slice(0, 60)}${item.text.length > 60 ? '…' : ''}`;
      const sourceBead = await this.beadsService.create(repoPath, sourceTitle, {
        type: 'chore',
        priority: 4,
        description: `Feedback ID: ${item.id}`,
      });
      feedbackSourceBeadId = sourceBead.id;
      item.feedbackSourceBeadId = feedbackSourceBeadId;
    } catch (err) {
      console.error(`[feedback] Failed to create feedback source bead for ${item.id}:`, err);
    }

    const beadType = this.categoryToBeadType(item.category);
    const createdIds: string[] = [];
    for (const title of taskTitles) {
      try {
        const issue = await this.createBeadTaskWithRetry(repoPath, title, {
          type: beadType,
          priority: item.category === 'bug' ? 0 : 2,
          parentId: parentEpicId,
        });
        if (issue) {
          createdIds.push(issue.id);

          // Link task to feedback source via discovered-from (PRD §14)
          if (feedbackSourceBeadId) {
            try {
              await this.beadsService.addDependency(
                repoPath,
                issue.id,
                feedbackSourceBeadId,
                'discovered-from',
              );
            } catch (depErr) {
              console.error(`[feedback] Failed to add discovered-from for ${issue.id}:`, depErr);
            }
          }
        }
      } catch (err) {
        console.error(`[feedback] Failed to create beads task "${title}":`, err);
      }
    }

    return createdIds;
  }

  /**
   * Create a beads task with retry logic for UNIQUE constraint failures.
   * The beads CLI can generate child IDs that collide with existing tasks
   * (stale counter). Retries give it a chance to advance; if all retries
   * fail, falls back to creating the task without a parent so the feedback
   * flow is not broken.
   */
  private async createBeadTaskWithRetry(
    repoPath: string,
    title: string,
    options: { type: string; priority: number; parentId?: string },
  ): Promise<BeadsIssue | null> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.beadsService.create(repoPath, title, options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isUniqueConstraint = msg.includes('UNIQUE constraint failed');

        if (!isUniqueConstraint) {
          throw err;
        }

        if (attempt < MAX_RETRIES) {
          console.warn(
            `[feedback] UNIQUE constraint on attempt ${attempt + 1}/${MAX_RETRIES + 1} ` +
            `for "${title}", retrying after delay...`,
          );
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }

        // All retries with parent exhausted; try without parent as fallback
        if (options.parentId) {
          console.warn(
            `[feedback] UNIQUE constraint persists under parent ${options.parentId}, ` +
            `creating standalone task: "${title}"`,
          );
          try {
            return await this.beadsService.create(repoPath, title, {
              ...options,
              parentId: undefined,
            });
          } catch (fallbackErr) {
            console.error(
              `[feedback] Standalone fallback also failed for "${title}":`,
              fallbackErr,
            );
            return null;
          }
        }

        console.error(`[feedback] UNIQUE constraint with no parent fallback for "${title}"`);
        return null;
      }
    }

    return null;
  }

  private async saveFeedback(projectId: string, item: FeedbackItem): Promise<void> {
    const feedbackDir = await this.getFeedbackDir(projectId);
    await writeJsonAtomic(path.join(feedbackDir, `${item.id}.json`), item);
  }

  /**
   * Retry categorization for all feedback items still in 'pending' status.
   * Called on server startup to recover from failed/interrupted categorizations.
   * Returns the number of items retried.
   */
  async retryPendingCategorizations(projectId: string): Promise<number> {
    const items = await this.listFeedback(projectId);
    const pending = items.filter((item) => item.status === 'pending');
    if (pending.length === 0) return 0;

    console.log(`[feedback] Retrying categorization for ${pending.length} pending feedback item(s)`);
    for (const item of pending) {
      this.categorizeFeedback(projectId, item).catch((err) => {
        console.error(`[feedback] Retry failed for ${item.id}:`, err);
      });
    }
    return pending.length;
  }

  /**
   * Re-categorize a single feedback item (resets to pending first).
   * Used for manual retry from the UI.
   */
  async recategorizeFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    const item = await this.getFeedback(projectId, feedbackId);
    item.status = 'pending';
    item.category = 'bug';
    item.mappedPlanId = null;
    item.createdTaskIds = [];
    item.taskTitles = undefined;
    await this.saveFeedback(projectId, item);

    this.categorizeFeedback(projectId, item).catch((err) => {
      console.error(`[feedback] Recategorize failed for ${item.id}:`, err);
    });

    return item;
  }

  /** Get a single feedback item */
  async getFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    const feedbackDir = await this.getFeedbackDir(projectId);
    try {
      const data = await fs.readFile(path.join(feedbackDir, `${feedbackId}.json`), 'utf-8');
      return JSON.parse(data) as FeedbackItem;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === 'ENOENT') {
        throw new AppError(404, ErrorCodes.FEEDBACK_NOT_FOUND, `Feedback '${feedbackId}' not found`, { feedbackId });
      }
      throw err;
    }
  }
}
