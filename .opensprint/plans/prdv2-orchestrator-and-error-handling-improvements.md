# PRDv2 — Orchestrator and Error Handling Improvements

## Overview

Implement the changes from PRD v1.7 to v1.8 (PRDv2.md). The improvements center on: (1) an always-on orchestrator with no manual start/pause, (2) orchestrator state persistence and crash recovery, (3) a 5-minute watchdog timer, (4) stricter trust boundaries (agents propose, orchestrator executes), (5) progressive backoff error handling replacing fixed retries and HIL escalation, and (6) a new Blocked task state for persistently failing tasks.

## Acceptance Criteria

- [ ] Orchestrator starts automatically when backend starts; no manual start/pause
- [ ] `POST /projects/:id/build/start` and `POST /projects/:id/build/pause` removed
- [ ] Orchestrator state persisted to `.opensprint/orchestrator-state.json` (gitignored)
- [ ] On startup: if active task recorded but agent PID dead, auto-recover (revert, re-queue, resume)
- [ ] 5-minute watchdog polls for eligible tasks and kicks off agent if none running; terminates stuck agents
- [ ] Plan phase: planning agent outputs structured task list; orchestrator executes all `bd create` and `bd dep add`
- [ ] Verify phase: planning agent outputs structured feedback mapping; orchestrator executes all `bd create` and `bd dep add`
- [ ] PRD updates: planning agent proposes; orchestrator applies to `prd.json` and commits
- [ ] Progressive backoff: deprioritize every 3 failed attempts; block at priority 4 after 3 failures
- [ ] Blocked state: `blocked` label on bead; task excluded from `bd ready`; `task.blocked` WebSocket event
- [ ] HIL config: "Test Failures & Retries" category removed (3 categories total)
- [ ] Build tab: Blocked column on kanban; user can unblock
- [ ] API: `reship` renamed to `rebuild`; `build.status` payload updated

## Technical Approach

### 1. Orchestrator Lifecycle

- Remove build start/pause API endpoints and any UI controls that trigger them
- On backend startup, immediately begin the orchestrator event loop
- Orchestrator runs continuously; no user action required to "pick up work"

### 2. Orchestrator State Persistence

- Create `.opensprint/orchestrator-state.json` with schema:
  - `active_task`: `{ task_id, phase, agent_pid, branch, started_at, last_output_at, attempt }`
  - `last_watchdog_run`: ISO timestamp
  - `pending_feedback_categorizations`: array
- Write state atomically on every transition (e.g., write to temp file, then rename)
- Add `.opensprint/orchestrator-state.json` to `.gitignore`

### 3. Startup Recovery

On backend start, read `orchestrator-state.json`:

1. **No active task:** Start normal loop and watchdog
2. **Active task, PID alive:** Resume monitoring existing agent process
3. **Active task, PID dead:** Revert partial git changes, add failure comment to bead, set task status to `open`, clear active task, resume loop

### 4. Watchdog Timer

- Run a timer every 5 minutes
- On each tick: call `bd ready --json`; if tasks available and no agent running, start next agent
- If agent has produced no output for 5 minutes, terminate and run error recovery (same as coding agent failure)
- Update `last_watchdog_run` in state file

### 5. Trust Boundary — Plan Phase

- Planning agent returns JSON: `{ tasks: [{ index, title, description, depends_on: [index, ...] }] }`
- Orchestrator: create tasks in order, build `index → beads ID` map, run `bd dep add` with resolved IDs
- Agent never invokes `bd` directly

### 6. Trust Boundary — Verify Phase

- Planning agent returns: `{ category, mapped_plan_id, proposed_tasks: [{ title, description, priority, dependencies }] }`
- Orchestrator runs `bd create` and `bd dep add` for each proposed task

### 7. Trust Boundary — PRD Updates

- Planning agent returns: `{ section_updates: [{ section, content, change_log_entry }] }`
- Orchestrator writes to `prd.json`, increments versions, appends to change_log, commits

### 8. Progressive Backoff

- Single cumulative attempt counter per task (coding failures + review rejections)
- **Odd attempts (1st, 3rd, 5th):** Immediate retry with failure context
- **Even attempts (2nd, 4th, 6th):** Requeue; before requeue, apply backoff:
  - Every 3 total failed attempts: `bd update <id> -p <priority+1>` (deprioritize)
  - After 3 failures at priority 4: add `blocked` label, send `task.blocked`, exclude from `bd ready`
- No user escalation; flywheel continues

### 9. Blocked State

- Blocked = `status: open` + `blocked` label
- Beads `bd ready` must exclude tasks with `blocked` label (or filter in orchestrator)
- Kanban: add Blocked column; tasks with `blocked` label appear there
- User action: remove `blocked` label (and optionally reset attempt count) to unblock
- WebSocket: `task.blocked` event with `{ taskId, totalAttempts, lastFailureReason }`

### 10. HIL Configuration

- Remove "Test Failures & Retries" from HIL decision categories
- Keep: Scope Changes, Architecture Decisions, Dependency Modifications
- Document that test/agent errors are always handled automatically

### 11. Build it! Scripted Sequence

Ensure "Build it!" executes in order:

1. `bd close <gate-id> --reason "Plan built"`
2. Update Plan metadata `shipped_at`
3. Invoke planning agent for PRD update proposals
4. Apply proposals to `prd.json`
5. Commit PRD changes
6. Tasks become available; orchestrator picks up automatically

### 12. API and WebSocket Changes

- Remove: `POST /projects/:id/build/start`, `POST /projects/:id/build/pause`
- Rename: `POST /projects/:id/plans/:planId/reship` → `POST /projects/:id/plans/:planId/rebuild`
- `build.status` payload: `{ currentTask, queueDepth }` (remove `running` if present)
- Add: `task.blocked` WebSocket event

## Dependencies

- Build orchestrator (context assembly, agent lifecycle)
- Beads CLI integration
- Plan phase feature decomposition
- Verify phase feedback submission and mapping
- WebSocket relay

## Data Model Changes

- New file: `.opensprint/orchestrator-state.json` (gitignored)
- Beads: use `blocked` label; no schema change
- HIL config: reduce from 4 to 3 categories in settings schema

## API Specification

| Change       | Before                           | After                            |
| ------------ | -------------------------------- | -------------------------------- |
| Build start  | `POST /projects/:id/build/start` | Removed                          |
| Build pause  | `POST /projects/:id/build/pause` | Removed                          |
| Plan re-ship | `POST .../plans/:planId/reship`  | `POST .../plans/:planId/rebuild` |
| WebSocket    | —                                | `task.blocked` event             |

## UI/UX Requirements

- Build tab: remove Start/Pause controls; show status only
- Build tab: add Blocked column to kanban; blocked tasks visually distinct
- Blocked tasks: affordance to unblock (remove label, optionally reset attempts)
- HIL settings: remove "Test Failures & Retries" category and its options

## Edge Cases and Error Handling

- **Orchestrator crash mid-task:** On restart, detect PID dead, revert, re-queue, resume
- **Watchdog and event both fire:** Ensure only one agent starts; use mutex/lock in orchestrator
- **Beads `bd ready` returns blocked task:** Filter blocked tasks in orchestrator before assigning
- **User unblocks task:** Remove `blocked` label; task re-enters `bd ready` on next poll

## Testing Strategy

- Unit tests: orchestrator state read/write, recovery logic, progressive backoff logic
- Integration tests: startup recovery (mock dead PID), watchdog triggers agent
- E2E: Build tab shows no start/pause; blocked task appears in Blocked column; unblock flow

## Estimated Complexity

**High** — touches orchestrator core, error handling, Plan/Verify agent contracts, API, and UI.