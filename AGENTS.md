# Agent Instructions — OpenSprint

This project uses **bd** (beads) for all task and issue tracking. Run `bd onboard` to get started.

## Project Overview

OpenSprint is a web application that guides users through the full software development lifecycle using AI agents. It has five phases — SPEED: Sketch, Plan, Execute, Evaluate, and Deliver. The PRD is at `PRD.md`.

**Tech stack:** Node.js + TypeScript (backend), React + TypeScript (frontend).

## Beads Quick Reference

**Always use `--no-daemon`** to prevent bd from auto-starting background daemon processes (they leak memory).

```bash
bd --no-daemon ready                          # Find next available work (priority-sorted, all deps resolved)
bd --no-daemon show <id>                      # View issue details and audit trail
bd --no-daemon update <id> --claim            # Atomically claim a task (sets assignee + in_progress)
bd --no-daemon close <id> --reason "..."      # Mark work done
bd --no-daemon create "Title" -t <type> -p <priority>  # Create an issue (types: bug/feature/task/epic/chore)
bd --no-daemon dep add <child> <parent>       # Add dependency (blocks, related, parent-child)
bd --no-daemon list --json                    # List all issues with JSON output
bd --no-daemon sync                           # Sync with git
```

## Task Workflow

1. Run `bd ready` to find the next task to work on
2. Claim the task with `bd update <id> --claim`
3. Create a feature branch: `git checkout -b opensprint/<task-id>`
4. Implement the task, write tests, commit changes
5. Close the task: `bd close <id> --reason "Implemented and tested"`
6. Run `bd sync` after closing

## Issue Hierarchy

Beads supports hierarchical IDs for organizing work:

- `opensprint.dev-xxxx` — Epic (feature-level)
- `opensprint.dev-xxxx.0` — Gating task (plan approval gate)
- `opensprint.dev-xxxx.1` — Task under that epic
- `opensprint.dev-xxxx.1.1` — Sub-task

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST finish ALL steps below. Work is NOT done until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** — Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) — Tests, linters, builds
3. **Update issue status** — Close finished work, update in-progress items
4. **PUSH TO REMOTE** — This is MANDATORY:
   ```bash
   git pull --rebase
   bd --no-daemon sync --import-only   # import any issues pulled from remote
   bd --no-daemon sync                 # export local changes to JSONL
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** — Clear stashes, prune remote branches
6. **Verify** — All changes committed AND pushed
7. **Hand off** — Provide context for next session

**CRITICAL RULES:**

- Work is NOT done until `git push` succeeds
- NEVER stop before pushing — that leaves work stranded locally
- NEVER say "ready to push when you are" — YOU must push
- If push fails, resolve and retry until it succeeds
- Always use `--json` flags when programmatically parsing bd output
