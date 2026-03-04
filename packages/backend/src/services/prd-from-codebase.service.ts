import { getAgentForPlanningRole } from "@opensprint/shared";
import { PlanService } from "./plan.service.js";
import { ChatService } from "./chat.service.js";
import { PrdService } from "./prd.service.js";
import { ProjectService } from "./project.service.js";
import { agentService } from "./agent.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { createLogger } from "../utils/logger.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";

const log = createLogger("prd-from-codebase");

const CODEBASE_TO_PRD_SYSTEM_PROMPT = `You are an AI assistant for OpenSprint. Your task is to analyze an existing codebase and produce a Product Requirements Document (PRD) that describes what the application does, its main features, technical stack, and architecture.

You will receive:
1. A file tree of the repository (excluding node_modules, .git, etc.)
2. Contents of key source files (truncated if large)

Analyze the codebase and output a comprehensive PRD using PRD_UPDATE blocks. Use this format:

[PRD_UPDATE:section_key]
<markdown content for the section>
[/PRD_UPDATE]

Valid section keys: executive_summary, problem_statement, user_personas, goals_and_metrics, feature_list, technical_architecture, data_model, api_contracts, non_functional_requirements, open_questions

Guidelines:
- Infer what the product does from the code: entry points, routes, components, APIs, data models.
- executive_summary: One or two paragraphs summarizing the application and its purpose.
- feature_list: Bullet list of main features/capabilities you can identify.
- technical_architecture: Stack (frameworks, languages), high-level structure, key directories.
- data_model: Entities, storage, or schema if evident from the code.
- api_contracts: Main APIs or endpoints if applicable.
- Do NOT include a top-level section header (e.g. "## 1. Executive Summary") inside the block — start with body content. Sub-headers like ### 3.1 are fine.
- Do NOT output placeholder content like "TBD". Infer reasonable content from the code or omit the section.
- Output multiple PRD_UPDATE blocks so the PRD is populated with as many sections as you can confidently derive.`;

export class PrdFromCodebaseService {
  private planService = new PlanService();
  private chatService = new ChatService();
  private prdService = new PrdService();
  private projectService = new ProjectService();

  async generatePrdFromCodebase(projectId: string): Promise<void> {
    const { fileTree, keyFilesContent } = await this.planService.getCodebaseContext(projectId);

    const userPrompt = `Analyze the following codebase and produce a PRD that describes the existing application.

## File tree

\`\`\`
${fileTree}
\`\`\`

## Key file contents

${keyFilesContent}

Output PRD_UPDATE blocks for each section you can derive.`;

    const settings = await this.projectService.getSettings(projectId);
    const agentConfig = getAgentForPlanningRole(settings, "dreamer");

    const agentId = `prd-from-codebase-${projectId}-${Date.now()}`;

    const repoPath = await this.projectService.getRepoPath(projectId);

    const systemPrompt = `${CODEBASE_TO_PRD_SYSTEM_PROMPT}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
    let responseContent: string;
    try {
      log.info("Invoking planning agent for PRD from codebase", { projectId });
      const response = await agentService.invokePlanningAgent({
        projectId,
        config: agentConfig,
        messages: [{ role: "user", content: userPrompt }],
        systemPrompt,
        cwd: repoPath,
        tracking: {
          id: agentId,
          projectId,
          phase: "sketch",
          role: "dreamer",
          label: "Generate PRD from codebase",
        },
      });
      responseContent = response.content ?? "";
    } catch (error) {
      const msg = getErrorMessage(error);
      log.error("PRD from codebase agent failed", { projectId, error });
      if (error instanceof AppError) {
        throw new AppError(
          error.statusCode,
          error.code,
          `The planning agent could not generate a PRD from the codebase. ${error.message}`,
          error.details
        );
      }
      throw new AppError(
        502,
        ErrorCodes.AGENT_INVOKE_FAILED,
        `The planning agent could not generate a PRD from the codebase. ${msg}`
      );
    }

    const prdUpdates = this.chatService.parsePrdUpdatesFromContent(responseContent);
    if (prdUpdates.length === 0) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "The agent did not return any PRD sections. The codebase may be too small or the agent could not infer content."
      );
    }

    const changes = await this.prdService.updateSections(projectId, prdUpdates, "sketch");
    for (const change of changes) {
      broadcastToProject(projectId, {
        type: "prd.updated",
        section: change.section,
        version: change.newVersion,
      });
    }

    await this.chatService.addSketchAssistantMessage(
      projectId,
      "I analyzed your codebase and generated a PRD describing the existing application, its features, and technical architecture. You can edit any section in the document or ask me to refine it."
    );

    log.info("PRD generated from codebase", { projectId, sectionsUpdated: changes.length });
  }
}

export const prdFromCodebaseService = new PrdFromCodebaseService();
