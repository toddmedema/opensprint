import fs from "fs/promises";
import path from "path";
import { v4 as uuid } from "uuid";
import type {
  Conversation,
  ConversationMessage,
  ChatRequest,
  ChatResponse,
  PrdSectionKey,
} from "@opensprint/shared";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { PrdService } from "./prd.service.js";
import { agentService } from "./agent.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { hilService } from "./hil-service.js";
import { activeAgentsService } from "./active-agents.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { writeJsonAtomic } from "../utils/file-utils.js";
import {
  buildHarmonizerPromptBuildIt,
  buildHarmonizerPromptScopeChange,
  parseHarmonizerResult,
  parseHarmonizerResultFull,
  type HarmonizerPrdUpdate,
} from "./harmonizer.service.js";

const ARCHITECTURE_SECTIONS = ["technical_architecture", "data_model", "api_contracts"] as const;

const SECTION_DISPLAY_NAMES: Record<string, string> = {
  technical_architecture: "Technical Architecture",
  data_model: "Data Model",
  api_contracts: "API Contracts",
};

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

const DREAM_SYSTEM_PROMPT = `You are the Sketch phase AI assistant for OpenSprint. You help users define their product vision and create a comprehensive Product Requirements Document (PRD).

Your role is to:
1. Ask clarifying questions about the user's product vision
2. Challenge assumptions and identify edge cases
3. Suggest architecture and technical approaches
4. Help define user personas, success metrics, and features
5. Proactively identify potential issues

**Empty-state onboarding:** When the PRD is empty (user's first message or uploaded document), generate a comprehensive initial PRD. Infer as many sections as you can from the user's description or uploaded content. Include executive_summary, problem_statement, user_personas, goals_and_metrics, feature_list, technical_architecture, and other relevant sections. Do not ask follow-up questions before generating — produce a full draft PRD in your first response so the user sees immediate value.

When you have enough information about a PRD section, output it as a structured update using this format:

[PRD_UPDATE:section_key]
<markdown content for the section>
[/PRD_UPDATE]

Valid section keys: executive_summary, problem_statement, user_personas, goals_and_metrics, feature_list, technical_architecture, data_model, api_contracts, non_functional_requirements, open_questions

Do NOT include a top-level section header (e.g. "## 1. Executive Summary") in the content — the UI already displays the section title. Start with the body content directly (sub-headers like ### 3.1 are fine).

You can include multiple PRD_UPDATE blocks in a single response. Only include updates when you have substantive content to add or modify.`;

const PLAN_REFINEMENT_SYSTEM_PROMPT = `You are an AI planning assistant for OpenSprint. You help users refine individual feature Plans through conversation.

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

The Plan must follow the structure: Feature Title, Overview, Acceptance Criteria, Technical Approach, Dependencies, Data Model Changes, API Specification, UI/UX Requirements, Mockups (ASCII wireframes of key screens/components), Edge Cases, Testing Strategy, Estimated Complexity.

Only include a PLAN_UPDATE block when you are making substantive changes to the Plan. For questions, suggestions, or discussion, respond in natural language without a PLAN_UPDATE block.`;

export class ChatService {
  private projectService = new ProjectService();
  private prdService = new PrdService();

  /** Get conversations directory for a project */
  private async getConversationsDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.conversations);
  }

  /** Normalize context: "spec" is legacy alias for "sketch". */
  private normalizeContext(context: string): string {
    return context === "spec" ? "sketch" : context;
  }

  /** Find or create a conversation for a given context. Accepts "spec" as alias for "sketch". */
  private async getOrCreateConversation(projectId: string, context: string): Promise<Conversation> {
    const canonical = this.normalizeContext(context);
    const dir = await this.getConversationsDir(projectId);

    // Look for existing conversation (check both canonical and legacy "spec" for sketch phase)
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const data = await fs.readFile(path.join(dir, file), "utf-8");
          const conv = JSON.parse(data) as Conversation;
          const convCanonical = this.normalizeContext(conv.context as string);
          if (convCanonical === canonical) {
            // Migrate legacy context to canonical when loading
            if (conv.context !== canonical) {
              conv.context = canonical as Conversation["context"];
              await this.saveConversation(projectId, conv);
            }
            return conv;
          }
        }
      }
    } catch {
      // Directory may not exist yet
    }

    // Create new conversation
    const conversation: Conversation = {
      id: uuid(),
      context: canonical as Conversation["context"],
      messages: [],
    };

    await fs.mkdir(dir, { recursive: true });
    await this.saveConversation(projectId, conversation);

    return conversation;
  }

  /** Save a conversation to disk */
  private async saveConversation(projectId: string, conversation: Conversation): Promise<void> {
    const dir = await this.getConversationsDir(projectId);
    const finalPath = path.join(dir, `${conversation.id}.json`);
    await writeJsonAtomic(finalPath, conversation);
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
  private parsePrdUpdates(content: string): Array<{ section: PrdSectionKey; content: string }> {
    const updates: Array<{ section: PrdSectionKey; content: string }> = [];
    const regex = /\[PRD_UPDATE:(\w+)\]([\s\S]*?)\[\/PRD_UPDATE\]/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const section = match[1] as PrdSectionKey;
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
    const project = await this.projectService.getProject(projectId);
    const planPath = path.join(project.repoPath, OPENSPRINT_PATHS.plans, `${planId}.md`);
    try {
      return await fs.readFile(planPath, "utf-8");
    } catch {
      return "";
    }
  }

  /** Write plan markdown (avoids PlanService circular dep) */
  private async writePlanContent(
    projectId: string,
    planId: string,
    content: string
  ): Promise<void> {
    const project = await this.projectService.getProject(projectId);
    const plansDir = path.join(project.repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planPath = path.join(plansDir, `${planId}.md`);
    await fs.writeFile(planPath, content);
  }

  /** Send a message to the planning agent */
  async sendMessage(projectId: string, body: ChatRequest): Promise<ChatResponse> {
    if (body.message == null || String(body.message).trim() === "") {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Chat message is required");
    }
    const context = body.context ?? "sketch";
    const isPlanContext = context.startsWith("plan:");
    const planId = isPlanContext ? context.slice(5) : null;

    const conversation = await this.getOrCreateConversation(projectId, context);

    // Build prompt for agent; add PRD section context if user clicked to focus (PRD §7.1.5)
    let agentPrompt = body.message;
    if (!isPlanContext && body.prdSectionFocus) {
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

    // Get agent config
    const settings = await this.projectService.getSettings(projectId);
    const agentConfig = settings.planningAgent;

    // Build system prompt and context based on design vs plan
    let systemPrompt: string;
    if (isPlanContext && planId) {
      const planContent = await this.getPlanContent(projectId, planId);
      const planContext = planContent
        ? `## Current Plan (${planId})\n\n${planContent}`
        : `## Plan ${planId}\n\n(Plan file is empty or not found.)`;
      const prdContext = await this.buildPrdContext(projectId);
      systemPrompt = `${PLAN_REFINEMENT_SYSTEM_PROMPT}\n\n${planContext}\n\n---\n\n## PRD Reference\n\n${prdContext}`;
    } else {
      const prdContext = await this.buildPrdContext(projectId);
      systemPrompt = DREAM_SYSTEM_PROMPT + "\n\n" + prdContext;
    }

    // Assemble messages for AgentService.invokePlanningAgent
    const messages = conversation.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    messages.push({ role: "user", content: agentPrompt });

    let responseContent: string;

    // Register agent for unified active-agents view (Design: phase design, Plan: phase plan)
    const agentId =
      isPlanContext && planId
        ? `plan-chat-${projectId}-${planId}-${conversation.id}-${Date.now()}`
        : `design-chat-${projectId}-${conversation.id}-${Date.now()}`;
    const phase = isPlanContext ? "plan" : "sketch";
    const label = isPlanContext ? "Plan chat" : "Sketch chat";
    activeAgentsService.register(
      agentId,
      projectId,
      phase,
      "dreamer",
      label,
      new Date().toISOString()
    );

    try {
      console.log("[chat] Invoking planning agent", {
        type: agentConfig.type,
        model: agentConfig.model ?? "default",
        context,
        messagesLen: messages.length,
      });
      const response = await agentService.invokePlanningAgent({
        config: agentConfig,
        messages,
        systemPrompt,
      });

      console.log("[chat] Planning agent returned", { contentLen: response.content?.length ?? 0 });
      responseContent = response.content;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Agent invocation failed:", error);
      responseContent =
        "I was unable to connect to the planning agent.\n\n" +
        `**Error:** ${msg}\n\n` +
        "**What to try:** Open Project Settings → Agent Config. Ensure your API key is set, the CLI is installed, and the model is valid.";
    } finally {
      activeAgentsService.unregister(agentId);
    }

    let displayContent: string;
    const prdChanges: ChatResponse["prdChanges"] = [];

    if (isPlanContext && planId) {
      // Plan context: parse PLAN_UPDATE, apply, strip from display
      const planUpdate = this.parsePlanUpdate(responseContent);
      displayContent = this.stripPlanUpdate(responseContent).trim() || responseContent;
      if (planUpdate) {
        await this.writePlanContent(projectId, planId, planUpdate);
        broadcastToProject(projectId, { type: "plan.updated", planId });
      }
    } else {
      // Sketch context: parse PRD updates, apply, strip from display
      const prdUpdates = this.parsePrdUpdates(responseContent);
      displayContent = this.stripPrdUpdates(responseContent) || responseContent;
      if (prdUpdates.length > 0) {
        const changes = await this.prdService.updateSections(projectId, prdUpdates, "sketch");
        for (const change of changes) {
          prdChanges.push({
            section: change.section,
            previousVersion: change.previousVersion,
            newVersion: change.newVersion,
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

  /**
   * When a Plan is approved for build (Execute!), invoke the Harmonizer to review the Plan against the PRD
   * and update any affected sections. PRD §12.3.3, §15.1 Living PRD Synchronization.
   * Trigger: build_it.
   */
  async syncPrdFromPlanShip(projectId: string, planId: string, planContent: string): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const agentConfig = settings.planningAgent;
    const prdContext = await this.buildPrdContext(projectId);

    const prompt = buildHarmonizerPromptBuildIt(planId, planContent);
    const systemPrompt = `You are the Harmonizer agent for OpenSprint (PRD §12.3.3). Review shipped Plans against the PRD and propose section updates.\n\n## Current PRD\n\n${prdContext}`;

    const agentId = `harmonizer-build-it-${projectId}-${planId}-${Date.now()}`;
    activeAgentsService.register(
      agentId,
      projectId,
      "plan",
      "harmonizer",
      "Execute! PRD sync",
      new Date().toISOString()
    );

    let response;
    try {
      response = await agentService.invokePlanningAgent({
        config: agentConfig,
        messages: [{ role: "user", content: prompt }],
        systemPrompt,
      });
    } finally {
      activeAgentsService.unregister(agentId);
    }

    const legacyUpdates = this.parsePrdUpdates(response.content);
    const result = parseHarmonizerResult(response.content, legacyUpdates);
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
    const settings = await this.projectService.getSettings(projectId);
    const agentConfig = settings.planningAgent;
    const prdContext = await this.buildPrdContext(projectId);

    const prompt = buildHarmonizerPromptScopeChange(feedbackText);
    const systemPrompt = `You are the Harmonizer agent for OpenSprint (PRD §12.3.3). Review scope-change feedback against the PRD and propose section updates.\n\n## Current PRD\n\n${prdContext}`;

    const agentId = `harmonizer-scope-preview-${projectId}-${Date.now()}`;
    activeAgentsService.register(
      agentId,
      projectId,
      "plan",
      "harmonizer",
      "Scope-change proposal",
      new Date().toISOString()
    );

    let response;
    try {
      response = await agentService.invokePlanningAgent({
        config: agentConfig,
        messages: [{ role: "user", content: prompt }],
        systemPrompt,
      });
    } finally {
      activeAgentsService.unregister(agentId);
    }

    const legacyUpdates = this.parsePrdUpdates(response.content);
    const result = parseHarmonizerResultFull(response.content, legacyUpdates);
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
   * When Eval feedback is categorized as a scope change and the user approves via HIL,
   * invoke the Harmonizer to review the feedback against the PRD and update affected
   * sections. PRD §7.4.2, §12.3.3, §15.1 Living PRD Synchronization.
   * Trigger: scope_change.
   */
  async syncPrdFromScopeChangeFeedback(projectId: string, feedbackText: string): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const agentConfig = settings.planningAgent;
    const prdContext = await this.buildPrdContext(projectId);

    const prompt = buildHarmonizerPromptScopeChange(feedbackText);
    const systemPrompt = `You are the Harmonizer agent for OpenSprint (PRD §12.3.3). Review scope-change feedback against the PRD and propose section updates.\n\n## Current PRD\n\n${prdContext}`;

    const agentId = `harmonizer-scope-change-${projectId}-${Date.now()}`;
    activeAgentsService.register(
      agentId,
      projectId,
      "plan",
      "harmonizer",
      "Scope-change PRD sync",
      new Date().toISOString()
    );

    let response;
    try {
      response = await agentService.invokePlanningAgent({
        config: agentConfig,
        messages: [{ role: "user", content: prompt }],
        systemPrompt,
      });
    } finally {
      activeAgentsService.unregister(agentId);
    }

    const legacyUpdates = this.parsePrdUpdates(response.content);
    const result = parseHarmonizerResult(response.content, legacyUpdates);
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
      true // default: apply when automated/notify_and_proceed
    );

    return approved ? prdUpdates : nonArchUpdates;
  }
}
