import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { FeedbackItem, FeedbackSubmitRequest, FeedbackCategory, PrdSectionKey } from '@opensprint/shared';
import { OPENSPRINT_PATHS } from '@opensprint/shared';
import { ProjectService } from './project.service.js';
import { AgentClient } from './agent-client.js';
import { PrdService } from './prd.service.js';
import { BeadsService } from './beads.service.js';
import { HilService } from './hil-service.js';
import { broadcastToProject } from '../websocket/index.js';

const FEEDBACK_CATEGORIZATION_PROMPT = `You are an AI assistant that categorizes user feedback about a software product.

Given the user's feedback text, determine:
1. The category: "bug" (something broken), "feature" (new capability request), "ux" (usability improvement), or "scope" (fundamental change to requirements)
2. Which feature/plan it relates to (if identifiable)
3. A suggested title for a task to address it

Respond in JSON format:
{
  "category": "bug" | "feature" | "ux" | "scope",
  "suggestedTitle": "Short task title",
  "suggestedDescription": "Detailed task description",
  "mappedPlanId": "plan-id-if-identifiable or null"
}`;

export class FeedbackService {
  private projectService = new ProjectService();
  private agentClient = new AgentClient();
  private prdService = new PrdService();
  private beads = new BeadsService();
  private hilService = new HilService();

  /** Resolve plan ID (e.g. "user-auth") to bead epic ID for discovered-from dependency */
  private async resolvePlanIdToBeadEpicId(
    repoPath: string,
    planId: string,
  ): Promise<string | null> {
    try {
      const metaPath = path.join(repoPath, OPENSPRINT_PATHS.plans, `${planId}.meta.json`);
      const data = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(data) as { beadEpicId?: string };
      return meta.beadEpicId && meta.beadEpicId.trim() ? meta.beadEpicId : null;
    } catch {
      return null;
    }
  }

  /** Get feedback directory for a project */
  private async getFeedbackDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.feedback);
  }

  /** Atomic JSON write */
  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
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

  /** Submit new feedback with AI categorization and task creation */
  async submitFeedback(
    projectId: string,
    body: FeedbackSubmitRequest,
  ): Promise<FeedbackItem> {
    const feedbackDir = await this.getFeedbackDir(projectId);
    await fs.mkdir(feedbackDir, { recursive: true });
    const id = uuid();

    // Create initial feedback item
    const item: FeedbackItem = {
      id,
      text: body.text,
      category: 'bug', // Default, will be updated by AI
      mappedPlanId: null,
      createdTaskIds: [],
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    // Save immediately
    await this.writeJson(path.join(feedbackDir, `${id}.json`), item);

    // Invoke planning agent for categorization (async)
    this.categorizeFeedback(projectId, item).catch((err) => {
      console.error(`Failed to categorize feedback ${id}:`, err);
    });

    return item;
  }

  /** AI categorization and task creation */
  private async categorizeFeedback(projectId: string, item: FeedbackItem): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const project = await this.projectService.getProject(projectId);

    try {
      const response = await this.agentClient.invoke({
        config: settings.planningAgent,
        prompt: `Categorize this feedback:\n\n"${item.text}"`,
        systemPrompt: FEEDBACK_CATEGORIZATION_PROMPT,
        cwd: project.repoPath,
      });

      // Parse AI response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        item.category = parsed.category as FeedbackCategory;
        item.mappedPlanId = parsed.mappedPlanId || null;

        // Handle scope changes with HIL
        if (item.category === 'scope') {
          const { approved } = await this.hilService.evaluateDecision(
            projectId,
            'scopeChanges',
            `Scope change feedback: "${item.text}"`,
          );

          if (!approved) {
            item.status = 'mapped';
            await this.saveFeedback(projectId, item);
            return;
          }
        }

        // Create a beads task from the feedback
        const taskResult = await this.beads.create(project.repoPath, parsed.suggestedTitle || item.text.slice(0, 80), {
          type: item.category === 'bug' ? 'bug' : 'task',
          description: parsed.suggestedDescription || item.text,
          priority: item.category === 'bug' ? 1 : 2,
        });

        if (item.mappedPlanId) {
          // Resolve plan ID to bead epic ID for discovered-from dependency (PRD §14)
          const beadEpicId = await this.resolvePlanIdToBeadEpicId(
            project.repoPath,
            item.mappedPlanId,
          );
          if (beadEpicId) {
            await this.beads.addDependency(
              project.repoPath,
              taskResult.id,
              beadEpicId,
              'discovered-from',
            );
          }
        }

        item.createdTaskIds = [taskResult.id];
        item.status = 'mapped';

        // Broadcast feedback mapping
        broadcastToProject(projectId, {
          type: 'feedback.mapped',
          feedbackId: item.id,
          planId: item.mappedPlanId || '',
          taskIds: item.createdTaskIds,
        });
      }
    } catch (error) {
      console.error(`AI categorization failed for feedback ${item.id}:`, error);
      item.status = 'mapped';
    }

    await this.saveFeedback(projectId, item);
  }

  private async saveFeedback(projectId: string, item: FeedbackItem): Promise<void> {
    const feedbackDir = await this.getFeedbackDir(projectId);
    await this.writeJson(path.join(feedbackDir, `${item.id}.json`), item);
  }

  /** Get a single feedback item */
  async getFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    const feedbackDir = await this.getFeedbackDir(projectId);
    const data = await fs.readFile(path.join(feedbackDir, `${feedbackId}.json`), 'utf-8');
    return JSON.parse(data) as FeedbackItem;
  }
}
