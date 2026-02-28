import crypto from "crypto";
import type {
  FeedbackItem,
  FeedbackSubmitRequest,
  FeedbackCategory,
  ProposedTask,
} from "@opensprint/shared";
import { getAgentForPlanningRole, clampTaskComplexity } from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { ProjectService } from "./project.service.js";
import { agentService } from "./agent.service.js";
import { hilService } from "./hil-service.js";
import { ChatService } from "./chat.service.js";
import { PlanService } from "./plan.service.js";
import { PrdService } from "./prd.service.js";
import type { HarmonizerPrdUpdate } from "./harmonizer.service.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { planComplexityToTask } from "./plan-complexity.js";
import { feedbackStore } from "./feedback-store.service.js";
import { writeFeedbackImages } from "./feedback-store.service.js";
import { notificationService } from "./notification.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { JSON_OUTPUT_PREAMBLE } from "../utils/agent-prompts.js";
import { triggerDeployForEvent } from "./deploy-trigger.service.js";
import { buildAutonomyDescription } from "./context-assembler.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("feedback");

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

${JSON_OUTPUT_PREAMBLE}

**Category guide:** bug = broken/incorrect behavior; feature = new capability request; ux = usability/copy/layout improvement; scope = fundamental requirement change requiring PRD update.

**Fail-early when feedback is too vague:** When the feedback is too vague, ambiguous, or insufficient to categorize or create tasks (e.g. single word, unclear intent, missing context), return a non-empty \`open_questions\` array instead of categorizing. Do NOT create tasks or link to existing. The user will answer these questions before the Analyst proceeds. Use open_questions only when you genuinely cannot proceed; otherwise categorize normally.

**Plan/epic association:** Associate feedback to a plan/epic ONLY when there is a VERY CLEAR link. When feedback does not clearly map to work in an existing plan/epic, use mapped_plan_id: null and mapped_epic_id: null. In that case, proposed_tasks create top-level (standalone) tasks — do not force feedback into an existing plan when the link is ambiguous.

Given the user's feedback (and any attached images), the PRD, available plans, and **Existing OPEN tasks**, determine:
1. The category: "bug" | "feature" | "ux" | "scope"
2. Which feature/plan it relates to (if clearly identifiable) — use the planId from the available plans list, or null when the link is not clear
3. The mapped epic ID — use the epicId from the plan you mapped to (or null if no plan or link unclear)
4. Whether this is a scope change — true if the feedback fundamentally alters requirements/PRD; false otherwise
5. Proposed tasks in indexed Planner format — same structure as Planner output: index, title, description, priority, depends_on, complexity (integer 1-10 — assign per task based on implementation difficulty, 1=simplest, 10=most complex). When mapped_plan_id is null, create top-level tasks (no parent epic).

**Linking to existing tasks:** When feedback is clearly covered by one or more existing OPEN tasks, prefer linking instead of creating new tasks:
- \`link_to_existing_task_ids\`: string[]. If non-empty, do NOT create new tasks; link feedback to these existing task IDs. All IDs must appear in the Existing OPEN/READY tasks list.
- \`similar_existing_task_id\`: string | null. Return a task ID only when feedback clearly adds to or refines the same work (single task). Otherwise null. When set, it is equivalent to link_to_existing_task_ids: [id].
- \`update_existing_tasks\`: Record<taskId, { title?: string, description?: string }>. Keys are task IDs from link_to_existing_task_ids. Apply these updates before linking (e.g. refine title/description when feedback improves the task).
- Rule: if link_to_existing_task_ids is non-empty (or similar_existing_task_id is set), ignore proposed_tasks.

When feedback lacks a clear plan/epic link, use mapped_plan_id: null, mapped_epic_id: null and propose_tasks as top-level (standalone) tasks. For proposed_tasks: use a single task when feedback addresses one concern; use multiple only when feedback clearly describes distinct work items.

For replies (parent_id present), consider the parent's category and mapped plan — the reply often refines or adds to the parent. If the feedback is a single word or too vague to categorize, default to "ux" and propose_tasks: [] with a generic title.

**Reply-derived complexity:** When feedback is a reply (parent_id present), always set complexity to 7 for every proposed task. Rationale: a reply indicates the default agent could not resolve it, so the work merits a higher-complexity agent.

JSON format:
{
  "category": "bug" | "feature" | "ux" | "scope",
  "mapped_plan_id": "plan-id-if-identifiable or null",
  "mapped_epic_id": "epicId-from-plan or null",
  "is_scope_change": true | false,
  "proposed_tasks": [
    { "index": 0, "title": "Task title", "description": "Detailed spec with acceptance criteria", "priority": 1, "depends_on": [], "complexity": 3 }
  ],
  "link_to_existing_task_ids": ["task-id-1", "task-id-2"],
  "similar_existing_task_id": "task-id or null",
  "update_existing_tasks": { "task-id": { "title": "...", "description": "..." } },
  "open_questions": [{ "id": "q1", "text": "Clarification question..." }]
}

When feedback is too vague: return non-empty open_questions in the standard protocol format: [{ "id": "q1", "text": "Clarification question..." }]. The server surfaces these via the Human Notification System. Do not set proposed_tasks or link_to_existing_task_ids. When open_questions is non-empty, the system will not create tasks or link to existing. Omit open_questions (or use empty array) when you can categorize normally.

priority: 0 (highest) to 4 (lowest). depends_on: array of task indices (0-based) this task is blocked by. complexity: integer 1-10 (1=simplest, 10=most complex) — assign per task based on implementation difficulty.`;

export class FeedbackService {
  private projectService = new ProjectService();
  private hilService = hilService;
  private chatService = new ChatService();
  private planService = new PlanService();
  private prdService = new PrdService();
  private taskStore = taskStoreSingleton;

  /**
   * Enqueue a feedback item for Analyst processing (Gastown-style mailbox).
   * Does not run the Analyst; the orchestrator will process the queue.
   */
  async enqueueForCategorization(projectId: string, feedbackId: string): Promise<void> {
    await feedbackStore.enqueueForCategorization(projectId, feedbackId);
  }

  /** Get the next feedback ID in the inbox (FIFO). Does not remove it. */
  async getNextPendingFeedbackId(projectId: string): Promise<string | null> {
    return feedbackStore.getNextPendingFeedbackId(projectId);
  }

  /**
   * Atomically claim and remove the next pending feedback from the inbox.
   * Use this in the orchestrator to prevent duplicate processing when multiple loop runs race.
   */
  async claimNextPendingFeedbackId(projectId: string): Promise<string | null> {
    return feedbackStore.claimNextPendingFeedbackId(projectId);
  }

  /**
   * Remove a feedback ID from the inbox (ack). Call only after successful processing.
   */
  async removeFromInbox(projectId: string, feedbackId: string): Promise<void> {
    await feedbackStore.removeFromInbox(projectId, feedbackId);
  }

  /** List feedback IDs currently in the inbox (for status/UI). */
  async listPendingFeedbackIds(projectId: string): Promise<string[]> {
    return feedbackStore.listPendingFeedbackIds(projectId);
  }

  /**
   * Run the Analyst on one feedback item. Used by the orchestrator.
   * Caller must have already claimed the feedback via claimNextPendingFeedbackId (atomic claim
   * prevents duplicate processing). Skips feedback that already has at least one linked task.
   * Re-enqueues on failure for retry.
   */
  async processFeedbackWithAnalyst(projectId: string, feedbackId: string): Promise<void> {
    const item = await this.getFeedback(projectId, feedbackId);
    if ((item.createdTaskIds?.length ?? 0) > 0) {
      return;
    }
    try {
      await this.categorizeFeedbackImpl(projectId, item);
    } catch (err) {
      // Re-enqueue for retry so the feedback is not lost
      await this.enqueueForCategorization(projectId, feedbackId);
      throw err;
    }
  }

  async listFeedback(projectId: string): Promise<FeedbackItem[]>;
  async listFeedback(
    projectId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FeedbackItem[] | { items: FeedbackItem[]; total: number }>;
  async listFeedback(
    projectId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<FeedbackItem[] | { items: FeedbackItem[]; total: number }> {
    return feedbackStore.listFeedback(projectId, options);
  }

  /** Submit new feedback with AI categorization and mapping */
  async submitFeedback(projectId: string, body: FeedbackSubmitRequest): Promise<FeedbackItem> {
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Feedback text is required");
    }
    const id = await feedbackStore.generateUniqueFeedbackId(projectId);

    // Validate parent_id when creating a reply (PRD §7.4.1)
    const parentId =
      typeof body?.parent_id === "string" && body.parent_id.trim() ? body.parent_id.trim() : null;
    let depth = 0;
    if (parentId) {
      try {
        const parent = await feedbackStore.getFeedback(projectId, parentId);
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
          const base64 = img.startsWith("data:") ? img : `data:image/png;base64,${img}`;
          images.push(base64);
        }
      }
    }

    // Validate and store user-specified priority (0-4)
    const userPriority =
      typeof body?.priority === "number" && body.priority >= 0 && body.priority <= 4
        ? body.priority
        : undefined;

    const item: FeedbackItem = {
      id,
      text,
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
      parent_id: parentId ?? null,
      depth,
      ...(userPriority !== undefined && { userPriority }),
    };

    const imagePaths = images.length > 0 ? await writeFeedbackImages(projectId, id, images) : null;
    await feedbackStore.insertFeedback(projectId, item, imagePaths);
    await this.enqueueForCategorization(projectId, id);

    return feedbackStore.getFeedback(projectId, id);
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

  /** Build plan context for AI mapping (planId, epicId, title from first heading) */
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
        const epicId = p.metadata.epicId ?? "";
        return `- ${p.metadata.planId} (epicId: ${epicId || "none"}): ${title}`;
      });
      return `Available plans (use planId for mapped_plan_id, epicId for mapped_epic_id):\n${lines.join("\n")}`;
    } catch {
      return "No plans available. Use mapped_plan_id: null, mapped_epic_id: null.";
    }
  }

  /** Build open tasks context for Analyst (id, title, description excerpt). Excludes epic, chore, in_progress, closed, blocked. */
  private async getOpenTasksContextForCategorization(projectId: string): Promise<string> {
    try {
      const allTasks = await this.taskStore.listAll(projectId);
      const openLeafTasks = allTasks.filter(
        (t) =>
          (t.status as string) === "open" &&
          (t.issue_type ?? t.type) !== "epic" &&
          (t.issue_type ?? t.type) !== "chore"
      );
      if (openLeafTasks.length === 0) return "No open tasks.";
      const lines = openLeafTasks.map((t) => {
        const desc = (t.description ?? "").trim();
        const excerpt = desc.length > 200 ? `${desc.slice(0, 200)}…` : desc || "(no description)";
        return `- ${t.id}: ${t.title} — ${excerpt}`;
      });
      return `Existing OPEN tasks (leaf tasks only; use these IDs for link_to_existing_task_ids or similar_existing_task_id):\n${lines.join("\n")}`;
    } catch {
      return "No open tasks.";
    }
  }

  /**
   * Walk up the parent chain collecting ALL ancestor feedback items (oldest first).
   * Provides the Analyst with full conversation context for deeply nested replies.
   * Caps at 20 ancestors to prevent runaway chains.
   */
  private async buildParentChainContext(projectId: string, parentId: string): Promise<string> {
    const ancestors: FeedbackItem[] = [];
    let currentId: string | null = parentId;
    const MAX_ANCESTORS = 20;
    const visited = new Set<string>();

    while (currentId && ancestors.length < MAX_ANCESTORS) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      try {
        const ancestor = await this.getFeedback(projectId, currentId);
        ancestors.push(ancestor);
        currentId = ancestor.parent_id ?? null;
      } catch {
        break;
      }
    }

    if (ancestors.length === 0) return "";

    // Reverse so root ancestor is first, immediate parent is last
    ancestors.reverse();

    const count = ancestors.length;
    const lines = ancestors.map((a, i) => {
      const label = count === 1
        ? "Parent feedback"
        : `Feedback ${i + 1} of ${count} (depth ${a.depth ?? i})`;
      return `${label}:\n  Content: "${a.text}"\n  Category: ${a.category}\n  mappedPlanId: ${a.mappedPlanId ?? "null"}`;
    });

    const header = count === 1
      ? "# Parent feedback (this is a reply)"
      : `# Feedback conversation chain (this is a reply — ${count} ancestors, oldest first)`;

    return `\n\n${header}\n\n${lines.join("\n\n")}\n`;
  }

  private async categorizeFeedbackImpl(projectId: string, item: FeedbackItem): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const project = await this.projectService.getProject(projectId);
    const [prdContext, planContext, openTasksContext] = await Promise.all([
      this.getPrdContextForCategorization(projectId),
      this.getPlanContextForCategorization(projectId),
      this.getOpenTasksContextForCategorization(projectId),
    ]);

    let plans: { metadata: { planId: string } }[] = [];
    try {
      plans = await this.planService.listPlans(projectId);
    } catch {
      // Ignore
    }
    const firstPlanId = plans.length > 0 ? plans[0].metadata.planId : null;

    // Build full parent chain context for replies (PRD §7.4.1: agent receives ALL ancestor feedback)
    let parentContext = "";
    if (item.parent_id) {
      parentContext = await this.buildParentChainContext(projectId, item.parent_id);
    }

    const agentId = `feedback-categorize-${projectId}-${item.id}-${Date.now()}`;
    let linkIds: string[] = [];
    let similarExistingTaskId: string | null = null;
    let updateExistingTasks: Record<string, { title?: string; description?: string }> = {};
    try {
      const response = await agentService.invokePlanningAgent({
        projectId,
        config: getAgentForPlanningRole(settings, "analyst"),
        messages: [
          {
            role: "user",
            content: `# PRD\n\n${prdContext}\n\n# Plans\n\n${planContext}\n\n# Existing OPEN tasks\n\n${openTasksContext}${parentContext}\n\n# Feedback to categorize\n\n"${item.text}"`,
          },
        ],
        systemPrompt: (() => {
          const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
          return autonomyDesc
            ? `${FEEDBACK_CATEGORIZATION_PROMPT}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
            : FEEDBACK_CATEGORIZATION_PROMPT;
        })(),
        images: item.images,
        cwd: project.repoPath,
        tracking: {
          id: agentId,
          projectId,
          phase: "eval",
          role: "analyst",
          label: "Feedback categorization",
          feedbackId: item.id,
        },
      });

      // Parse AI response; fallback: default to bug, map to first plan (PRD §7.4.2 edge case)
      const parsed = extractJsonFromAgentResponse<Record<string, unknown>>(response.content);
      if (parsed) {
        const validCategories: FeedbackCategory[] = ["bug", "feature", "ux", "scope"];
        const rawCategory = parsed.category;
        item.category =
          typeof rawCategory === "string" &&
          validCategories.includes(rawCategory as FeedbackCategory)
            ? (rawCategory as FeedbackCategory)
            : "bug";
        // mapped_plan_id: respect explicit null — only fallback to firstPlanId when key is missing (legacy)
        const rawMappedPlanId = parsed.mapped_plan_id ?? parsed.mappedPlanId;
        item.mappedPlanId =
          rawMappedPlanId === undefined
            ? firstPlanId
            : typeof rawMappedPlanId === "string"
              ? rawMappedPlanId
              : null;

        // mapped_epic_id: respect explicit null — only resolve from plan when mappedPlanId is set
        const rawMappedEpicId = parsed.mapped_epic_id ?? parsed.mappedEpicId;
        if (typeof rawMappedEpicId === "string" && rawMappedEpicId.trim()) {
          item.mappedEpicId = rawMappedEpicId.trim();
        } else if (item.mappedPlanId) {
          try {
            const plan = await this.planService.getPlan(projectId, item.mappedPlanId);
            if (plan.metadata.epicId) {
              item.mappedEpicId = plan.metadata.epicId;
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

        const rawProposed = parsed.proposed_tasks ?? parsed.proposedTasks;
        if (Array.isArray(rawProposed) && rawProposed.length > 0) {
          const parsedTasks: ProposedTask[] = rawProposed
            .filter(
              (t: unknown) =>
                t &&
                typeof t === "object" &&
                typeof (
                  (t as { title?: unknown }).title ?? (t as { task_title?: unknown }).task_title
                ) === "string"
            )
            .map(
              (t: {
                index?: number;
                title?: string;
                task_title?: string;
                description?: string;
                task_description?: string;
                priority?: number;
                task_priority?: number;
                depends_on?: number[];
                dependsOn?: number[];
                complexity?: string;
              }) => {
                const title = String(t.title ?? t.task_title ?? "").trim();
                const deps = (t.depends_on ?? t.dependsOn ?? []) as unknown[];
                const rawComplexity = t.complexity;
                let complexity =
                  clampTaskComplexity(rawComplexity) ??
                  (rawComplexity === "simple" || rawComplexity === "low" ? 3 : rawComplexity === "complex" || rawComplexity === "high" ? 7 : undefined);
                // Reply-derived tasks: always complex (default agent could not resolve)
                if (item.parent_id) {
                  complexity = 7;
                }
                return {
                  index: typeof t.index === "number" ? t.index : 0,
                  title,
                  description:
                    typeof (t.description ?? t.task_description) === "string"
                      ? ((t.description ?? t.task_description) as string)
                      : "",
                  priority:
                    typeof (t.priority ?? t.task_priority) === "number"
                      ? ((t.priority ?? t.task_priority) as number)
                      : 2,
                  depends_on: Array.isArray(deps)
                    ? deps.filter((d): d is number => typeof d === "number")
                    : [],
                  ...(complexity != null && { complexity }),
                };
              }
            );
          // Deduplicate by normalized title to prevent duplicate tasks from Analyst output
          const tasks = this.deduplicateProposedTasks(parsedTasks);
          if (tasks.length > 0) {
            item.proposedTasks = tasks;
            item.taskTitles = tasks.map((t) => t.title);
          }
        }
        if (!item.proposedTasks?.length) {
          const fromTaskTitles = Array.isArray(parsed.task_titles)
            ? parsed.task_titles.filter((t: unknown) => typeof t === "string")
            : parsed.suggestedTitle
              ? [String(parsed.suggestedTitle)]
              : [item.text.slice(0, 80)];
          // Never leave taskTitles empty when we have feedback text (AI may return task_titles: [])
          item.taskTitles = fromTaskTitles.length > 0 ? fromTaskTitles : [item.text.slice(0, 80)];
        }

        // link_to_existing_task_ids / similar_existing_task_id — stored for use after try block
        const rawLinkIds = parsed.link_to_existing_task_ids ?? parsed.linkToExistingTaskIds;
        const rawSimilarId = parsed.similar_existing_task_id ?? parsed.similarExistingTaskId;
        linkIds =
          Array.isArray(rawLinkIds) && rawLinkIds.length > 0
            ? rawLinkIds.filter((id: unknown) => typeof id === "string").map((id) => String(id))
            : [];
        similarExistingTaskId =
          linkIds.length === 0 &&
          typeof rawSimilarId === "string" &&
          rawSimilarId.trim()
            ? rawSimilarId.trim()
            : null;
        const rawUpdates = parsed.update_existing_tasks ?? parsed.updateExistingTasks;
        updateExistingTasks =
          rawUpdates &&
          typeof rawUpdates === "object" &&
          !Array.isArray(rawUpdates)
            ? (rawUpdates as Record<string, { title?: string; description?: string }>)
            : {};

        // open_questions (Analyst fail-early): when feedback is too vague, emit notification and re-enqueue — do NOT create tasks or link
        const rawOpenQuestions = parsed.open_questions ?? parsed.openQuestions;
        const openQuestions: Array<{ id: string; text: string }> = Array.isArray(rawOpenQuestions)
          ? rawOpenQuestions
              .filter(
                (q: unknown) =>
                  q && typeof q === "object" && typeof (q as { text?: unknown }).text === "string"
              )
              .map((q: unknown) => {
                const qq = q as { id?: string; text: string };
                return {
                  id:
                    typeof qq.id === "string" ? qq.id : `q-${crypto.randomBytes(4).toString("hex")}`,
                  text: String(qq.text).trim(),
                };
              })
          : [];
        if (openQuestions.length > 0) {
          const notification = await notificationService.create({
            projectId,
            source: "eval",
            sourceId: item.id,
            questions: openQuestions.map((q) => ({ id: q.id, text: q.text })),
          });
          broadcastToProject(projectId, {
            type: "notification.added",
            notification: {
              id: notification.id,
              projectId: notification.projectId,
              source: notification.source,
              sourceId: notification.sourceId,
              questions: notification.questions,
              status: notification.status,
              createdAt: notification.createdAt,
              resolvedAt: notification.resolvedAt,
            },
          });
          await this.enqueueForCategorization(projectId, item.id);
          return;
        }

        // Handle scope changes with HIL (PRD §7.4.2, §15.1) — category=scope OR is_scope_change=true
        if (item.category === "scope" || item.isScopeChange) {
          // Get AI-generated proposal for modal summary (before HIL)
          let proposal: { summary: string; prdUpdates: HarmonizerPrdUpdate[] } | null = null;
          try {
            proposal = await this.chatService.getScopeChangeProposal(projectId, item.text);
          } catch (err) {
            log.warn("Could not get scope-change proposal for modal", { err });
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
            scopeChangeMetadata,
            "eval",
            item.id
          );

          if (!approved) {
            item.status = "pending";
            await this.saveFeedback(projectId, item);
            broadcastToProject(projectId, {
              type: "feedback.updated",
              feedbackId: item.id,
              planId: item.mappedPlanId || "",
              taskIds: item.createdTaskIds,
              item,
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
            log.error("PRD sync on scope-change approval failed", { err });
          }
        }
      } else {
        // Parse failed: default to bug, map to first plan
        item.category = "bug";
        item.mappedPlanId = firstPlanId;
        item.taskTitles = [item.text.slice(0, 80)];
      }
    } catch (error) {
      log.error("AI categorization failed for feedback", { feedbackId: item.id, error });
      item.category = "bug";
      item.mappedPlanId = firstPlanId;
      item.taskTitles = [item.text.slice(0, 80)];
    }

    // Link to existing tasks or create new tasks
    const LINK_INVALID_RETRY_CAP = 2;
    try {
      if (linkIds.length > 0) {
        const allTasks = await this.taskStore.listAll(projectId);
        const validIds = new Set(
          allTasks
            .filter(
              (t) =>
                (t.status as string) === "open" &&
                (t.issue_type ?? t.type) !== "epic" &&
                (t.issue_type ?? t.type) !== "chore"
            )
            .map((t) => t.id)
        );
        const invalidIds = linkIds.filter((id) => !validIds.has(id));
        if (invalidIds.length > 0) {
          const fresh = await feedbackStore.getFeedback(projectId, item.id);
          const retryCount = fresh.linkInvalidRetryCount ?? 0;
          log.warn("Invalid task IDs in link_to_existing_task_ids", {
            feedbackId: item.id,
            invalidIds: [...new Set(invalidIds)],
            retryCount,
          });
          if (retryCount >= LINK_INVALID_RETRY_CAP) {
            log.warn("Link invalid retry cap exceeded, falling back to create path", {
              feedbackId: item.id,
            });
            item.createdTaskIds = await this.createTasksFromFeedback(
              projectId,
              item,
              similarExistingTaskId ?? undefined
            );
          } else {
            item.linkInvalidRetryCount = retryCount + 1;
            await this.saveFeedback(projectId, item);
            await this.enqueueForCategorization(projectId, item.id);
            return;
          }
        } else {
          item.createdTaskIds = await this.linkFeedbackToExistingTasks(
            projectId,
            item,
            linkIds,
            updateExistingTasks
          );
        }
      } else {
        item.createdTaskIds = await this.createTasksFromFeedback(
          projectId,
          item,
          similarExistingTaskId ?? undefined
        );
      }
    } catch (err) {
      log.error("Failed to create or link tasks", { feedbackId: item.id, err });
    }
    item.status = "pending";

    await this.saveFeedback(projectId, item);

    broadcastToProject(projectId, {
      type: "feedback.updated",
      feedbackId: item.id,
      planId: item.mappedPlanId || "",
      taskIds: item.createdTaskIds,
      item,
    });
  }

  /**
   * Deduplicate proposed tasks by normalized title. Keeps first occurrence, reindexes and remaps depends_on.
   * Prevents duplicate tasks when Analyst returns the same proposed task multiple times.
   */
  private deduplicateProposedTasks(tasks: ProposedTask[]): ProposedTask[] {
    if (tasks.length <= 1) return tasks;
    const seen = new Set<string>();
    const kept: ProposedTask[] = [];
    const oldIndexToNewIndex = new Map<number, number>();
    const sorted = [...tasks].sort((a, b) => a.index - b.index);
    for (const t of sorted) {
      const key = t.title.toLowerCase().trim();
      if (seen.has(key)) {
        // Map duplicate's index to the new index of the kept task (same title)
        oldIndexToNewIndex.set(t.index, kept.length - 1);
        continue;
      }
      seen.add(key);
      const newIndex = kept.length;
      oldIndexToNewIndex.set(t.index, newIndex);
      kept.push({ ...t, index: newIndex });
    }
    // Remap depends_on to new indices; drop refs to removed tasks
    for (const t of kept) {
      const newDeps = (t.depends_on ?? [])
        .map((d) => oldIndexToNewIndex.get(d))
        .filter((d): d is number => d !== undefined);
      t.depends_on = [...new Set(newDeps)];
    }
    return kept;
  }

  /**
   * Map feedback category to task type (PRD §14).
   * bug → bug, feature → feature, ux → task.
   */
  private categoryToTaskType(category: FeedbackCategory): "bug" | "feature" | "task" {
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

  /**
   * Link feedback to existing tasks instead of creating new ones.
   * Creates a feedback source (chore) task, applies optional updates to existing tasks,
   * adds discovered-from deps from each existing task to the feedback source, sets createdTaskIds.
   */
  private async linkFeedbackToExistingTasks(
    projectId: string,
    item: FeedbackItem,
    taskIds: string[],
    updates?: Record<string, { title?: string; description?: string }>
  ): Promise<string[]> {
    const fresh = await feedbackStore.getFeedback(projectId, item.id);
    if (fresh.createdTaskIds && fresh.createdTaskIds.length > 0) {
      return fresh.createdTaskIds;
    }

    const project = await this.projectService.getProject(projectId);

    const sourceTitle = `Feedback: ${item.text.slice(0, 60)}${item.text.length > 60 ? "…" : ""}`;
    const sourceTask = await this.taskStore.create(project.id, sourceTitle, {
      type: "chore",
      priority: 4,
      description: `Feedback ID: ${item.id}`,
    });
    item.feedbackSourceTaskId = sourceTask.id;

    for (const taskId of taskIds) {
      const upd = updates?.[taskId];
      const existing = await Promise.resolve(this.taskStore.show(projectId, taskId));
      const existingIds =
        ((existing as { sourceFeedbackIds?: string[] }).sourceFeedbackIds ?? []) as string[];
      const sourceFeedbackIds = existingIds.includes(item.id)
        ? existingIds
        : [...existingIds, item.id];
      if (upd && (upd.title != null || upd.description != null)) {
        await this.taskStore.update(projectId, taskId, {
          ...(upd.title != null && { title: upd.title }),
          ...(upd.description != null && { description: upd.description }),
          extra: { sourceFeedbackIds },
        });
      } else {
        await this.taskStore.update(projectId, taskId, {
          extra: { sourceFeedbackIds },
        });
      }
      await this.taskStore.addDependency(
        projectId,
        taskId,
        sourceTask.id,
        "discovered-from"
      );
    }

    return taskIds;
  }

  /** Resolve plan complexity for an epic (for task complexity fallback). */
  private async resolvePlanComplexityForEpic(
    projectId: string,
    epicId: string
  ): Promise<"low" | "medium" | "high" | "very_high" | undefined> {
    const plan = await this.taskStore.planGetByEpicId(projectId, epicId);
    const c = plan?.metadata?.complexity;
    return typeof c === "string" &&
      ["low", "medium", "high", "very_high"].includes(c)
      ? (c as "low" | "medium" | "high" | "very_high")
      : undefined;
  }

  /** Create tasks from feedback (PRD §12.3.4). Idempotent: skips if tasks already created.
   * @param similar_existing_task_id Optional. When set, merge path: validate task exists and is OPEN/READY,
   * append feedbackId to sourceFeedbackIds, append feedback text to description, return [existingTaskId].
   * If invalid, log warning and fall through to create.
   */
  private async createTasksFromFeedback(
    projectId: string,
    item: FeedbackItem,
    similar_existing_task_id?: string | null
  ): Promise<string[]> {
    // Idempotency: fetch fresh from DB to handle concurrent invocation (e.g. before claim-then-process)
    const fresh = await feedbackStore.getFeedback(projectId, item.id);
    if (fresh.createdTaskIds && fresh.createdTaskIds.length > 0) {
      return fresh.createdTaskIds;
    }

    // Merge path: similar_existing_task_id provided
    if (similar_existing_task_id) {
      const allTasks = await this.taskStore.listAll(projectId);
      const openLeafTasks = allTasks.filter(
        (t) =>
          (t.status as string) === "open" &&
          (t.issue_type ?? t.type) !== "epic" &&
          (t.issue_type ?? t.type) !== "chore"
      );
      const validIds = new Set(openLeafTasks.map((t) => t.id));
      if (validIds.has(similar_existing_task_id)) {
        try {
          const existing = await Promise.resolve(
            this.taskStore.show(projectId, similar_existing_task_id)
          );
          const existingIds =
            ((existing as { sourceFeedbackIds?: string[] }).sourceFeedbackIds ?? []) as string[];
          const sourceFeedbackIds = existingIds.includes(item.id)
            ? existingIds
            : [...existingIds, item.id];
          const desc = (existing.description as string) ?? "";
          const appendedDesc = desc.trim()
            ? `${desc}\n\n---\nFeedback: ${item.text}`
            : `Feedback: ${item.text}`;
          await this.taskStore.update(projectId, similar_existing_task_id, {
            extra: { sourceFeedbackIds },
            description: appendedDesc,
          });
          item.createdTaskIds = [similar_existing_task_id];
          return [similar_existing_task_id];
        } catch (err) {
          log.warn("Merge into existing task failed, falling through to create", {
            feedbackId: item.id,
            existingTaskId: similar_existing_task_id,
            err,
          });
        }
      } else {
        log.warn("Invalid similar_existing_task_id, falling through to create", {
          feedbackId: item.id,
          similar_existing_task_id,
        });
      }
    }

    const proposedTasks = item.proposedTasks ?? [];
    let taskTitles = item.taskTitles ?? [];
    const hasProposed = proposedTasks.length > 0;
    let hasTitles = taskTitles.length > 0;
    if (!hasProposed && !hasTitles) {
      if (item.text?.trim()) {
        taskTitles = [item.text.slice(0, 80)];
        hasTitles = true;
      } else return [];
    }

    // User-specified priority (0-4) overrides AI-suggested and category-based default
    const userPriorityOverride =
      typeof item.userPriority === "number" && item.userPriority >= 0 && item.userPriority <= 4
        ? item.userPriority
        : undefined;

    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;

    // Resolve parent epic: mappedEpicId (from AI or plan) or look up from plan (PRD §12.3.4)
    let parentEpicId: string | undefined;
    if (item.mappedEpicId) {
      parentEpicId = item.mappedEpicId;
    } else if (item.mappedPlanId) {
      try {
        const plan = await this.planService.getPlan(projectId, item.mappedPlanId);
        if (plan.metadata.epicId) {
          parentEpicId = plan.metadata.epicId;
        }
      } catch {
        // Plan not found or no epic — create tasks without parent
      }
    }

    // Create feedback source task for discovered-from provenance (PRD §14, §15.3).
    // Skip when proposed_tasks has exactly 1 item — avoid duplicate user-visible task per feedback.
    const singleProposedTask = hasProposed && proposedTasks.length === 1;
    let feedbackSourceTaskId: string | undefined;
    if (!singleProposedTask) {
      try {
        const sourceTitle = `Feedback: ${item.text.slice(0, 60)}${item.text.length > 60 ? "…" : ""}`;
        const sourceTask = await this.taskStore.create(project.id, sourceTitle, {
          type: "chore",
          priority: 4,
          description: `Feedback ID: ${item.id}`,
        });
        feedbackSourceTaskId = sourceTask.id;
        item.feedbackSourceTaskId = sourceTask.id;
      } catch (err) {
        log.error("Failed to create feedback source task", { feedbackId: item.id, err });
      }
    }

    const taskType = this.categoryToTaskType(item.category);
    const createdIds: string[] = [];
    const taskIdMap = new Map<number, string>();

    if (hasProposed) {
      // Create tasks from proposed_tasks (Planner format) with description, priority, depends_on
      const sorted = [...proposedTasks].sort((a, b) => a.index - b.index);
      for (const task of sorted) {
        try {
          const priority =
            userPriorityOverride ?? task.priority ?? (item.category === "bug" ? 0 : 2);
          // When single proposed task, add feedback ID to description for provenance (no separate chore)
          const baseDesc = task.description || undefined;
          const description =
            singleProposedTask && baseDesc
              ? `${baseDesc}\n\nFeedback ID: ${item.id}`
              : singleProposedTask
                ? `Feedback ID: ${item.id}`
                : baseDesc;
          const planComplexity = parentEpicId
            ? await this.resolvePlanComplexityForEpic(projectId, parentEpicId)
            : undefined;
          // Reply-derived tasks: always complex (default agent could not resolve)
          const raw = task.complexity;
          const taskComplexity = item.parent_id
            ? 7
            : clampTaskComplexity(raw) ??
              (raw === "simple" || raw === "low" ? 3 : raw === "complex" || raw === "high" ? 7 : undefined) ??
              (planComplexity ? planComplexityToTask(planComplexity) : 3);
          const issue = await this.taskStore.createWithRetry(
            project.id,
            task.title,
            {
              type: taskType,
              priority,
              description,
              parentId: parentEpicId,
              complexity: taskComplexity,
              extra: { sourceFeedbackIds: [item.id] },
            },
            { fallbackToStandalone: true }
          );
          if (issue) {
            createdIds.push(issue.id);
            taskIdMap.set(task.index, issue.id);

            if (feedbackSourceTaskId) {
              try {
                await this.taskStore.addDependency(
                  repoPath,
                  issue.id,
                  feedbackSourceTaskId,
                  "discovered-from"
                );
              } catch (depErr) {
                log.error("Failed to add discovered-from", { taskId: issue.id, err: depErr });
              }
            }
          }
        } catch (err) {
          log.error("Failed to create task", { title: task.title, err });
        }
      }

      // Add inter-task blocks dependencies (depends_on indices → task IDs)
      for (const task of sorted) {
        const childId = taskIdMap.get(task.index);
        const deps = task.depends_on ?? [];
        if (childId) {
          for (const depIdx of deps) {
            const parentId = taskIdMap.get(depIdx);
            if (parentId) {
              try {
                await this.taskStore.addDependency(project.id, childId, parentId);
              } catch (depErr) {
                log.error("Failed to add blocks dep", { childId, parentId, err: depErr });
              }
            }
          }
        }
      }
    } else {
      // Legacy: create from task_titles only; deduplicate to prevent duplicate tasks
      const seenTitles = new Set<string>();
      const uniqueTitles = taskTitles.filter((t) => {
        const key = t.trim().toLowerCase();
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      });
      for (const title of uniqueTitles) {
        try {
          const priority = userPriorityOverride ?? (item.category === "bug" ? 0 : 2);
          // Reply-derived tasks: always complex (default agent could not resolve)
          const complexity = item.parent_id ? 7 : undefined;
          const issue = await this.taskStore.createWithRetry(
            project.id,
            title,
            {
              type: taskType,
              priority,
              parentId: parentEpicId,
              ...(complexity && { complexity }),
              extra: { sourceFeedbackIds: [item.id] },
            },
            { fallbackToStandalone: true }
          );
          if (issue) {
            createdIds.push(issue.id);
            if (feedbackSourceTaskId) {
              try {
                await this.taskStore.addDependency(
                  project.id,
                  issue.id,
                  feedbackSourceTaskId,
                  "discovered-from"
                );
              } catch (depErr) {
                log.error("Failed to add discovered-from", { taskId: issue.id, err: depErr });
              }
            }
          }
        } catch (err) {
          log.error("Failed to create task", { title, err });
        }
      }
    }

    return createdIds;
  }

  private async saveFeedback(projectId: string, item: FeedbackItem): Promise<void> {
    await feedbackStore.updateFeedback(projectId, item);
  }

  /**
   * Enqueue all feedback items still in 'pending' status for the orchestrator to process.
   * Called on server startup to recover from failed/interrupted categorizations.
   * Skips feedback that already has at least one linked task (already analyzed).
   * Returns the number of items enqueued.
   */
  async retryPendingCategorizations(projectId: string): Promise<number> {
    const items = await this.listFeedback(projectId);
    const pending = items.filter(
      (item) => item.status === "pending" && (item.createdTaskIds?.length ?? 0) === 0
    );
    if (pending.length === 0) return 0;

    const existing = new Set(await this.listPendingFeedbackIds(projectId));
    let enqueued = 0;
    for (const item of pending) {
      if (!existing.has(item.id)) {
        await this.enqueueForCategorization(projectId, item.id);
        existing.add(item.id);
        enqueued++;
      }
    }
    if (enqueued > 0) {
      log.info("Enqueued pending feedback for Analyst", { count: enqueued });
    }
    return enqueued;
  }

  /**
   * Re-categorize a single feedback item (resets to pending, enqueues for Analyst).
   * Used for manual retry from the UI. Orchestrator will process from inbox.
   * When answer is provided (e.g. from open-question resolution), appends it to feedback text
   * so the Analyst receives the clarification.
   */
  async recategorizeFeedback(
    projectId: string,
    feedbackId: string,
    options?: { answer?: string }
  ): Promise<FeedbackItem> {
    const item = await this.getFeedback(projectId, feedbackId);
    item.status = "pending";
    item.category = "bug";
    item.mappedPlanId = null;
    item.mappedEpicId = undefined;
    item.isScopeChange = undefined;
    item.createdTaskIds = [];
    item.taskTitles = undefined;
    item.proposedTasks = undefined;

    if (options?.answer?.trim()) {
      const separator = "\n\n---\n\n**Clarification:** ";
      item.text = `${item.text}${separator}${options.answer.trim()}`;
    }

    await this.saveFeedback(projectId, item);

    await this.enqueueForCategorization(projectId, feedbackId);

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
        i.status === "pending" &&
        i.createdTaskIds.length > 0 &&
        i.createdTaskIds.includes(closedTaskId)
    );
    if (candidates.length === 0) return;

    await this.projectService.getProject(projectId);
    const allIssues = await this.taskStore.listAll(projectId);
    const idToStatus = new Map(allIssues.map((i) => [i.id, (i.status as string) ?? "open"]));

    for (const item of candidates) {
      const allClosed = item.createdTaskIds.every((tid) => idToStatus.get(tid) === "closed");
      if (allClosed) {
        await this.resolveFeedback(projectId, item.id);
      }
    }
  }

  /**
   * Recursively resolve all children of a feedback item (items whose parent_id matches).
   * Cascades to grandchildren etc. Already-resolved children remain resolved (no-op).
   */
  private async cascadeResolveChildren(projectId: string, parentId: string): Promise<void> {
    const items = await this.listFeedback(projectId);
    const children = items.filter((i) => i.parent_id === parentId);
    for (const child of children) {
      if (child.status !== "resolved") {
        child.status = "resolved";
        await this.saveFeedback(projectId, child);
        broadcastToProject(projectId, {
          type: "feedback.resolved",
          feedbackId: child.id,
          item: child,
        });
      }
      await this.cascadeResolveChildren(projectId, child.id);
    }
  }

  /**
   * Resolve a feedback item (status -> resolved).
   * When resolving a parent, cascades to all children/replies recursively.
   * PRD §7.5.3: When all critical feedback (bugs) are resolved, triggers deploy for targets
   * with autoDeployTrigger "eval_resolution" via triggerDeployForEvent.
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
      item,
    });

    await this.cascadeResolveChildren(projectId, item.id);

    // PRD §7.5.3: Auto-deploy on Evaluate resolution — when all critical (bug) feedback resolved
    const items = await this.listFeedback(projectId);
    const criticalItems = items.filter((i) => i.category === "bug");
    const allCriticalResolved =
      criticalItems.length > 0 && criticalItems.every((i) => i.status === "resolved");

    if (allCriticalResolved) {
      triggerDeployForEvent(projectId, "eval_resolution").catch((err) => {
        log.warn("Auto-deploy on Evaluate resolution failed", { projectId, err });
      });
    }

    return item;
  }

  /**
   * Cancel a feedback item (status -> cancelled).
   * Deletes all linked tasks (createdTaskIds and feedbackSourceTaskId). Does not cascade to child feedback.
   * Intended for feedback where no linked tasks are in progress, in review, or done.
   */
  async cancelFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    const item = await this.getFeedback(projectId, feedbackId);
    if (item.status !== "pending") {
      return item;
    }
    item.status = "cancelled";
    await this.saveFeedback(projectId, item);

    broadcastToProject(projectId, {
      type: "feedback.resolved",
      feedbackId: item.id,
      item,
    });

    const taskIdsToDelete: string[] = [...(item.createdTaskIds ?? [])];
    if (item.feedbackSourceTaskId) {
      taskIdsToDelete.push(item.feedbackSourceTaskId);
    }
    if (taskIdsToDelete.length > 0) {
      await this.taskStore.deleteMany(projectId, taskIdsToDelete);
    }

    return item;
  }

  async getFeedback(projectId: string, feedbackId: string): Promise<FeedbackItem> {
    return feedbackStore.getFeedback(projectId, feedbackId);
  }
}
