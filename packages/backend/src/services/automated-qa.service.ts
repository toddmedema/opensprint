import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  REVIEW_AGENT_OPTIONS,
  getAgentForPlanningRole,
  type AutomatedQaRequest,
  type AutomatedQaResult,
} from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { BranchManager } from "./branch-manager.js";
import { agentService } from "./agent.service.js";
import { acquireGlobalAgentSlot } from "./agent-global-concurrency.service.js";
import { REVIEW_ANGLE_CHECKLISTS } from "./context-assembler.js";
import { getCombinedInstructions } from "./agent-instructions.service.js";
import type { FeedbackService } from "./feedback.service.js";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { broadcastToProject } from "../websocket/index.js";
import { createLogger } from "../utils/logger.js";
import { runGit, gitNoHooksConfigPrefix } from "../utils/git-command.js";
import { getGitNoHooksPath } from "../utils/git-no-hooks.js";

const log = createLogger("automated-qa");
const qaOutputSchema = z.object({
  status: z.enum(["success", "failed"]),
  summary: z.string().trim().min(1).max(20000),
  issues: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().min(1).max(20000),
        evidence: z.string().trim().min(1).max(20000),
        priority: z.number().int().min(0).max(4),
      })
    )
    .max(100),
});

/** On-demand QA uses the tool-capable task runner, with one isolated checkout per perspective. */
export class AutomatedQaService {
  private running = new Set<string>();
  private workspaceMutation: Promise<unknown> = Promise.resolve();

  private mutateWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.workspaceMutation.then(operation);
    this.workspaceMutation = pending.catch(() => {});
    return pending;
  }

  constructor(
    private feedbackService: Pick<FeedbackService, "submitFeedback">,
    private nudge: (projectId: string) => void,
    private projectService = new ProjectService(),
    private branches = new BranchManager()
  ) {}

  async run(projectId: string, request: AutomatedQaRequest): Promise<AutomatedQaResult> {
    if (this.running.has(projectId)) {
      throw new AppError(
        409,
        ErrorCodes.ALREADY_EXISTS,
        "An automated QA pass is already running for this project."
      );
    }
    this.running.add(projectId);
    try {
      const project = await this.projectService.getProject(projectId);
      const settings = await this.projectService.getSettings(projectId);
      const instructions = await getCombinedInstructions(project.repoPath, "auditor");
      const runId = randomUUID();
      const config = getAgentForPlanningRole(settings, "auditor");
      const { stdout } = await runGit(
        ["rev-parse", "--verify", "--end-of-options", `${settings.worktreeBaseBranch}^{commit}`],
        { cwd: project.repoPath }
      );
      const revision = stdout.trim();
      const results = await Promise.all(
        [...new Set(request.perspectives)].map(async (perspective) => {
          const feedbackIds: string[] = [];
          const taskId = `qa-${runId}-${perspective}`;
          const label = REVIEW_AGENT_OPTIONS.find((option) => option.value === perspective)!.label;
          let worktree: string | undefined;
          let release: (() => void) | undefined;
          try {
            release = await acquireGlobalAgentSlot(projectId);
            const workspacePath = path.join(project.repoPath, ".opensprint", "worktrees", taskId);
            await this.mutateWorkspace(async () => {
              await fs.mkdir(path.dirname(workspacePath), { recursive: true });
              await runGit(
                [
                  ...gitNoHooksConfigPrefix(getGitNoHooksPath()),
                  "worktree",
                  "add",
                  "--detach",
                  workspacePath,
                  revision,
                ],
                { cwd: project.repoPath }
              );
            });
            worktree = workspacePath;
            await this.branches.symlinkNodeModules(project.repoPath, worktree);
            const activeDir = path.join(worktree, ".opensprint", "active", taskId);
            await fs.mkdir(activeDir, { recursive: true });
            const resultPath = path.join(activeDir, "result.json");
            const promptPath = path.join(activeDir, "prompt.md");
            const checklist =
              perspective === "general"
                ? [
                    "Validate expected functionality against SPEC.md and user flows; inspect architecture and regressions.",
                  ]
                : REVIEW_ANGLE_CHECKLISTS[perspective];
            await fs.writeFile(
              promptPath,
              `# Automated QA: ${label}

${instructions}

You are an independent QA tester assessing the current application from the ${label} perspective.
Read the repository instructions and SPEC.md. Inspect the implementation and run relevant non-watch tests,
checks, or browser interactions using the available tools. Focus on these checks:
${checklist.map((item) => `- ${item}`).join("\n")}

Work only in this isolated checkout. Do not fix source code, commit, push, merge, deploy, or modify task state.
Do not access live production databases or external services with side effects. Use isolated test data.
Report only concrete, actionable issues supported by observed evidence (commands and output, reproduction steps,
or specific file locations). Distinguish tests you ran from inspection. If required checks cannot run,
report status failed with the limitation in summary; never claim the pass succeeded.

## Additional user instructions
${request.instructions?.trim() || "None."}

## Output contract
Write ONLY your report to ${resultPath}. The server files each issue into the Evaluate queue.
Use this exact JSON shape:
{"status":"success"|"failed","summary":"Checks performed and limitations","issues":[{"title":"Issue title","description":"Expected vs actual behavior and reproduction steps","evidence":"Observed evidence","priority":2}]}
Priority must be an integer 0–4. Use issues: [] when there are no confirmed findings.
Return status success only if the assigned QA checks completed. This report replaces the Execute result contract.
`
            );
            // Persist assignment before launch; interrupted worktrees retain this evidence.
            await fs.writeFile(
              path.join(activeDir, "assignment.json"),
              JSON.stringify({
                kind: "automated-qa",
                projectId,
                runId,
                perspective,
                taskId,
                config,
                revision,
                startedAt: new Date().toISOString(),
              })
            );
            await new Promise<void>((resolve, reject) => {
              agentService.invokeCodingAgent(promptPath, config, {
                cwd: worktree!,
                projectId,
                agentRole: "automated QA",
                tracking: {
                  id: taskId,
                  projectId,
                  phase: "evaluate",
                  role: "auditor",
                  label: `Automated QA (${label})`,
                },
                onOutput: () => {},
                // Wait for observed process completion before disposing of its checkout.
                onExit: (code) =>
                  code === 0
                    ? resolve()
                    : reject(new Error(`QA agent exited with code ${code ?? "unknown"}.`)),
              });
            });
            const report = qaOutputSchema.parse(JSON.parse(await fs.readFile(resultPath, "utf8")));
            for (const issue of report.issues) {
              const item = await this.feedbackService.submitFeedback(projectId, {
                text: `Automated QA · ${label}\n\n${issue.title}\n\n${issue.description}\n\nEvidence:\n${issue.evidence}`,
                priority: issue.priority,
              });
              feedbackIds.push(item.id);
              broadcastToProject(projectId, {
                type: "feedback.updated",
                feedbackId: item.id,
                planId: "",
                taskIds: [],
                item,
              });
              this.nudge(projectId);
            }
            return {
              perspective,
              status: report.status === "success" ? ("completed" as const) : ("failed" as const),
              summary: report.summary,
              feedbackIds,
            };
          } catch (error) {
            log.warn("Automated QA perspective failed", { projectId, perspective, error });
            return {
              perspective,
              status: "failed" as const,
              summary: error instanceof Error ? error.message : String(error),
              feedbackIds,
            };
          } finally {
            if (worktree) {
              // The runner has exited (or failed before launch); its assignment no longer owns execution.
              await fs
                .rm(path.join(worktree, ".opensprint", "active", taskId), {
                  recursive: true,
                  force: true,
                })
                .catch((error) => log.warn("QA artifact cleanup failed", { error }));
              try {
                await this.mutateWorkspace(() =>
                  runGit(["worktree", "remove", "--force", worktree!], { cwd: project.repoPath })
                );
              } catch (error) {
                log.warn("QA worktree cleanup failed", { error, worktree });
              }
            }
            release?.();
          }
        })
      );
      return { runId, results };
    } finally {
      this.running.delete(projectId);
    }
  }
}
