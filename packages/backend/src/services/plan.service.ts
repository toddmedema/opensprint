import fs from "fs/promises";
import path from "path";
import type {
  Plan,
  PlanMetadata,
  PlanMockup,
  PlanDependencyGraph,
  PlanDependencyEdge,
  SuggestedPlan,
  PlanComplexity,
  PlanStatusResponse,
  Prd,
  CrossEpicDependenciesResponse,
} from "@opensprint/shared";
import {
  OPENSPRINT_PATHS,
  getEpicId,
  PLAN_MARKDOWN_SECTIONS,
  validatePlanContent,
} from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { BeadsService, type BeadsIssue } from "./beads.service.js";
import { gitCommitQueue } from "./git-commit-queue.service.js";
import { ChatService } from "./chat.service.js";
import { PrdService } from "./prd.service.js";
import { AgentClient } from "./agent-client.js";
import { agentService } from "./agent.service.js";
import { buildAuditorPrompt, parseAuditorResult } from "./auditor.service.js";
import { buildDeltaPlannerPrompt, parseDeltaPlannerResult } from "./delta-planner.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { activeAgentsService } from "./active-agents.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { writeJsonAtomic } from "../utils/file-utils.js";

const PLAN_TEMPLATE_STRUCTURE = PLAN_MARKDOWN_SECTIONS.join(", ");

const DECOMPOSE_SYSTEM_PROMPT = `You are an AI planning assistant for OpenSprint. You analyze Product Requirements Documents (PRDs) and suggest a breakdown into discrete, implementable features (Plans).

Your task: Given the full PRD, produce a feature decomposition. For each feature:
1. Create a Plan with a clear title and full markdown specification
2. Break the Plan into granular, atomic tasks that an AI coding agent can implement
3. Specify task dependencies (dependsOn) where one task must complete before another
4. Recommend implementation order (foundational/risky first)
5. Create at least one UI/UX mockup per Plan using ASCII wireframes

Plan markdown MUST follow this structure (PRD §7.2.3). Each plan's content must include these sections in order:
${PLAN_MARKDOWN_SECTIONS.map((s) => `- ## ${s}`).join("\n")}

Template structure: ${PLAN_TEMPLATE_STRUCTURE}

Tasks should be atomic, implementable in one agent session, with clear acceptance criteria in the description.

MOCKUPS: Every Plan MUST include at least one mockup. Mockups are ASCII wireframes that illustrate key screens, components, or UI states for the feature. Use box-drawing characters, labels, and annotations. Even backend-heavy features should include a mockup of the admin/monitoring UI, API response shape, or data flow diagram. Include multiple mockups if the feature has several distinct views or states.

Respond with ONLY valid JSON in this exact format. You may use a markdown code block with language "json" for readability. The JSON structure:
{
  "plans": [
    {
      "title": "Feature Name",
      "content": "# Feature Name\\n\\n## Overview\\n...\\n\\n## Acceptance Criteria\\n...\\n\\n## Dependencies\\nReferences to other plans (e.g. user-authentication) if this feature depends on them.",
      "complexity": "medium",
      "dependsOnPlans": [],
      "mockups": [
        {"title": "Main Screen", "content": "+------------------+\\n| Header           |\\n+------------------+\\n| Content area     |\\n|                  |\\n+------------------+"}
      ],
      "tasks": [
        {"title": "Task title", "description": "Task spec", "priority": 1, "dependsOn": []}
      ]
    }
  ]
}

complexity: low, medium, high, or very_high. priority: 0=highest. dependsOn: array of task titles this task depends on (blocked by). dependsOnPlans: array of other plan titles (slugified, e.g. "user-auth") this plan depends on - use empty array if none. mockups: array of {title, content} — ASCII wireframes illustrating the UI; at least one required per plan.`;

const TASK_GENERATION_SYSTEM_PROMPT = `You are an AI planning assistant for OpenSprint. Given a feature plan specification (and optional PRD context), break it down into granular, atomic implementation tasks that an AI coding agent can complete in a single session.

For each task:
1. Title: Clear, specific action (e.g. "Add user login API endpoint", not "Handle auth")
2. Description: Detailed spec with acceptance criteria, which files to create/modify, and how to verify
3. Priority: 0 (highest — foundational/blocking) to 4 (lowest — polish/optional)
4. dependsOn: Array of other task titles this task is blocked by (use exact titles from your list)

Guidelines:
- Tasks must be atomic: one coding session, one concern
- Order matters: infrastructure/data-model tasks first, then API, then UI, then integration
- Include testing tasks or criteria within each task description
- Be specific about file paths and technology choices based on the plan

Respond with ONLY valid JSON (you may wrap in a markdown json code block):
{
  "tasks": [
    {"title": "Task title", "description": "Detailed implementation spec with acceptance criteria", "priority": 1, "dependsOn": []}
  ]
}`;

const AUTO_REVIEW_SYSTEM_PROMPT = `You are an auto-review agent for OpenSprint. After a plan is decomposed from a PRD, you review the generated plans and tasks against the existing codebase to identify what is already implemented.

Your task: Given the list of created plans/tasks and a summary of the repository structure and key files, identify which tasks are ALREADY IMPLEMENTED in the codebase. Only mark tasks as implemented when there is clear evidence in the code (e.g., the described functionality exists, the API endpoint is present, the component is built).

Respond with ONLY valid JSON in this exact format (no markdown wrapper):
{
  "taskIdsToClose": ["<bead-task-id-1>", "<bead-task-id-2>"],
  "reason": "Brief explanation of what was found"
}

Rules:
- taskIdsToClose: array of beads task IDs (e.g. bd-a3f8.1, opensprint.dev-xyz.2) that are already implemented. Use the exact IDs from the plan/task summary.
- Do NOT include gate tasks (IDs ending in .0) — those are closed by user "Build It!" action.
- Do NOT include epic IDs — only close individual implementation tasks.
- If nothing is implemented, return {"taskIdsToClose": [], "reason": "No existing implementation found"}.
- Be conservative: only include tasks where the implementation clearly exists. When in doubt, leave the task open.`;

const COMPLEXITY_EVALUATION_SYSTEM_PROMPT = `You are an AI planning assistant for OpenSprint. Your task is to evaluate the implementation complexity of a feature plan based on its title and content.

Consider: scope of work, technical risk, number of components, integration points, data model changes, API surface, UI complexity, and testing effort.

Respond with ONLY valid JSON in this exact format (no markdown wrapper):
{"complexity": "low" | "medium" | "high" | "very_high"}

- low: Small, isolated change; few files; minimal risk
- medium: Moderate scope; several components; standard patterns
- high: Large feature; many integrations; non-trivial architecture
- very_high: Major undertaking; high risk; complex dependencies; significant refactoring`;

const VALID_COMPLEXITIES: PlanComplexity[] = ["low", "medium", "high", "very_high"];

export class PlanService {
  private projectService = new ProjectService();
  private beads = new BeadsService();
  private chatService = new ChatService();
  private prdService = new PrdService();
  private agentClient = new AgentClient();

  /** Get the plans directory for a project */
  private async getPlansDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.plans);
  }

  /** Get the planning-runs directory for a project */
  private async getPlanningRunsDir(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return path.join(project.repoPath, OPENSPRINT_PATHS.planningRuns);
  }

  /** Get repo path for a project */
  private async getRepoPath(projectId: string): Promise<string> {
    const project = await this.projectService.getProject(projectId);
    return project.repoPath;
  }

  /**
   * Evaluate plan complexity using the planning agent. Returns "medium" on parse failure.
   */
  async evaluateComplexity(projectId: string, title: string, content: string): Promise<PlanComplexity> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.projectService.getSettings(projectId);

    const prompt = `Evaluate the implementation complexity of this feature plan.\n\n## Title\n${title}\n\n## Content\n${content}`;

    const agentId = `plan-complexity-${projectId}-${Date.now()}`;
    activeAgentsService.register(agentId, projectId, "plan", "planner", "Complexity evaluation", new Date().toISOString());

    let response;
    try {
      response = await this.agentClient.invoke({
        config: settings.planningAgent,
        prompt,
        systemPrompt: COMPLEXITY_EVALUATION_SYSTEM_PROMPT,
        cwd: repoPath,
      });
    } finally {
      activeAgentsService.unregister(agentId);
    }

    const jsonMatch = response.content.match(/\{[\s\S]*"complexity"[\s\S]*\}/);
    if (!jsonMatch) return "medium";

    try {
      const parsed = JSON.parse(jsonMatch[0]) as { complexity?: string };
      const c = parsed.complexity;
      if (c && VALID_COMPLEXITIES.includes(c as PlanComplexity)) {
        return c as PlanComplexity;
      }
    } catch {
      // fall through to default
    }
    return "medium";
  }

  /** Count tasks under an epic from beads (implementation tasks only, excludes gating .0) */
  private async countTasks(repoPath: string, epicId: string): Promise<{ total: number; done: number }> {
    try {
      const allIssues = await this.beads.listAll(repoPath);
      const children = allIssues.filter(
        (issue: BeadsIssue) =>
          issue.id.startsWith(epicId + ".") && !issue.id.endsWith(".0") && (issue.issue_type ?? issue.type) !== "epic",
      );
      const done = children.filter((issue: BeadsIssue) => (issue.status as string) === "closed").length;
      return { total: children.length, done };
    } catch (err) {
      console.warn("[plan] countTasks failed, using default:", err instanceof Error ? err.message : err);
      return { total: 0, done: 0 };
    }
  }

  /**
   * Core: build dependency edges from plan infos (beads + markdown).
   * Shared by buildDependencyEdges and buildDependencyEdgesFromProject.
   */
  private async buildDependencyEdgesCore(
    planInfos: Array<{ planId: string; beadEpicId: string; content: string }>,
    repoPath: string,
  ): Promise<PlanDependencyEdge[]> {
    const edges: PlanDependencyEdge[] = [];
    const seenEdges = new Set<string>();
    const epicToPlan = new Map(planInfos.filter((p) => p.beadEpicId).map((p) => [p.beadEpicId, p.planId]));

    const addEdge = (fromPlanId: string, toPlanId: string) => {
      if (fromPlanId === toPlanId) return;
      const key = `${fromPlanId}->${toPlanId}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ from: fromPlanId, to: toPlanId, type: "blocks" });
    };

    // 1. Build edges from beads
    try {
      const allIssues = await this.beads.listAll(repoPath);
      for (const issue of allIssues) {
        const deps = (issue.dependencies as Array<{ depends_on_id: string; type: string }>) ?? [];
        const blockers = deps.filter((d) => d.type === "blocks").map((d) => d.depends_on_id);
        const myEpicId = getEpicId(issue.id);
        const toPlanId = epicToPlan.get(myEpicId);
        if (!toPlanId) continue;
        for (const blockerId of blockers) {
          const blockerEpicId = getEpicId(blockerId);
          const fromPlanId = epicToPlan.get(blockerEpicId);
          if (fromPlanId && blockerEpicId !== myEpicId) {
            addEdge(fromPlanId, toPlanId);
          }
        }
      }
    } catch (err) {
      console.warn("[plan] buildDependencyEdgesCore: beads unavailable:", err instanceof Error ? err.message : err);
    }

    // 2. Parse Plan markdown for "## Dependencies" section
    for (const plan of planInfos) {
      const depsSection = plan.content.match(/## Dependencies[\s\S]*?(?=##|$)/i);
      if (!depsSection) continue;
      const text = depsSection[0].toLowerCase();
      for (const other of planInfos) {
        if (other.planId === plan.planId) continue;
        const slug = other.planId.replace(/-/g, "[\\s-]*");
        if (new RegExp(slug, "i").test(text)) {
          addEdge(other.planId, plan.planId);
        }
      }
    }

    return edges;
  }

  /** Build dependency edges between plans (from beads + markdown). */
  private async buildDependencyEdges(plans: Plan[], repoPath: string): Promise<PlanDependencyEdge[]> {
    const planInfos = plans.map((p) => ({
      planId: p.metadata.planId,
      beadEpicId: p.metadata.beadEpicId,
      content: p.content,
    }));
    return this.buildDependencyEdgesCore(planInfos, repoPath);
  }

  /** List all Plans with dependency graph in one call (avoids duplicate work) */
  async listPlansWithDependencyGraph(projectId: string): Promise<PlanDependencyGraph> {
    return this.listPlansWithEdges(projectId);
  }

  /** Internal: list plans and build edges once */
  private async listPlansWithEdges(projectId: string): Promise<PlanDependencyGraph> {
    const plansDir = await this.getPlansDir(projectId);
    const repoPath = await this.getRepoPath(projectId);
    const plans: Plan[] = [];

    try {
      const files = await fs.readdir(plansDir);
      for (const file of files) {
        if (file.endsWith(".md")) {
          const planId = file.replace(".md", "");
          try {
            const plan = await this.getPlan(projectId, planId);
            plans.push(plan);
          } catch (err) {
            console.warn(`[plan] Skipping broken plan ${planId}:`, err instanceof Error ? err.message : err);
          }
        }
      }
    } catch (err) {
      console.warn("[plan] No plans directory or read failed:", err instanceof Error ? err.message : err);
    }

    const edges = await this.buildDependencyEdges(plans, repoPath);
    for (const plan of plans) {
      plan.dependencyCount = edges.filter((e) => e.to === plan.metadata.planId).length;
    }

    return { plans, edges };
  }

  /** List all Plans for a project */
  async listPlans(projectId: string): Promise<Plan[]> {
    const { plans } = await this.listPlansWithEdges(projectId);
    return plans;
  }

  /** Build dependency edges from beads and plan markdown (reads files directly to avoid recursion) */
  private async buildDependencyEdgesFromProject(projectId: string): Promise<PlanDependencyEdge[]> {
    const plansDir = await this.getPlansDir(projectId);
    const repoPath = await this.getRepoPath(projectId);

    const planInfos: Array<{ planId: string; beadEpicId: string; content: string }> = [];
    try {
      const files = await fs.readdir(plansDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const planId = file.replace(".md", "");
        const mdPath = path.join(plansDir, file);
        const metaPath = path.join(plansDir, `${planId}.meta.json`);
        let beadEpicId = "";
        try {
          const metaData = await fs.readFile(metaPath, "utf-8");
          const meta = JSON.parse(metaData) as PlanMetadata;
          beadEpicId = meta.beadEpicId ?? "";
        } catch {
          // No metadata
        }
        let content = "";
        try {
          content = await fs.readFile(mdPath, "utf-8");
        } catch {
          // Skip broken plans
        }
        planInfos.push({ planId, beadEpicId, content });
      }
    } catch {
      return [];
    }

    return this.buildDependencyEdgesCore(planInfos, repoPath);
  }

  /** Get a single Plan by ID */
  async getPlan(projectId: string, planId: string): Promise<Plan> {
    const plansDir = await this.getPlansDir(projectId);
    const repoPath = await this.getRepoPath(projectId);
    const mdPath = path.join(plansDir, `${planId}.md`);
    const metaPath = path.join(plansDir, `${planId}.meta.json`);

    let content: string;
    try {
      content = await fs.readFile(mdPath, "utf-8");
    } catch {
      throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan '${planId}' not found`, { planId });
    }

    let lastModified: string | undefined;
    try {
      const stat = await fs.stat(mdPath);
      lastModified = stat.mtime.toISOString();
    } catch {
      // Ignore - lastModified remains undefined
    }

    let metadata: PlanMetadata;
    try {
      const metaData = await fs.readFile(metaPath, "utf-8");
      metadata = JSON.parse(metaData) as PlanMetadata;
    } catch {
      metadata = {
        planId,
        beadEpicId: "",
        gateTaskId: "",
        shippedAt: null,
        complexity: "medium",
      };
    }

    // Derive status from beads state
    let status: Plan["status"] = "planning";
    const { total, done } = metadata.beadEpicId
      ? await this.countTasks(repoPath, metadata.beadEpicId)
      : { total: 0, done: 0 };

    if (metadata.shippedAt) {
      status = total > 0 && done === total ? "complete" : "building";
    }
    // Re-execute gate open → planning (user must click Execute! to unblock delta tasks)
    if (metadata.reExecuteGateTaskId) {
      try {
        const gateIssue = await this.beads.show(repoPath, metadata.reExecuteGateTaskId);
        if ((gateIssue.status as string) !== "closed") {
          status = "planning";
        }
      } catch {
        // Gate may have been deleted; keep computed status
      }
    }

    const edges = await this.buildDependencyEdgesFromProject(projectId);
    const dependencyCount = edges.filter((e) => e.to === planId).length;

    return {
      metadata,
      content,
      status,
      taskCount: total,
      doneTaskCount: done,
      dependencyCount,
      lastModified,
    };
  }

  /** Create a new Plan with beads epic and gating task */
  async createPlan(
    projectId: string,
    body: {
      title: string;
      content: string;
      complexity?: string;
      mockups?: PlanMockup[];
      tasks?: Array<{ title: string; description: string; priority?: number; dependsOn?: string[] }>;
    },
  ): Promise<Plan> {
    const repoPath = await this.getRepoPath(projectId);
    const plansDir = await this.getPlansDir(projectId);
    await fs.mkdir(plansDir, { recursive: true });

    // Resolve complexity: use provided value if valid, else agent-evaluate
    let complexity: PlanComplexity;
    const provided = body.complexity as PlanComplexity | undefined;
    if (provided && VALID_COMPLEXITIES.includes(provided)) {
      complexity = provided;
    } else {
      complexity = await this.evaluateComplexity(projectId, body.title, body.content);
    }

    // Generate plan ID from title
    const planId = body.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Write markdown
    await fs.writeFile(path.join(plansDir, `${planId}.md`), body.content);

    // Validate against template (warn only, don't block) — PRD §7.2.3
    const validation = validatePlanContent(body.content);
    if (validation.warnings.length > 0) {
      console.warn(`[plan] Plan ${planId} validation: ${validation.warnings.join("; ")}`);
    }

    // Create beads epic
    const epicResult = await this.beads.create(repoPath, body.title, { type: "epic" });
    const epicId = epicResult.id;

    // Set epic description to Plan file path (PRD §7.2.2)
    const planPath = `${OPENSPRINT_PATHS.plans}/${planId}.md`;
    await this.beads.update(repoPath, epicId, { description: planPath });

    // Create gating task
    const gateResult = await this.beads.create(repoPath, "Plan approval gate", {
      type: "task",
      parentId: epicId,
    });
    const gateTaskId = gateResult.id;

    // Create child tasks if provided
    if (body.tasks && body.tasks.length > 0) {
      const taskIdMap = new Map<string, string>(); // title -> beads id

      for (const task of body.tasks) {
        const priority = Math.min(4, Math.max(0, task.priority ?? 2));
        const taskResult = await this.beads.create(repoPath, task.title, {
          type: "task",
          description: task.description,
          priority,
          parentId: epicId,
        });
        taskIdMap.set(task.title, taskResult.id);

        // Add blocks dependency on gating task
        await this.beads.addDependency(repoPath, taskResult.id, gateTaskId);
      }

      // Add inter-task dependencies
      for (const task of body.tasks) {
        if (task.dependsOn) {
          const childId = taskIdMap.get(task.title);
          if (childId) {
            for (const depTitle of task.dependsOn) {
              const parentId = taskIdMap.get(depTitle);
              if (parentId) {
                await this.beads.addDependency(repoPath, childId, parentId);
              }
            }
          }
        }
      }
    }

    // Write metadata
    const mockups: PlanMockup[] = (body.mockups ?? []).filter((m) => m.title && m.content);
    const metadata: PlanMetadata = {
      planId,
      beadEpicId: epicId,
      gateTaskId,
      shippedAt: null,
      complexity,
      mockups: mockups.length > 0 ? mockups : undefined,
    };

    await writeJsonAtomic(path.join(plansDir, `${planId}.meta.json`), metadata);

    // PRD §5.9: Beads export at checkpoint after plan creation
    gitCommitQueue.enqueue({
      type: "beads_export",
      repoPath,
      summary: `plan ${planId} created`,
    });

    return {
      metadata,
      content: body.content,
      status: "planning",
      taskCount: body.tasks?.length ?? 0,
      doneTaskCount: 0,
      dependencyCount: 0,
    };
  }

  /** Update a Plan's markdown */
  async updatePlan(projectId: string, planId: string, body: { content: string }): Promise<Plan> {
    const plansDir = await this.getPlansDir(projectId);
    await fs.writeFile(path.join(plansDir, `${planId}.md`), body.content);

    // Validate against template (warn only, don't block) — PRD §7.2.3
    const validation = validatePlanContent(body.content);
    if (validation.warnings.length > 0) {
      console.warn(`[plan] Plan ${planId} validation on update: ${validation.warnings.join("; ")}`);
    }

    return this.getPlan(projectId, planId);
  }

  /**
   * Auto-generate implementation tasks for a plan that has none.
   * Invokes the planning agent to decompose the plan's markdown into atomic tasks,
   * creates them as beads issues under the existing epic, and runs auto-review
   * to mark any already-implemented tasks as done.
   */
  private async generateAndCreateTasks(
    projectId: string,
    repoPath: string,
    plan: Plan,
  ): Promise<number> {
    const settings = await this.projectService.getSettings(projectId);
    const epicId = plan.metadata.beadEpicId;
    const gateTaskId = plan.metadata.gateTaskId;

    if (!epicId || !gateTaskId) return 0;

    // Build prompt with plan content + PRD context
    const prdContext = await this.buildPrdContext(projectId);
    const prompt = `Break down the following feature plan into implementation tasks.\n\n## Feature Plan\n\n${plan.content}\n\n## PRD Context\n\n${prdContext}`;

    const agentId = `plan-task-gen-${projectId}-${Date.now()}`;
    activeAgentsService.register(agentId, projectId, "plan", "planner", "Task generation", new Date().toISOString());

    let response;
    try {
      response = await this.agentClient.invoke({
        config: settings.planningAgent,
        prompt,
        systemPrompt: TASK_GENERATION_SYSTEM_PROMPT,
        cwd: repoPath,
      });
    } finally {
      activeAgentsService.unregister(agentId);
    }

    // Parse tasks from agent response
    const jsonMatch = response.content.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[plan] Task generation agent did not return valid JSON, shipping without tasks");
      return 0;
    }

    let parsed: { tasks?: Array<{ title: string; description: string; priority?: number; dependsOn?: string[] }> };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.warn("[plan] Task generation JSON parse failed, shipping without tasks");
      return 0;
    }

    const tasks = parsed.tasks ?? [];
    if (tasks.length === 0) {
      console.warn("[plan] Task generation returned no tasks");
      return 0;
    }

    // Create tasks under the existing epic
    const taskIdMap = new Map<string, string>();
    for (const task of tasks) {
      const priority = Math.min(4, Math.max(0, task.priority ?? 2));
      const taskResult = await this.beads.create(repoPath, task.title, {
        type: "task",
        description: task.description || "",
        priority,
        parentId: epicId,
      });
      taskIdMap.set(task.title, taskResult.id);
      await this.beads.addDependency(repoPath, taskResult.id, gateTaskId);
    }

    // Add inter-task dependencies
    for (const task of tasks) {
      if (task.dependsOn && task.dependsOn.length > 0) {
        const childId = taskIdMap.get(task.title);
        if (childId) {
          for (const depTitle of task.dependsOn) {
            const parentId = taskIdMap.get(depTitle);
            if (parentId) {
              await this.beads.addDependency(repoPath, childId, parentId);
            }
          }
        }
      }
    }

    console.log(`[plan] Generated ${tasks.length} tasks for plan ${plan.metadata.planId}`);

    // Broadcast task creation events
    for (const [, taskId] of taskIdMap) {
      broadcastToProject(projectId, {
        type: "task.updated",
        taskId,
        status: "open",
        assignee: null,
      });
    }

    return tasks.length;
  }

  /** Build It! — auto-generate tasks if needed, close gating task to unblock child tasks */
  async shipPlan(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);
    const plansDir = await this.getPlansDir(projectId);

    // Close the gate that is blocking tasks: re-execute gate if present, else main gate (PRD §7.2.2)
    const gateToClose = plan.metadata.reExecuteGateTaskId ?? plan.metadata.gateTaskId;
    if (!gateToClose) {
      throw new AppError(400, ErrorCodes.NO_GATE_TASK, "Plan has no gating task to close");
    }

    // If no implementation tasks exist, auto-generate them from the plan spec
    let tasksGenerated = 0;
    if (plan.taskCount === 0 && plan.metadata.beadEpicId) {
      try {
        tasksGenerated = await this.generateAndCreateTasks(projectId, repoPath, plan);
        if (tasksGenerated > 0) {
          // Auto-review: mark already-implemented tasks as done
          const updatedPlan = await this.getPlan(projectId, planId);
          await this.autoReviewPlanAgainstRepo(projectId, [updatedPlan]);
        }
      } catch (err) {
        console.error("[plan] Task generation failed, shipping without tasks:", err);
        // Ship proceeds even if task generation fails; user can add tasks manually
      }
    }

    // Close the gating task
    await this.beads.close(repoPath, gateToClose, "Plan approved for build");

    // Clear re-execute gate after closing (next re-execute will create a new one)
    if (plan.metadata.reExecuteGateTaskId) {
      plan.metadata.reExecuteGateTaskId = undefined;
    }

    // Save plan content for next Re-execute (plan_old = this content)
    const shippedPath = path.join(repoPath, OPENSPRINT_PATHS.plans, `${planId}.shipped.md`);
    await fs.writeFile(shippedPath, plan.content, "utf-8");

    // Update metadata
    plan.metadata.shippedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(plansDir, `${planId}.meta.json`), plan.metadata);

    // Living PRD sync: invoke planning agent to review Plan vs PRD and update affected sections (PRD §15.1)
    try {
      await this.chatService.syncPrdFromPlanShip(projectId, planId, plan.content);
    } catch (err) {
      console.error("[plan] PRD sync on build approval failed:", err);
      // Build approval succeeds even if PRD sync fails; user can manually update PRD
    }

    // Re-fetch plan to include updated task counts when tasks were generated
    if (tasksGenerated > 0) {
      const finalPlan = await this.getPlan(projectId, planId);
      return { ...finalPlan, status: "building" };
    }

    return { ...plan, status: "building" };
  }

  /** Rebuild an updated Plan — PRD §7.2.2: Auditor + Delta Planner two-agent approach */
  async reshipPlan(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);
    const plansDir = await this.getPlansDir(projectId);
    const epicId = plan.metadata.beadEpicId;
    const gateTaskId = plan.metadata.gateTaskId;

    // Verify all existing tasks are Done or none started
    if (epicId) {
      const allIssues = await this.beads.listAll(repoPath);
      const children = allIssues.filter(
        (issue: BeadsIssue) =>
          issue.id.startsWith(epicId + ".") &&
          issue.id !== gateTaskId &&
          issue.id !== plan.metadata.reExecuteGateTaskId &&
          (issue.issue_type ?? issue.type) !== "epic",
      );

      const hasInProgress = children.some((issue: BeadsIssue) => issue.status === "in_progress");
      if (hasInProgress) {
        throw new AppError(400, ErrorCodes.TASKS_IN_PROGRESS, "Cannot rebuild while tasks are In Progress or In Review");
      }

      const allDone = children.every((issue: BeadsIssue) => issue.status === "closed");
      const noneStarted = children.every((issue: BeadsIssue) => issue.status === "open");

      if (noneStarted && children.length > 0) {
        // Delete all existing sub-tasks (including any re-execute gate), then ship fresh
        const toDelete = allIssues.filter(
          (i: BeadsIssue) =>
            i.id.startsWith(epicId + ".") && i.id !== gateTaskId && (i.issue_type ?? i.type) !== "epic",
        );
        for (const child of toDelete) {
          await this.beads.delete(repoPath, child.id);
        }
        if (plan.metadata.reExecuteGateTaskId) {
          plan.metadata.reExecuteGateTaskId = undefined;
          await writeJsonAtomic(path.join(plansDir, `${planId}.meta.json`), plan.metadata);
        }
        return this.shipPlan(projectId, planId);
      }
      if (!allDone && children.length > 0) {
        throw new AppError(400, ErrorCodes.TASKS_NOT_COMPLETE, "All tasks must be Done before rebuilding (or none started)");
      }
    }

    // All done: use Auditor + Delta Planner two-agent approach (PRD §12.3.6–7)
    const { fileTree, keyFilesContent, completedTasksJson } = await this.assembleReExecuteContext(
      repoPath,
      epicId ?? "",
      gateTaskId,
    );

    const auditorPrompt = buildAuditorPrompt(planId, epicId ?? "");
    const auditorFullPrompt = `${auditorPrompt}

## context/file_tree.txt

${fileTree}

## context/key_files/

${keyFilesContent}

## context/completed_tasks.json

${completedTasksJson}`;

    const agentIdAuditor = `auditor-${projectId}-${planId}-${Date.now()}`;
    activeAgentsService.register(agentIdAuditor, projectId, "plan", "auditor", "Re-execute: capability audit", new Date().toISOString());

    let auditorResponse;
    try {
      auditorResponse = await agentService.invokePlanningAgent({
        config: (await this.projectService.getSettings(projectId)).planningAgent,
        messages: [{ role: "user", content: auditorFullPrompt }],
        systemPrompt: "You are the Auditor agent for OpenSprint (PRD §12.3.6). Summarize the app's current capabilities from the codebase and completed task history.",
      });
    } finally {
      activeAgentsService.unregister(agentIdAuditor);
    }

    const auditorResult = parseAuditorResult(auditorResponse.content);
    if (!auditorResult || auditorResult.status !== "success" || !auditorResult.capability_summary) {
      console.error("[plan] Auditor failed or returned invalid result, falling back to full rebuild");
      return this.shipPlan(projectId, planId);
    }

    const planOld = await this.getShippedPlanContent(repoPath, planId);
    const planNew = plan.content;

    const deltaPlannerPrompt = buildDeltaPlannerPrompt(planId, epicId ?? "");
    const deltaPlannerFullPrompt = `${deltaPlannerPrompt}

## context/plan_old.md

${planOld}

## context/plan_new.md

${planNew}

## context/capability_summary.md

${auditorResult.capability_summary}`;

    const agentIdDelta = `delta-planner-${projectId}-${planId}-${Date.now()}`;
    activeAgentsService.register(agentIdDelta, projectId, "plan", "delta_planner", "Re-execute: delta task list", new Date().toISOString());

    let deltaResponse;
    try {
      deltaResponse = await agentService.invokePlanningAgent({
        config: (await this.projectService.getSettings(projectId)).planningAgent,
        messages: [{ role: "user", content: deltaPlannerFullPrompt }],
        systemPrompt: "You are the Delta Planner agent for OpenSprint (PRD §12.3.7). Compare old/new Plan against capability summary and output only the delta tasks needed.",
      });
    } finally {
      activeAgentsService.unregister(agentIdDelta);
    }

    const deltaResult = parseDeltaPlannerResult(deltaResponse.content);
    if (!deltaResult || deltaResult.status === "no_changes_needed" || deltaResult.status === "failed") {
      return this.getPlan(projectId, planId);
    }

    if (!deltaResult.tasks || deltaResult.tasks.length === 0) {
      return this.getPlan(projectId, planId);
    }

    // Create new approval gate and delta tasks (PRD §7.2.2)
    const newGateResult = await this.beads.create(repoPath, "Re-execute approval gate", {
      type: "task",
      parentId: epicId,
    });
    const newGateTaskId = newGateResult.id;

    const taskIdMap = new Map<number, string>();
    for (const task of deltaResult.tasks) {
      const priority = Math.min(4, Math.max(0, task.priority ?? 2));
      const taskResult = await this.beads.create(repoPath, task.title, {
        type: "task",
        description: task.description || "",
        priority,
        parentId: epicId,
      });
      taskIdMap.set(task.index, taskResult.id);
      await this.beads.addDependency(repoPath, taskResult.id, newGateTaskId);
    }

    for (const task of deltaResult.tasks) {
      if (task.depends_on && task.depends_on.length > 0) {
        const childId = taskIdMap.get(task.index);
        if (childId) {
          for (const depIndex of task.depends_on) {
            const parentId = taskIdMap.get(depIndex);
            if (parentId) {
              await this.beads.addDependency(repoPath, childId, parentId);
            }
          }
        }
      }
    }

    plan.metadata.reExecuteGateTaskId = newGateTaskId;
    await writeJsonAtomic(path.join(plansDir, `${planId}.meta.json`), plan.metadata);

    gitCommitQueue.enqueue({
      type: "beads_export",
      repoPath,
      summary: `re-execute ${planId}: ${deltaResult.tasks.length} delta tasks`,
    });

    for (const [, taskId] of taskIdMap) {
      broadcastToProject(projectId, {
        type: "task.updated",
        taskId,
        status: "open",
        assignee: null,
      });
    }

    return this.getPlan(projectId, planId);
  }

  /** Assemble context for Auditor: file tree, key files, completed tasks (PRD §12.3.6) */
  private async assembleReExecuteContext(
    repoPath: string,
    epicId: string,
    gateTaskId: string,
  ): Promise<{ fileTree: string; keyFilesContent: string; completedTasksJson: string }> {
    const fileTree = await this.buildFileTree(repoPath);
    const keyFilesContent = await this.getKeyFilesContent(repoPath);
    const completedTasks = await this.getCompletedTasksForEpic(repoPath, epicId, gateTaskId);
    const completedTasksJson = JSON.stringify(completedTasks, null, 2);
    return { fileTree, keyFilesContent, completedTasksJson };
  }

  /** Build file tree string (excludes node_modules, .git, etc.) */
  private async buildFileTree(repoPath: string): Promise<string> {
    const SKIP_DIRS = new Set([".git", "node_modules", ".opensprint", "dist", "build", ".next", ".turbo", "coverage"]);
    const lines: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries: { name: string; isDirectory: () => boolean }[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of sorted) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(repoPath, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          lines.push(rel + "/");
          await walk(full);
        } else {
          lines.push(rel);
        }
      }
    };
    await walk(repoPath);
    return lines.join("\n") || "(empty)";
  }

  /** Get content of key source files (capped by size) */
  private async getKeyFilesContent(repoPath: string): Promise<string> {
    const EXT = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"];
    const SKIP = ["node_modules", ".git", ".opensprint", "dist", "build", ".next"];
    const MAX_FILE = 50 * 1024;
    const MAX_TOTAL = 200 * 1024;
    let total = 0;
    const parts: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (total >= MAX_TOTAL) return;
      let entries: { name: string; isDirectory: () => boolean }[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = full.replace(repoPath + path.sep, "").replace(/\\/g, "/");
        if (entry.isDirectory()) {
          if (!SKIP.includes(entry.name)) await walk(full);
        } else if (EXT.some((e) => entry.name.endsWith(e))) {
          try {
            const content = await fs.readFile(full, "utf-8");
            const truncated = content.length > MAX_FILE ? content.slice(0, MAX_FILE) + "\n... (truncated)" : content;
            parts.push(`### ${rel}\n\n\`\`\`\n${truncated}\n\`\`\`\n`);
            total += truncated.length;
            if (total >= MAX_TOTAL) return;
          } catch {
            // skip unreadable
          }
        }
      }
    };
    await walk(repoPath);
    return parts.join("\n") || "(no source files)";
  }

  /** Get completed (closed) tasks for epic for Auditor context */
  private async getCompletedTasksForEpic(
    repoPath: string,
    epicId: string,
    gateTaskId: string,
  ): Promise<Array<{ id: string; title: string; description?: string; close_reason?: string }>> {
    const all = await this.beads.listAll(repoPath);
    const closed = all.filter(
      (i: BeadsIssue) =>
        i.id.startsWith(epicId + ".") &&
        i.id !== gateTaskId &&
        (i.issue_type ?? i.type) !== "epic" &&
        (i.status as string) === "closed",
    );
    return closed.map((i: BeadsIssue) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      close_reason: (i.close_reason as string) ?? (i as { close_reason?: string }).close_reason,
    }));
  }

  /** Get plan content as it was when last shipped (for plan_old) */
  private async getShippedPlanContent(repoPath: string, planId: string): Promise<string> {
    const shippedPath = path.join(repoPath, OPENSPRINT_PATHS.plans, `${planId}.shipped.md`);
    try {
      return await fs.readFile(shippedPath, "utf-8");
    } catch {
      return "# Plan (no previous shipped version)";
    }
  }

  /** Get the dependency graph for all Plans */
  async getDependencyGraph(projectId: string): Promise<PlanDependencyGraph> {
    return this.listPlansWithDependencyGraph(projectId);
  }

  /**
   * Get cross-epic dependencies: plans that must be executed first (still in Planning state).
   * Returns prerequisite plan IDs in topological order for execution.
   */
  async getCrossEpicDependencies(projectId: string, planId: string): Promise<CrossEpicDependenciesResponse> {
    const { plans, edges } = await this.listPlansWithDependencyGraph(projectId);
    const planById = new Map(plans.map((p) => [p.metadata.planId, p]));
    const targetPlan = planById.get(planId);
    if (!targetPlan) {
      return { prerequisitePlanIds: [] };
    }

    // Edges: (from, to) means "from blocks to" — so "to" depends on "from"
    // Collect all prerequisites (plans that block us) that are still in planning
    const inPlanning = new Set(plans.filter((p) => p.status === "planning").map((p) => p.metadata.planId));
    const directPrereqs = new Set<string>();
    for (const edge of edges) {
      if (edge.to === planId && inPlanning.has(edge.from)) {
        directPrereqs.add(edge.from);
      }
    }

    // Transitive closure: include prerequisites of prerequisites
    const allPrereqs = new Set<string>();
    const visit = (p: string) => {
      if (allPrereqs.has(p)) return;
      allPrereqs.add(p);
      for (const e of edges) {
        if (e.to === p && inPlanning.has(e.from)) visit(e.from);
      }
    };
    for (const p of directPrereqs) visit(p);

    // Topological sort: for each prereq, all its dependencies must come first
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visitSort = (p: string) => {
      if (visited.has(p)) return;
      visited.add(p);
      for (const e of edges) {
        if (e.to === p && allPrereqs.has(e.from)) visitSort(e.from);
      }
      sorted.push(p);
    };
    for (const p of allPrereqs) visitSort(p);

    return { prerequisitePlanIds: sorted };
  }

  /**
   * Execute a plan and its prerequisites in dependency order.
   * Prerequisites must be in topological order (as returned by getCrossEpicDependencies).
   */
  async shipPlanWithPrerequisites(
    projectId: string,
    planId: string,
    prerequisitePlanIds: string[],
  ): Promise<Plan> {
    for (const prereqId of prerequisitePlanIds) {
      await this.shipPlan(projectId, prereqId);
    }
    return this.shipPlan(projectId, planId);
  }

  /** Get plan status for Sketch CTA (plan/replan/none). PRD §7.1.5 */
  async getPlanStatus(projectId: string): Promise<PlanStatusResponse> {
    const latestRun = await this.getLatestPlanningRun(projectId);
    if (!latestRun) {
      return { hasPlanningRun: false, prdChangedSinceLastRun: false, action: "plan" };
    }
    const currentPrd = await this.prdService.getPrd(projectId);
    const prdChanged = !this.prdsEqual(currentPrd, latestRun.prd_snapshot);
    if (!prdChanged) {
      return { hasPlanningRun: true, prdChangedSinceLastRun: false, action: "none" };
    }
    return { hasPlanningRun: true, prdChangedSinceLastRun: true, action: "replan" };
  }

  /** Get the latest planning run (most recent by created_at) */
  private async getLatestPlanningRun(
    projectId: string,
  ): Promise<{ id: string; created_at: string; prd_snapshot: Prd; plans_created: string[] } | null> {
    const runsDir = await this.getPlanningRunsDir(projectId);
    try {
      const files = await fs.readdir(runsDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      if (jsonFiles.length === 0) return null;
      let latest: { id: string; created_at: string; prd_snapshot: Prd; plans_created: string[] } | null = null;
      for (const file of jsonFiles) {
        const data = await fs.readFile(path.join(runsDir, file), "utf-8");
        const run = JSON.parse(data) as { id: string; created_at: string; prd_snapshot: Prd; plans_created: string[] };
        if (!latest || run.created_at > latest.created_at) latest = run;
      }
      return latest;
    } catch {
      return null;
    }
  }

  /** Compare two PRDs by section content (ignoring changeLog) */
  private prdsEqual(a: Prd, b: Prd): boolean {
    const keys = new Set([...Object.keys(a.sections ?? {}), ...Object.keys(b.sections ?? {})]);
    for (const key of keys) {
      const ac = (a.sections as Record<string, { content?: string }>)?.[key]?.content ?? "";
      const bc = (b.sections as Record<string, { content?: string }>)?.[key]?.content ?? "";
      if (ac !== bc) return false;
    }
    return true;
  }

  /** Create a planning run with PRD snapshot. Called after decompose or replan. */
  async createPlanningRun(
    projectId: string,
    plansCreated: Plan[],
  ): Promise<{ id: string; created_at: string }> {
    const prd = await this.prdService.getPrd(projectId);
    const runId = crypto.randomUUID();
    const created_at = new Date().toISOString();
    const run = {
      id: runId,
      created_at,
      prd_snapshot: { ...prd },
      plans_created: plansCreated.map((p) => p.metadata.planId),
    };
    const runsDir = await this.getPlanningRunsDir(projectId);
    await fs.mkdir(runsDir, { recursive: true });
    await writeJsonAtomic(path.join(runsDir, `${runId}.json`), run);
    return { id: runId, created_at };
  }

  /**
   * Archive a plan: close all ready/open tasks to done. Tasks in progress remain unchanged.
   */
  async archivePlan(projectId: string, planId: string): Promise<Plan> {
    const plan = await this.getPlan(projectId, planId);
    const repoPath = await this.getRepoPath(projectId);

    if (!plan.metadata.beadEpicId) {
      throw new AppError(400, ErrorCodes.NO_EPIC, "Plan has no epic; cannot archive");
    }

    const allIssues = await this.beads.listAll(repoPath);
    const planTasks = allIssues.filter(
      (issue: BeadsIssue) =>
        issue.id.startsWith(plan.metadata.beadEpicId + ".") &&
        issue.id !== plan.metadata.gateTaskId &&
        (issue.issue_type ?? issue.type) !== "epic",
    );

    for (const task of planTasks) {
      const status = (task.status as string) ?? "open";
      if (status === "open") {
        await this.beads.close(repoPath, task.id, "Archived plan");
        await this.beads.sync(repoPath);
        broadcastToProject(projectId, {
          type: "task.updated",
          taskId: task.id,
          status: "closed",
          assignee: null,
        });
      }
      // in_progress tasks are left unchanged
    }

    return this.getPlan(projectId, planId);
  }

  /** Build a summary of the codebase structure for the auto-review agent (file tree, key files). */
  private async buildCodebaseContext(repoPath: string): Promise<string> {
    const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv"]);
    const MAX_FILES = 150;
    const MAX_FILE_SIZE = 2000;

    async function walk(dir: string, prefix: string, files: string[]): Promise<void> {
      if (files.length >= MAX_FILES) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (files.length >= MAX_FILES) break;
          const rel = prefix + e.name;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
              await walk(path.join(dir, e.name), rel + "/", files);
            }
          } else {
            files.push(rel);
          }
        }
      } catch {
        // Ignore permission errors
      }
    }

    const files: string[] = [];
    await walk(repoPath, "", files);
    let context = "## Repository file structure\n\n```\n" + files.slice(0, MAX_FILES).join("\n") + "\n```\n\n";

    // Include key config/source files for context (truncated, max 8 files)
    const keyPatterns = ["package.json", "tsconfig.json", "src/", "app/", "lib/"];
    let keyFileCount = 0;
    for (const f of files) {
      if (context.length > 12000 || keyFileCount >= 8) break;
      if (keyPatterns.some((p) => f.includes(p)) && (f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".json"))) {
        try {
          const fullPath = path.join(repoPath, f);
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_FILE_SIZE * 10) continue;
          const content = await fs.readFile(fullPath, "utf-8");
          const excerpt = content.slice(0, MAX_FILE_SIZE);
          context += `### ${f}\n\n\`\`\`\n${excerpt}${content.length > MAX_FILE_SIZE ? "\n... (truncated)" : ""}\n\`\`\`\n\n`;
          keyFileCount++;
        } catch {
          // Skip unreadable files
        }
      }
    }
    return context;
  }

  /** Build plan/task summary for the auto-review agent. */
  private async buildPlanTaskSummary(repoPath: string, createdPlans: Plan[]): Promise<string> {
    const allIssues = await this.beads.listAll(repoPath);
    const lines: string[] = [];

    for (const plan of createdPlans) {
      const epicId = plan.metadata.beadEpicId;
      if (!epicId) continue;
      const tasks = allIssues.filter(
        (i: BeadsIssue) =>
          i.id.startsWith(epicId + ".") &&
          i.id !== plan.metadata.gateTaskId &&
          (i.issue_type ?? i.type) !== "epic",
      );
      lines.push(`## Plan: ${plan.metadata.planId} (epic: ${epicId})`);
      for (const t of tasks) {
        lines.push(`- **${t.id}**: ${t.title}`);
        if (t.description) lines.push(`  Description: ${String(t.description).slice(0, 200)}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * Auto-review: invoke planning agent to compare created plans against the codebase
   * and mark already-implemented tasks as done. Best-effort; failures are logged, not thrown.
   */
  private async autoReviewPlanAgainstRepo(projectId: string, createdPlans: Plan[]): Promise<void> {
    if (createdPlans.length === 0) return;

    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.projectService.getSettings(projectId);
    const validTaskIds = new Set<string>();

    for (const plan of createdPlans) {
      if (!plan.metadata.beadEpicId) continue;
      const allIssues = await this.beads.listAll(repoPath);
      const tasks = allIssues.filter(
        (i: BeadsIssue) =>
          i.id.startsWith(plan.metadata.beadEpicId + ".") &&
          i.id !== plan.metadata.gateTaskId &&
          (i.issue_type ?? i.type) !== "epic",
      );
      for (const t of tasks) {
        validTaskIds.add(t.id);
      }
    }

    if (validTaskIds.size === 0) return;

    try {
      const codebaseContext = await this.buildCodebaseContext(repoPath);
      const planSummary = await this.buildPlanTaskSummary(repoPath, createdPlans);

      const prompt = `Review the following plans and tasks against the codebase. Identify which tasks are already implemented.\n\n## Created plans and tasks\n\n${planSummary}\n\n${codebaseContext}`;

      const agentId = `plan-auto-review-${projectId}-${Date.now()}`;
      activeAgentsService.register(agentId, projectId, "plan", "planner", "Plan auto-review", new Date().toISOString());

      let response;
      try {
        response = await this.agentClient.invoke({
          config: settings.planningAgent,
          prompt,
          systemPrompt: AUTO_REVIEW_SYSTEM_PROMPT,
          cwd: repoPath,
        });
      } finally {
        activeAgentsService.unregister(agentId);
      }

      const jsonMatch = response.content.match(/\{[\s\S]*"taskIdsToClose"[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn("[plan] Auto-review agent did not return valid JSON, skipping");
        return;
      }

      let parsed: { taskIdsToClose?: string[]; reason?: string };
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        console.warn("[plan] Auto-review agent JSON parse failed, skipping");
        return;
      }

      const ids = parsed.taskIdsToClose ?? [];
      const toClose = ids.filter((id) => validTaskIds.has(id) && !id.endsWith(".0"));

      for (const taskId of toClose) {
        try {
          await this.beads.close(repoPath, taskId, "Already implemented (auto-review)");
          await this.beads.sync(repoPath);
          broadcastToProject(projectId, {
            type: "task.updated",
            taskId,
            status: "closed",
            assignee: null,
          });
        } catch (err) {
          console.warn(`[plan] Auto-review: failed to close task ${taskId}:`, err);
        }
      }

      if (toClose.length > 0) {
        console.log(`[plan] Auto-review marked ${toClose.length} task(s) as done: ${toClose.join(", ")}`);
      }
    } catch (err) {
      console.error("[plan] Auto-review against repo failed:", err);
      // Decompose succeeded; auto-review is best-effort
    }
  }

  /** Build PRD context string for agent prompts */
  private async buildPrdContext(projectId: string): Promise<string> {
    try {
      const prd = await this.prdService.getPrd(projectId);
      let context = "";
      for (const [key, section] of Object.entries(prd.sections)) {
        if (section.content) {
          context += `### ${key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}\n`;
          context += `${section.content}\n\n`;
        }
      }
      return context || "The PRD is currently empty.";
    } catch (err) {
      console.warn("[plan] buildPrdContext: PRD unavailable:", err instanceof Error ? err.message : err);
      return "No PRD exists yet.";
    }
  }

  /**
   * AI-assisted decomposition (suggest only): Planning agent analyzes PRD and returns suggested plans.
   * Does NOT create plans or beads — returns JSON for user to accept/modify. PRD §7.2.2
   */
  async suggestPlans(projectId: string): Promise<{ plans: SuggestedPlan[] }> {
    const settings = await this.projectService.getSettings(projectId);
    const prdContext = await this.buildPrdContext(projectId);
    const repoPath = await this.getRepoPath(projectId);

    const prompt = `Analyze the PRD below and produce a feature decomposition. Output valid JSON with a "plans" array. Each plan has: title, content (full markdown), complexity (low|medium|high|very_high), and tasks array. Each task has: title, description, priority (0-4), dependsOn (array of task titles it depends on).`;

    const agentId = `plan-suggest-${projectId}-${Date.now()}`;
    activeAgentsService.register(agentId, projectId, "plan", "planner", "Feature decomposition (suggest)", new Date().toISOString());

    let response;
    try {
      response = await this.agentClient.invoke({
        config: settings.planningAgent,
        prompt,
        systemPrompt: DECOMPOSE_SYSTEM_PROMPT + "\n\n## Current PRD\n\n" + prdContext,
        cwd: repoPath,
      });
    } finally {
      activeAgentsService.unregister(agentId);
    }

    const planSpecs = this.parseDecomposeResponse(response.content);
    return { plans: planSpecs };
  }

  /**
   * Parse agent decomposition response into SuggestedPlan array.
   * Extracts JSON from response (may be wrapped in ```json ... ```).
   */
  private parseDecomposeResponse(content: string): SuggestedPlan[] {
    const jsonMatch = content.match(/\{[\s\S]*"plans"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        "Planning agent did not return valid decomposition JSON. Response: " + content.slice(0, 500),
        { responsePreview: content.slice(0, 500) },
      );
    }

    let parsed: { plans?: SuggestedPlan[] };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new AppError(400, ErrorCodes.DECOMPOSE_JSON_INVALID, "Could not parse decomposition JSON from agent response");
    }

    const planSpecs = parsed.plans ?? [];
    if (planSpecs.length === 0) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_EMPTY,
        "Planning agent returned no plans. Ensure the PRD has sufficient content.",
      );
    }
    return planSpecs;
  }

  /**
   * AI-assisted decomposition: Planning agent analyzes PRD and suggests feature breakdown.
   * Creates Plans + tasks from AI. PRD §7.2.2
   */
  async decomposeFromPrd(projectId: string): Promise<{ created: number; plans: Plan[] }> {
    const repoPath = await this.getRepoPath(projectId);
    const settings = await this.projectService.getSettings(projectId);

    const prdContext = await this.buildPrdContext(projectId);

    const prompt = `Analyze the PRD below and produce a feature decomposition. Output valid JSON with a "plans" array. Each plan has: title, content (full markdown), complexity (low|medium|high|very_high), and tasks array. Each task has: title, description, priority (0-4), dependsOn (array of task titles it depends on).`;

    const agentId = `plan-decompose-${projectId}-${Date.now()}`;
    activeAgentsService.register(agentId, projectId, "plan", "planner", "Feature decomposition", new Date().toISOString());

    let response;
    try {
      response = await this.agentClient.invoke({
        config: settings.planningAgent,
        prompt,
        systemPrompt: DECOMPOSE_SYSTEM_PROMPT + "\n\n## Current PRD\n\n" + prdContext,
        cwd: repoPath,
      });
    } finally {
      activeAgentsService.unregister(agentId);
    }

    const planSpecs = this.parseDecomposeResponse(response.content);

    const created: Plan[] = [];
    for (const spec of planSpecs) {
      const plan = await this.createPlan(projectId, {
        title: spec.title || "Untitled Feature",
        content: spec.content || "# Untitled Feature\n\nNo content.",
        complexity: (spec.complexity as PlanMetadata["complexity"]) || "medium",
        mockups: (spec.mockups ?? []).map((m) => ({
          title: m.title || "Mockup",
          content: m.content || "",
        })),
        tasks: (spec.tasks ?? []).map((t) => ({
          title: t.title || "Untitled task",
          description: t.description || "",
          priority: Math.min(4, Math.max(0, t.priority ?? 2)),
          dependsOn: t.dependsOn ?? [],
        })),
      });
      created.push(plan);
    }

    // Auto-review: invoke second agent to mark already-implemented tasks as done
    try {
      await this.autoReviewPlanAgainstRepo(projectId, created);
    } catch (err) {
      console.error("[plan] Auto-review after decompose failed:", err);
      // Decompose succeeded; auto-review is best-effort
    }

    // Create planning run with PRD snapshot (PRD §5.6, §7.2.2)
    await this.createPlanningRun(projectId, created);

    return { created: created.length, plans: created };
  }
}
