# Contributing to Open Sprint

Thanks for your interest in contributing. This guide explains how to get set up, run checks, and submit changes.

## Getting started

1. **Prerequisites:** Git, [Node.js 20+](https://nodejs.org/), and a configured git identity (`user.name`, `user.email`).
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

To fix formatting: `npm run format`.

## Submitting changes

- **Pull requests:** Open a PR against `main`. Describe what changed and how you tested it.
- **Bug reports and ideas:** Use [GitHub Issues](https://github.com/toddmedema/opensprint/issues).

Maintainers will review and merge when ready. By contributing, you agree that your contributions are licensed under the project’s [AGPL-3.0 license](LICENSE).

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
