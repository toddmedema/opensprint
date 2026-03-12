/**
 * ReviewSynthesizerService — lead agent that synthesizes multi-angle review findings
 * into a single report. When multiple parallel reviewers run (security, performance,
 * etc.), each reports findings. The synthesizer reads all angle results and produces
 * one coherent report for approval or rejection.
 */

import type { ReviewAgentResult } from "@opensprint/shared";
import { REVIEW_ANGLE_OPTIONS } from "@opensprint/shared";
import { agentService } from "./agent.service.js";
import { ProjectService } from "./project.service.js";
import { getAgentForComplexity } from "@opensprint/shared";
import { getComplexityForAgent } from "./plan-complexity.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { createLogger } from "../utils/logger.js";
import type { TaskStoreService } from "./task-store.service.js";
import type { StoredTask } from "./task-store.service.js";

const log = createLogger("review-synthesizer");

export interface AngleReviewInput {
  angle: string;
  result: ReviewAgentResult;
}

const SYNTHESIZER_SYSTEM_PROMPT = `You are the Review Lead for Open Sprint. Multiple parallel reviewers have each assessed a code change from a distinct angle (security, performance, test coverage, code quality, design/UX/accessibility). Your job is to synthesize their findings into a single coherent report.

Rules:
- If ANY angle rejected, the overall status MUST be "rejected". Synthesize all rejection feedback into a clear, actionable report. Combine issues from multiple angles; deduplicate where appropriate.
- If ALL angles approved, the overall status MUST be "approved". Produce a brief synthesis summary acknowledging each angle's approval.
- Output ONLY valid JSON in this exact format (no markdown wrapper):
  For approval: {"status":"approved","summary":"Brief synthesis (e.g. All angles passed: Security, Performance, Code quality.)","notes":""}
  For rejection: {"status":"rejected","summary":"One-line overall reason","issues":["Issue 1","Issue 2",...],"notes":"Additional context if needed"}
- The status field MUST be exactly "approved" or "rejected".
- Be concise. Do not add new findings; only synthesize what the angle reviewers reported.`;

export class ReviewSynthesizerService {
  private projectService = new ProjectService();

  /**
   * Run the lead synthesizer agent to produce a single report from multi-angle review results.
   * Used when reviewAngles has 2+ items and all angle reviewers have completed.
   */
  async synthesize(
    projectId: string,
    repoPath: string,
    task: StoredTask,
    angleInputs: AngleReviewInput[],
    taskStore: TaskStoreService
  ): Promise<ReviewAgentResult> {
    const settings = await this.projectService.getSettings(projectId);
    const complexity = await getComplexityForAgent(projectId, repoPath, task, taskStore);
    const agentConfig = getAgentForComplexity(settings, complexity);

    const angleBlocks = angleInputs
      .map(({ angle, result }) => {
        const label =
          REVIEW_ANGLE_OPTIONS.find((o) => o.value === angle)?.label ?? angle;
        const status = result.status;
        const summary = result.summary ?? "";
        const issues = result.issues?.length ? result.issues.join("\n- ") : "";
        return `### ${label} (${angle})\nStatus: ${status}\nSummary: ${summary}${issues ? `\nIssues:\n- ${issues}` : ""}\n`;
      })
      .join("\n");

    const prompt = `## Task

**Task ID:** ${task.id}
**Title:** ${task.title}

## Angle Review Results

${angleBlocks}

---

Synthesize the above into a single report. Output ONLY valid JSON with status, summary, and (if rejected) issues and notes.`;

    const systemPrompt = `${SYNTHESIZER_SYSTEM_PROMPT}\n\n${await getCombinedInstructions(repoPath, "reviewer")}`;
    try {
      const response = await agentService.invokePlanningAgent({
        projectId,
        role: "reviewer",
        config: agentConfig,
        messages: [{ role: "user", content: prompt }],
        systemPrompt,
        cwd: repoPath,
        tracking: {
          id: `synthesizer-${projectId}-${task.id}-${Date.now()}`,
          projectId,
          phase: "execute",
          role: "reviewer",
          label: "Review Synthesizer",
        },
      });

      const parsed = extractJsonFromAgentResponse<{
        status?: string;
        summary?: string;
        issues?: string[];
        notes?: string;
      }>(response.content, "status");

      if (!parsed || !parsed.status) {
        log.warn("Synthesizer did not return valid JSON, using programmatic merge", {
          projectId,
          taskId: task.id,
        });
        return this.programmaticMerge(angleInputs);
      }

      const status = parsed.status === "rejected" ? "rejected" : "approved";
      return {
        status,
        summary: parsed.summary?.trim() ?? (status === "approved" ? "All angles passed" : "Review rejected"),
        ...(parsed.issues?.length ? { issues: parsed.issues } : {}),
        notes: parsed.notes?.trim() ?? "",
      };
    } catch (err) {
      log.error("Synthesizer agent failed, falling back to programmatic merge", {
        projectId,
        taskId: task.id,
        err,
      });
      return this.programmaticMerge(angleInputs);
    }
  }

  /** Fallback when synthesizer agent fails: merge angle results programmatically */
  private programmaticMerge(angleInputs: AngleReviewInput[]): ReviewAgentResult {
    const rejected = angleInputs.filter((i) => i.result.status === "rejected");
    if (rejected.length > 0) {
      const issues = [
        ...new Set(
          rejected
            .flatMap((r) => r.result.issues ?? [])
            .map((i) => i.trim())
            .filter(Boolean)
        ),
      ];
      const summary = rejected
        .map((r) => r.result.summary?.trim())
        .filter(Boolean)
        .join(" | ");
      return {
        status: "rejected",
        summary: summary || "Review rejected",
        ...(issues.length > 0 && { issues }),
        notes: rejected
          .map((r) => r.result.notes?.trim())
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    const first = angleInputs[0]!;
    return {
      status: "approved",
      summary: first.result.summary ?? "All angles passed",
      notes: angleInputs
        .map((i) => i.result.notes?.trim())
        .filter(Boolean)
        .join("\n\n"),
    };
  }
}

export const reviewSynthesizerService = new ReviewSynthesizerService();
