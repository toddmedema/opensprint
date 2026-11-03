import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import type { CreateProjectRequest, Project, ProjectSettings } from "@opensprint/shared";
import {
  OPENSPRINT_DIR,
  SPEC_MD,
  prdToSpecMarkdown,
  DEFAULT_REVIEW_MODE,
  getTestCommandForFramework,
  MAX_TOTAL_CONCURRENT_AGENTS_CAP,
} from "@opensprint/shared";
import { AppError } from "../../middleware/error-handler.js";
import { ErrorCodes } from "../../middleware/error-codes.js";
import * as projectIndex from "../project-index.js";
import { setSettingsInStore } from "../settings-store.service.js";
import { detectTestFramework } from "../test-framework.service.js";
import { ensureEasConfig } from "../eas-config.js";
import { parseAgentConfig, type AgentConfigInput } from "../../schemas/agent-config.js";
import { getErrorMessage } from "../../utils/error-utils.js";
import { createLogger } from "../../utils/logger.js";
import { assertSupportedRepoPath } from "../../utils/repo-path-policy.js";
import { runGit } from "../../utils/git-command.js";
import { ensureRepoHasInitialCommit } from "../../utils/git-repo-state.js";
import {
  ensureOpenSprintRuntimeContract,
  ensureProjectGitignoreEntries,
} from "./project-runtime-contract.js";
import {
  buildDefaultSettings,
  normalizeRepoPath,
  resolveAiAutonomyAndHil,
  toCanonicalSettings,
} from "./project-settings-helpers.js";
import { normalizeDeployment } from "./project-deployment-normalize.js";
import { commitBootstrapRepoChanges } from "./project-bootstrap-git.js";
import { resolvePreferredProjectEntry } from "./project-index-preference.js";
import { prepareRepoForProject } from "./project-repo-prepare.js";

const log = createLogger("project-create");

export type CreateProjectFlowDeps = {
  invalidateListCache: () => void;
  getProject: (id: string) => Promise<Project>;
  taskStore: { listAll: (projectId: string) => Promise<unknown> };
};

export async function runCreateProjectFlow(
  deps: CreateProjectFlowDeps,
  input: CreateProjectRequest
): Promise<Project> {
  const name = (input.name ?? "").trim();
  const repoPath = (input.repoPath ?? "").trim();
  if (!name) {
    throw new AppError(400, ErrorCodes.INVALID_INPUT, "Project name is required");
  }
  if (!repoPath) {
    throw new AppError(400, ErrorCodes.INVALID_INPUT, "Project folder is required");
  }
  assertSupportedRepoPath(repoPath);
  const normalizedRepoPath = normalizeRepoPath(repoPath);

  const simpleInput = input.simpleComplexityAgent ?? input.lowComplexityAgent;
  const complexInput = input.complexComplexityAgent ?? input.highComplexityAgent;
  let simpleComplexityAgent: AgentConfigInput | undefined;
  let complexComplexityAgent: AgentConfigInput | undefined;
  try {
    if (simpleInput !== undefined && simpleInput !== null) {
      simpleComplexityAgent = parseAgentConfig(simpleInput, "simpleComplexityAgent");
    }
    if (complexInput !== undefined && complexInput !== null) {
      complexComplexityAgent = parseAgentConfig(complexInput, "complexComplexityAgent");
    }
  } catch (err) {
    const msg = getErrorMessage(err, "Invalid agent configuration");
    throw new AppError(400, ErrorCodes.INVALID_AGENT_CONFIG, msg);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const existingEntries = (await projectIndex.getProjects()).filter(
    (entry) => normalizeRepoPath(entry.repoPath) === normalizedRepoPath
  );

  const opensprintDir = path.join(repoPath, OPENSPRINT_DIR);
  try {
    await fs.access(opensprintDir);
    if (existingEntries.length > 0) {
      await ensureProjectGitignoreEntries(repoPath);
      const existing = await resolvePreferredProjectEntry(existingEntries);
      return deps.getProject(existing.id);
    }
    const adoptId = randomUUID();
    const adoptName = name || "Existing project";
    await projectIndex.addProject({
      id: adoptId,
      name: adoptName,
      repoPath: normalizedRepoPath,
      createdAt: now,
    });
    const defaults = buildDefaultSettings();
    const adoptInitial = toCanonicalSettings(defaults) as unknown as Record<string, unknown>;
    delete adoptInitial.simpleComplexityAgent;
    delete adoptInitial.complexComplexityAgent;
    delete adoptInitial.lowComplexityAgent;
    delete adoptInitial.highComplexityAgent;
    await setSettingsInStore(adoptId, adoptInitial as unknown as ProjectSettings);
    await ensureProjectGitignoreEntries(repoPath);
    deps.invalidateListCache();
    return deps.getProject(adoptId);
  } catch (err) {
    if (err instanceof AppError) throw err;
  }

  for (const entry of existingEntries) {
    await projectIndex.removeProject(entry.id);
  }

  await fs.mkdir(repoPath, { recursive: true });

  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: repoPath });
  } catch {
    await runGit(["init"], { cwd: repoPath });
    await ensureRepoHasInitialCommit(repoPath, input.worktreeBaseBranch);
  }

  const { hadHead, baseBranch } = await prepareRepoForProject(
    repoPath,
    input.worktreeBaseBranch,
    input.gitChangesAction
  );

  if (!hadHead) {
    await ensureRepoHasInitialCommit(repoPath, baseBranch);
  }

  const agentsMdPath = path.join(repoPath, "AGENTS.md");
  try {
    const agentsContent = await fs.readFile(agentsMdPath, "utf-8");
    const nextAgentsContent = ensureOpenSprintRuntimeContract(agentsContent);
    if (nextAgentsContent !== agentsContent) {
      await fs.writeFile(agentsMdPath, nextAgentsContent);
    }
  } catch {
    await fs.writeFile(agentsMdPath, ensureOpenSprintRuntimeContract(""));
  }

  await ensureProjectGitignoreEntries(repoPath);

  await fs.mkdir(opensprintDir, { recursive: true });

  const emptySection = () => ({ content: "", version: 0, updatedAt: now });
  const initialPrd = {
    version: 0,
    sections: {
      executive_summary: emptySection(),
      problem_statement: emptySection(),
      user_personas: emptySection(),
      goals_and_metrics: emptySection(),
      assumptions_and_constraints: emptySection(),
      feature_list: emptySection(),
      technical_architecture: emptySection(),
      data_model: emptySection(),
      api_contracts: emptySection(),
      non_functional_requirements: emptySection(),
      open_questions: emptySection(),
    },
    changeLog: [],
  };
  const specPath = path.join(repoPath, SPEC_MD);
  await fs.writeFile(specPath, prdToSpecMarkdown(initialPrd), "utf-8");

  const deployment = normalizeDeployment(input.deployment);
  const { aiAutonomyLevel, hilConfig } = resolveAiAutonomyAndHil(input);
  const detected = await detectTestFramework(repoPath);
  const testFramework = input.testFramework ?? detected?.framework ?? null;
  const testCommand = (detected?.testCommand ?? getTestCommandForFramework(testFramework)) || null;
  const gitWorkingMode = input.gitWorkingMode === "branches" ? "branches" : "worktree";
  const effectiveMaxConcurrentCoders =
    gitWorkingMode === "branches" ? 1 : (input.maxConcurrentCoders ?? 1);
  const rawMaxTotal = input.maxTotalConcurrentAgents;
  const initialMaxTotal =
    typeof rawMaxTotal === "number" && Number.isFinite(rawMaxTotal) && rawMaxTotal >= 1
      ? Math.min(MAX_TOTAL_CONCURRENT_AGENTS_CAP, Math.max(1, Math.round(rawMaxTotal)))
      : undefined;
  const settingsPayload: Record<string, unknown> = {
    deployment,
    aiAutonomyLevel,
    deliveryMode: input.deliveryMode === "pull_request" ? "pull_request" : "direct",
    hilConfig,
    testFramework,
    testCommand,
    ...(input.toolchainProfile && { toolchainProfile: input.toolchainProfile }),
    reviewMode: DEFAULT_REVIEW_MODE,
    gitWorkingMode,
    worktreeBaseBranch: baseBranch,
    maxConcurrentCoders: effectiveMaxConcurrentCoders,
    ...(initialMaxTotal != null && { maxTotalConcurrentAgents: initialMaxTotal }),
    ...(effectiveMaxConcurrentCoders > 1 &&
      input.unknownScopeStrategy && {
        unknownScopeStrategy: input.unknownScopeStrategy,
      }),
  };
  if (simpleComplexityAgent !== undefined) {
    settingsPayload.simpleComplexityAgent = simpleComplexityAgent;
  }
  if (complexComplexityAgent !== undefined) {
    settingsPayload.complexComplexityAgent = complexComplexityAgent;
  }
  await setSettingsInStore(id, settingsPayload as unknown as ProjectSettings);

  if (deployment.mode === "expo") {
    await ensureEasConfig(repoPath);
  }

  await commitBootstrapRepoChanges(repoPath, {
    includeWholeRepo: !hadHead,
    extraPaths: deployment.mode === "expo" ? ["eas.json"] : [],
  });

  await projectIndex.addProject({
    id,
    name,
    repoPath,
    createdAt: now,
  });

  deps.invalidateListCache();

  try {
    await deps.taskStore.listAll(id);
  } catch (e) {
    log.warn("Task store schema not ready after create project", { err: getErrorMessage(e) });
  }

  return {
    id,
    name,
    repoPath,
    currentPhase: "sketch",
    createdAt: now,
    updatedAt: now,
  };
}
