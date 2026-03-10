/**
 * SelfImprovementRunnerService — runs a self-improvement review over the codebase and creates
 * improvement tasks. Builds context (SPEC.md, file tree), runs one review per lens (or one general
 * review when no lenses), parses agent output into tasks with source: 'self-improvement', and
 * updates last run timestamp only on success.
 */

import type { ReviewAngle } from "@opensprint/shared";
import { REVIEW_ANGLE_OPTIONS } from "@opensprint/shared";
import { getAgentForPlanningRole } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import { agentService } from "./agent.service.js";
import { ProjectService } from "./project.service.js";
import { PlanService } from "./plan.service.js";
import { ContextAssembler } from "./context-assembler.js";
import { updateSettingsInStore, getSettingsFromStore } from "./settings-store.service.js";
import type { ProjectSettings } from "@opensprint/shared";
import { extractJsonFromAgentResponse } from "../utils/json-extract.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import { createLogger } from "../utils/logger.js";
import { shellExec } from "../utils/shell-exec.js";

const log = createLogger("self-improvement-runner");

export interface ImprovementItem {
  title: string;
  description?: string;
  priority?: number;
}

export interface RunSelfImprovementOptions {
  planId?: string;
  runId?: string;
  /** If provided, stored as selfImprovementLastCommitSha on success. If omitted, current HEAD is used. */
  lastCommitSha?: string;
}

const SELF_IMPROVEMENT_SYSTEM_PROMPT = `You are the Self-Improvement reviewer for OpenSprint. Your job is to review the codebase (SPEC, file tree, and key files) and produce a structured list of improvement tasks.

Output MUST be one of:

1. **JSON** — a single JSON array of improvement items:
[
  {"title": "Short task title", "description": "Optional details", "priority": 1},
  ...
]
- title: required, short phrase
- description: optional
- priority: optional number 0-4 (0=highest)

2. **Markdown** — a list where each item has a title (first line or bold) and optional description:
- **Title one** — optional description
- Title two: optional description

Focus on actionable improvements: code quality, test coverage, documentation, performance, security, design/UX. Be concise; do not propose more than 10 items. If there are no clear improvements, return an empty array or empty list.`;

/** Parse agent response into improvement items. Tries JSON array first, then markdown list; on failure returns one fallback task. */
export function parseImprovementList(content: string): ImprovementItem[] {
  if (!content || !content.trim()) {
    return [{ title: "Self-improvement review: parse empty response", description: "Review produced no parseable output." }];
  }

  // Try bare JSON array (extractJsonFromAgentResponse only finds {...} objects)
  try {
    const parsed = JSON.parse(content.trim()) as unknown;
    if (Array.isArray(parsed)) {
      const items: ImprovementItem[] = [];
      for (const item of parsed) {
        if (item && typeof item === "object" && typeof (item as ImprovementItem).title === "string") {
          const t = item as ImprovementItem;
          items.push({
            title: t.title.trim(),
            description: typeof t.description === "string" ? t.description.trim() : undefined,
            priority:
              typeof t.priority === "number" && !Number.isNaN(t.priority)
                ? Math.min(4, Math.max(0, Math.round(t.priority)))
                : undefined,
          });
        }
      }
      return items;
    }
  } catch {
    // not a bare array, continue
  }

  // Try JSON object/array embedded in text
  const json = extractJsonFromAgentResponse<ImprovementItem[]>(content);
  if (Array.isArray(json) && json.length >= 0) {
    const items: ImprovementItem[] = [];
    for (const item of json) {
      if (item && typeof item === "object" && typeof (item as ImprovementItem).title === "string") {
        const t = item as ImprovementItem;
        items.push({
          title: t.title.trim(),
          description: typeof t.description === "string" ? t.description.trim() : undefined,
          priority:
            typeof t.priority === "number" && !Number.isNaN(t.priority)
              ? Math.min(4, Math.max(0, Math.round(t.priority)))
              : undefined,
        });
      }
    }
    if (items.length > 0) return items;
    return [];
  }

  // Try single JSON object with "items" or "improvements" array
  const obj = extractJsonFromAgentResponse<{ items?: ImprovementItem[]; improvements?: ImprovementItem[] }>(content);
  if (obj && (Array.isArray(obj.items) || Array.isArray(obj.improvements))) {
    const arr = (obj.items ?? obj.improvements) as ImprovementItem[];
    const items: ImprovementItem[] = [];
    for (const item of arr) {
      if (item && typeof item === "object" && typeof item.title === "string") {
        items.push({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : undefined,
          priority:
            typeof item.priority === "number" && !Number.isNaN(item.priority)
              ? Math.min(4, Math.max(0, Math.round(item.priority)))
              : undefined,
        });
      }
    }
    if (items.length > 0) return items;
  }

  // Try markdown list: - **Title** or - Title: description
  const lines = content.split(/\n/);
  const items: ImprovementItem[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-") && !trimmed.startsWith("*")) continue;
    const rest = trimmed.slice(1).trim();
    let title = rest;
    let description: string | undefined;
    const boldMatch = rest.match(/^\*\*(.+?)\*\*(?:\s*[—\-:]\s*(.+))?$/);
    if (boldMatch) {
      title = boldMatch[1]!.trim();
      description = boldMatch[2]?.trim();
    } else {
      const colon = rest.indexOf(":");
      if (colon > 0) {
        title = rest.slice(0, colon).replace(/\*\*/g, "").trim();
        description = rest.slice(colon + 1).trim();
      }
    }
    if (title.length > 0) items.push({ title, description });
  }
  if (items.length > 0) return items;

  return [{ title: "Self-improvement review: parse failed", description: content.slice(0, 500) }];
}

export class SelfImprovementRunnerService {
  private taskStore = taskStoreSingleton;
  private projectService = new ProjectService();
  private planService = new PlanService();
  private contextAssembler = new ContextAssembler();

  /**
   * Run self-improvement: build context, run one review per lens (or one general), parse output,
   * create tasks with extra.source and optional planId/runId, update last run only on success.
   */
  async runSelfImprovement(
    projectId: string,
    options?: RunSelfImprovementOptions
  ): Promise<{ created: number; runId: string }> {
    const runId = options?.runId ?? `si-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const project = await this.projectService.getProject(projectId);
    const repoPath = project.repoPath;
    const settings = await this.projectService.getSettings(projectId);

    const angles = [...new Set((settings.reviewAngles ?? []).filter(Boolean))] as ReviewAngle[];
    const lenses = angles.length > 0 ? angles : (["general"] as const);

    const { fileTree, keyFilesContent } = await this.planService.getCodebaseContext(projectId);
    const specContent = await this.contextAssembler.extractPrdExcerpt(repoPath);

    const baseContext = `## SPEC (product/sketch)

${specContent.slice(0, 12000)}${specContent.length > 12000 ? "\n\n...(truncated)" : ""}

## File tree

\`\`\`
${fileTree}
\`\`\`

## Key file contents

${keyFilesContent.slice(0, 20000)}${keyFilesContent.length > 20000 ? "\n\n...(truncated)" : ""}

---

Review the codebase and output a structured list of improvement tasks (JSON array or markdown list).`;

    const systemPrompt = `${SELF_IMPROVEMENT_SYSTEM_PROMPT}\n\n${await getCombinedInstructions(repoPath, "auditor")}`;
    const config = getAgentForPlanningRole(settings, "auditor");
    const extraBase: Record<string, unknown> = {
      source: "self-improvement",
      runId,
      ...(options?.planId && { planId: options.planId }),
    };

    let allItems: ImprovementItem[] = [];

    for (const lens of lenses) {
      const angleLabel =
        lens === "general"
          ? "General"
          : REVIEW_ANGLE_OPTIONS.find((o) => o.value === lens)?.label ?? lens;
      const userPrompt =
        lens === "general"
          ? `${baseContext}\n\nProvide improvement tasks from a general code quality and maintainability perspective.`
          : `${baseContext}\n\nFocus ONLY on the **${angleLabel}** lens. Provide improvement tasks for this angle only.`;

      const agentId = `self-improvement-${lens}-${projectId}-${runId}`;
      try {
        const response = await agentService.invokePlanningAgent({
          projectId,
          config,
          messages: [{ role: "user", content: userPrompt }],
          systemPrompt,
          cwd: repoPath,
          tracking: {
            id: agentId,
            projectId,
            phase: "execute",
            role: "auditor",
            label: `Self-improvement (${angleLabel})`,
            planId: options?.planId,
          },
        });

        const items = parseImprovementList(response.content);
        for (const item of items) {
          allItems.push(item);
        }
      } catch (err) {
        log.warn("Self-improvement agent run failed", { projectId, lens, err });
        allItems.push({
          title: `Self-improvement (${angleLabel}): run failed`,
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let createdCount = 0;
    for (const item of allItems) {
      await this.taskStore.create(projectId, item.title, {
        description: item.description,
        priority: item.priority ?? 2,
        extra: { ...extraBase },
      });
      createdCount += 1;
    }
    const now = new Date().toISOString();
    let lastCommitSha: string | undefined = options?.lastCommitSha;
    if (lastCommitSha === undefined) {
      try {
        const out = await shellExec("git rev-parse HEAD", { cwd: repoPath });
        lastCommitSha = out.stdout?.trim() || undefined;
      } catch {
        // optional
      }
    }

    const current = await getSettingsFromStore(projectId, settings as ProjectSettings);
    await updateSettingsInStore(projectId, current, (s) => ({
      ...s,
      selfImprovementLastRunAt: now,
      ...(lastCommitSha && { selfImprovementLastCommitSha: lastCommitSha }),
    }));

    return { created: createdCount, runId };
  }
}

export const selfImprovementRunnerService = new SelfImprovementRunnerService();

/** Run self-improvement for a project. Exported for API/scheduler. */
export async function runSelfImprovement(
  projectId: string,
  options?: RunSelfImprovementOptions
): Promise<{ created: number; runId: string }> {
  return selfImprovementRunnerService.runSelfImprovement(projectId, options);
}
