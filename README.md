# Open Sprint

**AI-powered software development from Sketch to Delivery.** Like having a Product Manager in your pocket.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<p align="center">
  <img src="docs/assets/hero-demo.gif" alt="Open Sprint — Sketch, Plan, Execute, Evaluate, Deliver" width="800" />
</p>

Open Sprint guides teams from idea to shipped software through the **SPEED** lifecycle: **S**ketch (define the idea), **P**lan (break into tasks), **E**xecute (AI agents implement), **E**valuate (review and iterate), **D**eliver (ship to production). A team of nine specialized agents handles orchestration so you focus on _what_ to build; the AI handles _how_.

[**Demo**](https://demo.opensprint.dev/) · [**Get started**](#quick-start)

## Why Open Sprint

Traditional AI development is broken. Open Sprint fixes it.

| Instead of…                                                  | Open Sprint                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| **Fragmented AI tools** — lots of setup, no single workflow  | One unified workflow for planning and execution             |
| **No feedback loop** — the AI keeps building the wrong thing | SPEED keeps feedback continuous and tied to project context |
| **Manual orchestration** — hand-prompting every agent        | Your agent team automates coordination and handoffs         |

## Who is this for

- **Product managers & founders** — One workflow from idea to shipped product; keep feedback and context in one place; turn ideas into clear PRDs and plans.
- **Engineering leads & dev teams** — AI handles execution and handoffs; scope and PRD stay intact; agents work in sequence and own coordination.
- **Indie hackers & solo builders** — SPEED from sketch to ship; feedback loop on real usage; full agent team without hiring.

## Quick Start

**Mac:** Install [Node.js](https://nodejs.org/) ≥20 (e.g. `brew install node`), then:

```bash
git clone https://github.com/toddmedema/opensprint.dev.git
cd opensprint.dev
npm run setup       # installs deps, PostgreSQL (if needed), creates user/database; writes default databaseUrl
npm run dev
```

Then open **http://localhost:5173**. On Mac, setup is that simple — one `npm run setup` can install PostgreSQL via Homebrew and create the `opensprint` user and database.

**Windows / Linux:** Same steps (`npm run setup` then `npm run dev`). On Linux, setup installs PostgreSQL via apt or yum/dnf and creates the user and database. On Windows, install [PostgreSQL](https://www.postgresql.org/download/windows/) yourself (or use Chocolatey: `choco install postgresql`), create user `opensprint` with password `opensprint` and database `opensprint`, or use a remote Postgres and set `databaseUrl` in `~/.opensprint/global-settings.json`.

#### What `npm run setup` does (all platforms)

- Installs npm dependencies and ensures `~/.opensprint` exists with a default `databaseUrl`.
- **Mac:** Installs PostgreSQL via Homebrew (`brew install postgresql@16` or `postgresql`), starts the service, creates role `opensprint` with password `opensprint` and database `opensprint`.
- **Linux:** Installs PostgreSQL via apt or yum/dnf, starts the service, creates the same user and database.
- **Windows:** Prints instructions to install PostgreSQL and create the user/database manually, or use a remote `databaseUrl`.
- Applies the database schema so the backend can start without errors.

**`npm run dev`** ensures local PostgreSQL is running (starts the service on Mac/Linux if needed), then starts the backend and frontend.

### Integrations (BYO-AI)

Use your preferred AI — **Claude**, **Cursor**, **OpenAI**, or a **custom CLI**. Open Sprint orchestrates the workflow. Set `ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, or `OPENAI_API_KEY` (see [Environment variables](#environment-variables)); for custom providers, see the repo for CLI integration.

## SPEED lifecycle

```mermaid
flowchart LR
    A["🌙 Sketch"] -->|PRD| B["📋 Plan"]
    B -->|Epics & Tasks| C["🔨 Execute"]
    C -->|Working Code| D["✅ Evaluate"]
    D -->|Feedback| B

    style A fill:#3B82F6,color:#fff
    style B fill:#8B5CF6,color:#fff
    style C fill:#F59E0B,color:#fff
    style D fill:#10B981,color:#fff
```

| Phase        | What happens                                                |
| ------------ | ----------------------------------------------------------- |
| **Sketch**   | Define the idea and capture requirements → PRD              |
| **Plan**     | Break the idea into epics, tasks, and a dependency graph    |
| **Execute**  | AI agents implement the planned work (code + review cycles) |
| **Evaluate** | Review outputs and iterate based on feedback                |
| **Deliver**  | Ship to production and deploy                               |

### Agent team

Nine specialized agents guide you through SPEED:

|                                                                                                 | Agent          | Role                                                                             |
| ----------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| <img src="packages/frontend/public/agent-icons/dreamer.svg" width="48" height="48" alt="" />    | **Dreamer**    | Refines your idea into a PRD; asks the hard questions before the journey begins. |
| <img src="packages/frontend/public/agent-icons/planner.svg" width="48" height="48" alt="" />    | **Planner**    | Decomposes the PRD into epics, tasks, and dependency graph.                      |
| <img src="packages/frontend/public/agent-icons/harmonizer.svg" width="48" height="48" alt="" /> | **Harmonizer** | Keeps the PRD true as implementation forces compromises.                         |
| <img src="packages/frontend/public/agent-icons/analyst.svg" width="48" height="48" alt="" />    | **Analyst**    | Categorizes feedback and maps it to the right epic.                              |
| <img src="packages/frontend/public/agent-icons/summarizer.svg" width="48" height="48" alt="" /> | **Summarizer** | Distills context to exactly what the Coder needs.                                |
| <img src="packages/frontend/public/agent-icons/auditor.svg" width="48" height="48" alt="" />    | **Auditor**    | Surveys what's actually built and what still needs doing.                        |
| <img src="packages/frontend/public/agent-icons/coder.svg" width="48" height="48" alt="" />      | **Coder**      | Implements tasks and ships working code with tests.                              |
| <img src="packages/frontend/public/agent-icons/reviewer.svg" width="48" height="48" alt="" />   | **Reviewer**   | Validates implementation against acceptance criteria.                            |
| <img src="packages/frontend/public/agent-icons/merger.svg" width="48" height="48" alt="" />     | **Merger**     | Resolves rebase conflicts and keeps the journey moving.                          |

## Open Sprint vs Gas Town

[Gas Town](https://github.com/steveyegge/gastown) pioneered the AI orchestrator idea. Open Sprint levels it up:

- **Gas Town:** No built-in product workflow; manual tracking; terminal-based, text-only prompts.
- **Open Sprint:** Cohesive system from idea to shipped product; track status, attach screenshots, reply inline; brainstorm in a Google Docs–like interface; web-first workflow that rivals Jira.

_Build at the speed of a full open sprint._

## Project structure

```
opensprint.dev/
├── packages/
│   ├── backend/   # Node.js + Express API (TypeScript)
│   ├── frontend/  # React + Vite (TypeScript, Tailwind)
│   └── shared/    # Shared types and constants
├── PRD.md          # OpenSprint product requirements
├── SPEC.md         # Sketch phase output (per-project, at repo root)
└── package.json   # npm workspaces
```

**Task store:** PostgreSQL at `~/.opensprint` (or configured `databaseUrl` in `~/.opensprint/global-settings.json`). See [AGENTS.md](AGENTS.md) for orchestrator and task workflow.

### Scripts (from repo root)

| Command         | Description                                      |
| --------------- | ------------------------------------------------ |
| `npm run setup` | Install deps, PostgreSQL (if needed), create user/DB, apply schema (idempotent) |
| `npm run dev`   | Ensure Postgres is running, then start backend + frontend |
| `npm run build` | Build all packages (shared → backend → frontend) |
| `npm run test`  | Run tests                                        |
| `npm run lint`  | Lint all packages                                |
| `npm run clean` | Remove build artifacts and node_modules          |

### Tech stack

**Backend:** Node.js, Express, WebSocket (ws), TypeScript, Vitest · **Frontend:** React 19, React Router, Vite, Tailwind, TypeScript · **Task store:** PostgreSQL (node-postgres) at `~/.opensprint` or configured URL in `~/.opensprint/global-settings.json`

### PostgreSQL

OpenSprint uses PostgreSQL. **`npm run setup`** installs PostgreSQL locally (Homebrew on Mac, apt/yum on Linux), starts the service, and creates:

- **User:** `opensprint`
- **Password:** `opensprint`
- **Database:** `opensprint`
- **Port:** 5432 (default)

Connection URL: `postgresql://opensprint:opensprint@localhost:5432/opensprint`

To use a remote database (e.g. Supabase), set **`DATABASE_URL`** (env) or **`databaseUrl`** in `~/.opensprint/global-settings.json`. `DATABASE_URL` takes precedence for 12-factor deploys. To stop local Postgres on Mac: `brew services stop postgresql@16` (or `postgresql`). On Linux: `sudo systemctl stop postgresql`.

### Environment variables

| Variable                     | Default | Description                                                                                  |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | —       | PostgreSQL connection URL; overrides `databaseUrl` in global settings (12-factor).            |
| `ANTHROPIC_API_KEY`          | —       | Claude integration                                                                           |
| `CURSOR_API_KEY`             | —       | Cursor integration                                                                           |
| `OPENAI_API_KEY`             | —       | OpenAI integration                                                                           |
| `PORT`                       | `3100`  | Backend port                                                                                 |
| `OPENSPRINT_PRESERVE_AGENTS` | unset   | Set to `1` in dev so agent processes survive backend restarts; do **not** set in production. |
| `NODE_ENV`                   | unset   | Optional: set to `test` when running tests; prod should not run test-only logic.             |
| `VITE_API_BASE`             | (empty) | Frontend: API base URL (e.g. empty for same-origin, or full origin for production/staging). |

## Developing on Open Sprint (self-hosting)

Use two clones to avoid contention: a **control clone** (runs `npm run dev`) and a **dev clone** (where agents make changes). Prevents restarts when agents commit and avoids git lock contention.

1. Clone a second copy: `git clone <origin> ~/opensprint-dev && cd ~/opensprint-dev && npm run setup`
2. Copy state: `cp -r /path/to/control/.opensprint ~/opensprint-dev/` and copy `.env`
3. Point the project at the dev clone: `curl -X PUT http://localhost:3100/api/v1/projects/<ID> -H 'Content-Type: application/json' -d '{"repoPath":"/Users/you/opensprint-dev"}'` (or edit `~/.opensprint/projects.json`)

Run `npm run dev` only from the control clone; orchestrator uses worktrees from the dev clone.

## Contributing

1. Fork, create a branch (`git checkout -b my-feature`), make changes and add tests.
2. Run `npm test`, then open a pull request.

Bug reports: [GitHub Issues](https://github.com/toddmedema/opensprint/issues) with steps to reproduce, expected vs actual behavior, and environment (OS, Node, browser).

## License & contact

[AGPL-3.0](LICENSE). Support or partnership: [contact@opensprint.dev](mailto:contact@opensprint.dev).
