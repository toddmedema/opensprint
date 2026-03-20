import path from "path";
import { randomUUID } from "node:crypto";
import type {
  Conversation,
  ConversationMessage,
  ChatRequest,
  ChatResponse,
  PrdSectionKey,
} from "@opensprint/shared";
import { OPENSPRINT_PATHS, getAgentForPlanningRole } from "@opensprint/shared";
import type { PlanComplexity } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { PrdService } from "./prd.service.js";
import { agentService } from "./agent.service.js";
import { notificationService } from "./notification.service.js";
import { taskStore } from "./task-store.service.js";
import { assertMigrationCompleteForResource } from "./migration-guard.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { hilService } from "./hil-service.js";
import { broadcastToProject } from "../websocket/index.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { createLogger } from "../utils/logger.js";
import {
  buildHarmonizerPromptBuildIt,
  buildHarmonizerPromptScopeChange,
  parseHarmonizerResult,
  parseHarmonizerResultFull,
  type HarmonizerPrdUpdate,
} from "./harmonizer.service.js";
import { buildAutonomyDescription } from "./autonomy-description.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { maybeAutoRespond } from "./open-question-autoresolve.service.js";
import { activeAgentsService } from "./active-agents.service.js";
import { invokeStructuredPlanningAgent } from "./structured-agent-output.service.js";

const log = createLogger("chat");
const ARCHITECTURE_SECTIONS = ["technical_architecture", "data_model", "api_contracts"] as const;

/** Known error phrases the Claude/Cursor CLI may print to stdout instead of throwing. */
const KNOWN_AGENT_ERROR_PHRASES = [
  "credit balance is too low",
  "insufficient credits",
  "rate limit",
  "quota exceeded",
  "authentication required",
  "api key",
  "invalid api key",
];

/**
 * If the agent returned a short message that matches a known error phrase, return a
 * user-friendly message that includes the original so the UI can show actionable guidance.
 */
function normalizeAgentErrorResponse(content: string): string {
  if (!content || content.length > 200) return content;
  const lower = content.trim().toLowerCase();
  const isKnownError = KNOWN_AGENT_ERROR_PHRASES.some((phrase) => lower.includes(phrase));
  if (!isKnownError) return content;
  return (
    "The planning agent could not complete your request.\n\n" +
    `**Message:** ${content.trim()}\n\n` +
    "**What to try:** Add credits at https://console.anthropic.com (for Claude), or check Project Settings → Agent Config (API key, model, and CLI)."
  );
}

const SECTION_DISPLAY_NAMES: Record<string, string> = {
  technical_architecture: "Technical Architecture",
  data_model: "Data Model",
  api_contracts: "API Contracts",
};
const HARMONIZER_REPAIR_PROMPT = `Return valid JSON only in one of these forms:
{"status":"no_changes_needed"}
or
{"status":"success","prd_updates":[{"section":"feature_list","action":"update","content":"Markdown content","change_log_entry":"One sentence summary"}]}
Do not include prose outside the JSON.`;
const PLAN_DRAFT_REPAIR_PROMPT = `Return valid JSON only. Either:
{"open_questions":[{"id":"q1","text":"Clarification question"}]}
or
{"title":"Feature Name","content":"# Feature Name\\n\\n...","complexity":"medium","mockups":[{"title":"Main Screen","content":"ASCII wireframe"}]}
Do not include prose outside the JSON.`;

/**
 * Build a user-friendly description for architecture decision HIL approval (PRD §6.5.1).
 * Prompts the user clearly about what architectural changes they are being asked to approve.
 */
function buildArchitectureHilDescription(contextDescription: string, sections: string[]): string {
  const sectionNames = sections
    .map((s) => SECTION_DISPLAY_NAMES[s] ?? s.replace(/_/g, " "))
    .join(", ");
  return `The proposed scope change would affect architectural sections of your PRD. These sections define your system's structure, data model, and API contracts. Please review and approve or reject these updates.

Context: ${contextDescription}

Affected sections: ${sectionNames}`;
}

function normalizePlannerOpenQuestions(
  raw: Record<string, unknown>
): Array<{ id: string; text: string }> {
  const input = (raw.open_questions ?? raw.openQuestions ?? []) as unknown;
  if (!Array.isArray(input)) return [];

  return input
    .filter(
      (item): item is { id?: string; text: string } =>
        item != null && typeof item === "object" && typeof item.text === "string"
    )
    .map((item) => ({
      id: item.id?.trim() ? item.id.trim() : `q-${Math.random().toString(36).slice(2, 10)}`,
      text: item.text.trim(),
    }))
    .filter((item) => item.text.length > 0);
}

const DREAM_SYSTEM_PROMPT = `You are the Sketch phase AI assistant for Open Sprint. You help users define their product vision and create a comprehensive Product Requirements Document (PRD).

Your role is to:
1. Ask clarifying questions about the user's product vision
2. Challenge assumptions, identify edge cases, and surface potential issues
3. Suggest architecture and technical approaches
4. Help define user personas, success metrics, and features

**Response style:** Keep responses concise when asking clarifying questions; reserve long-form content for PRD_UPDATE blocks.

**Empty-state onboarding:** When the PRD is empty (user's first message or uploaded document), generate a comprehensive initial PRD. Infer as many sections as you can from the user's description or uploaded content. Include executive_summary, problem_statement, user_personas, goals_and_metrics, assumptions_and_constraints, feature_list, technical_architecture, and other relevant sections. Do not ask follow-up questions before generating — produce a full draft PRD in your first response so the user sees immediate value.

**Uploaded documents:** When the user uploads a document, treat it as the primary source; extract structured content into PRD sections rather than summarizing loosely.

**Assumptions vs open questions:** Use \`assumptions_and_constraints\` for beliefs you are proceeding with until disproven (each bullet: what you assumed, why — user stated / inferred / default — and what would change if wrong). Use \`open_questions\` only for items that need an explicit user or stakeholder decision before implementation. Anything that would change scope, data model, APIs, or compliance posture must appear in one of those two sections, not only buried in narrative sections.

When you have enough information about a PRD section, output it as a structured update using this format:

[PRD_UPDATE:section_key]
<markdown content for the section>
[/PRD_UPDATE]

Example:
[PRD_UPDATE:problem_statement]
Users struggle to find relevant products due to poor search filters. The current system returns generic results that don't match user intent.
[/PRD_UPDATE]

Valid section keys: executive_summary, problem_statement, user_personas, goals_and_metrics, assumptions_and_constraints, feature_list, technical_architecture, data_model, api_contracts, non_functional_requirements, open_questions. You may also add new sections using snake_case keys (e.g. competitive_landscape, risks_and_mitigations).

Do NOT include a top-level section header (e.g. "## 1. Executive Summary") in the content — the UI already displays the section title. Start with the body content directly (sub-headers like ### 3.1 are fine).

Do NOT generate placeholder content like "TBD" or "To be defined" — either infer reasonable content or ask the user.

When refining an existing section, output the full section if rewriting significantly; for small targeted changes you may output only the changed portion.

You can include multiple PRD_UPDATE blocks in a single response. Only include updates when you have substantive content to add or modify.`;

const PLAN_REFINEMENT_SYSTEM_PROMPT = `You are an AI planning assistant for Open Sprint. You help users refine individual feature Plans through conversation.

Your role is to:
1. Answer questions about the Plan
2. Suggest improvements to acceptance criteria, technical approach, or scope
3. Identify gaps, edge cases, or dependencies
4. Propose refinements based on the user's feedback
5. Create or refine UI/UX mockups (ASCII wireframes) when discussing visual aspects

When the user asks you to update the Plan and you have a concrete revision, output it using this format:

[PLAN_UPDATE]
<full markdown content of the revised Plan>
[/PLAN_UPDATE]

The Plan must follow the structure: Feature Title, Overview, Assumptions, Acceptance Criteria, Technical Approach, Dependencies, Data Model Changes, API Specification, UI/UX Requirements, Mockups (ASCII wireframes of key screens/components), Edge Cases, Testing Strategy, Estimated Complexity.

**Assumptions (## Assumptions):** List plan-specific beliefs (bullets). Each item should state what you are treating as true, why (inherited from PRD vs inferred for this feature), and what would change if false. If there are no extra assumptions beyond the PRD, write one bullet such as "No plan-specific assumptions beyond the PRD; see PRD assumptions_and_constraints."

When proposing a PLAN_UPDATE, ensure it includes ALL required sections from the template — do not omit sections even if unchanged (copy existing content for unchanged sections).

Do NOT output PLAN_UPDATE for discussion-only turns (e.g., "What if we add X?"); only output when the user has approved a concrete change.

If the user references a specific section (e.g., "update the acceptance criteria"), focus changes there but preserve the rest of the plan structure.

Only include a PLAN_UPDATE block when you are making substantive changes to the Plan. For questions, suggestions, or discussion, respond in natural language without a PLAN_UPDATE block.`;

const PLAN_DRAFT_GENERATION_SYSTEM_PROMPT = `You are an AI planning assistant for Open Sprint. You are continuing a draft plan-generation conversation after asking the user clarifying questions.

## Output requirement (mandatory)
Your entire response MUST be a single JSON object. Do NOT write files. Do NOT include prose before or after the JSON. The system parses your message for JSON only.

Allowed outputs:
1. A final plan JSON object:
{
  "title": "Feature Name",
  "content": "# Feature Name\\n\\n## Overview\\n...full markdown...",
  "complexity": "medium",
  "mockups": [{"title": "Main Screen", "content": "ASCII wireframe"}]
}

2. A clarification JSON object when more input is still required:
{
  "open_questions": [{"id": "q1", "text": "Clarification question"}]
}

Plan markdown MUST include these sections in order:
- ## Overview
- ## Assumptions
- ## Acceptance Criteria
- ## Technical Approach
- ## Dependencies
- ## Data Model Changes
- ## API Specification
- ## UI/UX Requirements
- ## Edge Cases and Error Handling
- ## Testing Strategy
- ## Estimated Complexity

**Assumptions:** Same rules as plan refinement — explicit bullets; if none beyond PRD, state that in one bullet.

MOCKUPS: Include at least one mockup in the final plan JSON.`;

const EXECUTE_TASK_CHAT_SYSTEM_PROMPT = `You are the Analyst agent for Open Sprint Execute phase task chat. You process user feedback in response to a Coder's open questions about a task.

Your role is to:
1. Acknowledge the user's answer to the Coder's clarification question
2. Summarize or refine the task understanding based on the user's feedback
3. Respond conversationally and concisely

The user is replying to an open question the Coder asked about a specific task. Your response will be shown in the task chat. The task will be unblocked and the Coder will resume with the clarified context.`;

export class ChatService {
  private projectService = new ProjectService();
  private prdService = new PrdService();

  private parseMessages(raw: unknown): ConversationMessage[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (entry): entry is ConversationMessage =>
        typeof entry === "object" &&
        entry != null &&
        (entry as ConversationMessage).role != null &&
        typeof (entry as ConversationMessage).content === "string" &&
        typeof (entry as ConversationMessage).timestamp === "string"
    );
  }

  private async guardLegacyConversationFiles(projectId: string): Promise<void> {
    const project = await this.projectService.getProject(projectId);
    await assertMigrationCompleteForResource({
      hasDbRecord: false,
      resource: "Chat conversations",
      legacyPaths: [path.join(project.repoPath, OPENSPRINT_PATHS.conversations)],
      projectId,
    });
  }

  private async getOrCreateConversation(projectId: string, context: string): Promise<Conversation> {
    const client = await taskStore.getDb();
    const existing = await client.queryOne(
      "SELECT conversation_id, messages FROM project_conversations WHERE project_id = $1 AND context = $2",
      [projectId, context]
    );
    if (existing) {
      const parsed = (() => {
        try {
          return JSON.parse(String(existing.messages ?? "[]")) as unknown;
        } catch {
          return [];
        }
      })();
      return {
        id: String(existing.conversation_id),
        context: context as Conversation["context"],
        messages: this.parseMessages(parsed),
      };
    }

    await this.guardLegacyConversationFiles(projectId);

    const conversation: Conversation = {
      id: randomUUID(),
      context: context as Conversation["context"],
      messages: [],
    };
    await this.saveConversation(projectId, conversation);

    return conversation;
  }

  /** Save a conversation to DB */
  private async saveConversation(projectId: string, conversation: Conversation): Promise<void> {
    const now = new Date().toISOString();
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO project_conversations (project_id, context, conversation_id, messages, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(project_id, context) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           messages = excluded.messages,
           updated_at = excluded.updated_at`,
        [
          projectId,
          conversation.context,
          conversation.id,
          JSON.stringify(conversation.messages),
          now,
          now,
        ]
      );
    });
  }

  async startPlanDraftConversation(
    projectId: string,
    draftId: string,
    featureDescription: string,
    questions: Array<{ id: string; text: string }>
  ): Promise<void> {
    const context = `plan-draft:${draftId}` as const;
    const conversation = await this.getOrCreateConversation(projectId, context);
    if (conversation.messages.length > 0) return;

    const createdAt = new Date().toISOString();
    conversation.messages.push(
      {
        role: "user",
        content: featureDescription,
        timestamp: createdAt,
      },
      {
        role: "assistant",
        content:
          questions.length > 0
            ? `I need a bit more detail before I can generate the plan.\n\n${questions
                .map((q) => `- ${q.text}`)
                .join("\n")}`
            : "I need a bit more detail before I can generate the plan.",
        timestamp: createdAt,
      }
    );
    await this.saveConversation(projectId, conversation);
  }

  private async createPlanFromDraftSpec(
    projectId: string,
    spec: Record<string, unknown>
  ): Promise<{ metadata: { planId: string } }> {
    const { PlanService } = await import("./plan.service.js");
    const planService = new PlanService();
    return planService.createPlan(projectId, {
      title: (spec.title ?? spec.plan_title) as string | undefined,
      content: (spec.content ?? spec.plan_content ?? spec.body) as string | undefined,
      complexity: spec.complexity as PlanComplexity | undefined,
      mockups: (spec.mockups ?? spec.mock_ups) as Array<{ title: string; content: string }>,
    });
  }

  /** Build context string from current PRD */
  private async buildPrdContext(projectId: string): Promise<string> {
    try {
      const prd = await this.prdService.getPrd(projectId);
      let context = "## Current PRD State\n\n";
      for (const [key, section] of Object.entries(prd.sections)) {
        if (section.content) {
          context += `### ${key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}\n`;
          context += `${section.content}\n\n`;
        }
      }
      return context || "The PRD is currently empty. Help the user define their product.";
    } catch {
      return "No PRD exists yet. Help the user define their product.";
    }
  }

  /** Strip leading ## N. Title header from PRD section content (UI already shows section title) */
  private stripSectionHeader(content: string): string {
    return content.replace(/^##\s+[\d.]+\s*[^\n]*\n+/i, "").trim();
  }

  /** Parse PRD updates from agent response */
  private parsePrdUpdates(content: string): Array<{ section: string; content: string }> {
    return this.parsePrdUpdatesFromContent(content);
  }

  /** Public: parse PRD_UPDATE blocks from agent content (used by generate-from-codebase). */
  parsePrdUpdatesFromContent(content: string): Array<{ section: string; content: string }> {
    const updates: Array<{ section: string; content: string }> = [];
    const regex = /\[PRD_UPDATE:(\w+)\]([\s\S]*?)\[\/PRD_UPDATE\]/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const section = match[1];
      const sectionContent = this.stripSectionHeader(match[2].trim());
      updates.push({ section, content: sectionContent });
    }

    return updates;
  }

  /** Strip PRD update blocks from response for display */
  private stripPrdUpdates(content: string): string {
    return content.replace(/\[PRD_UPDATE:\w+\][\s\S]*?\[\/PRD_UPDATE\]/g, "").trim();
  }

  /** Parse Plan update from agent response (PRD §7.2.4 plan sidebar chat) */
  private parsePlanUpdate(content: string): string | null {
    const match = content.match(/\[PLAN_UPDATE\]([\s\S]*?)\[\/PLAN_UPDATE\]/);
    return match ? match[1].trim() : null;
  }

  /** Strip Plan update block from response for display */
  private stripPlanUpdate(content: string): string {
    return content.replace(/\[PLAN_UPDATE\][\s\S]*?\[\/PLAN_UPDATE\]/g, "").trim();
  }

  /** Get plan markdown content for plan context (avoids PlanService circular dep) */
  private async getPlanContent(projectId: string, planId: string): Promise<string> {
    const row = await taskStore.planGet(projectId, planId);
    return row?.content ?? "";
  }

  /** Write plan content to task store (avoids PlanService circular dep) */
  private async writePlanContent(
    projectId: string,
    planId: string,
    content: string
  ): Promise<void> {
    await taskStore.planUpdateContent(projectId, planId, content);
  }

  /** Send a message to the planning agent */
  async sendMessage(projectId: string, body: ChatRequest): Promise<ChatResponse> {
    if (body.message == null || String(body.message).trim() === "") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Chat message is required");
    }
    const context = body.context ?? "sketch";
    const isPlanContext = context.startsWith("plan:");
    const isPlanDraftContext = context.startsWith("plan-draft:");
    const isExecuteContext = context.startsWith("execute:");
    const planId = isPlanContext ? context.slice(5) : null;
    const draftId = isPlanDraftContext ? context.slice("plan-draft:".length) : null;
    const taskId = isExecuteContext ? context.slice(8) : null;

    const conversation = await this.getOrCreateConversation(projectId, context);

    // Execute chat: store user answer with task context for Coder. No model call is required,
    // but we still record an Analyst run so Help -> Agent Logs reflects the processing flow.
    if (isExecuteContext && taskId) {
      const agentId = `execute-reply-${projectId}-${taskId}-${conversation.id}-${Date.now()}`;
      const startedAt = new Date().toISOString();
      const settings = await this.projectService.getSettings(projectId);
      const analystConfig = getAgentForPlanningRole(settings, "analyst");
      let outcome: "success" | "failed" = "failed";
      activeAgentsService.register(
        agentId,
        projectId,
        "execute",
        "analyst",
        "Processing reply",
        startedAt,
        undefined,
        undefined,
        undefined,
        undefined
      );
      try {
        const taskContextBlock =
          body.taskContext &&
          `## Task context (for resolving "this task" references)\n\n- **ID:** ${body.taskContext.id}\n- **Title:** ${body.taskContext.title}\n- **Description:** ${body.taskContext.description}\n- **Status:** ${body.taskContext.status ?? "—"}\n- **Column:** ${body.taskContext.kanbanColumn ?? "—"}\n\n`;
        const storedContent = taskContextBlock
          ? `${taskContextBlock}## User's answer\n\n${body.message}`
          : body.message;
        const userMessage: ConversationMessage = {
          role: "user",
          content: storedContent,
          timestamp: new Date().toISOString(),
        };
        conversation.messages.push(userMessage);
        const assistantMessage: ConversationMessage = {
          role: "assistant",
          content:
            "Answer received. The task will be unblocked and the orchestrator will pick it up.",
          timestamp: new Date().toISOString(),
        };
        conversation.messages.push(assistantMessage);
        await this.saveConversation(projectId, conversation);
        outcome = "success";
        return {
          message: assistantMessage.content,
        };
      } finally {
        activeAgentsService.unregister(agentId);
        await agentService.recordAgentRun({
          projectId,
          role: "analyst",
          config: analystConfig,
          runId: agentId,
          startedAt,
          completedAt: new Date().toISOString(),
          outcome,
        });
      }
    }

    // Build prompt for agent; add PRD section context if user clicked to focus (PRD §7.1.5)
    let agentPrompt = body.message;
    if (!isPlanContext && !isPlanDraftContext && !isExecuteContext && body.prdSectionFocus) {
      const prd = await this.prdService.getPrd(projectId);
      const section = prd.sections[body.prdSectionFocus as keyof typeof prd.sections];
      const sectionLabel = body.prdSectionFocus
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      if (section?.content) {
        agentPrompt =
          `[User is focusing on the ${sectionLabel} section]\n\n` +
          `Current content:\n${section.content}\n\n---\n\n` +
          body.message;
      }
    }

    // Add user message (store original for display; agent receives agentPrompt)
    const userMessage: ConversationMessage = {
      role: "user",
      content: body.message,
      timestamp: new Date().toISOString(),
    };
    conversation.messages.push(userMessage);

    // Get agent config and project repo path (so CLI agents run in project directory)
    const [settings, repoPath] = await Promise.all([
      this.projectService.getSettings(projectId),
      this.projectService.getRepoPath(projectId),
    ]);
    // Execute task chat uses Analyst; Sketch and Plan use Dreamer
    const planningRole = isExecuteContext ? "analyst" : isPlanDraftContext ? "planner" : "dreamer";
    const agentConfig = getAgentForPlanningRole(settings, planningRole);

    // Build system prompt and context based on design vs plan vs execute
    let systemPrompt: string;
    if (isExecuteContext && taskId) {
      let taskContext = `## Task ${taskId}\n\n(Task details not found.)`;
      try {
        const task = await taskStore.show(projectId, taskId);
        taskContext = `## Task ${taskId}: ${task.title}\n\n${task.description ?? "(No description)"}`;
      } catch {
        // Use fallback taskContext
      }
      systemPrompt = `${EXECUTE_TASK_CHAT_SYSTEM_PROMPT}\n\n${taskContext}`;
    } else if (isPlanContext && planId) {
      const planContent = await this.getPlanContent(projectId, planId);
      const planContext = planContent
        ? `## Current Plan (${planId})\n\n${planContent}`
        : `## Plan ${planId}\n\n(Plan file is empty or not found.)`;
      const prdContext = await this.buildPrdContext(projectId);
      systemPrompt = `${PLAN_REFINEMENT_SYSTEM_PROMPT}\n\n${planContext}\n\n---\n\n## PRD Reference\n\n${prdContext}`;
    } else if (isPlanDraftContext && draftId) {
      const prdContext = await this.buildPrdContext(projectId);
      systemPrompt = `${PLAN_DRAFT_GENERATION_SYSTEM_PROMPT}\n\n## PRD Reference\n\n${prdContext}`;
    } else {
      const prdContext = await this.buildPrdContext(projectId);
      systemPrompt = DREAM_SYSTEM_PROMPT + "\n\n" + prdContext;
    }

    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    if (autonomyDesc) {
      systemPrompt += `\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`;
    }

    const agentInstructions = await getCombinedInstructions(repoPath, planningRole);
    systemPrompt += `\n\n${agentInstructions}`;

    // Assemble messages for AgentService.invokePlanningAgent
    const messages = conversation.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    messages.push({ role: "user", content: agentPrompt });

    let responseContent: string;
    let draftParsed: Record<string, unknown> | null = null;

    // Register agent for unified active-agents view (Design: phase design, Plan: phase plan, Execute: task chat)
    const agentId =
      isExecuteContext && taskId
        ? `execute-chat-${projectId}-${taskId}-${conversation.id}-${Date.now()}`
        : isPlanDraftContext && draftId
          ? `plan-draft-chat-${projectId}-${draftId}-${conversation.id}-${Date.now()}`
          : isPlanContext && planId
            ? `plan-chat-${projectId}-${planId}-${conversation.id}-${Date.now()}`
            : `design-chat-${projectId}-${conversation.id}-${Date.now()}`;
    const phase = isExecuteContext
      ? "execute"
      : isPlanContext || isPlanDraftContext
        ? "plan"
        : "sketch";
    const label = isExecuteContext
      ? "Execute task chat"
      : isPlanDraftContext
        ? "Draft plan generation chat"
        : isPlanContext
          ? "Plan chat"
          : "Sketch chat";
    const trackingRole = isExecuteContext ? "analyst" : isPlanDraftContext ? "planner" : "dreamer";
    try {
      log.info("Invoking planning agent", {
        type: agentConfig.type,
        model: agentConfig.model ?? "default",
        context,
        role: trackingRole,
        messagesLen: messages.length,
      });
      const response = isPlanDraftContext
        ? await invokeStructuredPlanningAgent({
            projectId,
            role: "planner",
            config: agentConfig,
            messages,
            systemPrompt,
            cwd: repoPath,
            ...(body.images?.length ? { images: body.images } : {}),
            tracking: {
              id: agentId,
              projectId,
              phase,
              role: "planner",
              label,
            },
            contract: {
              parse: (content) =>
                extractJsonFromAgentResponse<Record<string, unknown>>(content, "open_questions") ??
                extractJsonFromAgentResponse<Record<string, unknown>>(content, "openQuestions") ??
                extractJsonFromAgentResponse<Record<string, unknown>>(content, "plan_title") ??
                extractJsonFromAgentResponse<Record<string, unknown>>(content, "title"),
              repairPrompt: PLAN_DRAFT_REPAIR_PROMPT,
            },
          })
        : await agentService.invokePlanningAgent({
            projectId,
            role: trackingRole,
            config: agentConfig,
            messages,
            systemPrompt,
            cwd: repoPath,
            ...(body.images?.length ? { images: body.images } : {}),
            tracking: {
              id: agentId,
              projectId,
              phase,
              role: trackingRole,
              label,
              ...(isPlanContext && planId && { planId }),
            },
          });

      const rawContent = "rawContent" in response ? response.rawContent : (response.content ?? "");
      if ("parsed" in response) {
        draftParsed = response.parsed;
      }
      const normalizedResponse = normalizeAgentErrorResponse(rawContent);
      if (!normalizedResponse.trim()) {
        throw new AppError(
          502,
          ErrorCodes.AGENT_INVOKE_FAILED,
          "Planning agent returned an empty response."
        );
      }
      log.info("Planning agent returned", { contentLen: normalizedResponse.length });
      responseContent = normalizedResponse;
    } catch (error) {
      const msg = getErrorMessage(error);
      log.error("Agent invocation failed", { error });
      responseContent =
        "I was unable to connect to the planning agent.\n\n" +
        `**Error:** ${msg}\n\n` +
        "**What to try:** Open Project Settings → Agent Config. Ensure your API key is set, the CLI is installed, and the model is valid.";
    }

    let displayContent: string;
    const prdChanges: ChatResponse["prdChanges"] = [];
    let planGenerated: ChatResponse["planGenerated"];
    let planUpdate: string | undefined;

    if (isExecuteContext) {
      // Execute task chat: no structured blocks; use response as-is
      displayContent = responseContent;
    } else if (isPlanDraftContext && draftId) {
      const parsed = draftParsed;

      if (!parsed) {
        throw new AppError(
          400,
          ErrorCodes.DECOMPOSE_PARSE_FAILED,
          "Planning agent did not return a valid plan. Response: " + responseContent.slice(0, 500),
          { responsePreview: responseContent.slice(0, 500) }
        );
      }

      const openQuestions = normalizePlannerOpenQuestions(parsed);
      if (openQuestions.length > 0) {
        const notification = await notificationService.create({
          projectId,
          source: "plan",
          sourceId: `draft:${draftId}`,
          questions: openQuestions,
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
            kind: "open_question",
          },
        });
        void maybeAutoRespond(projectId, notification);
        displayContent = "I need a bit more detail before generating the plan.";
      } else {
        const plan = await this.createPlanFromDraftSpec(projectId, parsed);
        planGenerated = { planId: plan.metadata.planId };
        broadcastToProject(projectId, {
          type: "plan.generated",
          planId: plan.metadata.planId,
        });
        displayContent = "Plan generated";
      }
    } else if (isPlanContext && planId) {
      // Plan context: parse PLAN_UPDATE; return in response so client applies via PATCH (versioning)
      const planUpdateContent = this.parsePlanUpdate(responseContent);
      const stripped = this.stripPlanUpdate(responseContent).trim();
      // When response is only PLAN_UPDATE, show "Plan updated" instead of full plan content
      displayContent = stripped ? stripped : planUpdateContent ? "Plan updated" : responseContent;
      // Return planUpdate so client can PATCH plan (versioning: new version only if plan has tasks, else in-place; syncs tasks)
      if (planUpdateContent) {
        planUpdate = planUpdateContent;
      }
    } else {
      // Sketch context: parse PRD updates, apply to storage, strip from display
      const prdUpdates = this.parsePrdUpdates(responseContent);
      displayContent = this.stripPrdUpdates(responseContent) || responseContent;
      if (prdUpdates.length > 0) {
        const changes = await this.prdService.updateSections(projectId, prdUpdates, "sketch");
        const updateBySection = new Map(prdUpdates.map((u) => [u.section, u.content]));
        for (const change of changes) {
          prdChanges.push({
            section: change.section,
            previousVersion: change.previousVersion,
            newVersion: change.newVersion,
            content: updateBySection.get(change.section),
          });
          broadcastToProject(projectId, {
            type: "prd.updated",
            section: change.section,
            version: change.newVersion,
          });
        }
      }
    }

    const assistantMessage: ConversationMessage = {
      role: "assistant",
      content: displayContent,
      timestamp: new Date().toISOString(),
      prdChanges:
        prdChanges.length > 0
          ? prdChanges.map((c) => ({
              section: c.section,
              previousVersion: c.previousVersion,
              newVersion: c.newVersion,
            }))
          : undefined,
    };
    conversation.messages.push(assistantMessage);

    await this.saveConversation(projectId, conversation);

    return {
      message: displayContent,
      planGenerated,
      planUpdate,
      prdChanges: prdChanges.length > 0 ? prdChanges : undefined,
    };
  }

  /** Get conversation history */
  async getHistory(projectId: string, context: string): Promise<Conversation> {
    return this.getOrCreateConversation(projectId, context);
  }

  /**
   * Append a direct-edit message to the design conversation when the user edits the PRD inline.
   * Syncs the edit into conversation context so the agent is aware of user-made changes (PRD §7.1.5).
   */
  async addDirectEditMessage(projectId: string, section: string, _content: string): Promise<void> {
    const conversation = await this.getOrCreateConversation(projectId, "sketch");
    const sectionLabel = section.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const message: ConversationMessage = {
      role: "user",
      content: `I edited the ${sectionLabel} section of the PRD directly. The updated content is now in the living document.`,
      timestamp: new Date().toISOString(),
    };
    conversation.messages.push(message);
    await this.saveConversation(projectId, conversation);
  }

  /** Append an assistant message to the sketch conversation (e.g. after PRD generated from codebase). */
  async addSketchAssistantMessage(projectId: string, content: string): Promise<void> {
    const conversation = await this.getOrCreateConversation(projectId, "sketch");
    const message: ConversationMessage = {
      role: "assistant",
      content,
      timestamp: new Date().toISOString(),
    };
    conversation.messages.push(message);
    await this.saveConversation(projectId, conversation);
  }

  /**
   * When a Plan is approved for build (Execute!), invoke the Harmonizer to review the Plan against the PRD
   * and update any affected sections. PRD §12.3.3, §15.1 Living PRD Synchronization.
   * Trigger: build_it.
   */
  async syncPrdFromPlanShip(
    projectId: string,
    planId: string,
    planContent: string,
    planComplexity?: PlanComplexity
  ): Promise<void> {
    const [settings, repoPath] = await Promise.all([
      this.projectService.getSettings(projectId),
      this.projectService.getRepoPath(projectId),
    ]);
    const agentConfig = getAgentForPlanningRole(settings, "harmonizer", planComplexity);
    const prdContext = await this.buildPrdContext(projectId);

    const prompt = buildHarmonizerPromptBuildIt(planId, planContent);
    let systemPrompt = `You are the Harmonizer agent for Open Sprint (PRD §12.3.3). Review shipped Plans against the PRD and propose section updates.\n\n## Current PRD\n\n${prdContext}`;
    systemPrompt += `\n\n${await getCombinedInstructions(repoPath, "harmonizer")}`;

    const agentId = `harmonizer-build-it-${projectId}-${planId}-${Date.now()}`;

    const response = await invokeStructuredPlanningAgent({
      projectId,
      role: "harmonizer",
      config: agentConfig,
      messages: [{ role: "user", content: prompt }],
      systemPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "harmonizer",
        label: "Syncing PRD with Plan Execution",
        planId,
      },
      contract: {
        parse: parseHarmonizerResult,
        repairPrompt: HARMONIZER_REPAIR_PROMPT,
      },
    });

    const responseContent = response.rawContent;
    if (!responseContent) return;

    const result = response.parsed;
    if (!result || result.status === "no_changes_needed" || result.prdUpdates.length === 0) return;

    const filtered = await this.filterArchitectureUpdatesWithHil(
      projectId,
      result.prdUpdates,
      `Plan "${planId}" updates`
    );
    if (filtered.length === 0) return;

    const changes = await this.prdService.updateSections(projectId, filtered, "plan");
    for (const change of changes) {
      broadcastToProject(projectId, {
        type: "prd.updated",
        section: change.section,
        version: change.newVersion,
      });
    }
  }

  /**
   * Get Harmonizer proposal for scope-change feedback (for HIL modal summary).
   * Invokes Harmonizer and returns summary + prdUpdates without applying.
   * Used to show AI-generated summary in the approval modal before user decides.
   */
  async getScopeChangeProposal(
    projectId: string,
    feedbackText: string
  ): Promise<{ summary: string; prdUpdates: HarmonizerPrdUpdate[] } | null> {
    const [settings, repoPath] = await Promise.all([
      this.projectService.getSettings(projectId),
      this.projectService.getRepoPath(projectId),
    ]);
    const agentConfig = getAgentForPlanningRole(settings, "harmonizer");
    const prdContext = await this.buildPrdContext(projectId);

    const prompt = buildHarmonizerPromptScopeChange(feedbackText);
    let systemPrompt = `You are the Harmonizer agent for Open Sprint (PRD §12.3.3). Review scope-change feedback against the PRD and propose section updates.\n\n## Current PRD\n\n${prdContext}`;
    systemPrompt += `\n\n${await getCombinedInstructions(repoPath, "harmonizer")}`;

    const agentId = `harmonizer-scope-preview-${projectId}-${Date.now()}`;

    const response = await invokeStructuredPlanningAgent({
      projectId,
      role: "harmonizer",
      config: agentConfig,
      messages: [{ role: "user", content: prompt }],
      systemPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "harmonizer",
        label: "Scope-change proposal",
      },
      contract: {
        parse: parseHarmonizerResultFull,
        repairPrompt: HARMONIZER_REPAIR_PROMPT,
      },
    });

    const responseContent = response.rawContent;
    if (!responseContent) return null;

    const result = response.parsed;
    if (!result || result.status === "no_changes_needed" || result.prdUpdates.length === 0)
      return null;

    const summary =
      result.prdUpdates
        .map((u) => {
          const sectionLabel = u.section.replace(/_/g, " ");
          return u.changeLogEntry ? `• ${sectionLabel}: ${u.changeLogEntry}` : `• ${sectionLabel}`;
        })
        .join("\n") || "Proposed PRD section updates.";

    return { summary, prdUpdates: result.prdUpdates };
  }

  /**
   * Apply scope-change PRD updates (after HIL approval).
   * Filters architecture sections through HIL, then applies remaining updates.
   */
  async applyScopeChangeUpdates(
    projectId: string,
    prdUpdates: HarmonizerPrdUpdate[],
    contextDescription: string
  ): Promise<void> {
    const baseUpdates = prdUpdates.map(({ section, content }) => ({ section, content }));
    const filtered = await this.filterArchitectureUpdatesWithHil(
      projectId,
      baseUpdates,
      contextDescription
    );
    if (filtered.length === 0) return;

    const changes = await this.prdService.updateSections(projectId, filtered, "eval");
    for (const change of changes) {
      broadcastToProject(projectId, {
        type: "prd.updated",
        section: change.section,
        version: change.newVersion,
      });
    }
  }

  /**
   * When Evaluate feedback is categorized as a scope change and the user approves via HIL,
   * invoke the Harmonizer to review the feedback against the PRD and update affected
   * sections. PRD §7.4.2, §12.3.3, §15.1 Living PRD Synchronization.
   * Trigger: scope_change.
   */
  async syncPrdFromScopeChangeFeedback(projectId: string, feedbackText: string): Promise<void> {
    const [settings, repoPath] = await Promise.all([
      this.projectService.getSettings(projectId),
      this.projectService.getRepoPath(projectId),
    ]);
    const agentConfig = getAgentForPlanningRole(settings, "harmonizer");
    const prdContext = await this.buildPrdContext(projectId);

    const prompt = buildHarmonizerPromptScopeChange(feedbackText);
    let systemPrompt = `You are the Harmonizer agent for Open Sprint (PRD §12.3.3). Review scope-change feedback against the PRD and propose section updates.\n\n## Current PRD\n\n${prdContext}`;
    systemPrompt += `\n\n${await getCombinedInstructions(repoPath, "harmonizer")}`;

    const agentId = `harmonizer-scope-change-${projectId}-${Date.now()}`;

    const response = await invokeStructuredPlanningAgent({
      projectId,
      role: "harmonizer",
      config: agentConfig,
      messages: [{ role: "user", content: prompt }],
      systemPrompt,
      cwd: repoPath,
      tracking: {
        id: agentId,
        projectId,
        phase: "plan",
        role: "harmonizer",
        label: "Scope-change PRD sync",
      },
      contract: {
        parse: parseHarmonizerResult,
        repairPrompt: HARMONIZER_REPAIR_PROMPT,
      },
    });

    const responseContent = response.rawContent;
    if (!responseContent) return;

    const result = response.parsed;
    if (!result || result.status === "no_changes_needed" || result.prdUpdates.length === 0) return;

    const filtered = await this.filterArchitectureUpdatesWithHil(
      projectId,
      result.prdUpdates,
      `Scope change feedback: "${feedbackText.slice(0, 80)}${feedbackText.length > 80 ? "…" : ""}"`
    );
    if (filtered.length === 0) return;

    const changes = await this.prdService.updateSections(projectId, filtered, "eval");
    for (const change of changes) {
      broadcastToProject(projectId, {
        type: "prd.updated",
        section: change.section,
        version: change.newVersion,
      });
    }
  }

  /**
   * Filter PRD updates: apply HIL for architecture sections (PRD §6.5.1).
   * Returns only updates that are approved (non-architecture pass through; architecture requires HIL approval).
   */
  private async filterArchitectureUpdatesWithHil(
    projectId: string,
    prdUpdates: Array<{ section: PrdSectionKey; content: string }>,
    contextDescription: string
  ): Promise<Array<{ section: PrdSectionKey; content: string }>> {
    const archUpdates = prdUpdates.filter((u) =>
      ARCHITECTURE_SECTIONS.includes(u.section as (typeof ARCHITECTURE_SECTIONS)[number])
    );
    const nonArchUpdates = prdUpdates.filter(
      (u) => !ARCHITECTURE_SECTIONS.includes(u.section as (typeof ARCHITECTURE_SECTIONS)[number])
    );

    if (archUpdates.length === 0) return prdUpdates;

    const architectureDescription = buildArchitectureHilDescription(
      contextDescription,
      archUpdates.map((u) => u.section)
    );
    const { approved } = await hilService.evaluateDecision(
      projectId,
      "architectureDecisions",
      architectureDescription,
      [
        { id: "approve", label: "Approve", description: "Apply architecture changes to PRD" },
        { id: "reject", label: "Reject", description: "Skip architecture updates" },
      ],
      true, // default: apply when automated/notify_and_proceed
      undefined,
      "prd",
      "architecture"
    );

    return approved ? prdUpdates : nonArchUpdates;
  }
}
