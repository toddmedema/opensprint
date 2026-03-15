# Open Sprint

[Open Sprint](https://opensprint.ai/) is an AI-powered software development lifecycle platform that guides a project from idea to shipped code across Sketch, Plan, Execute, Evaluate, and Deliver.

## Quick Start

### Mac/Linux

Prerequisites:

- [Git](https://git-scm.com/install/)
- [Node.js 24.x](https://nodejs.org/en/download)
- Git identity configured:
  - `git config --global user.name "Your Name"`
  - `git config --global user.email "you@example.com"`

```bash
git clone https://github.com/toddmedema/opensprint.git
cd opensprint
npm run setup
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

Optional faster source setup (skips Electron/Puppeteer workspace installs): `OPENSPRINT_SETUP_MINIMAL=1 npm run setup`

### Database

Open Sprint uses **SQLite by default** and stores data at `~/.opensprint/data/opensprint.sqlite`.
For first run, **no additional database setup is required**.

If you need **higher performance** and **cross-team collaboration**, you can optionally point Open Sprint to a PostgreSQL database:

- In the app: **Settings** -> set `databaseUrl` or use **Upgrade to PostgreSQL**
- In config: set `databaseUrl` in `~/.opensprint/global-settings.json`
- In env: set `DATABASE_URL` (highest precedence)

Database connection precedence is:

1. `DATABASE_URL`
2. `databaseUrl` in `~/.opensprint/global-settings.json`
3. Default SQLite path (`~/.opensprint/data/opensprint.sqlite`)

See [Upgrading to PostgreSQL](#upgrading-to-postgresql) for migration options.

### Windows

You will need to install [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) with Node.js: open PowerShell as admin, run `wsl --install`, reboot, then open the WSL application and [install Node.js 24.x](https://nodejs.org/en/download). Open Sprint uses SQLite by default in WSL; for PostgreSQL, install it in WSL and set `databaseUrl` in Settings.

Then, from the default ~ directory, run:

```bash
git clone https://github.com/toddmedema/opensprint.git
cd opensprint
npm run setup
npm run dev
```

Optional faster source setup (skips Electron/Puppeteer workspace installs): `OPENSPRINT_SETUP_MINIMAL=1 npm run setup`

_Native Windows Node, PowerShell, and `cmd.exe` execution are unsupported because the orchestration and process-management stack assumes Linux/Unix process behavior. Do not run Open Sprint from `/mnt/c/...` or any other Windows-mounted filesystem._

### Upgrading to PostgreSQL

Use this only if SQLite no longer meets your needs (for example, larger workloads or multi-user collaboration).

1. **In the app:** Open **Settings**, use **Upgrade to PostgreSQL** to enter your Postgres URL, migrate data, and switch in one step.
2. **Manually:** Set `databaseUrl` in `~/.opensprint/global-settings.json` to your PostgreSQL URL (for example, `postgresql://user:password@localhost:5432/opensprint`), run **Set up tables** in Settings if needed, then restart the app.

To install and prepare a local PostgreSQL during setup, run `USE_POSTGRES=1 npm run setup`.

### PostgreSQL Setup FAQ

Only needed if you are using PostgreSQL.

- If you already have PostgreSQL running, Open Sprint expects a local role `opensprint` with password `opensprint` and a local database named `opensprint`.
- If automatic setup cannot create the role or database, create them manually and rerun `USE_POSTGRES=1 npm run setup`.
- If another PostgreSQL install is already using the default port or conflicts with setup, use that existing local install and create the expected role and database yourself, or update the database URL in Settings to point to a different database.

## How Open Sprint Works

Open Sprint uses the SPEED Product Management lifecycle:

- **Sketch**: turn an idea into a clear product spec
- **Plan**: break the spec into epics, tasks, and dependencies
- **Execute**: AI agents implement the work
- **Evaluate**: review results and feed changes back into planning
- **Deliver**: ship working software

Specialized agents handle planning, implementation, review, and handoff so the project keeps moving without manual orchestration at every step.

## Architecture at a Glance

Open Sprint is a monorepo with four main packages:

- `packages/backend`: Node.js + TypeScript API and orchestrator
- `packages/frontend`: React + TypeScript web app
- `packages/shared`: shared types and constants
- `packages/electron`: Electron desktop shell (spawns backend, serves frontend in one window)

The product spec for Open Sprint lives in `PRD.md`. Each project's Sketch output is written to `SPEC.md` at the project repo root.

## Common Commands

| Command                                    | What it does                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `npm run setup`                            | Install dependencies, create default SQLite DB, and apply schema (optional: `USE_POSTGRES=1`)                  |
| `OPENSPRINT_SETUP_MINIMAL=1 npm run setup` | Install only shared/backend/frontend deps for source development (skips Electron/Puppeteer workspace installs) |
| `npm run dev`                              | Start the backend and frontend                                                                                 |
| `npm run test`                             | Run the test suite                                                                                             |
| `npm run lint`                             | Run lint checks across workspaces                                                                              |
| `npm run build`                            | Build all packages                                                                                             |
| `npm run start:desktop`                    | Run the Electron desktop app (builds once, then opens a window)                                                |
| `npm run build:desktop`                    | Build installers (for example, `.dmg`, `.exe`, `AppImage`) to `packages/electron/dist/`                        |

## Troubleshooting

### "The coding agent stopped without reporting whether the task succeeded or failed." (no_result)

This means the **coding agent process** (for example, Cursor CLI) exited before writing `.opensprint/active/<taskId>/result.json`. The orchestrator only considers a run successful when it can read that file, so if the process crashes or exits early, you get `no_result`.

**Typical causes:**

1. **API or auth**: Cursor/API key missing, invalid, or rate-limited. The agent may exit with code 1 as soon as it tries to call the API.
2. **Model config**: wrong or unsupported model name. Some backends return errors like "not a chat model" and the CLI exits 1.
3. **Process crash**: the agent CLI crashes before the model responds.

**What to do:**

- In **Settings**, check the AI provider and model. For Cursor, ensure the Cursor agent CLI is installed and `CURSOR_API_KEY` (or your key source) is set.
- For the failing task, open the **agent output log** at `.opensprint/active/<taskId>/agent-output.log` under the project worktree path (for example, `opensprint-worktrees/<taskId>/`).
- If you see API or auth errors, fix the key/model and retry. The task will be requeued; after repeated failures it may be blocked to prevent looped failures.

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for setup, quality checks, submitting pull requests, and the two-clone workflow when developing on this repo with Open Sprint.

## Building the Desktop App

You can run Open Sprint as a desktop app (Electron) or build installable artifacts.

**Prerequisites:** Same as Quick Start (Node.js 24.x). The desktop app uses SQLite by default; config and data live in `~/.opensprint` (see [Database](#database) and [PostgreSQL Setup FAQ](#postgresql-setup-faq)).

**Linux runtime prerequisites (Electron):** Install common desktop libs before running `npm run start:desktop` or launching the Linux AppImage (for example on Ubuntu/Debian: `sudo apt-get install -y libgtk-3-0 libnss3 libasound2 libxss1 libxtst6 libatspi2.0-0 libsecret-1-0 libnotify4 libcups2 libgbm1`).  
For AppImage specifically, install FUSE2 (`libfuse2`) or AppImage may fail to launch.

- **Run desktop in development:** From the repo root, run `npm run start:desktop`. This builds the app once, then launches Electron. The window loads the backend-served UI at `http://127.0.0.1:3100`. Only one instance runs; relaunching focuses the existing window.
- **Build installers:** Run `npm run build:desktop`. This builds shared, backend, and frontend, prepares a self-contained backend and frontend in `packages/electron/desktop-resources/`, then runs electron-builder. Output goes to `packages/electron/dist/` (for example, `.dmg` on macOS, `.exe` installer on Windows, `AppImage` on Linux). The packaged app runs the backend with Electron's embedded Node runtime.

## Publishing Desktop Releases

Pushing a version tag (for example, `v1.0.0`) triggers GitHub Actions to build the Electron app for macOS (DMG), Windows (installer `.exe`), and Linux (AppImage), and to attach those files to the GitHub Release for that tag. The workflow sets the app version from the tag so the built installers show the correct version.

## License

[AGPL-3.0](LICENSE). Support or partnership: [contact@opensprint.ai](mailto:contact@opensprint.ai).
