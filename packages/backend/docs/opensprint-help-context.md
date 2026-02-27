# OpenSprint Internal Documentation

This document provides context for the Help Chat agent to answer questions about OpenSprint's scheduling, configuration, orchestrator logic, and task runnability.

---

## Agent Instructions (AGENTS.md)

Task tracking is handled internally by `TaskStoreService` backed by an embedded sql.js database at `~/.opensprint/tasks.db`. There is no external CLI for task management.

**Project Overview:** OpenSprint is a web application that guides users through the full software development lifecycle using AI agents. It has five phases — SPEED: Sketch, Plan, Execute, Evaluate, and Deliver.

**Tech stack:** Node.js + TypeScript (backend), React + TypeScript (frontend).

### Orchestrator Recovery (GUPP-style)

Work state is persisted before agent spawn via `assignment.json` in `.opensprint/active/<task-id>/`. If the backend crashes, recovery reads the assignment and re-spawns the agent — no work is lost. **Always write assignment before spawn; never spawn then write.**

### Loop Kicker vs Watchdog

- **Loop kicker** (60s): Restarts the orchestrator loop when idle. Runs inside the orchestrator.
- **Watchdog** (5 min): Witness-style health patrol — stale heartbeats, orphaned tasks, stale `.git/index.lock`. Runs in a separate `WatchdogService`.

### Task Store

Tasks are stored in `~/.opensprint/tasks.db` (SQLite via sql.js WASM). The `TaskStoreService` provides:

- `create()` / `createMany()` — Create tasks with optional parent IDs
- `update()` / `updateMany()` — Update task fields (status, assignee, priority, etc.)
- `close()` / `closeMany()` — Close tasks with a reason
- `show()` — Get a single task by ID
- `listAll()` — List all tasks
- `ready()` — Get priority-sorted tasks with all blockers resolved
- `addDependency()` — Add dependency between tasks (blocks, parent-child, etc.)

### Task ID Format

- `os-xxxx` — Top-level task (random hex)
- `os-xxxx.1` — Child task under parent
- `os-xxxx.1.1` — Sub-task

### Epic Status and Task Runnability

- Epics can be `blocked` (plan not approved), `open` (approved), or `closed` (complete).
- When an epic has `status: "blocked"`, all its child tasks are **excluded from `ready()`** and show "Planning" in the kanban.
- When the user clicks "Execute!", the orchestrator sets the epic to `status: "open"` via `TaskStoreService.update`, making child tasks eligible for execution.
- Tasks in `ready()` must have: status=open, not an epic, and all `blocks` dependencies closed. Tasks whose epic is blocked are excluded.

---

## Glossary (docs/glossary.md)

| Term | Definition |
|------|------------|
| **Worktree** | Git worktree for a task at `.opensprint/worktrees/<task-id>/`. Survives backend restarts. |
| **Assignment** | `assignment.json` in `.opensprint/active/<task-id>/` — everything an agent needs to self-start. Enables GUPP-style crash recovery. |
| **Nudge** | Event that triggers the orchestrator loop (agent done, feedback submitted, Execute! clicked, or loop kicker tick). |
| **Loop kicker** | 60s timer that nudges when the orchestrator loop is idle. Runs inside the orchestrator. |
| **Watchdog** | 5-min health patrol (stale heartbeats, orphaned tasks, stale `.git/index.lock`). Runs in a separate `WatchdogService`. |
| **Progressive backoff** | Deprioritize then block tasks after repeated failures. |

---

## Orchestrator and Scheduling (PRD §5)

### Architecture

- **One orchestrator per project**, always running. When the backend starts, it launches an orchestrator for each registered project.
- **Single-agent constraint (v1):** Each project runs one Coder or Reviewer at a time. Other agents (Dreamer, Planner, Harmonizer, Analyst, Summarizer, Auditor) can run concurrently.
- **Event-driven with watchdog:** The orchestrator triggers agents on events. A watchdog runs every 5 minutes to catch edge cases: queries `ready()`, checks for running Coder/Reviewer, starts one if tasks are waiting, terminates agents inactive for 10 minutes.

### Task Store and ready()

- `TaskStoreService.ready()` — finds tasks with no open blockers, sorted by priority. This is the execution queue.
- Tasks excluded from `ready()`: epics, tasks with `status: "blocked"`, tasks whose epic has `status: "blocked"`, tasks with unresolved `blocks` dependencies.
- `assignee` field — the orchestrator uses `TaskStoreService.update(id, { assignee: 'agent-<id>' })` to track which agent is working on a task.

### Parallel Coders (maxConcurrentCoders)

When `maxConcurrentCoders > 1,` the **TaskScheduler** selects tasks for parallel execution:

1. **File Scope Analyzer** — predicts which files a task will touch (from Plan annotations, dependency diffs, or heuristics).
2. **Conflict-Aware Scheduler** — selects up to `maxSlots` non-overlapping tasks from the ready queue.

**Why only one coder might be active:** Even with `maxConcurrentCoders > 1`, the scheduler skips tasks whose predicted file scope would overlap with files already being modified by another active agent. If all ready tasks overlap with the active task, only one coder runs.

**Other reasons for one agent:** `maxConcurrentCoders` may be 1 (default in branches mode); `gitWorkingMode: "branches"` forces `maxConcurrentCoders` to 1; only one task may be ready.

---

## Configuration

- **Agent config:** Project Settings → Agent Config. Planning Agent Slot (Dreamer, Planner, etc.) and Coding Agent Slot (Coder, Reviewer) are configured separately.
- **maxConcurrentCoders:** Project settings. Default 1. When > 1, parallel coders can run if no file overlap.
- **gitWorkingMode:** "worktree" (default) or "branches". Branches mode forces `maxConcurrentCoders` to 1.
