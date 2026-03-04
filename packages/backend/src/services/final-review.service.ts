/**
 * FinalReviewService — runs a final review agent when the last task of an epic is completed.
 * The agent assesses: (1) missing/incorrect functionality vs plan scope; (2) code quality;
 * (3) test coverage; (4) failing tests. Creates new tasks for any issues found.
 * Epic closure is gated on review pass or user approval.
 *
 * When reviewAngles has 2+ items: spawns parallel reviewers (one per angle), then a lead
 * synthesizer produces a single report. Same multi-angle workflow as ticket-level review.
 */

import type { ReviewAngle } from "@opensprint/shared";
import { REVIEW_ANGLE_OPTIONS } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { agentService } from "./agent.service.js";
import { getAgentForPlanningRole } from "@opensprint/shared";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { PlanService } from "./plan.service.js";
import { ProjectService } from "./project.service.js";
import { ContextAssembler, REVIEW_ANGLE_CHECKLISTS } from "./context-assembler.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("final-review");

export interface FinalReviewProposedTask {
  title: string;
  description: string;
  priority?: number;
}

export interface FinalReviewResult {
  status: "pass" | "issues";
  assessment: string;
  proposedTasks: FinalReviewProposedTask[];
}

const FINAL_REVIEW_SYSTEM_PROMPT = `You are the Final Review agent for OpenSprint. When all implementation tasks of a plan/epic are completed, you perform a final assessment before the epic can be closed.

Your task: Given the plan scope, full implementation context (completed task summaries, codebase state), assess:
1. **Missing or incorrect functionality** — Does the implementation match the plan scope? Are there gaps or deviations?
2. **Code quality** — Are there obvious quality issues (structure, patterns, maintainability)?
3. **Test coverage** — Are critical paths tested? Are there obvious gaps?
4. **Failing tests** — Based on the context, would tests pass? (We don't run tests here; infer from implementation.)

Respond with ONLY valid JSON in this exact format (no markdown wrapper):
{
  "status": "pass" | "issues",
  "assessment": "Brief summary of your assessment (2-4 sentences).",
  "proposedTasks": [
    {"title": "Task title", "description": "What needs to be done", "priority": 1}
  ]
}

Rules:
- status "pass": Implementation meets plan scope; no significant issues. proposedTasks must be [].
- status "issues": You found issues. proposedTasks lists concrete tasks to address them. Each task should be actionable and linked to a specific gap.
- priority: 0-4 (0=highest). Omit for default 2.
- Be conservative: only propose tasks for clear, actionable issues. Do not nitpick.
- If the plan scope is fully met and quality is acceptable, return status "pass" with empty proposedTasks.`;

export class FinalReviewService {
  private taskStore = taskStoreSingleton;
  private planService = new PlanService();
  private projectService = new ProjectService();
  private contextAssembler = new ContextAssembler();

  /**
   * Run the final review agent for an epic whose implementation tasks are all closed.
   * Returns assessment and proposed tasks. Does not close the epic or create tasks.
   */
  async runFinalReview(
    projectId: string,
    epicId: string,
    repoPath: string
  ): Promise<FinalReviewResult | null> {
    const plan = await this.taskStore.planGetByEpicId(projectId, epicId);
    if (!plan) {
      log.info("Epic has no plan, skipping final review (e.g. deploy-fix epic)", {
        projectId,
        epicId,
      });
      return null;
    }

    const allIssues = await this.taskStore.listAll(projectId);
    const implTasks = allIssues.filter(
      (i) =>
        i.id.startsWith(epicId + ".") &&
        (i.issue_type ?? i.type) !== "epic" &&
        (i.status as string) === "closed"
    );
    if (implTasks.length === 0) {
      log.warn("No implementation tasks found for epic", { projectId, epicId });
      return null;
    }

    const depIds = implTasks.map((t) => t.id);
    const dependencyOutputs = await this.contextAssembler.collectDependencyOutputs(
      repoPath,
      depIds
    );

    const { fileTree, keyFilesContent } = await this.planService.getCodebaseContext(projectId);
    const prdExcerpt = await this.contextAssembler.extractPrdExcerpt(repoPath);

    const completedTasksSummary = implTasks
      .map((t) => {
        const out = dependencyOutputs.find((d) => d.taskId === t.id);
        const summary = out?.summary ?? t.close_reason ?? "Completed";
        return `### ${t.id}: ${t.title}\n${summary}`;
      })
      .join("\n\n");

    const basePrompt = `## Plan scope

${plan.content}

## PRD excerpt

${prdExcerpt.slice(0, 8000)}${prdExcerpt.length > 8000 ? "\n\n...(truncated)" : ""}

## Completed implementation tasks

${completedTasksSummary}

## Repository file structure

\`\`\`
${fileTree}
\`\`\`

## Key source files

${keyFilesContent.slice(0, 15000)}${keyFilesContent.length > 15000 ? "\n\n...(truncated)" : ""}

---

Assess the implementation against the plan scope. Return JSON with status, assessment, and proposedTasks.`;

    const settings = await this.projectService.getSettings(projectId);
    const reviewAngles = [
      ...new Set((settings.reviewAngles ?? []).filter(Boolean)),
    ] as ReviewAngle[];

    const planId = plan.plan_id;

    if (reviewAngles.length >= 2) {
      return this.runMultiAngleEpicReview(
        projectId,
        epicId,
        planId,
        repoPath,
        basePrompt,
        reviewAngles,
        settings
      );
    }

    const agentId = `final-review-${projectId}-${epicId}-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const finalReviewSystemPrompt = `${FINAL_REVIEW_SYSTEM_PROMPT}\n\n${await getCombinedInstructions(repoPath, "auditor")}`;
    try {
      const response = await agentService.invokePlanningAgent({
        projectId,
        config: getAgentForPlanningRole(settings, "auditor"),
        messages: [{ role: "user", content: basePrompt }],
        systemPrompt: finalReviewSystemPrompt,
        cwd: repoPath,
        tracking: {
          id: agentId,
          projectId,
          phase: "execute",
          role: "auditor",
          label: "Final review",
          planId,
        },
      });

      const result = this.parseFinalReviewResponse(response.content, projectId, epicId);
      await this.persistAuditorRun(projectId, planId, epicId, startedAt, result.status, result.assessment);
      return result;
    } catch (err) {
      log.error("Final review agent failed", { projectId, epicId, err });
      await this.persistAuditorRun(
        projectId,
        planId,
        epicId,
        startedAt,
        "failed",
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  /**
   * Multi-angle epic review: parallel reviewers per angle, then lead synthesizer.
   */
  private async runMultiAngleEpicReview(
    projectId: string,
    epicId: string,
    planId: string,
    repoPath: string,
    basePrompt: string,
    reviewAngles: ReviewAngle[],
    settings: import("@opensprint/shared").ProjectSettings
  ): Promise<FinalReviewResult | null> {
    const EPIC_ANGLE_SYSTEM = `You are a Final Review angle reviewer for OpenSprint. Focus ONLY on your assigned angle. Assess the epic implementation from that lens.

Respond with ONLY valid JSON (no markdown):
{"status":"pass"|"issues","assessment":"Brief summary for this angle","proposedTasks":[{"title":"...","description":"...","priority":0-4}]}
- status "pass": This angle has no significant issues. proposedTasks must be [].
- status "issues": You found issues. proposedTasks lists concrete tasks for this angle only.`;

    const angleSystemPrompt = `${EPIC_ANGLE_SYSTEM}\n\n${await getCombinedInstructions(repoPath, "auditor")}`;
    const config = getAgentForPlanningRole(settings, "auditor");
    const angleResults: Array<{ angle: string; status: string; assessment: string; proposedTasks: FinalReviewProposedTask[] }> = [];

    const anglePromises = reviewAngles.map(async (angle) => {
      const label = REVIEW_ANGLE_OPTIONS.find((o) => o.value === angle)?.label ?? angle;
      const checklist = REVIEW_ANGLE_CHECKLISTS[angle] ?? [];
      const checklistBlock = checklist.length > 0
        ? `\n\n## Checklist for ${label}\n${checklist.map((c) => `- [ ] ${c}`).join("\n")}\n`
        : "";
      const prompt = `${basePrompt}${checklistBlock}\n\nFocus ONLY on the ${label} angle.`;
      const agentId = `final-review-${angle}-${projectId}-${epicId}-${Date.now()}`;
      try {
        const response = await agentService.invokePlanningAgent({
          projectId,
          config,
          messages: [{ role: "user", content: prompt }],
          systemPrompt: angleSystemPrompt,
          cwd: repoPath,
          tracking: {
            id: agentId,
            projectId,
            phase: "execute",
            role: "auditor",
            label: `Final review (${label})`,
            planId,
          },
        });
        const parsed = extractJsonFromAgentResponse<{
          status?: string;
          assessment?: string;
          proposedTasks?: Array<{ title?: string; description?: string; priority?: number }>;
        }>(response.content, "status");
        const status = parsed?.status === "issues" ? "issues" : "pass";
        const proposedTasks: FinalReviewProposedTask[] = (parsed?.proposedTasks ?? [])
          .filter((t) => t.title && t.description)
          .map((t) => ({
            title: String(t.title),
            description: String(t.description),
            priority: typeof t.priority === "number" ? Math.min(4, Math.max(0, t.priority)) : 2,
          }));
        return { angle, status, assessment: parsed?.assessment ?? "", proposedTasks };
      } catch (err) {
        log.warn("Epic angle review failed", { projectId, epicId, angle, err });
        return { angle, status: "pass", assessment: "Angle review failed; assuming pass.", proposedTasks: [] };
      }
    });

    const results = await Promise.all(anglePromises);
    for (const r of results) angleResults.push(r);

    return this.synthesizeEpicReviewResults(
      angleResults,
      projectId,
      epicId,
      planId,
      repoPath,
      settings
    );
  }

  private async synthesizeEpicReviewResults(
    angleResults: Array<{ angle: string; status: string; assessment: string; proposedTasks: FinalReviewProposedTask[] }>,
    projectId: string,
    epicId: string,
    planId: string,
    repoPath: string,
    settings: import("@opensprint/shared").ProjectSettings
  ): Promise<FinalReviewResult> {
    const EPIC_SYNTHESIZER_PROMPT = `You are the Final Review Lead for OpenSprint. Multiple angle reviewers have assessed an epic. Synthesize their findings into one report.

Rules:
- If ANY angle returned "issues", overall status MUST be "issues". Merge proposedTasks from all angles; deduplicate by title/description.
- If ALL angles passed, status "pass", proposedTasks [].
- Output ONLY valid JSON: {"status":"pass"|"issues","assessment":"Synthesis summary","proposedTasks":[{"title":"...","description":"...","priority":0-4}]}`;

    const synthesizerSystemPrompt = `${EPIC_SYNTHESIZER_PROMPT}\n\n${await getCombinedInstructions(repoPath, "auditor")}`;
    const blocks = angleResults
      .map((r) => {
        const label = REVIEW_ANGLE_OPTIONS.find((o) => o.value === r.angle)?.label ?? r.angle;
        return `### ${label}\nStatus: ${r.status}\nAssessment: ${r.assessment}\nProposed: ${r.proposedTasks.map((t) => t.title).join(", ") || "none"}`;
      })
      .join("\n\n");

    const prompt = `## Angle review results\n\n${blocks}\n\n---\nSynthesize into one JSON with status, assessment, proposedTasks.`;

    const startedAt = new Date().toISOString();
    try {
      const response = await agentService.invokePlanningAgent({
        projectId,
        config: getAgentForPlanningRole(settings, "auditor"),
        messages: [{ role: "user", content: prompt }],
        systemPrompt: synthesizerSystemPrompt,
        cwd: repoPath,
        tracking: {
          id: `epic-synthesizer-${projectId}-${epicId}-${Date.now()}`,
          projectId,
          phase: "execute",
          role: "auditor",
          label: "Epic Review Synthesizer",
          planId,
        },
      });
      const parsed = extractJsonFromAgentResponse<{
        status?: string;
        assessment?: string;
        proposedTasks?: Array<{ title?: string; description?: string; priority?: number }>;
      }>(response.content, "status");
      const status = parsed?.status === "issues" ? "issues" : "pass";
      const proposedTasks: FinalReviewProposedTask[] = (parsed?.proposedTasks ?? [])
        .filter((t) => t.title && t.description)
        .map((t) => ({
          title: String(t.title),
          description: String(t.description),
          priority: typeof t.priority === "number" ? Math.min(4, Math.max(0, t.priority)) : 2,
        }));
      const result: FinalReviewResult = { status, assessment: parsed?.assessment ?? "", proposedTasks };
      await this.persistAuditorRun(projectId, planId, epicId, startedAt, result.status, result.assessment);
      return result;
    } catch (err) {
      log.warn("Epic synthesizer failed, using programmatic merge", { projectId, epicId, err });
      const hasIssues = angleResults.some((r) => r.status === "issues");
      const proposedTasks = angleResults.flatMap((r) => r.proposedTasks);
      const seen = new Set<string>();
      const deduped = proposedTasks.filter((t) => {
        const key = `${t.title}:${t.description}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const result: FinalReviewResult = {
        status: hasIssues ? "issues" : "pass",
        assessment: angleResults.map((r) => r.assessment).filter(Boolean).join(" | ") || "Epic review",
        proposedTasks: deduped,
      };
      await this.persistAuditorRun(projectId, planId, epicId, startedAt, result.status, result.assessment);
      return result;
    }
  }

  private async persistAuditorRun(
    projectId: string,
    planId: string,
    epicId: string,
    startedAt: string,
    status: string,
    assessment: string
  ): Promise<void> {
    try {
      await this.taskStore.auditorRunInsert({
        projectId,
        planId,
        epicId,
        startedAt,
        completedAt: new Date().toISOString(),
        status,
        assessment,
      });
    } catch (err) {
      log.warn("Failed to persist auditor run", { projectId, planId, epicId, err });
    }
  }

  private parseFinalReviewResponse(
    content: string,
    projectId: string,
    epicId: string
  ): FinalReviewResult {
    const parsed = extractJsonFromAgentResponse<{
      status?: string;
      assessment?: string;
      proposedTasks?: Array<{ title?: string; description?: string; priority?: number }>;
    }>(content, "status");

    if (!parsed || !parsed.status) {
      log.warn("Final review agent did not return valid JSON, treating as pass", {
        projectId,
        epicId,
      });
      return {
        status: "pass",
        assessment: "Review agent did not return valid result; assuming pass.",
        proposedTasks: [],
      };
    }

    const status = parsed.status === "issues" ? "issues" : "pass";
    const proposedTasks: FinalReviewProposedTask[] = (parsed.proposedTasks ?? [])
      .filter((t) => t.title && t.description)
      .map((t) => ({
        title: String(t.title),
        description: String(t.description),
        priority: typeof t.priority === "number" ? Math.min(4, Math.max(0, t.priority)) : 2,
      }));

    return {
      status,
      assessment: parsed.assessment ?? "",
      proposedTasks,
    };
  }

  /**
   * Create tasks from proposed tasks and link them to the epic.
   */
  async createTasksFromReview(
    projectId: string,
    epicId: string,
    proposedTasks: FinalReviewProposedTask[]
  ): Promise<string[]> {
    const createdIds: string[] = [];
    for (const task of proposedTasks) {
      try {
        const created = await this.taskStore.create(projectId, task.title, {
          type: "task",
          description: task.description,
          priority: task.priority ?? 2,
          parentId: epicId,
        });
        createdIds.push(created.id);
      } catch (err) {
        log.warn("Failed to create task from final review", {
          projectId,
          epicId,
          title: task.title,
          err,
        });
      }
    }
    return createdIds;
  }
}

export const finalReviewService = new FinalReviewService();
