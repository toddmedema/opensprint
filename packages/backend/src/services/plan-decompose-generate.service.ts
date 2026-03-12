/**
 * Plan decompose/generate: suggest plans, decompose from PRD, generate from description, plan tasks (generate and create tasks).
 * Encapsulates all planning-agent flows that create or suggest plans/tasks; used by PlanService and PlanShipService.
 */
import type {
  Plan,
  PlanMetadata,
  PlanDependencyEdge,
  SuggestedPlan,
  PlanComplexity,
  GeneratePlanResult,
  Notification,
} from "@opensprint/shared";
import { getAgentForPlanningRole } from "@opensprint/shared";
import {
  getEpicTitleFromPlanContent,
  normalizePlanSpec,
  normalizeDependsOnPlans,
  ensureDependenciesSection,
  normalizePlannerOpenQuestions,
  extractPlanJsonPathFromResponse,
} from "./plan/planner-normalize.js";
import {
  DECOMPOSE_SYSTEM_PROMPT,
  getPlanMarkdownSections,
  getPlanTemplateStructure,
} from "./plan/plan-prompts.js";
import { buildPrdContextString, parseDecomposeResponse } from "./plan/plan-decompose-generate.js";
import { readPlanJsonFromRepo } from "./plan/plan-read-json.js";
import { runAutoReviewPlanAgainstRepo } from "./plan/plan-auto-review.js";
import { generateAndCreateTasks as generateAndCreateTasksImpl } from "./plan/plan-task-generation.js";
import { ProjectService } from "./project.service.js";
import type { StoredTask } from "./task-store.service.js";
import { agentService } from "./agent.service.js";
import { PrdService } from "./prd.service.js";
import { buildAutonomyDescription } from "./autonomy-description.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { broadcastToProject } from "../websocket/index.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("plan-decompose-generate");

export interface PlanDecomposeGenerateDeps {
  taskStore: {
    listAll(projectId: string): Promise<StoredTask[]>;
    createMany(
      projectId: string,
      inputs: Array<Record<string, unknown> & { title: string }>
    ): Promise<Array<{ id: string }>>;
    addDependencies(projectId: string, deps: Array<{ childId: string; parentId: string; type?: string }>): Promise<void>;
    addLabel(projectId: string, taskId: string, label: string): Promise<void>;
    close(projectId: string, taskId: string, reason: string): Promise<void | StoredTask>;
    create(projectId: string, title: string, opts?: Record<string, unknown>): Promise<{ id: string }>;
    update(
      projectId: string,
      taskId: string,
      updates: Record<string, unknown>
    ): Promise<void | StoredTask>;
    planUpdateMetadata(projectId: string, planId: string, metadata: Record<string, unknown>): Promise<void>;
  };
  projectService: ProjectService;
  prdService: PrdService;
  createPlan: (
    projectId: string,
    body: Record<string, unknown>
  ) => Promise<Plan & { _createdTaskIds?: string[]; _createdTaskTitles?: string[] }>;
  getPlan: (
    projectId: string,
    planId: string,
    opts?: { allIssues?: StoredTask[]; edges?: PlanDependencyEdge[] }
  ) => Promise<Plan>;
}

export interface PlanDecomposeGenerateOptionalDeps {
  chatService?: {
    startPlanDraftConversation: (
      projectId: string,
      draftId: string,
      description: string,
      questions: Array<{ id: string; text: string }>
    ) => Promise<void>;
  };
  notificationService?: {
    create: (opts: {
      projectId: string;
      source: "plan" | "prd" | "execute" | "eval";
      sourceId: string;
      questions: Array<{ id: string; text: string; createdAt?: string }>;
    }) => Promise<{
      id: string;
      projectId: string;
      source: "plan" | "prd" | "execute" | "eval";
      sourceId: string;
      questions: Array<{ id: string; text: string; createdAt?: string }>;
      status: "open" | "resolved";
      createdAt: string;
      resolvedAt: string | null;
      kind?: string;
    }>;
  };
  maybeAutoRespond?: (projectId: string, notification: { id: string }) => Promise<void>;
}

export class PlanDecomposeGenerateService {
  constructor(
    private deps: PlanDecomposeGenerateDeps,
    private optionalDeps: PlanDecomposeGenerateOptionalDeps = {}
  ) {}

  private async getRepoPath(projectId: string): Promise<string> {
    const project = await this.deps.projectService.getProject(projectId);
    return project.repoPath;
  }

  private async buildPrdContext(projectId: string): Promise<string> {
    try {
      const prd = await this.deps.prdService.getPrd(projectId);
      return buildPrdContextString(prd);
    } catch (err) {
      log.warn("buildPrdContext: PRD unavailable", { err: getErrorMessage(err) });
      return "No PRD exists yet.";
    }
  }

  async autoReviewPlanAgainstRepo(
    projectId: string,
    createdPlans: Array<Plan & { _createdTaskIds?: string[]; _createdTaskTitles?: string[] }>
  ): Promise<void> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.deps.projectService.getSettings(projectId);
    await runAutoReviewPlanAgainstRepo(createdPlans, {
      projectId,
      repoPath,
      settings,
      taskStore: this.deps.taskStore,
    });
  }

  /**
   * Generate implementation tasks for a plan (no epic creation). Returns count and task refs.
   */
  async generateAndCreateTasks(
    projectId: string,
    repoPath: string,
    plan: Plan
  ): Promise<{
    count: number;
    taskRefs: Array<{ id: string; title: string }>;
    parseFailureReason?: string;
  }> {
    const settings = await this.deps.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);
    return generateAndCreateTasksImpl({
      projectId,
      repoPath,
      plan,
      prdContext,
      settings,
      taskStore: this.deps.taskStore,
    });
  }

  /** Plan Tasks: create epic if missing, then generate and create tasks. */
  async planTasks(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.deps.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);
    const { taskStore } = this.deps;
    let epicId = plan.metadata.epicId?.trim() || null;

    if (!epicId) {
      const { planComplexityToTask } = await import("./plan-complexity.js");
      const title = getEpicTitleFromPlanContent(plan.content, planId);
      const epicComplexity = plan.metadata.complexity
        ? planComplexityToTask(plan.metadata.complexity)
        : undefined;
      const epicResult = await taskStore.create(projectId, title, {
        type: "epic",
        ...(epicComplexity != null && { complexity: epicComplexity }),
      });
      epicId = epicResult.id;
      await taskStore.update(projectId, epicId, { description: planId });
      await taskStore.update(projectId, epicId, { status: "blocked" });
      await taskStore.planUpdateMetadata(
        projectId,
        planId,
        { ...plan.metadata, epicId } as unknown as Record<string, unknown>
      );
      log.info("Created missing epic for plan", { planId, epicId, title });
    } else {
      await taskStore.update(projectId, epicId, { status: "blocked" });
    }

    if (plan.taskCount > 0) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "Plan already has implementation tasks. Use Execute! to start building."
      );
    }

    let tasksGenerated = 0;
    let parseFailureReason: string | undefined;
    const planWithEpic: Plan = {
      ...plan,
      metadata: { ...plan.metadata, epicId: epicId ?? plan.metadata.epicId },
    };
    try {
      const genResult = await this.generateAndCreateTasks(projectId, repoPath, planWithEpic);
      tasksGenerated = genResult.count;
      parseFailureReason = genResult.parseFailureReason;
      if (tasksGenerated > 0) {
        const updatedPlan = await this.deps.getPlan(projectId, planId);
        await this.autoReviewPlanAgainstRepo(projectId, [updatedPlan]);
      }
    } catch (err) {
      log.error("Task generation failed", { planId, err });
      throw err;
    }

    if (tasksGenerated === 0) {
      const reason = parseFailureReason?.trim();
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        reason
          ? `Planner did not return valid tasks (${reason}). Try refining the plan content.`
          : "Planner did not return valid tasks. Try refining the plan content.",
        reason ? { parseFailureReason: reason } : undefined
      );
    }

    broadcastToProject(projectId, { type: "plan.updated", planId });
    return this.deps.getPlan(projectId, planId);
  }

  async suggestPlans(projectId: string): Promise<{ plans: SuggestedPlan[] }> {
    const settings = await this.deps.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);
    const repoPath = await this.getRepoPath(projectId);

    const prompt = `Analyze the PRD below and produce a feature decomposition. Output valid JSON with a "plans" array. Each plan has: title, content (full markdown), complexity (low|medium|high|very_high), and tasks array. Each task has: title, description, priority (0-4), dependsOn (array of task titles it depends on), complexity (integer 1-10 only — assign per task based on implementation difficulty, 1=simplest, 10=most complex; use the full range as appropriate, do not bias toward any specific number).`;

    const agentId = `plan-suggest-${projectId}-${Date.now()}`;

    const baseSystemPrompt = DECOMPOSE_SYSTEM_PROMPT + "\n\n## Current PRD\n\n" + prdContext;
    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const systemPrompt = autonomyDesc
      ? `${baseSystemPrompt}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : baseSystemPrompt;

    const suggestSystemPrompt = `${systemPrompt}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
    const response = await agentService.invokePlanningAgent({
      projectId,
      role: "planner",
      config: getAgentForPlanningRole(settings, "planner"),
      messages: [{ role: "user", content: prompt }],
      systemPrompt: suggestSystemPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Feature decomposition (suggest)",
      },
    });

    const planSpecs = parseDecomposeResponse(response.content);
    return { plans: planSpecs };
  }

  async decomposeFromPrd(projectId: string): Promise<{ created: number; plans: Plan[] }> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.deps.projectService.getSettings(projectId);

    const prdContext = await this.buildPrdContext(projectId);

    const prompt = `Analyze the PRD below and produce a feature decomposition. Output valid JSON with a "plans" array. Each plan has: title, content (full markdown), complexity (low|medium|high|very_high), dependsOnPlans (array of slugified plan IDs this plan depends on), and mockups (array of {title, content} — ASCII wireframes). Do NOT include a tasks array; plans are created with markdown and mockups only.`;

    const agentId = `plan-decompose-${projectId}-${Date.now()}`;

    const baseSystemPrompt = DECOMPOSE_SYSTEM_PROMPT + "\n\n## Current PRD\n\n" + prdContext;
    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const systemPrompt = autonomyDesc
      ? `${baseSystemPrompt}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : baseSystemPrompt;

    const decomposeSystemPrompt = `${systemPrompt}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
    const response = await agentService.invokePlanningAgent({
      projectId,
      role: "planner",
      config: getAgentForPlanningRole(settings, "planner"),
      messages: [{ role: "user", content: prompt }],
      systemPrompt: decomposeSystemPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Feature decomposition",
      },
    });

    const planSpecs = parseDecomposeResponse(response.content);

    const created: Plan[] = [];
    for (const spec of planSpecs) {
      const rawContent = spec.content || "# Untitled Feature\n\nNo content.";
      const content = ensureDependenciesSection(
        rawContent,
        normalizeDependsOnPlans(spec as unknown as Record<string, unknown>)
      );
      const plan = await this.deps.createPlan(projectId, {
        title: spec.title || "Untitled Feature",
        content,
        complexity: (spec.complexity as PlanMetadata["complexity"]) || "medium",
        mockups: (spec.mockups ?? []).map((m) => ({
          title: m.title || "Mockup",
          content: m.content || "",
        })),
      });
      created.push(plan);
    }

    try {
      await this.autoReviewPlanAgainstRepo(projectId, created);
    } catch (err) {
      log.error("Auto-review after decompose failed", { err });
    }

    return { created: created.length, plans: created };
  }

  async generatePlanFromDescription(
    projectId: string,
    description: string
  ): Promise<GeneratePlanResult> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.deps.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);

    const systemPrompt = `You are an AI planning assistant for Open Sprint. The user will describe a feature idea in freeform text. Your job is to produce a complete feature plan (markdown and mockups only; no subtasks).

## Output requirement (mandatory)
Your entire response MUST be the plan as a single JSON object. Do NOT write the plan to a file. Do NOT respond with a summary, description, or "here's what I created" text — the system parses your message for JSON only; any prose instead of JSON will cause failure.
You may wrap the JSON in a markdown code block (\`\`\`json ... \`\`\`). The JSON must include at minimum: "title", "content", "complexity", "mockups". Do NOT include a tasks array.

Required JSON shape:
{
  "title": "Feature Name",
  "content": "# Feature Name\\n\\n## Overview\\n...full markdown...",
  "complexity": "medium",
  "mockups": [{"title": "Main Screen", "content": "ASCII wireframe"}]
}

Plan markdown MUST follow this structure (PRD §7.2.3). Each plan's content must include these sections in order:
${getPlanMarkdownSections().map((s) => `- ## ${s}`).join("\n")}

Template structure: ${getPlanTemplateStructure()}

MOCKUPS: Include at least one mockup (ASCII wireframe or text diagram) illustrating key UI for the feature.

Field rules: complexity: low, medium, high, or very_high (plan-level).

**When requirements are unclear:** If the feature idea is too vague to decompose, return JSON with \`open_questions\`: [{ "id": "q1", "text": "Clarification question" }] instead of a plan. The server surfaces these via the Human Notification System; wait for user answers before proceeding.`;

    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const systemPromptWithAutonomy = autonomyDesc
      ? `${systemPrompt}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : systemPrompt;

    const prompt = `Generate a complete feature plan for the following idea.\n\n## Feature Idea\n\n${description}\n\n## PRD Context\n\n${prdContext}`;

    const agentId = `plan-generate-${projectId}-${Date.now()}`;

    const generateSystemPrompt = `${systemPromptWithAutonomy}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
    const response = await agentService.invokePlanningAgent({
      projectId,
      role: "planner",
      config: getAgentForPlanningRole(settings, "planner"),
      messages: [{ role: "user", content: prompt }],
      systemPrompt: generateSystemPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "planner",
        label: "Generate plan from description",
      },
    });

    let parsed: Record<string, unknown> | null =
      extractJsonFromAgentResponse<Record<string, unknown>>(response.content, "open_questions") ??
      extractJsonFromAgentResponse<Record<string, unknown>>(response.content, "openQuestions") ??
      extractJsonFromAgentResponse<Record<string, unknown>>(response.content, "title") ??
      extractJsonFromAgentResponse<Record<string, unknown>>(response.content, "plan_title");

    if (!parsed) {
      const planJsonPath = extractPlanJsonPathFromResponse(response.content);
      if (planJsonPath) {
        parsed = await readPlanJsonFromRepo(repoPath, planJsonPath);
        if (parsed) log.info("Used plan from file (agent wrote to file)", { path: planJsonPath });
      }
    }

    if (!parsed) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        "Planning agent did not return a valid plan. Response: " + response.content.slice(0, 500),
        { responsePreview: response.content.slice(0, 500) }
      );
    }

    const openQuestions = normalizePlannerOpenQuestions(parsed);
    if (openQuestions.length > 0) {
      const { notificationService } = this.optionalDeps;
      const { chatService, maybeAutoRespond } = this.optionalDeps;
      if (!notificationService || !chatService) {
        throw new AppError(
          400,
          ErrorCodes.DECOMPOSE_PARSE_FAILED,
          "Clarification questions require notification and chat services",
          {}
        );
      }
      const draftId = crypto.randomUUID();
      const notification = await notificationService.create({
        projectId,
        source: "plan",
        sourceId: `draft:${draftId}`,
        questions: openQuestions,
      });
      await chatService.startPlanDraftConversation(
        projectId,
        draftId,
        description,
        openQuestions
      );
      broadcastToProject(projectId, {
        type: "notification.added",
        notification: {
          id: notification.id,
          projectId: notification.projectId,
          source: notification.source as "plan" | "prd" | "execute" | "eval",
          sourceId: notification.sourceId,
          questions: notification.questions,
          status: notification.status as "open" | "resolved",
          createdAt: notification.createdAt,
          resolvedAt: notification.resolvedAt,
          kind: "open_question",
        },
      });
      if (maybeAutoRespond) void maybeAutoRespond(projectId, notification);
      return {
        status: "needs_clarification",
        draftId,
        resumeContext: `plan-draft:${draftId}`,
        notification: notification as Notification,
      };
    }

    const spec = normalizePlanSpec(parsed);
    if (!spec.title.trim()) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        "Planning agent did not return a valid plan. Response: " + response.content.slice(0, 500),
        { responsePreview: response.content.slice(0, 500) }
      );
    }

    const plan = await this.deps.createPlan(projectId, {
      title: spec.title,
      content: spec.content || `# ${spec.title}\n\n${description}`,
      complexity: spec.complexity as PlanComplexity | undefined,
      mockups: spec.mockups,
    });

    try {
      await this.autoReviewPlanAgainstRepo(projectId, [plan]);
    } catch (err) {
      log.error("Auto-review after generate failed", { err });
    }

    broadcastToProject(projectId, {
      type: "plan.generated",
      planId: plan.metadata.planId,
    });

    return {
      status: "created",
      plan,
    };
  }
}
