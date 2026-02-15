import fs from 'fs/promises';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type {
  Conversation,
  ConversationMessage,
  ChatRequest,
  ChatResponse,
  Prd,
  PrdSectionKey,
} from '@opensprint/shared';
import { OPENSPRINT_PATHS } from '@opensprint/shared';
import { ProjectService } from './project.service.js';
import { PrdService } from './prd.service.js';
import { AgentClient } from './agent-client.js';
import { broadcastToProject } from '../websocket/index.js';

const DESIGN_SYSTEM_PROMPT = `You are an AI product design assistant for OpenSprint. You help users define their product vision and create a comprehensive Product Requirements Document (PRD).

Your role is to:
1. Ask clarifying questions about the user's product vision
2. Challenge assumptions and identify edge cases
3. Suggest architecture and technical approaches
4. Help define user personas, success metrics, and features
5. Proactively identify potential issues

When you have enough information about a PRD section, output it as a structured update using this format:

[PRD_UPDATE:section_key]
<markdown content for the section>
[/PRD_UPDATE]

Valid section keys: executive_summary, problem_statement, user_personas, goals_and_metrics, feature_list, technical_architecture, data_model, api_contracts, non_functional_requirements, open_questions

You can include multiple PRD_UPDATE blocks in a single response. Only include updates when you have substantive content to add or modify.`;

const PLAN_REFINEMENT_SYSTEM_PROMPT = `You are an AI planning assistant for OpenSprint. You help users refine individual feature Plans through conversation.

Your role is to:
1. Answer questions about the Plan
2. Suggest improvements to acceptance criteria, technical approach, or scope
3. Identify gaps, edge cases, or dependencies
4. Propose refinements based on the user's feedback

When the user asks you to update the Plan and you have a concrete revision, output it using this format:

[PLAN_UPDATE]
<full markdown content of the revised Plan>
[/PLAN_UPDATE]

The Plan must follow the structure: Feature Title, Overview, Acceptance Criteria, Technical Approach, Dependencies, Data Model Changes, API Specification, UI/UX Requirements, Edge Cases, Testing Strategy, Estimated Complexity.

Only include a PLAN_UPDATE block when you are making substantive changes to the Plan. For questions, suggestions, or discussion, respond in natural language without a PLAN_UPDATE block.`;

export class ChatService {
  private projectService = new ProjectService();
  private prdService = new PrdService();
  private agentClient = new AgentClient();

  /** Get conversations directory for a project */
  private async getConversationsDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.conversations);
  }

  /** Find or create a conversation for a given context */
  private async getOrCreateConversation(
    projectId: string,
    context: string,
  ): Promise<Conversation> {
    const dir = await this.getConversationsDir(projectId);

    // Look for existing conversation with this context
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const data = await fs.readFile(path.join(dir, file), 'utf-8');
          const conv = JSON.parse(data) as Conversation;
          if (conv.context === context) {
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
      context: context as Conversation['context'],
      messages: [],
    };

    await fs.mkdir(dir, { recursive: true });
    await this.saveConversation(projectId, conversation);

    return conversation;
  }

  /** Save a conversation to disk */
  private async saveConversation(projectId: string, conversation: Conversation): Promise<void> {
    const dir = await this.getConversationsDir(projectId);
    const tmpPath = path.join(dir, `${conversation.id}.json.tmp`);
    const finalPath = path.join(dir, `${conversation.id}.json`);
    await fs.writeFile(tmpPath, JSON.stringify(conversation, null, 2));
    await fs.rename(tmpPath, finalPath);
  }

  /** Build context string from current PRD */
  private async buildPrdContext(projectId: string): Promise<string> {
    try {
      const prd = await this.prdService.getPrd(projectId);
      let context = '## Current PRD State\n\n';
      for (const [key, section] of Object.entries(prd.sections)) {
        if (section.content) {
          context += `### ${key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}\n`;
          context += `${section.content}\n\n`;
        }
      }
      return context || 'The PRD is currently empty. Help the user define their product.';
    } catch {
      return 'No PRD exists yet. Help the user define their product.';
    }
  }

  /** Parse PRD updates from agent response */
  private parsePrdUpdates(content: string): Array<{ section: PrdSectionKey; content: string }> {
    const updates: Array<{ section: PrdSectionKey; content: string }> = [];
    const regex = /\[PRD_UPDATE:(\w+)\]([\s\S]*?)\[\/PRD_UPDATE\]/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const section = match[1] as PrdSectionKey;
      const sectionContent = match[2].trim();
      updates.push({ section, content: sectionContent });
    }

    return updates;
  }

  /** Strip PRD update blocks from response for display */
  private stripPrdUpdates(content: string): string {
    return content
      .replace(/\[PRD_UPDATE:\w+\][\s\S]*?\[\/PRD_UPDATE\]/g, '')
      .trim();
  }

  /** Parse Plan update from agent response (PRD §7.2.4 plan sidebar chat) */
  private parsePlanUpdate(content: string): string | null {
    const match = content.match(/\[PLAN_UPDATE\]([\s\S]*?)\[\/PLAN_UPDATE\]/);
    return match ? match[1].trim() : null;
  }

  /** Strip Plan update block from response for display */
  private stripPlanUpdate(content: string): string {
    return content
      .replace(/\[PLAN_UPDATE\][\s\S]*?\[\/PLAN_UPDATE\]/g, '')
      .trim();
  }

  /** Get plan markdown content for plan context (avoids PlanService circular dep) */
  private async getPlanContent(projectId: string, planId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    const planPath = path.join(project.repoPath, OPENSPRINT_PATHS.plans, `${planId}.md`);
    try {
      return await fs.readFile(planPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /** Write plan markdown (avoids PlanService circular dep) */
  private async writePlanContent(projectId: string, planId: string, content: string): Promise<void> {
    const project = await this.projectService.getProject(projectId);
    const plansDir = path.join(project.repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planPath = path.join(plansDir, `${planId}.md`);
    await fs.writeFile(planPath, content);
  }

  /** Send a message to the planning agent */
  async sendMessage(projectId: string, body: ChatRequest): Promise<ChatResponse> {
    const context = body.context ?? 'design';
    const isPlanContext = context.startsWith('plan:');
    const planId = isPlanContext ? context.slice(5) : null;

    const conversation = await this.getOrCreateConversation(projectId, context);

    // Build prompt for agent; add PRD section context if user clicked to focus (PRD §7.1.5)
    let agentPrompt = body.message;
    if (!isPlanContext && body.prdSectionFocus) {
      const prd = await this.prdService.getPrd(projectId);
      const section = prd.sections[body.prdSectionFocus as keyof typeof prd.sections];
      const sectionLabel = body.prdSectionFocus
        .replace(/_/g, ' ')
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
      role: 'user',
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
      systemPrompt = DESIGN_SYSTEM_PROMPT + '\n\n' + prdContext;
    }

    // Assemble conversation history for agent
    const history = conversation.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let responseContent: string;

    try {
      console.log('[chat] Invoking agent', { type: agentConfig.type, model: agentConfig.model ?? 'default', context, historyLen: history.length, promptLen: agentPrompt.length });
      const response = await this.agentClient.invoke({
        config: agentConfig,
        prompt: agentPrompt,
        systemPrompt,
        conversationHistory: history,
        cwd: (await this.projectService.getProject(projectId)).repoPath,
      });

      console.log('[chat] Agent returned', { contentLen: response.content?.length ?? 0 });
      responseContent = response.content;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Agent invocation failed:', error);
      responseContent =
        'I was unable to connect to the planning agent.\n\n' +
        `**Error:** ${msg}\n\n` +
        '**What to try:** Open Project Settings → Agent Config. Ensure your API key is set, the CLI is installed, and the model is valid.';
    }

    let displayContent: string;
    const prdChanges: ChatResponse['prdChanges'] = [];

    if (isPlanContext && planId) {
      // Plan context: parse PLAN_UPDATE, apply, strip from display
      const planUpdate = this.parsePlanUpdate(responseContent);
      displayContent = this.stripPlanUpdate(responseContent).trim() || responseContent;
      if (planUpdate) {
        await this.writePlanContent(projectId, planId, planUpdate);
        broadcastToProject(projectId, { type: 'plan.updated', planId });
      }
    } else {
      // Design context: parse PRD updates, apply, strip from display
      const prdUpdates = this.parsePrdUpdates(responseContent);
      displayContent = this.stripPrdUpdates(responseContent) || responseContent;
      if (prdUpdates.length > 0) {
        const changes = await this.prdService.updateSections(projectId, prdUpdates, 'design');
        for (const change of changes) {
          prdChanges.push({
            section: change.section,
            previousVersion: change.previousVersion,
            newVersion: change.newVersion,
          });
          broadcastToProject(projectId, {
            type: 'prd.updated',
            section: change.section,
            version: change.newVersion,
          });
        }
      }
    }

    const assistantMessage: ConversationMessage = {
      role: 'assistant',
      content: displayContent,
      timestamp: new Date().toISOString(),
      prdChanges: prdChanges.length > 0
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
  async addDirectEditMessage(
    projectId: string,
    section: string,
    _content: string,
  ): Promise<void> {
    const conversation = await this.getOrCreateConversation(projectId, 'design');
    const sectionLabel = section
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const message: ConversationMessage = {
      role: 'user',
      content: `I edited the ${sectionLabel} section of the PRD directly. The updated content is now in the living document.`,
      timestamp: new Date().toISOString(),
    };
    conversation.messages.push(message);
    await this.saveConversation(projectId, conversation);
  }

  /**
   * When a Plan is shipped, invoke the planning agent to review the Plan against the PRD
   * and update any affected sections. PRD §15.1 Living PRD Synchronization.
   */
  async syncPrdFromPlanShip(projectId: string, planId: string, planContent: string): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const agentConfig = settings.planningAgent;
    const prdContext = await this.buildPrdContext(projectId);
    const repoPath = (await this.projectService.getProject(projectId)).repoPath;

    const systemPrompt = `You are a PRD synchronization assistant for OpenSprint. A Plan has just been shipped.

Your task: Review the shipped Plan against the current PRD. Update any PRD sections that should reflect the Plan's decisions, scope, technical approach, or acceptance criteria. The PRD is the living document; it should stay aligned with what is being built.

Output updates using this format:
[PRD_UPDATE:section_key]
<markdown content for the section>
[/PRD_UPDATE]

Valid section keys: executive_summary, problem_statement, user_personas, goals_and_metrics, feature_list, technical_architecture, data_model, api_contracts, non_functional_requirements, open_questions

Only output PRD_UPDATE blocks for sections that need changes. If no updates are needed, respond briefly without any PRD_UPDATE blocks.`;

    const prompt = `Review this shipped Plan (${planId}) and update the PRD as needed.\n\n## Shipped Plan\n\n${planContent}`;

    const fullContext = `${systemPrompt}\n\n## Current PRD\n\n${prdContext}`;

    const response = await this.agentClient.invoke({
      config: agentConfig,
      prompt,
      systemPrompt: fullContext,
      cwd: repoPath,
    });

    const prdUpdates = this.parsePrdUpdates(response.content);
    if (prdUpdates.length === 0) return;

    const changes = await this.prdService.updateSections(projectId, prdUpdates, 'plan');
    for (const change of changes) {
      broadcastToProject(projectId, {
        type: 'prd.updated',
        section: change.section,
        version: change.newVersion,
      });
    }
  }

  /**
   * When Validate feedback is categorized as a scope change and the user approves via HIL,
   * invoke the planning agent to review the feedback against the PRD and update affected
   * sections. PRD §7.4.2, §15.1 Living PRD Synchronization.
   */
  async syncPrdFromScopeChangeFeedback(projectId: string, feedbackText: string): Promise<void> {
    const settings = await this.projectService.getSettings(projectId);
    const agentConfig = settings.planningAgent;
    const prdContext = await this.buildPrdContext(projectId);
    const repoPath = (await this.projectService.getProject(projectId)).repoPath;

    const systemPrompt = `You are a PRD synchronization assistant for OpenSprint. A user has submitted validation feedback that was categorized as a scope change and approved for PRD updates.

Your task: Review the feedback against the current PRD. Determine if updates are necessary. If so, produce targeted section updates that incorporate the scope change. The PRD is the living document; it should reflect the approved scope change.

Output updates using this format:
[PRD_UPDATE:section_key]
<markdown content for the section>
[/PRD_UPDATE]

Valid section keys: executive_summary, problem_statement, user_personas, goals_and_metrics, feature_list, technical_architecture, data_model, api_contracts, non_functional_requirements, open_questions

Only output PRD_UPDATE blocks for sections that need changes. If no updates are needed, respond briefly without any PRD_UPDATE blocks.`;

    const prompt = `Review this scope-change feedback and update the PRD as needed.\n\n## Feedback\n\n"${feedbackText}"`;

    const fullContext = `${systemPrompt}\n\n## Current PRD\n\n${prdContext}`;

    const response = await this.agentClient.invoke({
      config: agentConfig,
      prompt,
      systemPrompt: fullContext,
      cwd: repoPath,
    });

    const prdUpdates = this.parsePrdUpdates(response.content);
    if (prdUpdates.length === 0) return;

    const changes = await this.prdService.updateSections(projectId, prdUpdates, 'validate');
    for (const change of changes) {
      broadcastToProject(projectId, {
        type: 'prd.updated',
        section: change.section,
        version: change.newVersion,
      });
    }
  }
}
