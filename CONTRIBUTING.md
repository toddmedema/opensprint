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

| Command                          | Purpose                                                |
| -------------------------------- | ------------------------------------------------------ |
| `npm run test`                   | Run the test suite (all workspaces)                    |
| `npm run lint`                   | Lint all packages                                      |
| `npm run format:check`           | Check Prettier formatting                              |
| `npm run build`                  | Build shared, backend, and frontend                    |
| `npm run test:coverage:affected` | Run CI workspace selection and affected coverage gates |

CI runs `npm run lint`; use `npm run format:check` to check Prettier locally as well. Keep changed files formatted before submitting.

**Coverage and E2E:** The test job in `.github/workflows/merge-gate.yml` selects affected workspaces and runs `npm run test:coverage` for shared, backend, frontend, and Electron as applicable. The frontend suite includes E2E tests (`*.e2e.test.tsx`); each workspace coverage step is bounded by a 20-minute timeout. The SPEC coverage targets and passing E2E tests are enforced in CI; see `SPEC.md` for thresholds and details.

Before opening or updating a PR, run both `npm run verify:merge-gates` and `npm run test:coverage:affected` from the repository root. The first runs build, lint, and ordinary tests; the second exercises CI's Git-based workspace selection and coverage thresholds. Inspect the selection with `node scripts/affected-workspaces.mjs --coverage-only --json`. Do not substitute `--all` for this check: it bypasses Git comparison and cannot detect checkout/history problems.

The shared test suite includes real complete-history and shallow Git checkout regressions. CI fetches full history for workspace selection; if a comparison base is unavailable, the selector conservatively runs every workspace. Missing PostgreSQL or other prerequisites make local validation incomplete. After pushing, verify every required CI job before reporting the PR ready; passing scoped tests or the ordinary merge gate alone does not establish that the coverage job passed.

To fix formatting: `npm run format`.

## Dependency ownership

- Keep test tooling explicit in each workspace that runs tests (`vitest` and `@vitest/coverage-v8` in package-level `devDependencies`).
- Avoid relying on a root-only test runner dependency for workspace scripts; this keeps `npm run test -w packages/<workspace>` self-contained.
- If upgrading shared toolchain packages (for example, `vitest`, `vite`, `typescript`), align versions across workspaces in one change and regenerate lockfiles from repo root.

## Provider rollout checklist

When you add or expand an agent provider or capability, update the full rollout surface in one change instead of patching each layer separately later.

- Backend validation: request schemas, provider enums, route validation, and any env-key save/validate paths.
- Shared contracts: `AgentType`, API-key provider constants, provider-to-env-key mapping, and any shared labels/helpers used across packages.
- Frontend flows: onboarding, API key setup modal, create-project flow, project settings, and any provider dropdowns or default-provider logic.
- Provider UX: missing-key warnings, placeholders, help links, and local-provider behavior when no API key should be requested.
- Tests: add or update targeted coverage for one happy path and one missing-key/error path so provider drift is caught quickly.

Prefer extending existing shared provider helpers over introducing a new hand-written provider map in a feature file.

## Submitting changes

- **Pull requests:** Open a PR against `main`. Describe what changed and how you tested it.
- **Screenshots:** Every PR with user-visible UI changes must embed screenshots of the finished
  interface in its description. Include desktop and mobile views when responsive behavior changes.
  Upload review-only images as GitHub attachments rather than committing them, and check that they
  contain no sensitive data. If capture or upload is blocked, explain why in the PR and tell the user.
  Changes with no visible effect do not require screenshots. See the
  [create-pr skill](.agents/skills/create-pr/SKILL.md) for capture and upload guidance.
- **Bug reports and ideas:** Use [GitHub Issues](https://github.com/toddmedema/opensprint/issues).

Maintainers will review and merge when ready. By contributing, you agree that your contributions are licensed under the project’s [AGPL-3.0 license](LICENSE).

## Agent contract sync

When you change **agent lifecycle** or **prompt contract** (how agents are spawned, what they receive, or how they report), keep these three sources in sync:

| File                                               | Role                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `AGENTS.md`                                        | Canonical agent instructions (rules, runtime contract, maintenance notes).      |
| `packages/backend/src/services/project.service.ts` | Bootstrap contract (what the backend injects into agent context when spawning). |
| `packages/backend/docs/opensprint-help-context.md` | Help/context doc used by the app or agents.                                     |

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
