# Contributing to Open Sprint

Thanks for your interest in contributing. This guide explains how to get set up, run checks, and submit changes.

## Getting started

1. **Prerequisites:** Git, [Node.js 24.x](https://nodejs.org/), and a configured git identity (`user.name`, `user.email`).
2. **Clone and run:** See the [README Quick Start](README.md#quick-start). From the repo root:
   ```bash
   npm run setup
   npm run dev
   ```
   Then open http://localhost:5173.

For a faster setup that skips Electron/Puppeteer workspace installs: `OPENSPRINT_SETUP_MINIMAL=1 npm run setup`.

## Development workflow

1. **Fork** the repo (if you don’t have write access) and create a **branch** from `main` (e.g. `feature/short-description` or `fix/issue-description`).
2. **Make your changes** and add or update tests as needed.
3. **Run quality checks** before opening a pull request (see below).
4. **Open a pull request** against `main` with a clear summary and any testing notes.

## Quality checks

From the repo root, run:

| Command                | Purpose                             |
| ---------------------- | ----------------------------------- |
| `npm run test`         | Run the test suite (all workspaces) |
| `npm run lint`         | Lint all packages                   |
| `npm run format:check` | Check Prettier formatting           |
| `npm run build`        | Build shared, backend, and frontend |

CI also runs `npm run lint:ci` (lint + format check). Fix any failures before submitting.

**Merge gate and E2E:** The merge gate (`.github/workflows/merge-gate.yml`) runs `npm run test:coverage` for shared, backend, and frontend. The frontend suite includes E2E tests (`*.e2e.test.tsx`); the test step is bounded by a 20-minute timeout. The SPEC target of >80% coverage with passing E2E tests is enforced in CI; see `SPEC.md` for thresholds and details.

To fix formatting: `npm run format`.

## Submitting changes

- **Pull requests:** Open a PR against `main`. Describe what changed and how you tested it.
- **Bug reports and ideas:** Use [GitHub Issues](https://github.com/toddmedema/opensprint/issues).

Maintainers will review and merge when ready. By contributing, you agree that your contributions are licensed under the project’s [AGPL-3.0 license](LICENSE).

## Agent contract sync

When you change **agent lifecycle** or **prompt contract** (how agents are spawned, what they receive, or how they report), keep these three sources in sync:

| File | Role |
|------|------|
| `AGENTS.md` | Canonical agent instructions (rules, runtime contract, maintenance notes). |
| `packages/backend/src/services/project.service.ts` | Bootstrap contract (what the backend injects into agent context when spawning). |
| `packages/backend/docs/opensprint-help-context.md` | Help/context doc used by the app or agents. |

**Checklist:** After editing any of the above for lifecycle or prompt changes, review and update the other two so behavior and wording stay consistent.

## Project layout

- `packages/backend` — Node.js + TypeScript API and orchestrator
- `packages/frontend` — React + TypeScript web app
- `packages/shared` — Shared types and constants
- `packages/electron` — Electron desktop app

Product spec: `SPEC.md`. Architecture and commands: [README](README.md#architecture-at-a-glance).

## Developing on Open Sprint with Open Sprint

If you use Open Sprint to work on this repo, use two clones to avoid restarts and git lock contention:

1. Keep a control clone running `npm run dev`.
2. Create a second clone for agent work.
3. Point the project at the second clone so orchestrated work happens there.

Run `npm run dev` only from the control clone.
