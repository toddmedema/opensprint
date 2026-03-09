# Open Sprint

[Open Sprint](https://opensprint.ai/) guides a software project from idea to shipped code using AI agents across Sketch, Plan, Execute, Evaluate, and Deliver.

_Plan like a Product Manager. Ship at the speed of thought._

## Quick Start

### Mac/Linux

Prerequisites:

- [Git](https://git-scm.com/install/)
- [Node.js 20+](https://nodejs.org/en/download)

```bash
git clone https://github.com/toddmedema/opensprint.git
cd opensprint
npm run setup
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) and get building!

### Database

OpenSprint uses **SQLite** by default (stored in `~/.opensprint/data/opensprint.sqlite`). No database setup required. To use **PostgreSQL** instead, go to **Settings** in the app and enter your PostgreSQL URL, or see [Upgrading to PostgreSQL](#upgrading-to-postgresql).

### Windows

You will need to install [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) with Node.js: open PowerShell as admin, run `wsl --install`, reboot, then open the WSL application and [install Node.js 20+](https://stackoverflow.com/a/75739322). OpenSprint uses SQLite by default in WSL; for PostgreSQL, install it in WSL and set `databaseUrl` in Settings.

Then, from the default ~ directory, run:

```bash
git clone https://github.com/toddmedema/opensprint.git
cd opensprint
npm run setup
npm run dev
```

_Native Windows Node, PowerShell, and `cmd.exe` execution are unsupported because the orchestration and process-management stack assumes Linux/Unix process behavior. Do not run OpenSprint from `/mnt/c/...` or any other Windows-mounted filesystem._

### Upgrading to PostgreSQL

If you started with SQLite and want to switch to PostgreSQL:

1. **In the app:** Open **Settings**, use **Upgrade to PostgreSQL** to enter your Postgres URL, migrate data, and switch in one step.
2. **Manually:** Set `databaseUrl` in `~/.opensprint/global-settings.json` to your PostgreSQL URL (e.g. `postgresql://user:password@localhost:5432/opensprint`), run **Set up tables** in Settings if needed, then restart the app.

To install and prepare a local PostgreSQL during setup, run `USE_POSTGRES=1 npm run setup`.

### PostgreSQL Setup FAQ

- If you already have PostgreSQL running, OpenSprint expects a local role `opensprint` with password `opensprint` and a local database named `opensprint`.
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

## Contributing

1. Fork the repo and create a branch.
2. Make changes and add tests.
3. Run `npm run test`.
4. Open a pull request.

Bug reports: [GitHub Issues](https://github.com/toddmedema/opensprint/issues)

### Project Structure

Open Sprint is a monorepo with three main packages:

- `packages/backend`: Node.js + TypeScript API and orchestrator
- `packages/frontend`: React + TypeScript web app
- `packages/shared`: shared types and constants
- `packages/electron`: Electron desktop shell (spawns backend, serves frontend in one window)

The product spec for Open Sprint lives in `PRD.md`. Each project's Sketch output is written to `SPEC.md` at the project repo root.

### Developing On Open Sprint

If you are using Open Sprint to work on Open Sprint itself, use two clones to avoid restarts and git lock contention:

1. Keep a control clone running `npm run dev`.
2. Create a second clone for agent work.
3. Point the project at the second clone so orchestrated work happens there.

Run `npm run dev` only from the control clone.

### Common Commands

| Command         | What it does                                                             |
| --------------- | ------------------------------------------------------------------------ |
| `npm run setup` | Install dependencies, create default SQLite DB and apply schema (optional: `USE_POSTGRES=1` for PostgreSQL) |
| `npm run dev`   | Start the backend and frontend                                           |
| `npm run test`  | Run the test suite                                                       |
| `npm run build` | Build all packages                                                       |
| `npm run start:desktop` | Run the Electron desktop app (builds once, then opens window)     |
| `npm run build:desktop` | Build installers (e.g. .dmg, .exe, AppImage) to `packages/electron/dist/` |

### Building the desktop app

You can run OpenSprint as a desktop app (Electron) or build installable artifacts.

**Prerequisites:** Same as Quick Start (Node.js 20+). The desktop app uses SQLite by default; config and data live in `~/.opensprint` (see [Database](#database) and [PostgreSQL Setup FAQ](#postgresql-setup-faq)).

- **Run desktop in development:** From the repo root, run `npm run start:desktop`. This builds the app once, then launches Electron. The window loads the backend-served UI at `http://127.0.0.1:3100`. Only one instance runs; relaunching focuses the existing window.
- **Build installers:** Run `npm run build:desktop`. This builds shared, backend, and frontend, prepares a self-contained backend and frontend in `packages/electron/desktop-resources/`, then runs electron-builder. Output goes to `packages/electron/dist/` (e.g. `.dmg` on macOS, `.exe`/installer on Windows, `AppImage` on Linux). The packaged app requires Node.js on the system PATH so the backend process can start.

### Publishing desktop releases

Pushing a version tag (e.g. `v1.0.0`) triggers GitHub Actions to build the Electron app for macOS (DMG), Windows (installer .exe), and Linux (AppImage), and to attach those files to the GitHub Release for that tag. The workflow sets the app version from the tag so the built installers show the correct version.

## License

[AGPL-3.0](LICENSE). Support or partnership: [contact@opensprint.ai](mailto:contact@opensprint.ai).
