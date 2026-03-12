/**
 * Open-question auto-respond: when autonomy is "full", invoke the Dreamer agent
 * to answer open questions (PRD, Plans, feedback, execute) from PRD context and
 * persist/surface the answer so questions are resolved without manual input.
 */

import { getAgentForPlanningRole } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { PrdService } from "./prd.service.js";
import { agentService } from "./agent.service.js";
import { notificationService } from "./notification.service.js";
import { taskStore } from "./task-store.service.js";
import { ChatService } from "./chat.service.js";
import { FeedbackService } from "./feedback.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { createLogger } from "../utils/logger.js";
import type { Notification } from "./notification.service.js";

const log = createLogger("open-question-autoresolve");

let _projectService: ProjectService | null = null;
let _prdService: PrdService | null = null;
let _chatService: ChatService | null = null;
let _feedbackService: FeedbackService | null = null;

function getProjectService(): ProjectService {
  if (!_projectService) _projectService = new ProjectService();
  return _projectService;
}
function getPrdService(): PrdService {
  if (!_prdService) _prdService = new PrdService();
  return _prdService;
}
function getChatService(): ChatService {
  if (!_chatService) _chatService = new ChatService();
  return _chatService;
}
function getFeedbackService(): FeedbackService {
  if (!_feedbackService) _feedbackService = new FeedbackService();
  return _feedbackService;
}

function buildPrdContextFromSections(sections: Record<string, { content?: string }>): string {
  let context = "## Current PRD / Spec\n\n";
  for (const [key, section] of Object.entries(sections)) {
    if (section?.content) {
      context += `### ${key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}\n`;
      context += `${section.content}\n\n`;
    }
  }
  return context || "The PRD is empty.";
}

/**
 * When project has full autonomy and the notification is an open_question,
 * invoke Dreamer to produce a recommended answer from the PRD, then apply it
 * (add to chat / recategorize / resolve) so the question is resolved without
 * manual user input. Runs fire-and-forget; errors are logged.
 */
export async function maybeAutoRespond(
  projectId: string,
  notification: Notification
): Promise<void> {
  if (notification.kind !== "open_question") return;

  try {
    const settings = await getProjectService().getSettings(projectId);
    if (settings.aiAutonomyLevel !== "full") return;

    const questionTexts = notification.questions.map((q) => q.text).filter(Boolean);
    if (questionTexts.length === 0) return;

    const prd = await getPrdService().getPrd(projectId).catch(() => null);
    const prdContext = prd ? buildPrdContextFromSections(prd.sections) : "No PRD available.";

    const repoPath = await getProjectService().getRepoPath(projectId).catch(() => undefined);
    const agentConfig = getAgentForPlanningRole(settings, "dreamer");
    const instructions = repoPath
      ? await getCombinedInstructions(repoPath, "dreamer")
      : "";

    const prompt = `You are helping resolve an open question so work can proceed without manual input.

${prdContext}

---

The following open question(s) were emitted by an agent. Based on the PRD/spec above, provide a single recommended answer that can be used to resolve the question. Be concise and decisive. Output only the answer text—no JSON, no markdown headers, no preamble.

Open question(s):
${questionTexts.map((t) => `- ${t}`).join("\n")}`;

    const systemPrompt =
      `You are the Dreamer agent. Answer the user's question using only the provided PRD/spec context. Output only the answer text.` +
      (instructions ? `\n\n${instructions}` : "");

    const response = await agentService.invokePlanningAgent({
      projectId,
      role: "dreamer",
      config: agentConfig,
      messages: [{ role: "user", content: prompt }],
      systemPrompt,
      cwd: repoPath,
    });

    const rawAnswer = (response?.content ?? "").trim();
    const answer = rawAnswer.slice(0, 8000).trim();
    if (!answer) {
      log.warn("Dreamer returned empty answer for open-question auto-respond", {
        projectId,
        notificationId: notification.id,
        source: notification.source,
      });
      return;
    }

    const { source, sourceId, id: notificationId } = notification;

    switch (source) {
      case "execute": {
        await getChatService().sendMessage(projectId, {
          message: answer,
          context: `execute:${sourceId}`,
        });
        await notificationService.resolve(projectId, notificationId);
        try {
          await taskStore.update(projectId, sourceId, {
            status: "open",
            block_reason: null,
          });
        } catch {
          // Task may not exist or already unblocked
        }
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId,
          projectId,
          source,
          sourceId,
        });
        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: sourceId,
          projectId,
          status: "open",
          assignee: null,
        });
        log.info("Auto-resolved execute open question with Dreamer answer", {
          projectId,
          notificationId,
          taskId: sourceId,
        });
        break;
      }
      case "plan": {
        const draftId = sourceId.startsWith("draft:") ? sourceId.slice("draft:".length) : sourceId;
        await getChatService().sendMessage(projectId, {
          message: answer,
          context: `plan-draft:${draftId}`,
        });
        await notificationService.resolve(projectId, notificationId);
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId,
          projectId,
          source,
          sourceId,
        });
        log.info("Auto-resolved plan open question with Dreamer answer", {
          projectId,
          notificationId,
          sourceId,
        });
        break;
      }
      case "eval": {
        await notificationService.resolve(projectId, notificationId);
        await getFeedbackService().recategorizeFeedback(projectId, sourceId, { answer });
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId,
          projectId,
          source,
          sourceId,
        });
        log.info("Auto-resolved eval open question with Dreamer answer", {
          projectId,
          notificationId,
          feedbackId: sourceId,
        });
        break;
      }
      case "prd": {
        await getChatService().sendMessage(projectId, {
          message: answer,
          context: "sketch",
        });
        await notificationService.resolve(projectId, notificationId);
        broadcastToProject(projectId, {
          type: "notification.resolved",
          notificationId,
          projectId,
          source,
          sourceId,
        });
        log.info("Auto-resolved prd open question with Dreamer answer", {
          projectId,
          notificationId,
          sourceId,
        });
        break;
      }
      default:
        log.warn("Unknown notification source for auto-respond", { source, projectId, notificationId });
    }
  } catch (err) {
    log.error("Open-question auto-respond failed", {
      projectId,
      notificationId: notification.id,
      source: notification.source,
      err,
    });
  }
}
