/**
 * Plan decompose/generate: suggest plans, decompose from PRD, generate from description, plan tasks (generate and create tasks).
 * Encapsulates all planning-agent flows that create or suggest plans/tasks; used by PlanService and PlanShipService.
 */
import type {
  Plan,
  PlanAttachment,
  PlanMetadata,
  PlanDependencyEdge,
  SuggestedPlan,
  PlanComplexity,
  GeneratePlanResult,
  Notification,
  NotificationSource,
  ProjectSettings,
} from "@opensprint/shared";
import { getAgentForPlanningRole, MAX_PLAN_DEPTH } from "@opensprint/shared";
import {
  getEpicTitleFromPlanContent,
  normalizePlanSpec,
  normalizeDependsOnPlans,
  ensureDependenciesSection,
  normalizePlannerOpenQuestions,
  normalizePlanMarkdownContent,
  buildSubPlanDependencyEdges,
  slugifyPlanTitleToId,
  sortSubPlansTopologically,
  type NormalizedSubPlan,
  type NormalizedPlannerTask,
} from "./plan/planner-normalize.js";
import {
  DECOMPOSE_SYSTEM_PROMPT,
  buildMaxDepthTaskGenerationConsolidationInstruction,
  getPlanMarkdownSections,
  getPlanTemplateStructure,
} from "./plan/plan-prompts.js";
import {
  buildPlanTaskSummaryFromCreated,
  buildPrdContextString,
  explainDecomposeResponseFailure,
  parseDecomposeResponse,
  parseDecomposeResponseOrNull,
} from "./plan/plan-decompose-generate.js";
import { runAutoReviewPlanAgainstRepo } from "./plan/plan-auto-review.js";
import { runPlannerWithRepoGuard } from "./plan/plan-repo-guard.js";
import {
  generateAndCreateTasks as generateAndCreateTasksImpl,
  type PlanTaskHierarchyContext,
} from "./plan/plan-task-generation.js";
import { validatePlanDependencyDAG } from "./plan/plan-dependency-graph.js";
import { buildPlanningTaskPolicy } from "./plan/plan-task-policy.js";
import { evaluatePlanComplexity } from "./plan/plan-complexity-gate.js";
import { ProjectService } from "./project.service.js";
import type { StoredTask } from "./task-store.types.js";
import { PrdService } from "./prd.service.js";
import { buildAutonomyDescription } from "./autonomy-description.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { broadcastToProject } from "../websocket/index.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { createLogger } from "../utils/logger.js";
import { invokeStructuredPlanningAgent } from "./structured-agent-output.service.js";

const log = createLogger("plan-decompose-generate");

/** Match plan-crud version filtering for tasks listed under an epic. */
function taskPlanVersionForTaskGeneration(task: StoredTask): number {
  const raw =
    (task as Record<string, unknown>).sourcePlanVersionNumber ??
    (task as Record<string, unknown>).source_plan_version_number;
  return typeof raw === "number" && raw >= 1 ? raw : 1;
}

export const GENERATE_PLAN_SYSTEM_PROMPT = `You are an AI planning assistant for Open Sprint. The user will describe a feature idea in freeform text. Your job is to produce a complete feature plan (markdown in content; optional structured mockups; no subtasks).

## Output requirement (mandatory)
Your entire response MUST be the plan as a single JSON object. Do NOT write the plan to a file. Do NOT create, modify, stage, or commit any files in the repository. Do NOT respond with a summary, description, or "here's what I created" text — the system parses your message for JSON only; any prose instead of JSON will cause failure.
You may wrap the JSON in a markdown code block (\`\`\`json ... \`\`\`). The JSON must include at minimum: "title", "content", "complexity", "mockups" (use [] if none). Do NOT include a tasks array.

Required JSON shape:
{
  "title": "Feature Name",
  "content": "# Feature Name\\n\\n## Overview\\n...full markdown...",
  "complexity": "medium",
  "mockups": []
}

Visual aids: You choose per plan — include Mermaid (fenced \`\`\`mermaid in content), ASCII mockups in \`mockups\`, both, or neither if prose is sufficient. Prefer Mermaid for flows/architecture; prefer ASCII mockups for screen layout. Keep diagrams small and valid.

Plan markdown MUST follow this structure (PRD §7.2.3). Each plan's content must include these sections in order:
${getPlanMarkdownSections()
  .map((s) => `- ## ${s}`)
  .join("\n")}

Template structure: ${getPlanTemplateStructure()}

Field rules: complexity: low, medium, high, or very_high (plan-level).

**Scale, speed, and cost awareness:** Before writing the Technical Approach, check whether the feature description or PRD context mentions scale (expected users, data volume, growth), speed (latency, throughput), or cost (budget, infra constraints). When present, factor them into the Technical Approach and any relevant sections. When absent, include a brief note in the Assumptions section: "No scale, speed, or cost constraints were specified; sensible defaults are assumed."

**When requirements are unclear:** If the feature idea is too vague to decompose, return JSON with \`open_questions\`: [{ "id": "q1", "text": "Clarification question" }] instead of a plan. The server surfaces these via the Human Notification System; wait for user answers before proceeding.`;

const DECOMPOSE_REPAIR_PROMPT =
  'Return valid JSON only with a top-level "plans" array (or "plan_list"). Do not include prose outside the JSON.';
const GENERATE_PLAN_REPAIR_PROMPT = `Return valid JSON only. Either:
{"open_questions":[{"id":"q1","text":"Clarification question"}]}
or
{"title":"Feature Name","content":"# Feature Name\\n\\n...","complexity":"medium","mockups":[]}
(mockups may be [] or include ASCII wireframes; you may use fenced mermaid in content for diagrams.)
Do not include prose outside the JSON.`;

/**
 * Build a prompt section from user-supplied attachments (Markdown text, PDFs, images).
 * Text-based attachments are inlined; binary attachments are described with a note.
 */
function buildAttachmentContext(attachments?: PlanAttachment[]): string {
  if (!attachments || attachments.length === 0) return "";
  const sections: string[] = [];
  for (const att of attachments) {
    if (att.textContent) {
      sections.push(`### Attachment: ${att.name}\n\n${att.textContent}`);
    } else if (att.mimeType.startsWith("image/")) {
      sections.push(
        `### Attachment: ${att.name} (image, ${att.mimeType})\n\n[Image attached — use the visual context if your model supports multimodal input; otherwise treat this as supplementary reference material named "${att.name}".]`
      );
    } else if (att.mimeType === "application/pdf") {
      sections.push(
        `### Attachment: ${att.name} (PDF)\n\n[PDF document attached — text extraction is not available in this pipeline. Treat this as supplementary reference material named "${att.name}".]`
      );
    }
  }
  if (sections.length === 0) return "";
  return `\n\n## User-Supplied Attachments\n\n${sections.join("\n\n")}`;
}

export interface PlanDecomposeGenerateDeps {
  taskStore: {
    listAll(projectId: string): Promise<StoredTask[]>;
    createMany(
      projectId: string,
      inputs: Array<Record<string, unknown> & { title: string }>
    ): Promise<Array<{ id: string }>>;
    addDependencies(
      projectId: string,
      deps: Array<{ childId: string; parentId: string; type?: string }>
    ): Promise<void>;
    addLabel(projectId: string, taskId: string, label: string): Promise<void>;
    close(projectId: string, taskId: string, reason: string): Promise<void | StoredTask>;
    create(
      projectId: string,
      title: string,
      opts?: Record<string, unknown>
    ): Promise<{ id: string }>;
    update(
      projectId: string,
      taskId: string,
      updates: Record<string, unknown>
    ): Promise<void | StoredTask>;
    planUpdateMetadata(
      projectId: string,
      planId: string,
      metadata: Record<string, unknown>
    ): Promise<void>;
    planListByParent(projectId: string, parentPlanId: string): Promise<string[]>;
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
  /** Ensures each new plan has a v1 row in plan_versions from that plan's stored content (used for sub-plans). */
  ensurePlanHasAtLeastOneVersion: (projectId: string, planId: string) => Promise<void>;
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
      source: NotificationSource;
      sourceId: string;
      questions: Array<{ id: string; text: string; createdAt?: string }>;
    }) => Promise<Notification>;
  };
  maybeAutoRespond?: (projectId: string, notification: Notification) => Promise<void>;
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

  /** Short ancestor chain (plan titles) for complexity-gate context on nested plans. */
  private async buildAncestorChainSummary(
    projectId: string,
    plan: Plan
  ): Promise<string | undefined> {
    const titles: string[] = [];
    let parentId = plan.metadata.parentPlanId;
    let guard = 0;
    while (parentId && guard++ < 8) {
      try {
        const parent = await this.deps.getPlan(projectId, parentId);
        const firstLine =
          parent.content.trim().split("\n")[0]?.replace(/^#\s*/, "").trim() ||
          parent.metadata.planId;
        titles.unshift(firstLine);
        parentId = parent.metadata.parentPlanId;
      } catch {
        break;
      }
    }
    if (titles.length === 0) return undefined;
    const slice = titles.length > 4 ? titles.slice(-4) : titles;
    return slice.join(" → ");
  }

  private truncatePlanningSnippet(text: string, maxChars: number): string {
    const singleLine = text.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxChars) return singleLine;
    return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  /**
   * Short summaries of other child plans under the same parent (for complexity gate + task prompts).
   */
  private async buildSiblingPlanSummaries(
    projectId: string,
    plan: Plan
  ): Promise<string | undefined> {
    const parentId = plan.metadata.parentPlanId?.trim();
    if (!parentId) return undefined;

    let siblingIds: string[];
    try {
      siblingIds = await this.deps.taskStore.planListByParent(projectId, parentId);
    } catch (err) {
      log.warn("buildSiblingPlanSummaries: planListByParent failed", {
        err: getErrorMessage(err),
        planId: plan.metadata.planId,
      });
      return undefined;
    }

    const others = siblingIds.filter((id) => id !== plan.metadata.planId);
    if (others.length === 0) return undefined;

    const lines: string[] = [];
    for (const sid of [...others].sort()) {
      try {
        const sib = await this.deps.getPlan(projectId, sid);
        const title =
          sib.content.trim().split("\n")[0]?.replace(/^#\s*/, "").trim() || sib.metadata.planId;
        const body = sib.content.replace(/^#[^\n]*\n?/, "").trim();
        const excerpt = this.truncatePlanningSnippet(body, 240);
        lines.push(`- **${sid}** (${title}): ${excerpt || "(no body)"}`);
      } catch (err) {
        log.warn("buildSiblingPlanSummaries: skipped sibling", {
          err: getErrorMessage(err),
          siblingId: sid,
        });
        lines.push(`- **${sid}**: (could not load plan)`);
      }
    }
    return lines.join("\n");
  }

  private planTitleFromContent(plan: Plan): string {
    return plan.content.trim().split("\n")[0]?.replace(/^#\s*/, "").trim() || plan.metadata.planId;
  }

  private planOverviewFromContent(plan: Plan): string {
    const body = plan.content.replace(/^#[^\n]*\n?/, "").trim();
    const overviewMatch = body.match(/^##\s*Overview\s*\n+([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
    if (overviewMatch?.[1]) return overviewMatch[1].trim();
    return body.split(/\n\n+/)[0]?.trim() ?? "";
  }

  /**
   * Hierarchy context for recursive task generation: ancestor chain + siblings that already
   * have implementation tasks for the current plan version.
   */
  private async buildTaskGenerationHierarchyContext(
    projectId: string,
    plan: Plan
  ): Promise<PlanTaskHierarchyContext | undefined> {
    const parentPlanId = plan.metadata.parentPlanId?.trim();
    if (!parentPlanId) return undefined;

    const ancestors: PlanTaskHierarchyContext["ancestors"] = [];
    let walkId: string | undefined = parentPlanId;
    let guard = 0;
    while (walkId && guard++ < 16) {
      try {
        const p = await this.deps.getPlan(projectId, walkId);
        ancestors.unshift({
          title: this.planTitleFromContent(p),
          overview: this.planOverviewFromContent(p),
        });
        walkId = p.metadata.parentPlanId?.trim() || undefined;
      } catch {
        break;
      }
    }

    let siblingIds: string[];
    try {
      siblingIds = await this.deps.taskStore.planListByParent(projectId, parentPlanId);
    } catch (err) {
      log.warn("buildTaskGenerationHierarchyContext: planListByParent failed", {
        err: getErrorMessage(err),
        planId: plan.metadata.planId,
      });
      return { ancestors, siblings: [] };
    }

    const selfId = plan.metadata.planId;
    const siblings: PlanTaskHierarchyContext["siblings"] = [];
    for (const sid of [...siblingIds].filter((id) => id !== selfId).sort()) {
      try {
        const sib = await this.deps.getPlan(projectId, sid);
        if ((sib.taskCount ?? 0) === 0) continue;
        const epicId = sib.metadata.epicId?.trim();
        if (!epicId) continue;
        const allIssues = await this.deps.taskStore.listAll(projectId);
        const currentVersion = sib.currentVersionNumber ?? 1;
        const children = allIssues.filter((issue) => {
          if (!issue.id.startsWith(`${epicId}.`)) return false;
          if ((issue.issue_type ?? issue.type) === "epic") return false;
          return taskPlanVersionForTaskGeneration(issue) === currentVersion;
        });
        if (children.length === 0) continue;
        const sorted = [...children].sort((a, b) => a.id.localeCompare(b.id));
        const planForSummary = {
          ...sib,
          _createdTaskIds: sorted.map((c) => c.id),
          _createdTaskTitles: sorted.map((c) => c.title),
        };
        siblings.push({
          title: this.planTitleFromContent(sib),
          taskSummary: buildPlanTaskSummaryFromCreated([planForSummary]),
        });
      } catch (err) {
        log.warn("buildTaskGenerationHierarchyContext: skipped sibling", {
          err: getErrorMessage(err),
          siblingId: sid,
        });
      }
    }

    return { ancestors, siblings };
  }

  /**
   * Titles of implementation tasks under sibling plans (same parent) → task ids. Used so a child
   * plan’s generated tasks can use dependsOn pointing at sibling tasks. First wins on title clash.
   */
  private async buildCrossEpicSiblingTaskTitleToIdMap(
    projectId: string,
    plan: Plan,
    parentPlanId: string,
    allIssues: StoredTask[]
  ): Promise<Record<string, string>> {
    const selfId = plan.metadata.planId;
    let siblingIds: string[];
    try {
      siblingIds = await this.deps.taskStore.planListByParent(projectId, parentPlanId);
    } catch (err) {
      log.warn("buildCrossEpicSiblingTaskTitleToIdMap: planListByParent failed", {
        err: getErrorMessage(err),
        planId: plan.metadata.planId,
      });
      return {};
    }

    const out: Record<string, string> = {};
    for (const sid of [...siblingIds].filter((id) => id !== selfId).sort()) {
      try {
        const sib = await this.deps.getPlan(projectId, sid);
        if ((sib.taskCount ?? 0) === 0) continue;
        const epicId = sib.metadata.epicId?.trim();
        if (!epicId) continue;
        const ver = sib.currentVersionNumber ?? 1;
        const children = allIssues.filter((issue) => {
          if (!issue.id.startsWith(`${epicId}.`)) return false;
          if ((issue.issue_type ?? issue.type) === "epic") return false;
          return taskPlanVersionForTaskGeneration(issue) === ver;
        });
        for (const c of children) {
          if (!(c.title in out)) {
            out[c.title] = c.id;
          }
        }
      } catch (err) {
        log.warn("buildCrossEpicSiblingTaskTitleToIdMap: skipped sibling", {
          err: getErrorMessage(err),
          siblingId: sid,
        });
      }
    }
    return out;
  }

  /**
   * Persist child plans + epics for a sub-plan split. Runs sequentially so epic IDs stay unique.
   * Injects cross-sub-plan ordering into markdown via `ensureDependenciesSection`, broadcasts
   * `plan.updated` for each child and the parent.
   */
  private async createSubPlans(
    projectId: string,
    parentPlan: Plan,
    subPlans: NormalizedSubPlan[]
  ): Promise<Plan[]> {
    if (subPlans.length === 0) return [];

    const parentDepth = parentPlan.metadata.depth ?? parentPlan.depth ?? 1;
    if (parentDepth + 1 > MAX_PLAN_DEPTH) {
      throw new AppError(
        400,
        ErrorCodes.PLAN_DEPTH_EXCEEDED,
        "Cannot create sub-plans: maximum hierarchy depth of 4 reached"
      );
    }

    const interEdges = buildSubPlanDependencyEdges(subPlans);
    const allSubPlanIds = subPlans.map((s) => slugifyPlanTitleToId(s.title));
    const dagCheck = validatePlanDependencyDAG(interEdges, allSubPlanIds);
    if (!dagCheck.valid) {
      throw new AppError(
        400,
        ErrorCodes.PLAN_CIRCULAR_DEPENDENCY,
        `Sub-plan dependencies contain a cycle: ${(dagCheck.cycle ?? []).join(" → ")}`,
        { cycle: dagCheck.cycle }
      );
    }

    const childDepth = parentDepth + 1;
    const created: Plan[] = [];

    for (const spec of subPlans) {
      const scoped = spec.content.trim().startsWith("#")
        ? spec.content
        : `# ${spec.title}\n\n${spec.overview}\n\n${spec.content}`;
      const markdown = normalizePlanMarkdownContent(scoped);
      const content = ensureDependenciesSection(markdown, spec.dependsOnPlans);

      const child = await this.deps.createPlan(projectId, {
        title: spec.title,
        content,
        parentPlanId: parentPlan.metadata.planId,
        depth: childDepth,
        complexity: parentPlan.metadata.complexity,
      });
      await this.deps.ensurePlanHasAtLeastOneVersion(projectId, child.metadata.planId);
      created.push(child);
      broadcastToProject(projectId, { type: "plan.updated", planId: child.metadata.planId });
    }

    broadcastToProject(projectId, { type: "plan.updated", planId: parentPlan.metadata.planId });
    return created;
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
    plan: Plan,
    opts?: { extraUserPromptSuffix?: string; preGeneratedTasks?: NormalizedPlannerTask[] }
  ): Promise<{
    count: number;
    taskRefs: Array<{ id: string; title: string }>;
    parseFailureReason?: string;
  }> {
    const settings = await this.deps.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);
    const hierarchyContext = await this.buildTaskGenerationHierarchyContext(projectId, plan);
    const ancestorChainSummary = await this.buildAncestorChainSummary(projectId, plan);
    const siblingPlanSummaries = await this.buildSiblingPlanSummaries(projectId, plan);

    let crossEpicDependsTitleToId: Record<string, string> | undefined;
    const parentPlanId = plan.metadata.parentPlanId?.trim();
    if (parentPlanId) {
      try {
        const allIssues = await this.deps.taskStore.listAll(projectId);
        const map = await this.buildCrossEpicSiblingTaskTitleToIdMap(
          projectId,
          plan,
          parentPlanId,
          allIssues
        );
        if (Object.keys(map).length > 0) {
          crossEpicDependsTitleToId = map;
        }
      } catch (err) {
        log.warn("cross-epic task title map failed", {
          err: getErrorMessage(err),
          planId: plan.metadata.planId,
        });
      }
    }

    return generateAndCreateTasksImpl({
      projectId,
      repoPath,
      plan,
      prdContext,
      hierarchyContext,
      ancestorChainSummary: hierarchyContext ? undefined : ancestorChainSummary,
      siblingPlanSummaries: hierarchyContext ? undefined : siblingPlanSummaries,
      extraUserPromptSuffix: opts?.extraUserPromptSuffix,
      preGeneratedTasks: opts?.preGeneratedTasks,
      crossEpicDependsTitleToId,
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
      await taskStore.planUpdateMetadata(projectId, planId, {
        ...plan.metadata,
        epicId,
      } as unknown as Record<string, unknown>);
      log.info("Created missing epic for plan", { planId, epicId, title });
    } else {
      await taskStore.update(projectId, epicId, { status: "blocked" });
    }

    if (plan.hasGeneratedPlanTasksForCurrentVersion) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        "Plan already has implementation tasks. Use Execute! to start building."
      );
    }

    const planWithEpic: Plan = {
      ...plan,
      metadata: { ...plan.metadata, epicId: epicId ?? plan.metadata.epicId },
    };

    const settings = await this.deps.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);
    const currentDepth = planWithEpic.metadata.depth ?? planWithEpic.depth ?? 1;
    const agentConfig = getAgentForPlanningRole(
      settings as ProjectSettings,
      "planner",
      planWithEpic.metadata.complexity
    );
    const ancestorChainSummary = await this.buildAncestorChainSummary(projectId, planWithEpic);
    const siblingPlanSummaries = await this.buildSiblingPlanSummaries(projectId, planWithEpic);

    const atMaxDepth = currentDepth >= MAX_PLAN_DEPTH;
    const decision = atMaxDepth
      ? { strategy: "tasks" as const, tasks: [] }
      : await evaluatePlanComplexity({
          projectId,
          repoPath,
          planContent: planWithEpic.content,
          prdContext,
          currentDepth,
          agentConfig,
          settings,
          hierarchyContext: await this.buildTaskGenerationHierarchyContext(projectId, planWithEpic),
          planComplexity: planWithEpic.metadata.complexity,
          planId: planWithEpic.metadata.planId,
          ancestorChainSummary,
          siblingPlanSummaries,
        });

    if (decision.strategy === "sub_plans") {
      const interEdges = buildSubPlanDependencyEdges(decision.subPlans);
      const allSiblingIds = decision.subPlans.map((s) => slugifyPlanTitleToId(s.title));
      const dagGate = validatePlanDependencyDAG(interEdges, allSiblingIds);
      if (!dagGate.valid) {
        throw new AppError(
          400,
          ErrorCodes.PLAN_CIRCULAR_DEPENDENCY,
          `Sub-plan dependencies contain a cycle: ${(dagGate.cycle ?? []).join(" → ")}`,
          { cycle: dagGate.cycle }
        );
      }
      const sortResult = sortSubPlansTopologically(decision.subPlans);
      if (!sortResult.ok) {
        log.error("sortSubPlansTopologically failed after DAG validation", {
          reason: sortResult.reason,
        });
        throw new AppError(
          400,
          ErrorCodes.PLAN_CIRCULAR_DEPENDENCY,
          "Sub-plan dependencies contain a cycle. Remove the circular ordering between sibling sub-plans and try Plan Tasks again."
        );
      }
      const ordered = sortResult.ordered;
      const childPlans = await this.createSubPlans(projectId, planWithEpic, ordered);
      const failedPlanIds: string[] = [];
      const successPlanIds: string[] = [];
      let cumulativeTaskCount = 0;

      for (const child of childPlans) {
        const childPlanId = child.metadata.planId;
        try {
          const updatedChild = await this.planTasks(projectId, childPlanId);
          cumulativeTaskCount += updatedChild.totalTasksCreated ?? 0;
          const refreshed = await this.deps.getPlan(projectId, childPlanId);
          if (refreshed.hasGeneratedPlanTasksForCurrentVersion) {
            successPlanIds.push(childPlanId);
          } else {
            failedPlanIds.push(childPlanId);
            broadcastToProject(projectId, {
              type: "plan.updated",
              planId: childPlanId,
              planTasksGenerationFailed: true,
              planTasksGenerationErrorMessage:
                "Plan Tasks did not complete for this sub-plan; retry on this plan.",
            });
          }
        } catch (err) {
          log.error("Recursive plan tasks failed for child", { planId, childPlanId, err });
          failedPlanIds.push(childPlanId);
          broadcastToProject(projectId, {
            type: "plan.updated",
            planId: childPlanId,
            planTasksGenerationFailed: true,
            planTasksGenerationErrorMessage: getErrorMessage(err),
          });
        }
      }

      if (cumulativeTaskCount === 0) {
        throw new AppError(
          400,
          ErrorCodes.DECOMPOSE_PARSE_FAILED,
          "Sub-plans did not yield any implementation tasks. Try refining the plan content."
        );
      }

      const allDirectChildrenSucceeded = failedPlanIds.length === 0;
      if (allDirectChildrenSucceeded) {
        const generatedForVersion = plan.currentVersionNumber ?? 1;
        await taskStore.planUpdateMetadata(projectId, planId, {
          ...planWithEpic.metadata,
          lastTaskGenerationVersionNumber: generatedForVersion,
        } as unknown as Record<string, unknown>);
      }

      const updatedPlan = await this.deps.getPlan(projectId, planId);
      await this.autoReviewPlanAgainstRepo(projectId, [updatedPlan]);
      broadcastToProject(projectId, { type: "plan.updated", planId });
      log.info("planTasks sub-plan split complete", {
        planId,
        cumulativeTaskCount,
        failedPlanIds,
        successPlanIds,
      });
      return {
        ...updatedPlan,
        totalTasksCreated: cumulativeTaskCount,
        failedPlanIds,
        successPlanIds,
      };
    }

    let tasksGenerated = 0;
    let parseFailureReason: string | undefined;
    try {
      const genResult = await this.generateAndCreateTasks(projectId, repoPath, planWithEpic, {
        preGeneratedTasks: decision.tasks.length > 0 ? decision.tasks : undefined,
        extraUserPromptSuffix: atMaxDepth
          ? buildMaxDepthTaskGenerationConsolidationInstruction()
          : undefined,
      });
      tasksGenerated = genResult.count;
      parseFailureReason = genResult.parseFailureReason;
      if (tasksGenerated > 0) {
        const generatedForVersion = plan.currentVersionNumber ?? 1;
        await taskStore.planUpdateMetadata(projectId, planId, {
          ...planWithEpic.metadata,
          lastTaskGenerationVersionNumber: generatedForVersion,
        } as unknown as Record<string, unknown>);
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

    const finalPlan = await this.deps.getPlan(projectId, planId);
    broadcastToProject(projectId, { type: "plan.updated", planId });
    return {
      ...finalPlan,
      totalTasksCreated: tasksGenerated,
      failedPlanIds: [],
      successPlanIds: [planId],
    };
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

    const suggestSystemPrompt = `${systemPrompt}\n\n${buildPlanningTaskPolicy(settings)}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
    const response = await runPlannerWithRepoGuard({
      repoPath,
      label: "Feature decomposition (suggest)",
      run: () =>
        invokeStructuredPlanningAgent({
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
          contract: {
            parse: parseDecomposeResponseOrNull,
            repairPrompt: DECOMPOSE_REPAIR_PROMPT,
            invalidReason: explainDecomposeResponseFailure,
          },
        }),
    });

    const planSpecs = response.parsed ?? parseDecomposeResponse(response.rawContent);
    return { plans: planSpecs };
  }

  async decomposeFromPrd(projectId: string): Promise<{ created: number; plans: Plan[] }> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.deps.projectService.getSettings(projectId);

    const prdContext = await this.buildPrdContext(projectId);

    const prompt = `Analyze the PRD below and produce a feature decomposition. Output valid JSON with a "plans" array. Each plan has: title, content (full markdown; you may include fenced mermaid for flows/architecture), complexity (low|medium|high|very_high), dependsOnPlans (array of slugified plan IDs this plan depends on), and mockups (array of {title, content} for ASCII wireframes, or [] if diagrams are only in markdown). Do NOT include a tasks array.`;

    const agentId = `plan-decompose-${projectId}-${Date.now()}`;

    const baseSystemPrompt = DECOMPOSE_SYSTEM_PROMPT + "\n\n## Current PRD\n\n" + prdContext;
    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const systemPrompt = autonomyDesc
      ? `${baseSystemPrompt}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : baseSystemPrompt;

    const decomposeSystemPrompt = `${systemPrompt}\n\n${buildPlanningTaskPolicy(settings)}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
    const response = await runPlannerWithRepoGuard({
      repoPath,
      label: "Feature decomposition",
      run: () =>
        invokeStructuredPlanningAgent({
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
          contract: {
            parse: parseDecomposeResponseOrNull,
            repairPrompt: DECOMPOSE_REPAIR_PROMPT,
            invalidReason: explainDecomposeResponseFailure,
          },
        }),
    });

    const planSpecs = response.parsed ?? parseDecomposeResponse(response.rawContent);
    const totalCount = planSpecs.length;

    broadcastToProject(projectId, {
      type: "plan.decompose.progress",
      createdCount: 0,
      totalCount,
    });

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
      broadcastToProject(projectId, {
        type: "plan.decompose.progress",
        createdCount: created.length,
        totalCount,
      });
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
    description: string,
    attachments?: PlanAttachment[]
  ): Promise<GeneratePlanResult> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.deps.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);

    const systemPrompt = GENERATE_PLAN_SYSTEM_PROMPT;

    const autonomyDesc = buildAutonomyDescription(settings.aiAutonomyLevel, settings.hilConfig);
    const systemPromptWithAutonomy = autonomyDesc
      ? `${systemPrompt}\n\n## AI Autonomy Level\n\n${autonomyDesc}\n\n`
      : systemPrompt;

    const attachmentContext = buildAttachmentContext(attachments);
    const prompt = `Generate a complete feature plan for the following idea.\n\n## Feature Idea\n\n${description}\n\n## PRD Context\n\n${prdContext}${attachmentContext}`;

    const agentId = `plan-generate-${projectId}-${Date.now()}`;

    const generateSystemPrompt = `${systemPromptWithAutonomy}\n\n${buildPlanningTaskPolicy(settings)}\n\n${await getCombinedInstructions(repoPath, "planner")}`;
    const response = await runPlannerWithRepoGuard({
      repoPath,
      label: "Generate plan from description",
      run: () =>
        invokeStructuredPlanningAgent({
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
          contract: {
            parse: (content) =>
              extractJsonFromAgentResponse<Record<string, unknown>>(content, "open_questions") ??
              extractJsonFromAgentResponse<Record<string, unknown>>(content, "openQuestions") ??
              extractJsonFromAgentResponse<Record<string, unknown>>(content, "plan_title") ??
              extractJsonFromAgentResponse<Record<string, unknown>>(content, "title"),
            repairPrompt: GENERATE_PLAN_REPAIR_PROMPT,
            invalidReason: (content) =>
              content.trim()
                ? `Planning agent did not return a valid plan. Response: ${content.slice(0, 500)}`
                : "Planning agent returned no parseable content.",
          },
        }),
    });

    const parsed = response.parsed;

    if (!parsed) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        "Planning agent did not return a valid plan. Response: " +
          response.rawContent.slice(0, 500),
        { responsePreview: response.rawContent.slice(0, 500) }
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
      await chatService.startPlanDraftConversation(projectId, draftId, description, openQuestions);
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
        "Planning agent did not return a valid plan. Response: " +
          response.rawContent.slice(0, 500),
        { responsePreview: response.rawContent.slice(0, 500) }
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
