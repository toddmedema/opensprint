# Agent Instructions — Open Sprint

## Project Overview

Open Sprint is a web application that guides users through the full software development lifecycle using AI agents. It has five phases — SPEED: Sketch, Plan, Execute, Evaluate, and Deliver. The active product spec is `SPEC.md` at the repo root.

**Tech stack:** Node.js + TypeScript (backend), React + TypeScript (frontend).

## Repository development skills

These skills guide contributions to this repository:

- Use [verify-opensprint](.agents/skills/verify-opensprint/SKILL.md) for behavior changes,
  regressions, and new guardrails. Prove the observable contract with the existing test tooling.
- Use [create-pr](.agents/skills/create-pr/SKILL.md) when preparing or updating a pull request.
  **Every PR with user-visible UI changes must embed screenshots of the finished interface in its
  description**, including desktop and mobile views when responsive behavior is relevant. Review
  images for sensitive data and upload them as GitHub attachments; do not commit review-only images.
  If capture or upload is blocked, state the limitation in the PR and tell the user. Changes with no
  visible effect do not require screenshots.

These repository skills do not change the Execute agent runtime contract below. Execute agents must
keep their prepared branch, use the requested result schema, and leave publication to the orchestrator.

## Open Sprint Runtime Contract

Task tracking is handled internally by `TaskStoreService` backed by **SQLite (default)** or **PostgreSQL**. The connection is resolved in order: **`DATABASE_URL`**, then **`databaseUrl`** in `~/.opensprint/global-settings.json`, then the default SQLite path (`~/.opensprint/data/opensprint.sqlite`). There is no external task CLI.

**Integration token encryption:** Integration OAuth tokens are encrypted at rest. Without **`INTEGRATION_ENCRYPTION_KEY`** (base64-encoded 32-byte key), the backend derives a key from the hostname and `~/.opensprint/encryption-salt`, which is acceptable for typical local single-user use but **not** for shared hosts where other users might read `~/.opensprint`. For those deployments, set `INTEGRATION_ENCRYPTION_KEY` in the environment; the backend emits a startup warning when it is unset.

When Open Sprint spawns an Execute agent:

1. The task branch and worktree are already prepared. Do not create or switch branches unless the task prompt explicitly tells you to recover git state.
2. Implement the requested change and run the smallest relevant non-watch verification for touched workspaces while iterating. Use scoped tests first, add scoped build/typecheck and lint commands when your changes could affect them, and leave the branch in a state where the project’s configured merge quality gates are expected to pass before you report success. The orchestrator **re-runs those merge gate commands server-side** after `result.json` reports success (unless the project disables `enforceMergeGatesOnCodingSuccess`); failures there reject the success path even if the agent believed it was done.
3. **Dependencies:** If you add, remove, or upgrade dependencies, follow the repository’s documented install workflow from the **repository root**. Keep manifests and lockfiles in sync for the project’s package/dependency ecosystem, and commit metadata updates in the same commits as code that introduces new imports.
4. **Build/typecheck compatibility:** If test files are included in the project’s build/typecheck, ensure test-runner globals and typing/runtime configuration are set so build/typecheck still succeeds after your changes.
5. Commit incremental logical units while working so crash recovery can preserve progress.
6. Report completion only by writing the exact `result.json` payload requested in the task prompt. Do not call `TaskStoreService.close()` from feature code.
7. If blocked by ambiguity, return `status: "failed"` with `open_questions` instead of guessing.
8. Do not push, merge, or close tasks manually. The orchestrator handles validation, task state, merging, and remote publication.

## Orchestrator Recovery (GUPP-style)

Work state is persisted before agent spawn via `assignment.json` in `.opensprint/active/<task-id>/`. If the backend crashes, recovery reads the assignment and re-spawns or resumes the agent. **Always write assignment before spawn; never spawn then write.**

Agent admission is cancellable and FIFO. Recheck attempt generation and owning slot after admission and immediately before launch; cancelled or replaced queued attempts must never launch. Concurrency limit changes preserve active accounting. A recovered PID is observation-only until ownership is independently verified: report uncertain execution and retain its assignment instead of killing or requeueing it. A stop request becomes stopped only after observed completion. A terminal result file alone cannot complete an unverified recovered process. Guidance receipts distinguish durable queue acceptance from inclusion in a model turn.

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

## Protected Path Policy

Certain file paths are **sensitive surfaces** (integration, OAuth, token handling) and must only be modified when the task explicitly scopes integration or OAuth work. Execute agents will refuse to modify these paths for non-integration tasks, and reviewers will flag violations.

**Protected patterns:**

| Pattern                 | Label                     |
| ----------------------- | ------------------------- |
| `routes/integrations-*` | Integration routes        |
| `integration-store`     | Integration store service |
| `token-encryption`      | Token encryption service  |
| `routes/oauth`          | OAuth routes              |
| `todoist-sync`          | Todoist sync service      |

**Scope keywords that unlock protected paths:** integration, oauth, todoist, token-encrypt, api-key-stor, third-party-auth, external-service, connect(ion)-service.

If a non-integration task genuinely needs to touch these files, the agent should report `status: "failed"` with `open_questions` asking for explicit scope confirmation.

The policy is enforced in:

- `packages/backend/src/services/protected-path-policy.ts` — path definitions and audit logic
- `packages/backend/src/services/agent-default-instructions.ts` — coder and reviewer default instructions
- `packages/backend/src/services/context-assembler.ts` — coding prompt (Protected Path Policy section) and review checklist

## Merge quality gates and test stability

**Default gates (this repo):** `npm run build`, `npm run lint`, and `npm run test`, in that order (`DEFAULT_MERGE_QUALITY_GATE_COMMANDS` in [`packages/backend/src/services/toolchain-profile.service.ts`](packages/backend/src/services/toolchain-profile.service.ts)). Open Sprint uses the same style of commands when validating merges unless the project overrides its toolchain profile.

**Local verification:** From the repository root, `npm run verify:merge-gates` runs those three commands in sequence so human checks match what the orchestrator expects on `main`.

**Open Sprint repo dogfooding:** Optional [`.opensprint/merge-toolchain.json`](.opensprint/merge-toolchain.json) is merged into loaded project settings (see [`packages/backend/src/services/project/repo-toolchain-override.ts`](packages/backend/src/services/project/repo-toolchain-override.ts)). This repo sets `mergeQualityGateCommands` to `npm run verify:merge-gates`. The orchestrator expands that single command to `build`, `lint`, and `test` when running the deterministic gate profile so merge-gate test mode (`OPENSPRINT_MERGE_GATE_TEST_MODE` / Vitest env) applies only to the test step (see [`packages/backend/src/services/merge-quality-gates.ts`](packages/backend/src/services/merge-quality-gates.ts)).

**Flaky HTTP route tests:** [`packages/backend/src/__tests__/env-route.test.ts`](packages/backend/src/__tests__/env-route.test.ts) runs in an isolated Vitest project ([`packages/backend/vitest.env-route.config.ts`](packages/backend/vitest.env-route.config.ts)) because of `vi.mock` ordering. `GET /env/global-status` uses a shared helper with request timeout and a single retry on supertest `socket hang up` so merge-gate test runs do not fail intermittently. If you add new supertest coverage that mutates `process.env` and hits the same Express app, reuse that pattern instead of raw `authedSupertest(app).get(...)` for `/global-status`.

Other tests that assign `process.env` are mostly unit-level (no in-process HTTP listener); they are lower risk for the same failure mode.

## Maintenance Notes

- If you change the agent lifecycle or prompt contract, keep this file, the bootstrap contract in `packages/backend/src/services/project/project-runtime-contract.ts` (used by `project.service.ts`), and `packages/backend/docs/opensprint-help-context.md` in sync.
- Prefer short, role-specific instructions over one long global ruleset when adding new agent guidance.
