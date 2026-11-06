import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { AutomatedQaService } from "../services/automated-qa.service.js";
import { ProjectService } from "../services/project.service.js";
import { BranchManager } from "../services/branch-manager.js";
import { agentService, type InvokeCodingAgentOptions } from "../services/agent.service.js";
import { runGit } from "../utils/git-command.js";
import { getAgentForPlanningRole, parseSettings } from "@opensprint/shared";
import { automatedQaBodySchema } from "../schemas/request-common.js";

const mocks = vi.hoisted(() => ({ release: vi.fn(), broadcast: vi.fn() }));
vi.mock("../services/agent.service.js", () => ({ agentService: { invokeCodingAgent: vi.fn() } }));
vi.mock("../services/project.service.js", () => ({ ProjectService: vi.fn() }));
vi.mock("../services/branch-manager.js", () => ({ BranchManager: vi.fn() }));
vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: vi.fn().mockResolvedValue("Repository QA instructions"),
}));
vi.mock("../services/agent-global-concurrency.service.js", () => ({
  acquireGlobalAgentSlot: vi.fn(async () => mocks.release),
}));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: mocks.broadcast }));

describe("automated QA", () => {
  let repo: string;
  let service: AutomatedQaService;
  let submitFeedback: ReturnType<typeof vi.fn>;
  let nudge: ReturnType<typeof vi.fn>;
  const settings = parseSettings({
    simpleComplexityAgent: { type: "codex", model: "qa-model", effort: "high" },
    worktreeBaseBranch: "main",
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "automated-qa-test-"));
    await runGit(["init", "-b", "main"], { cwd: repo });
    await fs.writeFile(path.join(repo, "SPEC.md"), "Sample app specification");
    await runGit(["add", "SPEC.md"], { cwd: repo });
    await runGit(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "Initial",
      ],
      { cwd: repo }
    );
    await runGit(["checkout", "-b", "human-work"], { cwd: repo });
    submitFeedback = vi.fn().mockImplementation(async (_projectId, body) => ({
      id: `feedback-${submitFeedback.mock.calls.length}`,
      ...body,
    }));
    nudge = vi.fn();
    const projects = {
      getProject: vi.fn().mockResolvedValue({ repoPath: repo }),
      getSettings: vi.fn().mockResolvedValue(settings),
    };
    service = new AutomatedQaService(
      { submitFeedback },
      nudge,
      projects as unknown as ProjectService,
      { symlinkNodeModules: vi.fn().mockResolvedValue(undefined) } as unknown as BranchManager
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete settings.simpleComplexityAgent.timeoutMs;
    await fs.rm(repo, { recursive: true, force: true });
  });

  function runAgents(report: (prompt: string) => unknown) {
    vi.mocked(agentService.invokeCodingAgent).mockImplementation((promptPath, _config, options) => {
      void (async () => {
        try {
          const prompt = await fs.readFile(promptPath, "utf8");
          const assignment = JSON.parse(
            await fs.readFile(path.join(path.dirname(promptPath), "assignment.json"), "utf8")
          );
          expect(assignment.projectId).toBe("project-1");
          expect(assignment.revision).toMatch(/^[a-f0-9]{40}$/);
          expect(await fs.readFile(path.join(options.cwd, "SPEC.md"), "utf8")).toBe(
            "Sample app specification"
          );
          expect(prompt).toContain("Focus on keyboard navigation");
          await fs.writeFile(
            path.join(path.dirname(promptPath), "result.json"),
            JSON.stringify(report(prompt))
          );
          options.onExit(0);
        } catch {
          options.onExit(1);
        }
      })();
      return { kill: vi.fn(), pid: null };
    });
  }

  it("runs one isolated tool-capable agent per selected perspective and files evidence into Evaluate", async () => {
    runAgents((prompt) => ({
      status: "success",
      summary: "Ran relevant checks",
      issues: prompt.includes("# Automated QA: Performance")
        ? []
        : [
            {
              title: "Missing focus indicator",
              description: "Tab to navigation: focus is invisible",
              evidence: "Browser keyboard test on navigation",
              priority: 1,
            },
          ],
    }));
    const result = await service.run("project-1", {
      perspectives: ["design_ux_accessibility", "performance", "performance"],
      instructions: "Focus on keyboard navigation",
    });
    expect(result.results).toEqual([
      {
        perspective: "design_ux_accessibility",
        status: "completed",
        summary: "Ran relevant checks",
        feedbackIds: ["feedback-1"],
      },
      {
        perspective: "performance",
        status: "completed",
        summary: "Ran relevant checks",
        feedbackIds: [],
      },
    ]);
    expect(agentService.invokeCodingAgent).toHaveBeenCalledTimes(2);
    const invocations = vi.mocked(agentService.invokeCodingAgent).mock.calls;
    expect(new Set(invocations.map((call) => call[2].cwd)).size).toBe(2);
    expect(invocations[0][1]).toEqual(getAgentForPlanningRole(settings, "auditor"));
    expect(invocations[0][2].tracking).toMatchObject({ phase: "evaluate", role: "auditor" });
    expect(submitFeedback).toHaveBeenCalledWith("project-1", {
      text: expect.stringContaining("Browser keyboard test on navigation"),
      priority: 1,
    });
    expect(mocks.broadcast).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ type: "feedback.updated" })
    );
    expect(nudge).toHaveBeenCalledWith("project-1");
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect((await runGit(["branch", "--show-current"], { cwd: repo })).stdout.trim()).toBe(
      "human-work"
    );
    expect(
      (await runGit(["worktree", "list", "--porcelain"], { cwd: repo })).stdout.match(
        /^worktree /gm
      )
    ).toHaveLength(1);
  });

  it("keeps successful findings when another perspective returns invalid output", async () => {
    runAgents((prompt) =>
      prompt.includes("# Automated QA: General")
        ? {
            status: "success",
            summary: "Tested navigation",
            issues: [
              {
                title: "Broken link",
                description: "Link returns 404",
                evidence: "GET /help returned 404",
                priority: 2,
              },
            ],
          }
        : { status: "success", issues: [] }
    );
    const result = await service.run("project-1", {
      perspectives: ["general", "security"],
      instructions: "Focus on keyboard navigation",
    });
    expect(result.results.map((entry) => entry.status)).toEqual(["completed", "failed"]);
    expect(submitFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("reports incomplete checks without claiming success or filing invented issues", async () => {
    runAgents(() => ({ status: "failed", summary: "Browser unavailable", issues: [] }));
    const result = await service.run("project-1", {
      perspectives: ["general"],
      instructions: "Focus on keyboard navigation",
    });
    expect(result.results[0]).toMatchObject({
      status: "failed",
      summary: "Browser unavailable",
      feedbackIds: [],
    });
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("rejects duplicate runs while the first agent is active and releases the project after exit", async () => {
    let exit: InvokeCodingAgentOptions["onExit"] | undefined;
    vi.mocked(agentService.invokeCodingAgent).mockImplementation((_prompt, _config, options) => {
      exit = options.onExit;
      return { kill: vi.fn(), pid: null };
    });
    const first = service.run("project-1", { perspectives: ["general"] });
    await vi.waitFor(() => expect(exit).toBeDefined());
    await expect(service.run("project-1", { perspectives: ["general"] })).rejects.toMatchObject({
      statusCode: 409,
    });
    exit!(1);
    expect((await first).results[0].status).toBe("failed");
    runAgents(() => ({ status: "success", summary: "Checks passed", issues: [] }));
    expect(
      (
        await service.run("project-1", {
          perspectives: ["general"],
          instructions: "Focus on keyboard navigation",
        })
      ).results[0].status
    ).toBe("completed");
  });

  it.each([300000, undefined, null])(
    "honors timeout %s and retains the checkout and capacity until observed exit",
    async (timeoutMs) => {
      settings.simpleComplexityAgent.timeoutMs = timeoutMs;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const kill = vi.fn();
      let options: InvokeCodingAgentOptions | undefined;
      vi.mocked(agentService.invokeCodingAgent).mockImplementation((_prompt, _config, opts) => {
        options = opts;
        return { kill, pid: null };
      });
      const pending = service.run("project-1", { perspectives: ["general"] });
      await vi.waitFor(() => expect(options).toBeDefined());
      const deadline = timeoutMs === undefined ? 900000 : (timeoutMs ?? 3600000);
      await vi.advanceTimersByTimeAsync(deadline - 100);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(kill).toHaveBeenCalledTimes(timeoutMs === null ? 0 : 1);
      expect(mocks.release).not.toHaveBeenCalled();
      expect(await fs.stat(options!.cwd)).toBeDefined();
      // A result written before timeout cannot turn a timed-out run into success.
      await fs.writeFile(
        path.join(options!.cwd, ".opensprint", "active", options!.tracking!.id, "result.json"),
        JSON.stringify({ status: "success", summary: "Checks passed", issues: [] })
      );
      options!.onExit(0);
      const result = await pending;
      expect(result.results[0]).toMatchObject(
        timeoutMs === null
          ? { status: "completed", summary: "Checks passed" }
          : { status: "failed", summary: "QA agent timed out." }
      );
      expect(mocks.release).toHaveBeenCalledOnce();
      await expect(fs.stat(options!.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("cleans up and releases capacity after a synchronous launch failure", async () => {
    vi.mocked(agentService.invokeCodingAgent).mockImplementation(() => {
      throw new Error("CLI unavailable");
    });
    const result = await service.run("project-1", { perspectives: ["general"] });
    expect(result.results[0]).toMatchObject({ status: "failed", summary: "CLI unavailable" });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(
      (await runGit(["worktree", "list", "--porcelain"], { cwd: repo })).stdout.match(
        /^worktree /gm
      )
    ).toHaveLength(1);
  });

  it.each([
    { perspectives: [] },
    { perspectives: ["invalid"] },
    { perspectives: "general" },
    { perspectives: ["general"], instructions: "x".repeat(10001) },
  ])("rejects invalid QA requests: %j", (body) => {
    expect(automatedQaBodySchema.safeParse(body).success).toBe(false);
  });
});
