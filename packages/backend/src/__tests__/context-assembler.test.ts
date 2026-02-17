import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ContextAssembler } from '../services/context-assembler.js';
import { OPENSPRINT_PATHS } from '@opensprint/shared';

describe('ContextAssembler', () => {
  let assembler: ContextAssembler;
  let repoPath: string;

  beforeEach(async () => {
    assembler = new ContextAssembler();
    repoPath = path.join(os.tmpdir(), `opensprint-context-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should assemble task directory with PRD excerpt, plan, and deps', async () => {
    // Setup PRD
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({
        sections: {
          executive_summary: { content: '## Summary\n\nTest product.' },
        },
      }),
    );

    // Setup plan
    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planContent = `# Feature: Auth

## Overview
User authentication.

## Acceptance Criteria

- User can log in with email/password
- JWT tokens are issued on success

## Technical Approach

- Use bcrypt for password hashing
- JWT for session tokens
`;
    await fs.writeFile(path.join(plansDir, 'auth.md'), planContent);

    const config = {
      invocation_id: 'bd-a3f8.1',
      agent_role: 'coder' as const,
      taskId: 'bd-a3f8.1',
      repoPath,
      branch: 'opensprint/bd-a3f8.1',
      testCommand: 'npm test',
      attempt: 1,
      phase: 'coding' as const,
      previousFailure: null as string | null,
      reviewFeedback: null as string | null,
    };

    const taskDir = await assembler.assembleTaskDirectory(repoPath, config.taskId, config, {
      taskId: config.taskId,
      title: 'Implement login endpoint',
      description: 'Add POST /auth/login',
      planContent,
      prdExcerpt: '# Product Requirements\n\nTest product.',
      dependencyOutputs: [
        { taskId: 'bd-a3f8.0', diff: 'diff content', summary: 'Gate closed' },
      ],
    });

    expect(taskDir).toContain('.opensprint/active/bd-a3f8.1');

    const contextDir = path.join(taskDir, 'context');
    const depsDir = path.join(contextDir, 'deps');

    const configJson = JSON.parse(await fs.readFile(path.join(taskDir, 'config.json'), 'utf-8'));
    expect(configJson.invocation_id).toBe('bd-a3f8.1');
    expect(configJson.agent_role).toBe('coder');
    expect(configJson.taskId).toBe('bd-a3f8.1');
    expect(configJson.phase).toBe('coding');

    const prdExcerpt = await fs.readFile(path.join(contextDir, 'prd_excerpt.md'), 'utf-8');
    expect(prdExcerpt).toContain('Test product.');

    const planMd = await fs.readFile(path.join(contextDir, 'plan.md'), 'utf-8');
    expect(planMd).toContain('User authentication');

    const depDiff = await fs.readFile(path.join(depsDir, 'bd-a3f8.0.diff'), 'utf-8');
    expect(depDiff).toBe('diff content');

    const depSummary = await fs.readFile(path.join(depsDir, 'bd-a3f8.0.summary.md'), 'utf-8');
    expect(depSummary).toBe('Gate closed');

    const prompt = await fs.readFile(path.join(taskDir, 'prompt.md'), 'utf-8');
    expect(prompt).toContain('# Task: Implement login endpoint');
    expect(prompt).toContain('## Acceptance Criteria');
    expect(prompt).toContain('User can log in with email/password');
    expect(prompt).toContain('## Technical Approach');
    expect(prompt).toContain('Use bcrypt for password hashing');
    expect(prompt).toContain('context/plan.md');
    expect(prompt).toContain('context/prd_excerpt.md');
    expect(prompt).toContain('context/deps/');
    expect(prompt).toContain('Commit after each meaningful change');
    expect(prompt).toContain('Do not wait until the end to commit');
    // Terminology: use "done" and "finish" instead of "complete" (feedback consistency)
    expect(prompt).toContain('when the task is done');
    expect(prompt).toContain('could not finish it');
    expect(prompt).not.toContain('when the task is complete');
  });

  it('should include Review Feedback section in coding prompt when reviewFeedback is provided', async () => {
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({
        sections: {
          executive_summary: { content: '## Summary\n\nTest product.' },
        },
      }),
    );

    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planContent = `# Feature: Auth

## Overview
User authentication.

## Acceptance Criteria

- User can log in with email/password

## Technical Approach

- Use bcrypt for password hashing
`;
    await fs.writeFile(path.join(plansDir, 'auth.md'), planContent);

    const config = {
      invocation_id: 'bd-a3f8.1',
      agent_role: 'coder' as const,
      taskId: 'bd-a3f8.1',
      repoPath,
      branch: 'opensprint/bd-a3f8.1',
      testCommand: 'npm test',
      attempt: 2,
      phase: 'coding' as const,
      previousFailure: null as string | null,
      reviewFeedback: 'Tests do not cover edge cases.\nMissing error handling for invalid input.',
    };

    const taskDir = await assembler.assembleTaskDirectory(repoPath, config.taskId, config, {
      taskId: config.taskId,
      title: 'Implement login endpoint',
      description: 'Add POST /auth/login',
      planContent,
      prdExcerpt: '# Product Requirements\n\nTest product.',
      dependencyOutputs: [],
    });

    const prompt = await fs.readFile(path.join(taskDir, 'prompt.md'), 'utf-8');
    expect(prompt).toContain('## Review Feedback');
    expect(prompt).toContain('The review agent rejected the previous implementation:');
    expect(prompt).toContain('Tests do not cover edge cases.');
    expect(prompt).toContain('Missing error handling for invalid input.');
  });

  it('should extract PRD excerpt when prd.json exists', async () => {
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({
        sections: {
          problem_statement: { content: 'Users face fragmentation.' },
        },
      }),
    );

    const excerpt = await assembler.extractPrdExcerpt(repoPath);
    expect(excerpt).toContain('Product Requirements');
    expect(excerpt).toContain('Users face fragmentation.');
  });

  it('should return fallback when PRD missing', async () => {
    const excerpt = await assembler.extractPrdExcerpt(repoPath);
    expect(excerpt).toContain('No PRD available');
  });

  it('should read plan content', async () => {
    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(path.join(plansDir, 'auth.md'), '# Auth Plan\n\nLogin flow.');

    const content = await assembler.readPlanContent(repoPath, 'auth');
    expect(content).toContain('Auth Plan');
    expect(content).toContain('Login flow.');
  });

  it('should getPlanContentForTask return plan content when parent epic has plan path', async () => {
    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(path.join(plansDir, 'auth.md'), '# Auth Plan\n\nLogin flow.');

    const mockBeads = {
      getParentId: (taskId: string) => {
        const lastDot = taskId.lastIndexOf('.');
        if (lastDot <= 0) return null;
        return taskId.slice(0, lastDot);
      },
      show: async (_repoPath: string, id: string) => {
        if (id === 'bd-a3f8') {
          return { id: 'bd-a3f8', description: '.opensprint/plans/auth.md' };
        }
        throw new Error(`Unknown id: ${id}`);
      },
    };

    const task = { id: 'bd-a3f8.1', title: 'Implement login', description: '' };
    const content = await assembler.getPlanContentForTask(repoPath, task as any, mockBeads as any);
    expect(content).toContain('Auth Plan');
    expect(content).toContain('Login flow.');
  });

  it('should getPlanContentForTask return empty string when task has no parent', async () => {
    const mockBeads = {
      getParentId: () => null,
    };

    const task = { id: 'bd-a3f8', title: 'Epic', description: '' };
    const content = await assembler.getPlanContentForTask(repoPath, task as any, mockBeads as any);
    expect(content).toBe('');
  });

  it('should getPlanContentForTask return empty string when parent has no plan path', async () => {
    const mockBeads = {
      getParentId: (taskId: string) => {
        const lastDot = taskId.lastIndexOf('.');
        if (lastDot <= 0) return null;
        return taskId.slice(0, lastDot);
      },
      show: async () => ({ id: 'bd-a3f8', description: 'Some other description' }),
    };

    const task = { id: 'bd-a3f8.1', title: 'Implement login', description: '' };
    const content = await assembler.getPlanContentForTask(repoPath, task as any, mockBeads as any);
    expect(content).toBe('');
  });

  it('should getPlanContentForTask return empty string when parent does not exist', async () => {
    const mockBeads = {
      getParentId: () => 'bd-nonexistent',
      show: async () => {
        throw new Error('Parent not found');
      },
    };

    const task = { id: 'bd-a3f8.1', title: 'Implement login', description: '' };
    const content = await assembler.getPlanContentForTask(repoPath, task as any, mockBeads as any);
    expect(content).toBe('');
  });

  it('should collect dependency outputs from approved sessions', async () => {
    const sessionsDir = path.join(repoPath, OPENSPRINT_PATHS.sessions);
    await fs.mkdir(path.join(sessionsDir, 'bd-a3f8.1-1'), { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, 'bd-a3f8.1-1', 'session.json'),
      JSON.stringify({
        status: 'approved',
        gitDiff: 'diff from task 1',
        summary: 'Implemented login endpoint',
      }),
    );

    const outputs = await assembler.collectDependencyOutputs(repoPath, ['bd-a3f8.1']);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].taskId).toBe('bd-a3f8.1');
    expect(outputs[0].diff).toBe('diff from task 1');
    expect(outputs[0].summary).toBe('Implemented login endpoint');
  });

  it('should skip non-approved sessions', async () => {
    const sessionsDir = path.join(repoPath, OPENSPRINT_PATHS.sessions);
    await fs.mkdir(path.join(sessionsDir, 'bd-a3f8.1-1'), { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, 'bd-a3f8.1-1', 'session.json'),
      JSON.stringify({ status: 'failed', gitDiff: '', summary: '' }),
    );

    const outputs = await assembler.collectDependencyOutputs(repoPath, ['bd-a3f8.1']);
    expect(outputs).toHaveLength(0);
  });

  it('should buildContext given taskId: Plan from epic, PRD sections, dependency diffs', async () => {
    // Setup PRD
    const prdDir = path.join(repoPath, path.dirname(OPENSPRINT_PATHS.prd));
    await fs.mkdir(prdDir, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, OPENSPRINT_PATHS.prd),
      JSON.stringify({
        sections: {
          executive_summary: { content: '## Summary\n\nTest product.' },
        },
      }),
    );

    // Setup plan
    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planContent = '# Auth Plan\n\nUser authentication.';
    await fs.writeFile(path.join(plansDir, 'auth.md'), planContent);

    // Setup dependency session (branch merged, so we use archived session)
    const sessionsDir = path.join(repoPath, OPENSPRINT_PATHS.sessions);
    await fs.mkdir(path.join(sessionsDir, 'bd-a3f8.1-1'), { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, 'bd-a3f8.1-1', 'session.json'),
      JSON.stringify({
        status: 'approved',
        gitDiff: 'diff from dep task',
        summary: 'Implemented login endpoint',
      }),
    );

    const mockBeads = {
      show: async (_repoPath: string, id: string) => {
        if (id === 'bd-a3f8.2') {
          return {
            id: 'bd-a3f8.2',
            title: 'Implement JWT validation',
            description: 'Add JWT validation middleware',
            dependencies: [{ type: 'blocks', depends_on_id: 'bd-a3f8.1' }],
          };
        }
        if (id === 'bd-a3f8') {
          return {
            id: 'bd-a3f8',
            description: '.opensprint/plans/auth.md',
          };
        }
        throw new Error(`Unknown id: ${id}`);
      },
      getParentId: (taskId: string) => {
        const lastDot = taskId.lastIndexOf('.');
        if (lastDot <= 0) return null;
        return taskId.slice(0, lastDot);
      },
      getBlockers: async () => ['bd-a3f8.1'],
    };

    const mockBranchManager = {
      getDiff: async () => {
        throw new Error('Branch merged'); // Simulate branch no longer exists
      },
    };

    const context = await assembler.buildContext(
      repoPath,
      'bd-a3f8.2',
      mockBeads as any,
      mockBranchManager as any,
    );

    expect(context.taskId).toBe('bd-a3f8.2');
    expect(context.title).toBe('Implement JWT validation');
    expect(context.description).toBe('Add JWT validation middleware');
    expect(context.planContent).toContain('Auth Plan');
    expect(context.planContent).toContain('User authentication');
    expect(context.prdExcerpt).toContain('Test product.');
    expect(context.dependencyOutputs).toHaveLength(1);
    expect(context.dependencyOutputs[0].taskId).toBe('bd-a3f8.1');
    expect(context.dependencyOutputs[0].diff).toBe('diff from dep task');
    expect(context.dependencyOutputs[0].summary).toBe('Implemented login endpoint');
  });

  it('should generate review prompt per PRD §12.3 when phase is review', async () => {
    const plansDir = path.join(repoPath, OPENSPRINT_PATHS.plans);
    await fs.mkdir(plansDir, { recursive: true });
    const planContent = `# Feature: Auth

## Overview
User authentication.

## Acceptance Criteria

- User can log in with email/password
- JWT tokens are issued on success

## Technical Approach

- Use bcrypt for password hashing
`;
    await fs.writeFile(path.join(plansDir, 'auth.md'), planContent);

    const config = {
      invocation_id: 'bd-a3f8.2',
      agent_role: 'reviewer' as const,
      taskId: 'bd-a3f8.2',
      repoPath,
      branch: 'opensprint/bd-a3f8.2',
      testCommand: 'npm test',
      attempt: 1,
      phase: 'review' as const,
      previousFailure: null as string | null,
      reviewFeedback: null as string | null,
    };

    const context = {
      taskId: config.taskId,
      title: 'Implement JWT validation',
      description: 'Add JWT validation middleware',
      planContent,
      prdExcerpt: '# Product Requirements\n\nTest product.',
      dependencyOutputs: [] as Array<{ taskId: string; diff: string; summary: string }>,
    };

    const taskDir = await assembler.assembleTaskDirectory(repoPath, config.taskId, config, context);

    const prompt = await fs.readFile(path.join(taskDir, 'prompt.md'), 'utf-8');

    // Per PRD §12.3: Review agent prompt structure
    expect(prompt).toContain('# Review Task: Implement JWT validation');
    expect(prompt).toContain('## Objective');
    expect(prompt).toContain('Review the implementation of this task against its specification and acceptance criteria');
    expect(prompt).toContain('## Task Specification');
    expect(prompt).toContain('Add JWT validation middleware');
    expect(prompt).toContain('## Acceptance Criteria');
    expect(prompt).toContain('User can log in with email/password');
    expect(prompt).toContain('## Implementation');
    expect(prompt).toContain('The coding agent has produced changes on branch `opensprint/bd-a3f8.2`');
    expect(prompt).toContain('The orchestrator has already committed them before invoking you');
    expect(prompt).toContain('Run `git diff main...opensprint/bd-a3f8.2` to review the committed changes');
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('1. Review the diff between main and the task branch using `git diff main...opensprint/bd-a3f8.2`');
    expect(prompt).toContain('2. Verify the implementation meets ALL acceptance criteria');
    expect(prompt).toContain('3. Verify tests exist and cover the ticket scope');
    expect(prompt).toContain('4. Run `npm test` and confirm all tests pass');
    expect(prompt).toContain('5. Check code quality');
    // PRD §12.3: Do NOT merge — orchestrator will merge after exit
    expect(prompt).toContain('6. If approving: write your result to `.opensprint/active/bd-a3f8.2/result.json` with status "approved"');
    expect(prompt).toContain('Do NOT merge — the orchestrator will merge after you exit');
    expect(prompt).toContain('7. If rejecting: write your result to `.opensprint/active/bd-a3f8.2/result.json` with status "rejected"');
    expect(prompt).toContain('provide specific, actionable feedback');
  });
});
