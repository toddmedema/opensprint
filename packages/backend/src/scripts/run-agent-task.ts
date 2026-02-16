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
import { BeadsService, type BeadsIssue } from '../services/beads.service.js';
import { ContextAssembler } from '../services/context-assembler.js';
import { AgentClient } from '../services/agent-client.js';
import { OPENSPRINT_PATHS, getTestCommandForFramework } from '@opensprint/shared';
import type { AgentConfig, ProjectSettings } from '@opensprint/shared';

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

async function getPlanContentForTask(beads: BeadsService, task: BeadsIssue): Promise<string> {
  const parentId = beads.getParentId(task.id);
  if (!parentId) return '';
  try {
    const parent = await beads.show(repoPath, parentId);
    const desc = parent.description as string;
    if (desc?.startsWith('.opensprint/plans/')) {
      const planId = path.basename(desc, '.md');
      return contextAssembler.readPlanContent(repoPath, planId);
    }
  } catch {
    // Parent might not exist
  }
  return '';
}

const beads = new BeadsService();
const contextAssembler = new ContextAssembler();
const agentClient = new AgentClient();

async function main(): Promise<number> {
  const settings = await loadSettings();
  const codingAgent = settings.codingAgent as AgentConfig;
  const branchName = `opensprint/${taskId}`;

  const task = await beads.show(repoPath, taskId);
  const planContent = await getPlanContentForTask(beads, task);
  const blockers = await beads.getBlockers(repoPath, taskId);
  const prdExcerpt = await contextAssembler.extractPrdExcerpt(repoPath);
  const dependencyOutputs = await contextAssembler.collectDependencyOutputs(repoPath, blockers);

  const testCommand = getTestCommandForFramework(settings.testFramework) || 'echo "No tests"';
  const config = {
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

## When Done (agent-chain flow)

Run these steps to complete the task and continue the chain:

1. bd update ${taskId} --status done
2. git add -A && git commit -m "Complete ${taskId}: ${task.title}"
3. bd sync
4. git pull --rebase && git push
5. Run: ./scripts/agent-chain.sh

If ./scripts/agent-chain.sh reports no more open tasks, you are done. Otherwise it will start the next agent.
`;
  const existingPrompt = await fs.readFile(promptPath, 'utf-8');
  await fs.writeFile(promptPath, existingPrompt + chainInstructions);

  return new Promise((resolve) => {
    let agentDone = false;

    const proc = agentClient.spawnWithTaskFile(
      codingAgent,
      promptPath,
      repoPath,
      (chunk: string) => {
        process.stdout.write(chunk);
      },
      (code: number | null) => {
        agentDone = true;
        resolve(code ?? 0);
      },
    );

    process.on('SIGINT', () => {
      if (agentDone) return; // Agent already finished — ignore stray signal
      proc.kill();
      resolve(130);
    });
    process.on('SIGTERM', () => {
      if (agentDone) return; // Agent already finished — ignore stray signal
      proc.kill();
      resolve(143);
    });
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[run-agent-task]', err.message);
    process.exit(1);
  });
