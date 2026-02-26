import type { HelpChatRequest, HelpChatResponse, ActiveAgent } from "@opensprint/shared";
import { getAgentForPlanningRole, AGENT_ROLE_LABELS } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { PrdService } from "./prd.service.js";
import { PlanService } from "./plan.service.js";
import { taskStore } from "./task-store.service.js";
import { orchestratorService } from "./orchestrator.service.js";
import { agentService } from "./agent.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("help-chat");

const HELP_SYSTEM_PROMPT = `You are the Help assistant for OpenSprint, an AI-powered software development workflow tool.

**CRITICAL: Ask-only mode.** You must ONLY answer questions. You must NEVER:
- Change project state, PRD, plans, or tasks
- Output [PRD_UPDATE], [PLAN_UPDATE], or any structured update blocks
- Create, modify, or close tasks
- Suggest or perform any state-changing operations

Your role is to help users understand their projects, tasks, plans, and currently running agents. Answer based on the context provided. If the user asks for something you cannot do (e.g. "create a task"), politely explain that you are in ask-only mode and direct them to the appropriate part of the UI.

**How to help:**
- Explain what you see in the context (PRD, plans, tasks, active agents)
- When asked "how many agents are running" or similar, report the exact count and list each agent from the "Currently Running Agents" section — never say "(None)" if the context shows agents
- Answer questions about OpenSprint workflow (Sketch, Plan, Execute, Evaluate, Deliver)
- Point users to where they can take action (e.g. "Use the Execute tab to run tasks")
- Describe agent roles and phases when asked`;

/** Max chars per section in context to avoid token overflow */
const MAX_CONTEXT_CHARS = 8000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n\n[... truncated for context length]";
}

export class HelpChatService {
  private projectService = new ProjectService();
  private prdService = new PrdService();
  private planService = new PlanService();

  /** Build project-scoped context: PRD, plans, tasks, active agents */
  private async buildProjectContext(projectId: string): Promise<string> {
    const [project, prdResult, plansResult, tasksResult, agents] = await Promise.all([
      this.projectService.getProject(projectId),
      this.prdService.getPrd(projectId).catch(() => null),
      this.planService.listPlans(projectId).catch(() => []),
      taskStore.listAll(projectId).catch(() => []),
      orchestratorService.getActiveAgents(projectId).catch(() => []),
    ]);

    const parts: string[] = [];
    parts.push(`## Project: ${project.name} (${projectId})`);

    // PRD
    if (prdResult?.sections) {
      let prdText = "";
      for (const [key, section] of Object.entries(prdResult.sections)) {
        if (section?.content) {
          const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          prdText += `### ${label}\n${section.content}\n\n`;
        }
      }
      if (prdText) {
        parts.push("## PRD\n\n" + truncate(prdText, MAX_CONTEXT_CHARS));
      } else {
        parts.push("## PRD\n(Empty or not yet created)");
      }
    } else {
      parts.push("## PRD\n(Not found)");
    }

    // Plans
    if (plansResult.length > 0) {
      const planLines = plansResult.map(
        (p) =>
          `- ${p.metadata.planId}: ${p.metadata.epicId} | status: ${p.status} | tasks: ${p.doneTaskCount}/${p.taskCount}`
      );
      parts.push("## Plans\n\n" + planLines.join("\n"));
    } else {
      parts.push("## Plans\n(No plans yet)");
    }

    // Tasks (summary)
    const nonEpic = tasksResult.filter((t) => t.issue_type !== "epic");
    if (nonEpic.length > 0) {
      const taskLines = nonEpic.slice(0, 50).map(
        (t) =>
          `- ${t.id}: ${(t.title ?? "").slice(0, 60)} | status: ${t.status} | assignee: ${t.assignee ?? "unassigned"}`
      );
      const more = nonEpic.length > 50 ? `\n... and ${nonEpic.length - 50} more tasks` : "";
      parts.push("## Tasks\n\n" + taskLines.join("\n") + more);
    } else {
      parts.push("## Tasks\n(No tasks yet)");
    }

    // Active agents
    if (agents.length > 0) {
      const agentLines = agents.map(
        (a) =>
          `- ${AGENT_ROLE_LABELS[a.role as keyof typeof AGENT_ROLE_LABELS] ?? a.role}: ${a.label} (phase: ${a.phase})`
      );
      parts.push("## Currently Running Agents\n\n" + agentLines.join("\n"));
    } else {
      parts.push("## Currently Running Agents\n(None)");
    }

    return parts.join("\n\n---\n\n");
  }

  /** Build homepage context: projects summary, active agents across all projects */
  private async buildHomepageContext(): Promise<string> {
    const projects = await this.projectService.listProjects();
    const agentsWithProject: { agent: ActiveAgent; projectName: string }[] = [];
    for (const p of projects) {
      try {
        const agents = await orchestratorService.getActiveAgents(p.id);
        for (const a of agents) {
          agentsWithProject.push({ agent: a, projectName: p.name });
        }
      } catch {
        // Skip projects that fail (e.g. not yet initialized)
      }
    }

    const parts: string[] = [];
    parts.push("## Homepage View — All Projects");

    if (projects.length > 0) {
      const projectLines = projects.map((p) => `- ${p.name} (id: ${p.id})`);
      parts.push("## Projects\n\n" + projectLines.join("\n"));
    } else {
      parts.push("## Projects\n(No projects yet)");
    }

    if (agentsWithProject.length > 0) {
      const agentLines = agentsWithProject.map(
        ({ agent: a, projectName }) =>
          `- ${AGENT_ROLE_LABELS[a.role as keyof typeof AGENT_ROLE_LABELS] ?? a.role}: ${a.label} | project: ${projectName} | phase: ${a.phase}`
      );
      parts.push("## Currently Running Agents (across all projects)\n\n" + agentLines.join("\n"));
    } else {
      parts.push("## Currently Running Agents\n(None)");
    }

    parts.push(
      "\n**Instructions for the user:** To get detailed context about a specific project (PRD, plans, tasks), they should open that project and use the Help modal from the project view."
    );

    return parts.join("\n\n---\n\n");
  }

  async sendMessage(body: HelpChatRequest): Promise<HelpChatResponse> {
    const message = body.message?.trim();
    if (!message) {
      throw new AppError(400, ErrorCodes.INVALID_INPUT, "Message is required");
    }

    const projectId = body.projectId?.trim() || null;
    const isProjectView = !!projectId;

    if (isProjectView) {
      await this.projectService.getProject(projectId!);
    }

    const context =
      isProjectView && projectId
        ? await this.buildProjectContext(projectId)
        : await this.buildHomepageContext();

    const systemPrompt = `${HELP_SYSTEM_PROMPT}\n\n---\n\n## Current Context\n\nThe following context is provided for answering the user's question. Use it to give accurate, helpful answers.\n\n${context}`;

    const priorMessages = (body.messages ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    const messages = [...priorMessages, { role: "user" as const, content: message }];

    // Agent config: use project settings when in project view; otherwise first project
    let agentConfig;
    let cwd: string | undefined;
    if (isProjectView && projectId) {
      const [settings, project] = await Promise.all([
        this.projectService.getSettings(projectId),
        this.projectService.getProject(projectId),
      ]);
      agentConfig = getAgentForPlanningRole(settings, "dreamer");
      cwd = project.repoPath;
    } else {
      const projects = await this.projectService.listProjects();
      if (projects.length === 0) {
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          "No projects exist. Create a project to use the Help chat."
        );
      }
      const firstProject = projects[0]!;
      const settings = await this.projectService.getSettings(firstProject.id);
      agentConfig = getAgentForPlanningRole(settings, "dreamer");
      cwd = firstProject.repoPath;
    }

    const agentId = `help-chat-${isProjectView ? projectId : "homepage"}-${Date.now()}`;

    try {
      log.info("Invoking help agent", {
        projectId: projectId ?? "homepage",
        messageLen: message.length,
      });
      const response = await agentService.invokePlanningAgent({
        config: agentConfig,
        messages,
        systemPrompt,
        cwd,
        tracking: {
          id: agentId,
          projectId: projectId ?? "help-homepage",
          phase: "help",
          role: "dreamer",
          label: "Help chat",
        },
      });
      const content = response?.content ?? "";
      log.info("Help agent returned", { contentLen: content.length });
      return { message: content };
    } catch (error) {
      const msg = getErrorMessage(error);
      log.error("Help agent invocation failed", { error });
      return {
        message:
          "I was unable to connect to the AI assistant.\n\n" +
          `**Error:** ${msg}\n\n` +
          "**What to try:** Open Project Settings → Agent Config. Ensure your API key is set and the model is valid.",
      };
    }
  }
}
