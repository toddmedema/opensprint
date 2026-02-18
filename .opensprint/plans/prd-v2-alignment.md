# PRD v2.0 Alignment — SPEED Rename, Deliver Phase, Named Agents

## Overview

Align the OpenSprint codebase with PRD v2.0, which introduces the five-phase **SPEED** workflow (Spec, Plan, Execute, Eval, Deliver), replacing the previous four-phase Dream/Plan/Build/Verify model. This epic covers the global rename, new Deliver phase, named agent roles (9 total), new planning-slot agents (Harmonizer, Summarizer, Auditor, Delta Planner), API/WebSocket renames, cross-epic dependency UX, serialized git commit queue, and various internal alignment items.

## Acceptance Criteria

1. All UI labels, routes, types, and API endpoints use the SPEED phase names (Spec, Plan, Execute, Eval, Deliver).
2. The PRD.md file is updated to v2.0 with all new sections (Deliver phase, named agents, git concurrency, etc.).
3. The Deliver phase has a fully functional UI tab with deploy button, history, live logs, and rollback.
4. All 9 named agent roles are defined in types and used in orchestrator prompts and frontend display.
5. The Harmonizer agent is invoked during Execute! flow and scope-change feedback.
6. The Summarizer agent is invoked when context thresholds are exceeded (>2 deps or >2000-word Plan).
7. Execute! checks for cross-epic dependencies and shows a confirmation modal before auto-queueing prerequisite epics.
8. A serialized git commit queue prevents concurrent git operations on main.
9. Re-execute uses the Auditor + Delta Planner two-agent approach.
10. Blocked tasks use beads `blocked` status; attempt counts use beads labels.

## Technical Approach

The work is sequenced as a strict dependency chain — each task builds on the previous one.

### Task 1: Update PRD.md to v2.0 (60k.2)
Copy the new PRD from ~/Downloads/PRD.md, replacing the existing file. This is the foundation all other tasks reference.

### Task 2: Global phase rename (60k.3)
Rename across the entire stack: `ProjectPhase` type, `ConversationContext`, `PrdChangeLogEntry.source`, `PlanStatus` (done→complete), Navbar tabs, HomeScreen labels, phaseRouting, PRD_SOURCE_COLORS, component filenames (DreamPhase→SpecPhase, BuildPhase→ExecutePhase, VerifyPhase→EvalPhase), Redux slice names, backend route paths, shared schemas and constants. Update all imports and test files.

### Task 3: API endpoint and WebSocket event renames (60k.4)
REST: `/build/status` → `/execute/status`, `/plans/:planId/ship` → `/plans/:planId/execute`, `/plans/:planId/reship` → `/plans/:planId/re-execute`. WebSocket: `build.status` → `execute.status`, `agent.done` → `agent.completed`. Add deploy events. Remove `build.awaiting_approval`. Update all frontend API call sites and backend route handlers.

### Task 4: Action button renames (60k.5)
EpicCard.tsx: "Build It!" → "Execute!", "Rebuild" → "Re-execute". Update PlanPhase.tsx references and all related test files.

### Task 5: New Deliver phase (60k.6)
Backend: deploy routes (POST /deploy, GET /deploy/status, GET /deploy/history, POST /deploy/:deployId/rollback, PUT /deploy/settings). DeploymentRecord storage. WebSocket events. Wire existing DeploymentService. Frontend: DeliverPhase.tsx component, deploySlice.ts, phase routing integration.

### Task 6: Named agent roles (60k.7)
Add `AgentRole` type with all 9 roles. Update AgentConfig terminology. Map roles to Planning/Coding slots. Update orchestrator, ActiveAgentsList, task detail panel.

### Task 7: Harmonizer and Summarizer agents (60k.8)
Harmonizer: prompt template, Execute! integration, scope-change integration. Summarizer: threshold checks, prompt template, context assembly pipeline integration.

### Task 8: Cross-epic dependency confirmation modal (60k.9)
Backend: cross-epic dependency detection. Frontend: confirmation modal with auto-queue of prerequisites in dependency order.

### Task 9: Git commit queue (60k.10)
Async FIFO queue with single worker for all main-branch git ops. Beads auto-commit/auto-flush disabled during bd init. Orchestrator manages beads export explicitly.

### Task 10: Auditor + Delta Planner for re-execute (60k.11)
Replace generic rebuild with two-agent approach. Auditor produces capability summary, Delta Planner produces delta task list.

### Task 11: Minor alignment items (60k.12)
Blocked status (not label), attempt tracking via labels, orchestrator state updates, test_command setting, setup wizard enhancements.

## Dependencies

None — this is a standalone epic.

## Data Model Changes

- `ProjectPhase`: `"dream" | "plan" | "build" | "verify"` → `"spec" | "plan" | "execute" | "eval" | "deliver"`
- `PlanStatus`: `"done"` → `"complete"`
- `ConversationContext`: `"dream"` → `"spec"`
- New `AgentRole` type with 9 values
- New `DeploymentRecord` entity
- New deploy WebSocket events

## API Specification

See PRD v2.0 Sections 11.1 and 11.2 for the full updated API and WebSocket event specifications.

## UI/UX Requirements

- Navbar adds a 5th "Deliver" tab
- Phase route paths update to `/spec`, `/plan`, `/execute`, `/eval`, `/deliver`
- "Build It!" button becomes "Execute!"
- Cross-epic dependency confirmation modal on Execute!
- Deliver tab: deploy button, history list, live log panel, rollback

## Edge Cases and Error Handling

- Backward compatibility: existing projects with `currentPhase: "dream"` need migration or fallback parsing
- Deploy failures: rollback support, error display in deploy history
- Cross-epic confirmation: handle circular dependencies gracefully

## Testing Strategy

- Update all existing tests referencing old phase names
- Add tests for Deliver phase (routes, UI, WebSocket events)
- Add tests for named agent roles in orchestrator
- Add tests for Harmonizer/Summarizer invocation and thresholds
- Add tests for cross-epic dependency detection and confirmation flow
- Add tests for git commit queue serialization

## Estimated Complexity

very_high
