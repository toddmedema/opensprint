# Open Sprint

[Open Sprint](https://opensprint.ai/) guides a software project from idea to shipped code using AI agents across Sketch, Plan, Execute, Evaluate, and Deliver.

_Plan like a Product Manager. Ship at the speed of thought._

## Quick Start

### Mac/Linux

Prerequisites:

- [Git](https://git-scm.com/install/)
- [Node.js 20+](https://nodejs.org/en/download)
- [PostgreSQL](https://www.postgresql.org/download/)

```bash
git clone https://github.com/toddmedema/opensprint.git
cd opensprint
npm run setup
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) and get building!

### Windows

You will need to install ([WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)) with Node andd Postgres by opening PowerShell as an admin, running `wsl --install`, rebooting your computer, then running `wsl.exe --install` in PowerShell. Then, open the `WSL` application, [install node.js](https://stackoverflow.com/a/75739322), [install postgres](https://dev.to/sfpear/install-and-use-postgres-in-wsl-423d) and set the default postgres user password to `opensprint`.

Then, from the default ~ directory, run:

```bash
git clone https://github.com/toddmedema/opensprint.git
cd opensprint
npm run setup
npm run dev
```

_Native Windows Node, PowerShell, and `cmd.exe` execution are unsupported because the orchestration and process-management stack assumes Linux/Unix process behavior. Do not run OpenSprint from `/mnt/c/...` or any other Windows-mounted filesystem._

### PostgreSQL Setup FAQ

- If you already have PostgreSQL running, OpenSprint expects a local role `opensprint` with password `opensprint` and a local database named `opensprint`.
- If automatic setup cannot create the role or database, create them manually and rerun `npm run setup`.
- If another PostgreSQL install is already using the default port or conflicts with setup, use that existing local install and create the expected role and database yourself, or update the DATABASE_URL in the web UI settings to point to a different database.

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
| `npm run setup` | Install dependencies, prepare PostgreSQL when possible, and apply schema |
| `npm run dev`   | Start the backend and frontend                                           |
| `npm run test`  | Run the test suite                                                       |
| `npm run build` | Build all packages                                                       |

## License

[AGPL-3.0](LICENSE). Support or partnership: [contact@opensprint.ai](mailto:contact@opensprint.ai).
