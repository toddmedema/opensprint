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
});
