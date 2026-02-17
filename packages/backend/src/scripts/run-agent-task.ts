#!/usr/bin/env node
/**
 * CLI: Spawn coding agent with task directory and stream output.
 * Used by agent-chain.sh for headless task execution.
 *
 * Usage: npx tsx src/scripts/run-agent-task.ts <task-id>
 * Run from repo root (cwd = project repo).
 */

import path from 'path';
import fs from 'fs/promises';
import { config as loadEnv } from 'dotenv';
import { BeadsService } from '../services/beads.service.js';
import { ContextAssembler } from '../services/context-assembler.js';
import { AgentClient } from '../services/agent-client.js';
import { BranchManager } from '../services/branch-manager.js';
import { OPENSPRINT_PATHS, getTestCommandForFramework, getCodingAgentForComplexity } from '@opensprint/shared';
import type { AgentConfig, ProjectSettings } from '@opensprint/shared';
import { getPlanComplexityForTask } from '../services/plan-complexity.js';

// Load .env from monorepo root — override: true so the user's .env key wins
// over the Cursor IDE's internal CURSOR_API_KEY (which can't auth the CLI agent)
loadEnv({ path: path.resolve(process.cwd(), '.env'), override: true });
loadEnv({ path: path.resolve(process.cwd(), '../.env'), override: true });
loadEnv({ path: path.resolve(process.cwd(), '../../.env'), override: true });

const taskId = process.argv[2];
if (!taskId) {
  console.error('Usage: run-agent-task <task-id>');
  process.exit(1);
}

const repoPath = process.cwd();

async function loadSettings(): Promise<ProjectSettings> {
  const settingsPath = path.join(repoPath, OPENSPRINT_PATHS.settings);
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    return JSON.parse(raw) as ProjectSettings;
  } catch {
    return {
      planningAgent: { type: 'cursor', model: null, cliCommand: null },
      codingAgent: { type: 'cursor', model: null, cliCommand: null },
      deployment: { mode: 'custom' },
      hilConfig: {
        scopeChanges: 'requires_approval',
        architectureDecisions: 'requires_approval',
        dependencyModifications: 'automated',
        testFailuresAndRetries: 'automated',
      },
      testFramework: 'vitest',
    };
  }
}

const beads = new BeadsService();
const contextAssembler = new ContextAssembler();
const agentClient = new AgentClient();
const branchManager = new BranchManager();

async function main(): Promise<number> {
  const settings = await loadSettings();
  const branchName = `opensprint/${taskId}`;

  const task = await beads.show(repoPath, taskId);
  const taskComplexity = await getPlanComplexityForTask(repoPath, task);
  const codingAgent = getCodingAgentForComplexity(settings, taskComplexity);
  const planContent =
    (await contextAssembler.getPlanContentForTask(repoPath, task, beads)) ||
    '# Plan\n\nNo plan content available.';
  const blockers = await beads.getBlockers(repoPath, taskId);
  const prdExcerpt = await contextAssembler.extractPrdExcerpt(repoPath);
  const dependencyOutputs = await contextAssembler.collectDependencyOutputs(repoPath, blockers);

  const testCommand = getTestCommandForFramework(settings.testFramework) || 'echo "No tests"';
  const config = {
    invocation_id: taskId,
    agent_role: 'coder' as const,
    taskId,
    repoPath,
    branch: branchName,
    testCommand,
    attempt: 1,
    phase: 'coding' as const,
    previousFailure: null as string | null,
    reviewFeedback: null as string | null,
  };

  await contextAssembler.assembleTaskDirectory(repoPath, taskId, config, {
    taskId,
    title: task.title,
    description: task.description || '',
    planContent,
    prdExcerpt,
    dependencyOutputs,
  });

  const taskDir = path.join(repoPath, OPENSPRINT_PATHS.active, taskId);
  const promptPath = path.join(taskDir, 'prompt.md');

  // Append agent-chain completion instructions (CLI flow)
  const chainInstructions = `

## During Work

Commit after each meaningful change with descriptive WIP messages. Do not wait until the end to commit.

## When Done (agent-chain flow)

Run these steps to complete the task and continue the chain:

1. bd update ${taskId} --status done
2. git add -A && git commit -m "Done ${taskId}: ${task.title}"
3. bd sync
4. git pull --rebase && git push
5. Run: ./scripts/agent-chain.sh

If ./scripts/agent-chain.sh reports no more open tasks, you are done. Otherwise it will start the next agent.
`;
  const existingPrompt = await fs.readFile(promptPath, 'utf-8');
  await fs.writeFile(promptPath, existingPrompt + chainInstructions);

  return new Promise((resolve) => {
    let agentDone = false;
    let sigtermHandling = false; // Prevent onExit from resolving when we're doing WIP commit

    const proc = agentClient.spawnWithTaskFile(
      codingAgent,
      promptPath,
      repoPath,
      (chunk: string) => {
        process.stdout.write(chunk);
      },
      (code: number | null) => {
        if (sigtermHandling) return; // SIGTERM handler will resolve after WIP commit
        agentDone = true;
        resolve(code ?? 1);
      },
      'coder',
    );

    process.on('SIGINT', () => {
      if (agentDone) return; // Agent already finished — ignore stray signal
      proc.kill();
      resolve(130);
    });
    process.on('SIGTERM', () => {
      if (agentDone) return; // Agent already finished — ignore stray signal
      sigtermHandling = true;
      proc.kill(); // Stop agent first so it stops writing
      (async () => {
        try {
          await branchManager.commitWip(repoPath, taskId);
        } finally {
          resolve(143);
        }
      })();
    });
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[run-agent-task]', err.message);
    process.exit(1);
  });
