import fs from "fs/promises";
import path from "path";
import type {
  FeedbackItem,
  FeedbackSubmitRequest,
  FeedbackCategory,
  ProposedTask,
} from "@opensprint/shared";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { ProjectService } from "./project.service.js";
import { agentService } from "./agent.service.js";
import { hilService } from "./hil-service.js";
import { ChatService } from "./chat.service.js";
import { PlanService } from "./plan.service.js";
import { PrdService } from "./prd.service.js";
import type { HarmonizerPrdUpdate } from "./harmonizer.service.js";
import { BeadsService, type BeadsIssue } from "./beads.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { generateShortFeedbackId } from "../utils/feedback-id.js";
import { triggerDeploy } from "./deploy-trigger.service.js";

/**
 * Build a user-friendly description for scope change HIL approval (PRD §6.5.1).
 * Prompts the user clearly about what they are being asked to approve.
 */
function buildScopeChangeHilDescription(feedbackText: string): string {
  const truncated = feedbackText.length > 200 ? `${feedbackText.slice(0, 200)}…` : feedbackText;
  return `A user submitted feedback that was categorized as a scope change. Please review the proposed PRD updates below and approve or reject.

User feedback: "${truncated}"`;
}

const FEEDBACK_CATEGORIZATION_PROMPT = `You are an AI assistant that categorizes user feedback about a software product (PRD §12.3.4 Analyst contract).

Given the user's feedback text, the PRD (Product Requirements Document), and available plans, determine:
1. The category: "bug" (something broken), "feature" (new capability request), "ux" (usability improvement), or "scope" (fundamental change to requirements)
2. Which feature/plan it relates to (if identifiable) — use the planId from the available plans list
3. The mapped epic ID — use the beadEpicId from the plan you mapped to (or null if no plan)
4. Whether this is a scope change — true if the feedback fundamentally alters requirements/PRD; false otherwise
5. Proposed tasks in indexed Planner format — same structure as Planner output: index, title, description, priority, depends_on

Respond in JSON format:
{
  "category": "bug" | "feature" | "ux" | "scope",
  "mapped_plan_id": "plan-id-if-identifiable or null",
  "mapped_epic_id": "beadEpicId-from-plan or null",
  "is_scope_change": true | false,
  "proposed_tasks": [
    { "index": 0, "title": "Task title", "description": "Detailed spec with acceptance criteria", "priority": 1, "depends_on": [] },
    { "index": 1, "title": "Another task", "description": "...", "priority": 2, "depends_on": [0] }
  ]
}

priority: 0 (highest) to 4 (lowest). depends_on: array of task indices (0-based) this task is blocked by. Use a single task when feedback addresses one concern; use multiple only when clearly independent.`;

export class FeedbackService {
  private projectService = new ProjectService();
  private hilService = hilService;
  private chatService = new ChatService();
  private planService = new PlanService();
  private prdService = new PrdService();
  private beadsService = new BeadsService();

  /** Generate a unique 6-char alphanumeric feedback ID; retries on collision */
  private async generateUniqueFeedbackId(feedbackDir: string): Promise<string> {
    const MAX_RETRIES = 10;
    for (let i = 0; i < MAX_RETRIES; i++) {
      const id = generateShortFeedbackId();
      const filePath = path.join(feedbackDir, `${id}.json`);
      try {
        await fs.access(filePath);
      } catch {
        return id;
      }
    }
    throw new Error("Failed to generate unique feedback ID after retries");
  }

  /** Get feedback directory for a project */
  private async getFeedbackDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.feedback);
  }

  /** List all feedback items. Normalizes legacy items to include parent_id and depth (PRD §7.4.1). */
  async listFeedback(projectId: string): Promise<FeedbackItem[]> {
    const feedbackDir = await this.getFeedbackDir(projectId);
    const items: FeedbackItem[] = [];

    try {
      const files = await fs.readdir(feedbackDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const data = await fs.readFile(path.join(feedbackDir, file), "utf-8");
          const item = JSON.parse(data) as FeedbackItem;
          // Ensure parent_id and depth for client tree building (legacy items may lack these)
          if (item.parent_id === undefined) item.parent_id = null;
          if (item.depth === undefined) item.depth = 0;
          items.push(item);
        }
      }
    } catch {
      // No feedback yet
    }

    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Submit new feedback with AI categorization and mapping */
  async submitFeedback(projectId: string, body: FeedbackSubmitRequest): Promise<FeedbackItem> {
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Feedback text is required");
    }
    const feedbackDir = await this.getFeedbackDir(projectId);
    await fs.mkdir(feedbackDir, { recursive: true });
    const id = await this.generateUniqueFeedbackId(feedbackDir);

    // Validate parent_id when creating a reply (PRD §7.4.1)
    const parentId =
      typeof body?.parent_id === "string" && body.parent_id.trim() ? body.parent_id.trim() : null;
    let parent: FeedbackItem | null = null;
    let depth = 0;
    if (parentId) {
      try {
        parent = await this.getFeedback(projectId, parentId);
        depth = (parent.depth ?? 0) + 1;
      } catch {
        throw new AppError(
          404,
          ErrorCodes.FEEDBACK_NOT_FOUND,
          `Parent feedback '${parentId}' not found`,
          {
            feedbackId: parentId,
          }
        );
      }
    }

    // Validate and normalize image attachments (base64 strings)
    const images: string[] = [];
    if (Array.isArray(body?.images)) {
      for (const img of body.images) {
        if (typeof img === "string" && img.length > 0) {
          // Accept data URLs (data:image/...;base64,...) or raw base64
          const base64 = img.startsWith("data:") ? img : `data:image/png;base64,${img}`;
          images.push(base64);
        }
      }
    }

    // Create initial feedback item (PRD §7.4.1: parent_id null for top-level, depth 0)
    const item: FeedbackItem = {
      id,
      text,
      category: "bug", // Default, will be updated by AI
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
      ...(images.length > 0 && { images }),
      parent_id: parentId ?? null,
      depth,
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
        "executive_summary",
        "feature_list",
        "technical_architecture",
        "data_model",
      ] as const;
      for (const key of keys) {
        const section = sections[key];
        if (section?.content?.trim()) {
          parts.push(`## ${key}\n${section.content.trim()}`);
        }
      }
      if (parts.length === 0) return "No PRD content available.";
      return `# PRD (Product Requirements Document)\n\n${parts.join("\n\n")}`;
    } catch {
      return "No PRD available.";
    }
  }

  /** Build plan context for AI mapping (planId, beadEpicId, title from first heading) */
  private async getPlanContextForCategorization(projectId: string): Promise<string> {
    try {
      const plans = await this.planService.listPlans(projectId);
      if (plans.length === 0)
        return "No plans exist yet. Use mapped_plan_id: null, mapped_epic_id: null.";
      const lines = plans.map((p) => {
        const title =
          p.content
            .split("\n")[0]
            ?.replace(/^#+\s*/, "")
            .trim() || p.metadata.planId;
        const epicId = p.metadata.beadEpicId ?? "";
        return `- ${p.metadata.planId} (beadEpicId: ${epicId || "none"}): ${title}`;
      });
      return `Available plans (use planId for mapped_plan_id, beadEpicId for mapped_epic_id):\n${lines.join("\n")}`;
    } catch {
      return "No plans available. Use mapped_plan_id: null, mapped_epic_id: null.";
    }
  }

  /** AI categorization, mapping, and bead task creation */
  private async categorizeFeedback(projectId: string, item: FeedbackItem): Promise<void> {
    await this.categorizeFeedbackImpl(projectId, item);
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

    // Build parent context for replies (PRD §7.4.1: agent receives parent content, category, metadata)
    let parentContext = "";
    if (item.parent_id) {
      try {
        const parentItem = await this.getFeedback(projectId, item.parent_id);
        parentContext = `\n\n# Parent feedback (this is a reply)\n\nParent content: "${parentItem.text}"\nParent category: ${parentItem.category}\nParent mappedPlanId: ${parentItem.mappedPlanId ?? "null"}\n`;
      } catch {
        // Parent not found — proceed without parent context
      }
    }

    const agentId = `feedback-categorize-${projectId}-${item.id}-${Date.now()}`;
    try {
      const response = await agentService.invokePlanningAgent({
        config: settings.planningAgent,
        messages: [
          {
            role: "user",
            content: `# PRD\n\n${prdContext}\n\n# Plans\n\n${planContext}${parentContext}\n\n# Feedback to categorize\n\n"${item.text}"`,
          },
        ],
        systemPrompt: FEEDBACK_CATEGORIZATION_PROMPT,
        cwd: project.repoPath,
        tracking: {
          id: agentId,
          projectId,
          phase: "eval",
          role: "analyst",
          label: "Feedback categorization",
        },
      });

      // Parse AI response; fallback: default to bug, map to first plan (PRD §7.4.2 edge case)
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const validCategories: FeedbackCategory[] = ["bug", "feature", "ux", "scope"];
        item.category = validCategories.includes(parsed.category)
          ? (parsed.category as FeedbackCategory)
          : "bug";
        item.mappedPlanId = parsed.mapped_plan_id ?? parsed.mappedPlanId ?? firstPlanId;

        // mapped_epic_id: resolve from Plan beadEpicId if not provided (PRD §12.3.4)
        const rawMappedEpicId = parsed.mapped_epic_id ?? parsed.mappedEpicId;
        if (typeof rawMappedEpicId === "string" && rawMappedEpicId.trim()) {
          item.mappedEpicId = rawMappedEpicId.trim();
        } else if (item.mappedPlanId) {
          try {
            const plan = await this.planService.getPlan(projectId, item.mappedPlanId);
            if (plan.metadata.beadEpicId) {
              item.mappedEpicId = plan.metadata.beadEpicId;
            }
          } catch {
            // Plan not found — leave mappedEpicId unset
          }
        }

        // is_scope_change: explicit flag (PRD §12.3.4)
        item.isScopeChange =
          typeof parsed.is_scope_change === "boolean"
            ? parsed.is_scope_change
            : item.category === "scope";

        // proposed_tasks: full Planner format; fallback to task_titles / suggestedTitle (legacy)
        const rawProposed = parsed.proposed_tasks ?? parsed.proposedTasks;
        if (Array.isArray(rawProposed) && rawProposed.length > 0) {
          const tasks: ProposedTask[] = rawProposed
            .filter(
              (t: unknown) =>
                t && typeof t === "object" && typeof (t as { title?: unknown }).title === "string"
            )
            .map(
              (t: {
                index?: number;
                title: string;
                description?: string;
                priority?: number;
                depends_on?: number[];
              }) => ({
                index: typeof t.index === "number" ? t.index : 0,
                title: String(t.title),
                description: typeof t.description === "string" ? t.description : "",
                priority: typeof t.priority === "number" ? t.priority : 2,
                depends_on: Array.isArray(t.depends_on)
                  ? t.depends_on.filter((d): d is number => typeof d === "number")
                  : [],
              })
            );
          if (tasks.length > 0) {
            item.proposedTasks = tasks;
            item.taskTitles = tasks.map((t) => t.title);
          }
        }
        if (!item.proposedTasks?.length) {
          item.taskTitles = Array.isArray(parsed.task_titles)
            ? parsed.task_titles.filter((t: unknown) => typeof t === "string")
            : parsed.suggestedTitle
              ? [String(parsed.suggestedTitle)]
              : [item.text.slice(0, 80)];
        }

        // Handle scope changes with HIL (PRD §7.4.2, §15.1) — category=scope OR is_scope_change=true
        if (item.category === "scope" || item.isScopeChange) {
          // Get AI-generated proposal for modal summary (before HIL)
          let proposal: { summary: string; prdUpdates: HarmonizerPrdUpdate[] } | null = null;
          try {
            proposal = await this.chatService.getScopeChangeProposal(projectId, item.text);
          } catch (err) {
            console.warn("[feedback] Could not get scope-change proposal for modal:", err);
          }

          const scopeChangeMetadata = proposal
            ? {
                scopeChangeSummary: proposal.summary,
                scopeChangeProposedUpdates: proposal.prdUpdates.map((u) => ({
                  section: u.section,
                  changeLogEntry: u.changeLogEntry,
                })),
              }
            : undefined;

          const scopeChangeDescription = buildScopeChangeHilDescription(item.text);
          const scopeChangeOptions = [
            { id: "approve", label: "Approve", description: "Apply the proposed PRD updates" },
            {
              id: "reject",
              label: "Reject",
              description: "Skip updates and do not modify the PRD",
            },
          ];
          const { approved } = await this.hilService.evaluateDecision(
            projectId,
            "scopeChanges",
            scopeChangeDescription,
            scopeChangeOptions,
            true,
            scopeChangeMetadata
          );

          if (!approved) {
            item.status = "mapped";
            await this.saveFeedback(projectId, item);
            broadcastToProject(projectId, {
              type: "feedback.mapped",
              feedbackId: item.id,
              planId: item.mappedPlanId || "",
              taskIds: item.createdTaskIds,
            });
            return;
          }

          // After HIL approval, apply the PRD updates (reuse proposal to avoid duplicate Harmonizer call)
          try {
            if (proposal?.prdUpdates?.length) {
              await this.chatService.applyScopeChangeUpdates(
                projectId,
                proposal.prdUpdates,
                `Scope change feedback: "${item.text.slice(0, 80)}${item.text.length > 80 ? "…" : ""}"`
              );
            } else {
              await this.chatService.syncPrdFromScopeChangeFeedback(projectId, item.text);
            }
          } catch (err) {
            console.error("[feedback] PRD sync on scope-change approval failed:", err);
          }
        }
      } else {
        // Parse failed: default to bug, map to first plan
        item.category = "bug";
        item.mappedPlanId = firstPlanId;
        item.taskTitles = [item.text.slice(0, 80)];
      }
    } catch (error) {
      console.error(`AI categorization failed for feedback ${item.id}:`, error);
      item.category = "bug";
      item.mappedPlanId = firstPlanId;
      item.taskTitles = [item.text.slice(0, 80)];
    }

    // Create beads tasks from the generated task titles (best-effort)
    try {
      item.createdTaskIds = await this.createBeadTasksFromFeedback(projectId, item);
    } catch (err) {
      console.error(`[feedback] Failed to create beads tasks for ${item.id}:`, err);
    }
    item.status = "mapped";

    await this.saveFeedback(projectId, item);

    broadcastToProject(projectId, {
      type: "feedback.mapped",
      feedbackId: item.id,
      planId: item.mappedPlanId || "",
      taskIds: item.createdTaskIds,
    });
  }

  /**
   * Map feedback category to beads issue type (PRD §14).
   * bug → bug, feature → feature, ux → task.
   */
  private categoryToBeadType(category: FeedbackCategory): "bug" | "feature" | "task" {
    switch (category) {
      case "bug":
        return "bug";
      case "feature":
        return "feature";
      case "ux":
      case "scope":
      default:
        return "task";
    }
  }

  /** Create beads tasks from feedback — uses proposed_tasks (PRD §12.3.4) or task_titles (legacy) */
  private async createBeadTasksFromFeedback(
    projectId: string,
    item: FeedbackItem
  ): Promise<string[]> {
    const proposedTasks = item.proposedTasks ?? [];
    const taskTitles = item.taskTitles ?? [];
    const hasProposed = proposedTasks.length > 0;
    const hasTitles = taskTitles.length > 0;
    if (!hasProposed && !hasTitles) return [];

    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;

    // Resolve parent epic: mappedEpicId (from AI or plan) or look up from plan (PRD §12.3.4)
    let parentEpicId: string | undefined;
    if (item.mappedEpicId) {
      parentEpicId = item.mappedEpicId;
    } else if (item.mappedPlanId) {
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
      const sourceTitle = `Feedback: ${item.text.slice(0, 60)}${item.text.length > 60 ? "…" : ""}`;
      const sourceBead = await this.beadsService.create(repoPath, sourceTitle, {
        type: "chore",
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
    const taskIdMap = new Map<number, string>();

    if (hasProposed) {
      // Create tasks from proposed_tasks (Planner format) with description, priority, depends_on
      const sorted = [...proposedTasks].sort((a, b) => a.index - b.index);
      for (const task of sorted) {
        try {
          const priority = task.priority ?? (item.category === "bug" ? 0 : 2);
          const issue = await this.createBeadTaskWithRetry(repoPath, task.title, {
            type: beadType,
            priority,
            description: task.description || undefined,
            parentId: parentEpicId,
          });
          if (issue) {
            createdIds.push(issue.id);
            taskIdMap.set(task.index, issue.id);

            if (feedbackSourceBeadId) {
              try {
                await this.beadsService.addDependency(
                  repoPath,
                  issue.id,
                  feedbackSourceBeadId,
                  "discovered-from"
                );
              } catch (depErr) {
                console.error(`[feedback] Failed to add discovered-from for ${issue.id}:`, depErr);
              }
            }
          }
        } catch (err) {
          console.error(`[feedback] Failed to create beads task "${task.title}":`, err);
        }
      }

      // Add inter-task blocks dependencies (depends_on indices → bead IDs)
      for (const task of sorted) {
        const childId = taskIdMap.get(task.index);
        const deps = task.depends_on ?? [];
        if (childId) {
          for (const depIdx of deps) {
            const parentId = taskIdMap.get(depIdx);
            if (parentId) {
              try {
                await this.beadsService.addDependency(repoPath, childId, parentId);
              } catch (depErr) {
                console.error(
                  `[feedback] Failed to add blocks dep ${childId} -> ${parentId}:`,
                  depErr
                );
              }
            }
          }
        }
      }
    } else {
      // Legacy: create from task_titles only
      for (const title of taskTitles) {
        try {
          const issue = await this.createBeadTaskWithRetry(repoPath, title, {
            type: beadType,
            priority: item.category === "bug" ? 0 : 2,
            parentId: parentEpicId,
          });
          if (issue) {
            createdIds.push(issue.id);
            if (feedbackSourceBeadId) {
              try {
                await this.beadsService.addDependency(
                  repoPath,
                  issue.id,
                  feedbackSourceBeadId,
                  "discovered-from"
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
    options: { type: string; priority: number; description?: string; parentId?: string }
  ): Promise<BeadsIssue | null> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.beadsService.create(repoPath, title, options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isUniqueConstraint = msg.includes("UNIQUE constraint failed");

        if (!isUniqueConstraint) {
          throw err;
        }

        if (attempt < MAX_RETRIES) {
          console.warn(
            `[feedback] UNIQUE constraint on attempt ${attempt + 1}/${MAX_RETRIES + 1} ` +
              `for "${title}", retrying after delay...`
          );
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }

        // All retries with parent exhausted; try without parent as fallback
        if (options.parentId) {
          console.warn(
            `[feedback] UNIQUE constraint persists under parent ${options.parentId}, ` +
              `creating standalone task: "${title}"`
          );
          try {
            return await this.beadsService.create(repoPath, title, {
              ...options,
              parentId: undefined,
            });
          } catch (fallbackErr) {
            console.error(
              `[feedback] Standalone fallback also failed for "${title}":`,
              fallbackErr
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
    const pending = items.filter((item) => item.status === "pending");
    if (pending.length === 0) return 0;

    console.log(
      `[feedback] Retrying categorization for ${pending.length} pending feedback item(s)`
    );
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
    item.status = "pending";
    item.category = "bug";
    item.mappedPlanId = null;
    item.mappedEpicId = undefined;
    item.isScopeChange = undefined;
    item.createdTaskIds = [];
    item.taskTitles = undefined;
    item.proposedTasks = undefined;
    await this.saveFeedback(projectId, item);

    this.categorizeFeedback(projectId, item).catch((err) => {
      console.error(`[feedback] Recategorize failed for ${item.id}:`, err);
    });

    return item;
  }

  /**
   * Check if any mapped feedback items should be auto-resolved after a task is closed.
   * PRD §10.2: When all created tasks from feedback are Done and autoResolveFeedbackOnTaskCompletion is enabled,
   * auto-resolve the feedback item.
   */
  async checkAutoResolveOnTaskDone(projectId: string, closedTaskId: string): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    if (!settings.deployment.autoResolveFeedbackOnTaskCompletion) {
      return;
    }

    const items = await this.listFeedback(projectId);
    const candidates = items.filter(
      (i) =>
        i.status === "mapped" &&
        i.createdTaskIds.length > 0 &&
        i.createdTaskIds.includes(closedTaskId)
    );
    if (candidates.length === 0) return;

    const project = await this.projectService.getProject(projectId);
    const allIssues = await this.beadsService.listAll(project.repoPath);
    const idToStatus = new Map(allIssues.map((i) => [i.id, (i.status as string) ?? "open"]));

    for (const item of candidates) {
      const allClosed = item.createdTaskIds.every((tid) => idToStatus.get(tid) === "closed");
      if (allClosed) {
        await this.resolveFeedback(projectId, item.id);
      }
    }
  }

  /**
   * Resolve a feedback item (status -> resolved).
   * PRD §7.5.3: When all critical feedback (bugs) are resolved and autoDeployOnEvalResolution is enabled,
   * auto-triggers deployment.
   */
  async resolveFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    const item = await this.getFeedback(projectId, feedbackId);
    if (item.status === "resolved") {
      return item;
    }
    item.status = "resolved";
    await this.saveFeedback(projectId, item);

    broadcastToProject(projectId, {
      type: "feedback.resolved",
      feedbackId: item.id,
    });

    // PRD §7.5.3: Auto-deploy on eval resolution — when all critical (bug) feedback resolved
    const items = await this.listFeedback(projectId);
    const criticalItems = items.filter((i) => i.category === "bug");
    const allCriticalResolved =
      criticalItems.length > 0 && criticalItems.every((i) => i.status === "resolved");

    if (allCriticalResolved) {
      const settings = await this.projectService.getSettings(projectId);
      if (settings.deployment.autoDeployOnEvalResolution) {
        triggerDeploy(projectId).catch((err) => {
          console.warn(`[feedback] Auto-deploy on eval resolution failed for ${projectId}:`, err);
        });
      }
    }

    return item;
  }

  /** Get a single feedback item. Normalizes legacy items (parent_id, depth). */
  async getFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    const feedbackDir = await this.getFeedbackDir(projectId);
    try {
      const data = await fs.readFile(path.join(feedbackDir, `${feedbackId}.json`), "utf-8");
      const item = JSON.parse(data) as FeedbackItem;
      if (item.parent_id === undefined) item.parent_id = null;
      if (item.depth === undefined) item.depth = 0;
      return item;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        throw new AppError(
          404,
          ErrorCodes.FEEDBACK_NOT_FOUND,
          `Feedback '${feedbackId}' not found`,
          { feedbackId }
        );
      }
      throw err;
    }
  }
}
