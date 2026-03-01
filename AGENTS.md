# Agent Instructions — OpenSprint

Task tracking is handled internally by `TaskStoreService` backed by PostgreSQL. The connection URL is resolved in order: **`DATABASE_URL`** env (12-factor), then **`databaseUrl`** in `~/.opensprint/global-settings.json`, then the default local URL. There is no external CLI for task management.

## Project Overview

OpenSprint is a web application that guides users through the full software development lifecycle using AI agents. It has five phases — SPEED: Sketch, Plan, Execute, Evaluate, and Deliver. The PRD is at `PRD.md`.

**Tech stack:** Node.js + TypeScript (backend), React + TypeScript (frontend).

## Orchestrator Recovery (GUPP-style)

Work state is persisted before agent spawn via `assignment.json` in `.opensprint/active/<task-id>/`. If the backend crashes, recovery reads the assignment and re-spawns the agent — no work is lost. **Always write assignment before spawn; never spawn then write.**

## Loop Kicker vs Watchdog

- **Loop kicker** (60s): Restarts the orchestrator loop when idle. Runs inside the orchestrator.
- **Watchdog** (5 min): Witness-style health patrol — stale heartbeats, orphaned tasks, stale `.git/index.lock`. Runs in a separate `WatchdogService`.

## Task Store

Tasks are stored in PostgreSQL. Schema is applied on init via `runSchema` (CREATE TABLE IF NOT EXISTS in `packages/backend/src/db/schema.ts`). For versioned, reversible schema changes in the future, consider adding a migration runner (e.g. node-pg-migrate).

**Tests and production:** Backend tests use a separate test DB (`opensprint_test` or `TEST_DATABASE_URL`). The app never reads `TEST_DATABASE_URL`. For future test-only or prod-only behavior, run tests with `NODE_ENV=test` (or similar) and gate logic so production never runs test-only code.

The `TaskStoreService` provides:

- `create()` / `createMany()` — Create tasks with optional parent IDs
- `update()` / `updateMany()` — Update task fields (status, assignee, priority, etc.)
- `close()` / `closeMany()` — Close tasks with a reason
- `show()` — Get a single task by ID
- `listAll()` — List all tasks
- `ready()` — Get priority-sorted tasks with all blockers resolved
- `addDependency()` — Add dependency between tasks (blocks, parent-child, etc.)

## Task ID Format

- `os-xxxx` — Top-level task (random hex)
- `os-xxxx.1` — Child task under parent
- `os-xxxx.1.1` — Sub-task

## Merge Conflicts and Merger Agent

When a merge to main fails with **code conflicts** (after infra-only auto-resolve), the **merge-coordinator** tries once to fix it automatically:

1. **Rebase** the task branch onto main in the worktree (conflicts may appear).
2. **Merger agent**: spawns once to resolve rebase conflicts in the worktree (prompt in `.opensprint/merger/prompt.md`), then `rebase --continue`.
3. **Retry merge** to main. If that succeeds, the task is closed and cleaned up as usual.
4. If the merger step fails or the retry merge fails, the task is **requeued** (reopened, cumulative attempts incremented). The next run will pick it up again; after enough merge failures the task is **blocked**.

So: one merger attempt per merge failure; no infinite merger loop.

## Task Workflow

1. Identify the next task from the orchestrator
2. Create a feature branch: `git checkout -b opensprint/<task-id>`
3. Implement the task, write tests — **commit incrementally** during work (crash resilience)
4. Close the task via `TaskStoreService.close()`

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST finish ALL steps below. Work is NOT done until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** — Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) — Tests, linters, builds
3. **Update issue status** — Close finished work, update in-progress items
4. **PUSH TO REMOTE** — This is MANDATORY. Push directly to `origin/main` (no PRs):
   ```bash
   git fetch origin
   git rebase origin/main
   git reset --soft origin/main
   git commit -m "Closed <task-id>: <task name ~30 chars>"
   git checkout main
   git pull --rebase origin main
   git merge opensprint/<task-id>
   git push origin main
   git branch -d opensprint/<task-id>
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** — Clear stashes, prune remote branches
6. **Verify** — All changes committed AND pushed
7. **Hand off** — Provide context for next session

**CRITICAL RULES:**

- One commit on main per task. Push directly to `origin/main` — no PRs
- Work is NOT done until `git push` succeeds
- NEVER stop before pushing — that leaves work stranded locally
- NEVER say "ready to push when you are" — YOU must push
- If push fails, resolve and retry until it succeeds
