/**
 * Feedback categorization flow — Analyst invocation, context building, parsing,
 * open_questions, scope change HIL, and large-scope routing.
 * Extracted from feedback.service for maintainability.
 */

import crypto from "crypto";
import type { FeedbackItem, FeedbackCategory, ProposedTask, Plan } from "@opensprint/shared";
import { getAgentForPlanningRole, clampTaskComplexity } from "@opensprint/shared";
import { agentService } from "./agent.service.js";
import { hilService } from "./hil-service.js";
import { ChatService } from "./chat.service.js";
import { PlanService } from "./plan.service.js";
import { PrdService } from "./prd.service.js";
import type { HarmonizerPrdUpdate } from "./harmonizer.service.js";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { feedbackStore } from "./feedback-store.service.js";
import { notificationService } from "./notification.service.js";
import { orchestratorService } from "./orchestrator.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { JSON_OUTPUT_PREAMBLE } from "../utils/agent-prompts.js";
import { buildAutonomyDescription } from "./autonomy-description.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { maybeAutoRespond } from "./open-question-autoresolve.service.js";
import { createLogger } from "../utils/logger.js";
import { ProjectService } from "./project.service.js";

const log = createLogger("feedback-categorization");

/**
 * Build a user-friendly description for scope change HIL approval (PRD §6.5.1).
 */
export function buildScopeChangeHilDescription(feedbackText: string): string {
  const truncated = feedbackText.length > 200 ? `${feedbackText.slice(0, 200)}…` : feedbackText;
  return `A user submitted feedback that was categorized as a scope change. Please review the proposed PRD updates below and approve or reject.

User feedback: "${truncated}"`;
}

/**
 * Build description for plan-execution HIL (large-scope feedback → new plan).
 */
export function buildPlanExecutionHilDescription(
  feedbackText: string,
  planTitle: string
): string {
  const truncated = feedbackText.length > 150 ? `${feedbackText.slice(0, 150)}…` : feedbackText;
  return `A new plan was created from large-scope feedback. Please review the plan before execution.

User feedback: "${truncated}"

Plan: ${planTitle}`;
}

const FEEDBACK_CATEGORIZATION_PROMPT = `You are an AI assistant that categorizes user feedback about a software product (PRD §12.3.4 Analyst contract).

${JSON_OUTPUT_PREAMBLE}

**Category guide:** bug = broken/incorrect behavior; feature = new capability request; ux = usability/copy/layout improvement; scope = fundamental requirement change requiring PRD update.

**Fail-early when feedback is too vague:** When the feedback is too vague, ambiguous, or insufficient to categorize or create tasks (e.g. single word, unclear intent, missing context), return a non-empty \`open_questions\` array instead of categorizing. Do NOT create tasks or link to existing. The user will answer these questions before the Analyst proceeds. Use open_questions only when you genuinely cannot proceed; otherwise categorize normally.

**open_questions rules:** When asking questions, prefer tradeoff questions when appropriate: present options A, B, C with pros and cons (e.g. "Option A: X (pros: …, cons: …). Option B: Y (pros: …, cons: …). Which do you prefer?"). Keep questions concise. You may ask multiple questions when clarification would help; responses can be more thorough than yes/no.

**Plan/epic association:** Associate feedback to a plan/epic ONLY when there is a VERY CLEAR link. When feedback does not clearly map to work in an existing plan/epic, use mapped_plan_id: null and mapped_epic_id: null. In that case, proposed_tasks create top-level (standalone) tasks — do not force feedback into an existing plan when the link is ambiguous.

Given the user's feedback (and any attached images), the PRD, available plans, and **Existing OPEN tasks**, determine:
1. The category: "bug" | "feature" | "ux" | "scope"
2. Which feature/plan it relates to (if clearly identifiable) — use the planId from the available plans list, or null when the link is not clear
3. The mapped epic ID — use the epicId from the plan you mapped to (or null if no plan or link unclear)
4. Whether this is a scope change — true if the feedback fundamentally alters requirements/PRD; false otherwise
5. Whether this is **large scope** — true when feedback affects a whole epic/plan, architecture changes, or significant tradeoffs. Large-scope feedback is routed to the Planner to create a new Epic/Plan instead of individual tickets. Use is_large_scope: true for: whole-epic rewrites, architecture changes, major feature pivots, significant tradeoff decisions. Use is_large_scope: false for: single-task fixes, small enhancements, localized bugs.
6. Proposed tasks in indexed Planner format — same structure as Planner output: index, title, description, priority, depends_on, complexity (integer 1-10 only — assign per task based on implementation difficulty, 1=simplest, 10=most complex; use the full range as appropriate, do not bias toward any specific number). When mapped_plan_id is null and is_large_scope is false, create top-level tasks (no parent epic). **When is_large_scope is true, omit proposed_tasks** — the Planner will create the plan.

**Linking to existing tasks:** When feedback is clearly covered by one or more existing OPEN tasks, prefer linking instead of creating new tasks:
- \`link_to_existing_task_ids\`: string[]. If non-empty, do NOT create new tasks; link feedback to these existing task IDs. All IDs must appear in the Existing OPEN/READY tasks list.
- \`similar_existing_task_id\`: string | null. Return a task ID only when feedback clearly adds to or refines the same work (single task). Otherwise null. When set, it is equivalent to link_to_existing_task_ids: [id].
- \`update_existing_tasks\`: Record<taskId, { title?: string, description?: string }>. Keys are task IDs from link_to_existing_task_ids. Apply these updates before linking (e.g. refine title/description when feedback improves the task).
- Rule: if link_to_existing_task_ids is non-empty (or similar_existing_task_id is set), ignore proposed_tasks.

When feedback lacks a clear plan/epic link, use mapped_plan_id: null, mapped_epic_id: null and propose_tasks as top-level (standalone) tasks. For proposed_tasks: use a single task when feedback addresses one concern; use multiple only when feedback clearly describes distinct work items.

For replies (parent_id present), consider the parent's category and mapped plan — the reply often refines or adds to the parent. If the feedback is a single word or too vague to categorize, default to "ux" and propose_tasks: [] with a generic title.

**Reply-derived complexity:** When feedback is a reply (parent_id present), assign a complexity in the 6-10 range for each proposed task so the work is routed to a more capable agent.

JSON format:
{
  "category": "bug" | "feature" | "ux" | "scope",
  "mapped_plan_id": "plan-id-if-identifiable or null",
  "mapped_epic_id": "epicId-from-plan or null",
  "is_scope_change": true | false,
  "is_large_scope": true | false,
  "proposed_tasks": [
    { "index": 0, "title": "Task title", "description": "Detailed spec with acceptance criteria", "priority": 1, "depends_on": [], "complexity": 5 }
  ],
  "link_to_existing_task_ids": ["task-id-1", "task-id-2"],
  "similar_existing_task_id": "task-id or null",
  "update_existing_tasks": { "task-id": { "title": "...", "description": "..." } },
  "open_questions": [{ "id": "q1", "text": "Clarification question..." }]
}

When feedback is too vague: return non-empty open_questions: [{ "id": "q1", "text": "Clarification question..." }]. Server surfaces via Human Notification System. Do not set proposed_tasks or link_to_existing_task_ids. Omit open_questions when you can categorize normally.

priority: 0 (highest) to 4 (lowest). depends_on: array of task indices (0-based) this task is blocked by. complexity: integer 1-10 only (1=simplest, 10=most complex) — assign per task based on implementation difficulty; use the full range as appropriate.`;

export type CategorizationResult =
  | { done: true; reason: "open_questions" }
  | { done: true; reason: "large_scope" }
  | { done: true; reason: "scope_rejected" }
  | {
      done: false;
      linkIds: string[];
      similarExistingTaskId: string | null;
      updateExistingTasks: Record<string, { title?: string; description?: string }>;
    };

export interface FeedbackCategorizationDeps {
  enqueueForCategorization: (projectId: string, feedbackId: string) => Promise<void>;
  saveFeedback: (projectId: string, item: FeedbackItem) => Promise<void>;
  deduplicateProposedTasks: (tasks: ProposedTask[]) => ProposedTask[];
}

export class FeedbackCategorizationService {
  private projectService = new ProjectService();
  private planService: PlanService | null = null;
  private prdService = new PrdService();
  private taskStore = taskStoreSingleton;
  private chatService = new ChatService();
  private hilService = hilService;

  constructor(private deps: FeedbackCategorizationDeps) {}

  private getPlanService(): PlanService {
    this.planService ??= new PlanService();
    return this.planService;
  }

  /**
   * Run the full categorization flow. Mutates `item` in place.
   * Returns early-exit result (open_questions, large_scope, scope_rejected) or
   * continue with link/update info for task creation.
   */
  async categorize(
    projectId: string,
    item: FeedbackItem,
    getFeedback: (projectId: string, feedbackId: string) => Promise<FeedbackItem>
  ): Promise<CategorizationResult> {
    const settings = await this.projectService.getSettings(projectId);
    const project = await this.projectService.getProject(projectId);
    const [prdContext, planContext, openTasksContext] = await Promise.all([
      this.getPrdContextForCategorization(projectId),
      this.getPlanContextForCategorization(projectId),
      this.getOpenTasksContextForCategorization(projectId),
    ]);

    let plans: { metadata: { planId: string } }[] = [];
    try {
      plans = await this.getPlanService().listPlans(projectId);
    } catch {
      // Ignore
    }
    const firstPlanId = plans.length > 0 ? plans[0].metadata.planId : null;

    let parentContext = "";
    if (item.parent_id) {
      parentContext = await this.buildParentChainContext(projectId, item.parent_id, getFeedback);
    }

    const agentId = `feedback-categorize-${projectId}-${item.id}-${Date.now()}`;
    let linkIds: string[] = [];
    let similarExistingTaskId: string | null = null;
    let updateExistingTasks: Record<string, { title?: string; description?: string }> = {};
    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const baseSystemPrompt = autonomyDesc
      ? `${FEEDBACK_CATEGORIZATION_PROMPT}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : FEEDBACK_CATEGORIZATION_PROMPT;
    const systemPrompt = `${baseSystemPrompt}\n\n${await getCombinedInstructions(project.repoPath, "analyst")}`;

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
        systemPrompt,
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

      const parsed = extractJsonFromAgentResponse<Record<string, unknown>>(response.content);
      if (parsed) {
        const validCategories: FeedbackCategory[] = ["bug", "feature", "ux", "scope"];
        const rawCategory = parsed.category;
        item.category =
          typeof rawCategory === "string" &&
          validCategories.includes(rawCategory as FeedbackCategory)
            ? (rawCategory as FeedbackCategory)
            : "bug";

        if (item.submittedPlanId) {
          item.mappedPlanId = item.submittedPlanId;
        } else {
          const rawMappedPlanId = parsed.mapped_plan_id ?? parsed.mappedPlanId;
          item.mappedPlanId =
            rawMappedPlanId === undefined
              ? firstPlanId
              : typeof rawMappedPlanId === "string"
                ? rawMappedPlanId
                : null;
        }

        const rawMappedEpicId = parsed.mapped_epic_id ?? parsed.mappedEpicId;
        if (typeof rawMappedEpicId === "string" && rawMappedEpicId.trim()) {
          item.mappedEpicId = rawMappedEpicId.trim();
        } else if (item.mappedPlanId) {
          try {
            const plan = await this.getPlanService().getPlan(projectId, item.mappedPlanId);
            if (plan.metadata.epicId) {
              item.mappedEpicId = plan.metadata.epicId;
            }
          } catch {
            // Plan not found — leave mappedEpicId unset
          }
        }

        item.isScopeChange =
          typeof parsed.is_scope_change === "boolean"
            ? parsed.is_scope_change
            : item.category === "scope";

        item.isLargeScope =
          typeof parsed.is_large_scope === "boolean" ? parsed.is_large_scope : false;

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
                let complexity = clampTaskComplexity(rawComplexity);
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
          const tasks = this.deps.deduplicateProposedTasks(parsedTasks);
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
          item.taskTitles = fromTaskTitles.length > 0 ? fromTaskTitles : [item.text.slice(0, 80)];
        }

        const rawLinkIds = parsed.link_to_existing_task_ids ?? parsed.linkToExistingTaskIds;
        const rawSimilarId = parsed.similar_existing_task_id ?? parsed.similarExistingTaskId;
        linkIds =
          Array.isArray(rawLinkIds) && rawLinkIds.length > 0
            ? rawLinkIds.filter((id: unknown) => typeof id === "string").map((id) => String(id))
            : [];
        similarExistingTaskId =
          linkIds.length === 0 && typeof rawSimilarId === "string" && rawSimilarId.trim()
            ? rawSimilarId.trim()
            : null;
        const rawUpdates = parsed.update_existing_tasks ?? parsed.updateExistingTasks;
        updateExistingTasks =
          rawUpdates && typeof rawUpdates === "object" && !Array.isArray(rawUpdates)
            ? (rawUpdates as Record<string, { title?: string; description?: string }>)
            : {};

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
                    typeof qq.id === "string"
                      ? qq.id
                      : `q-${crypto.randomBytes(4).toString("hex")}`,
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
          void maybeAutoRespond(projectId, notification);
          await this.deps.enqueueForCategorization(projectId, item.id);
          return { done: true, reason: "open_questions" };
        }

        if (item.isLargeScope) {
          const largeResult = await this.handleLargeScope(projectId, item, settings, firstPlanId);
          if (largeResult) return largeResult;
        }

        if (item.category === "scope" || item.isScopeChange) {
          const scopeResult = await this.handleScopeChange(projectId, item);
          if (scopeResult) return scopeResult;
        }
      } else {
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

    return {
      done: false,
      linkIds,
      similarExistingTaskId,
      updateExistingTasks,
    };
  }

  private async handleLargeScope(
    projectId: string,
    item: FeedbackItem,
    settings: { hilConfig: { scopeChanges?: string } },
    firstPlanId: string | null
  ): Promise<CategorizationResult | null> {
    try {
      const generated = await this.getPlanService().generatePlanFromDescription(
        projectId,
        item.text
      );
      if (generated.status !== "created") {
        await this.deps.enqueueForCategorization(projectId, item.id);
        return { done: true, reason: "large_scope" };
      }
      const plan = generated.plan;
      item.mappedPlanId = plan.metadata.planId;
      item.mappedEpicId = plan.metadata.epicId ?? undefined;
      const childIds = (plan as Plan & { _createdTaskIds?: string[] })._createdTaskIds ?? [];
      item.createdTaskIds = childIds.length > 0 ? childIds : [plan.metadata.epicId!];

      const scopeMode = settings.hilConfig.scopeChanges;
      if (scopeMode === "requires_approval") {
        const planTitle =
          plan.content
            .split("\n")[0]
            ?.replace(/^#+\s*/, "")
            .trim() || plan.metadata.planId;
        const { approved } = await this.hilService.evaluateDecision(
          projectId,
          "scopeChanges",
          buildPlanExecutionHilDescription(item.text, planTitle),
          [
            {
              id: "approve",
              label: "Execute",
              description: "Approve plan and queue for execution",
            },
            { id: "reject", label: "Reject", description: "Keep plan in Planning state" },
          ],
          true,
          undefined,
          "eval",
          item.id
        );
        if (approved) {
          await this.getPlanService().shipPlan(projectId, plan.metadata.planId);
          orchestratorService.nudge(projectId);
        }
      } else {
        await this.getPlanService().shipPlan(projectId, plan.metadata.planId);
        orchestratorService.nudge(projectId);
      }

      item.status = "pending";
      await this.deps.saveFeedback(projectId, item);
      broadcastToProject(projectId, {
        type: "feedback.updated",
        feedbackId: item.id,
        planId: item.mappedPlanId || "",
        taskIds: item.createdTaskIds,
        item,
      });
      return { done: true, reason: "large_scope" };
    } catch (err) {
      log.error("Large-scope plan creation failed", { feedbackId: item.id, err });
      await this.deps.enqueueForCategorization(projectId, item.id);
      throw err;
    }
  }

  private async handleScopeChange(projectId: string, item: FeedbackItem): Promise<CategorizationResult | null> {
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
            content: u.content,
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
      await this.deps.saveFeedback(projectId, item);
      broadcastToProject(projectId, {
        type: "feedback.updated",
        feedbackId: item.id,
        planId: item.mappedPlanId || "",
        taskIds: item.createdTaskIds,
        item,
      });
      return { done: true, reason: "scope_rejected" };
    }

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
    return null; // continue to task creation
  }

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

  private async getPlanContextForCategorization(projectId: string): Promise<string> {
    try {
      const plans = await this.getPlanService().listPlans(projectId);
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

  private async buildParentChainContext(
    projectId: string,
    parentId: string,
    getFeedback: (projectId: string, feedbackId: string) => Promise<FeedbackItem>
  ): Promise<string> {
    const ancestors: FeedbackItem[] = [];
    let currentId: string | null = parentId;
    const MAX_ANCESTORS = 20;
    const visited = new Set<string>();

    while (currentId && ancestors.length < MAX_ANCESTORS) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      try {
        const ancestor = await getFeedback(projectId, currentId);
        ancestors.push(ancestor);
        currentId = ancestor.parent_id ?? null;
      } catch {
        break;
      }
    }

    if (ancestors.length === 0) return "";

    ancestors.reverse();
    const count = ancestors.length;
    const lines = ancestors.map((a, i) => {
      const label =
        count === 1 ? "Parent feedback" : `Feedback ${i + 1} of ${count} (depth ${a.depth ?? i})`;
      return `${label}:\n  Content: "${a.text}"\n  Category: ${a.category}\n  mappedPlanId: ${a.mappedPlanId ?? "null"}`;
    });

    const header =
      count === 1
        ? "# Parent feedback (this is a reply)"
        : `# Feedback conversation chain (this is a reply — ${count} ancestors, oldest first)`;

    return `\n\n${header}\n\n${lines.join("\n\n")}\n`;
  }
}
