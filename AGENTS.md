# Agent Instructions — Open Sprint

## Project Overview

Open Sprint is a web application that guides users through the full software development lifecycle using AI agents. It has five phases — SPEED: Sketch, Plan, Execute, Evaluate, and Deliver. The product spec is at `PRD.md`; the Sketch phase output is `SPEC.md` at the project repo root.

**Tech stack:** Node.js + TypeScript (backend), React + TypeScript (frontend).

## Open Sprint Runtime Contract

Task tracking is handled internally by `TaskStoreService` backed by **SQLite (default)** or **PostgreSQL**. The connection is resolved in order: **`DATABASE_URL`**, then **`databaseUrl`** in `~/.opensprint/global-settings.json`, then the default SQLite path (`~/.opensprint/data/opensprint.sqlite`). There is no external task CLI.

When Open Sprint spawns an Execute agent:

1. The task branch and worktree are already prepared. Do not create or switch branches unless the task prompt explicitly tells you to recover git state.
2. Implement the requested change and run the smallest relevant non-watch verification for touched workspaces while iterating. Use scoped tests first, add scoped build/typecheck and lint commands when your changes could affect them, and leave the branch in a state where the merge quality gates (`npm run build`, `npm run lint`, `npm run test`) are expected to pass before you report success.
3. Commit incremental logical units while working so crash recovery can preserve progress.
4. Report completion only by writing the exact `result.json` payload requested in the task prompt. Do not call `TaskStoreService.close()` from feature code.
5. If blocked by ambiguity, return `status: "failed"` with `open_questions` instead of guessing.
6. Do not push, merge, or close tasks manually. The orchestrator handles validation, task state, merging, and remote publication.

## Orchestrator Recovery (GUPP-style)

Work state is persisted before agent spawn via `assignment.json` in `.opensprint/active/<task-id>/`. If the backend crashes, recovery reads the assignment and re-spawns or resumes the agent. **Always write assignment before spawn; never spawn then write.**

## Loop Kicker vs Watchdog

- **Loop kicker** (60s): Restarts the orchestrator loop when idle. Runs inside the orchestrator.
- **Watchdog** (5 min): Witness-style health patrol — stale heartbeats, orphaned tasks, stale `.git/index.lock`. Runs in a separate `WatchdogService`.

## Task Store

Tasks are stored in the configured database (SQLite or PostgreSQL). Schema is applied on init via `runSchema(client, dialect)` in `packages/backend/src/db/schema.ts`. The same `DbClient` abstraction is used for both; dialect is chosen from the database URL.

**Tests and production:** Backend tests use a separate test DB (`opensprint_test` or `TEST_DATABASE_URL` for Postgres). The app never reads `TEST_DATABASE_URL`. For future test-only or prod-only behavior, run tests with `NODE_ENV=test` and gate logic so production never runs test-only code.

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

## Maintenance Notes

- If you change the agent lifecycle or prompt contract, keep this file, the bootstrap contract in `packages/backend/src/services/project.service.ts`, and `packages/backend/docs/opensprint-help-context.md` in sync.
- Prefer short, role-specific instructions over one long global ruleset when adding new agent guidance.
