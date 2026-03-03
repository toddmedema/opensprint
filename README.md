# Open Sprint

[Open Sprint](https://opensprint.ai/) guides a software project from idea to shipped code using AI agents across Sketch, Plan, Execute, Evaluate, and Deliver.

_Plan like a Product Manager. Ship at the speed of thought._

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL

### Windows Support

OpenSprint is supported on Windows only through WSL2.

- Install WSL2.
- Open a WSL terminal.
- Clone OpenSprint into your Linux home directory, for example `/home/<user>/src/opensprint`.
- Do not run OpenSprint from `/mnt/c/...` or any other Windows-mounted filesystem.
- Run `npm run setup` and `npm run dev` inside WSL.

Native Windows Node, PowerShell, and `cmd.exe` execution are unsupported because the orchestration and process-management stack assumes Linux/Unix process behavior.

### Start Open Sprint

```bash
git clone https://github.com/toddmedema/opensprint.dev.git
cd opensprint.dev
npm run setup
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173). If the browser does not open automatically, navigate there manually.

- `npm run setup` installs dependencies, prepares local PostgreSQL when possible, and applies the database schema.
- `npm run dev` starts the backend and frontend for local development.

## If PostgreSQL Setup Fails

If you already have PostgreSQL running, OpenSprint expects a local role `opensprint` with password `opensprint` and a local database named `opensprint`.

- If automatic setup cannot create the role or database, create them manually and rerun `npm run setup`.
- If another PostgreSQL install is already using the default port or conflicts with setup, use that existing local install and create the expected role and database yourself.
- On WSL, `npm run setup` does not try to install or start PostgreSQL for you. Make sure one of these is already reachable from WSL before running setup:
  - PostgreSQL inside the WSL distro on `localhost:5432`
  - PostgreSQL exposed to WSL `localhost` from Docker Desktop or another local service
  - A remote database configured through `DATABASE_URL` or `~/.opensprint/global-settings.json`
- `opensprint_test` is only needed for running tests, not for first launch.

## After Open Sprint Starts

Once the app is running:

- Open Settings in the web UI.
- Add your AI provider API key there.
- If you want to use a different database later, update the database connection in Settings.

## Common Commands

| Command         | What it does                                                             |
| --------------- | ------------------------------------------------------------------------ |
| `npm run setup` | Install dependencies, prepare PostgreSQL when possible, and apply schema |
| `npm run dev`   | Start the backend and frontend                                           |
| `npm run test`  | Run the test suite                                                       |
| `npm run build` | Build all packages                                                       |

## How Open Sprint Works

Open Sprint uses the SPEED lifecycle:

- **Sketch**: turn an idea into a clear product spec
- **Plan**: break the spec into epics, tasks, and dependencies
- **Execute**: AI agents implement the work
- **Evaluate**: review results and feed changes back into planning
- **Deliver**: ship working software

Specialized agents handle planning, implementation, review, and handoff so the project keeps moving without manual orchestration at every step.

## Project Structure

Open Sprint is a monorepo with three main packages:

- `packages/backend`: Node.js + TypeScript API and orchestrator
- `packages/frontend`: React + TypeScript web app
- `packages/shared`: shared types and constants

The product spec for Open Sprint lives in `PRD.md`. Each project's Sketch output is written to `SPEC.md` at the project repo root.

## Advanced: Developing On Open Sprint

If you are using Open Sprint to work on Open Sprint itself, use two clones to avoid restarts and git lock contention:

1. Keep a control clone running `npm run dev`.
2. Create a second clone for agent work.
3. Point the project at the second clone so orchestrated work happens there.

Run `npm run dev` only from the control clone.

## Contributing

1. Fork the repo and create a branch.
2. Make changes and add tests.
3. Run `npm run test`.
4. Open a pull request.

Bug reports: [GitHub Issues](https://github.com/toddmedema/opensprint/issues)

## License

[AGPL-3.0](LICENSE). Support or partnership: [contact@opensprint.dev](mailto:contact@opensprint.dev).
