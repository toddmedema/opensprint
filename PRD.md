# OpenSprint — Product Requirements Document

**Version:** 2.1
**Date:** February 17, 2026
**Status:** Draft

---

## 1. Executive Summary

OpenSprint is a web application that guides users through the complete software development lifecycle using AI agents. It provides a structured, five-phase workflow — **SPEED**: Sketch, Plan, Execute, Eval, and Deliver — that transforms high-level product ideas into working software with minimal manual intervention.

The platform pairs a browser-based interface with a background agent CLI, enabling AI to autonomously execute development tasks while keeping the user in control of strategy and direction. The core philosophy is that humans should focus on _what_ to build and _why_, while AI handles _how_ to build it.

OpenSprint supports multiple agent backends (Claude, Cursor, and custom CLI agents), comprehensive automated testing including end-to-end and integration tests, configurable human-in-the-loop thresholds, and full offline operation for users with local agent setups.

---

## 2. Problem Statement

Building software with AI today is fragmented and unstructured. Developers use AI coding assistants for individual tasks, but there is no cohesive system that manages the full journey from idea to deployed product. This leads to several persistent problems:

- **Lack of architectural coherence:** AI-generated code often lacks a unified vision because each prompt is handled in isolation, without awareness of the broader system design.
- **No dependency tracking:** When building features in parallel, there is no mechanism to ensure that work on one feature accounts for dependencies on another.
- **Manual orchestration overhead:** Users spend significant time managing prompts, context windows, and task sequencing rather than focusing on product decisions.
- **No feedback loop:** There is no structured way to validate completed work and feed findings back into the development process.

OpenSprint solves these problems by providing an end-to-end platform that maintains context across the entire lifecycle and automates the orchestration of AI development agents.

---

## 3. Goals & Success Metrics

### 3.1 Primary Goals

1. Reduce the time from idea to working prototype by 10x compared to traditional AI-assisted development workflows.
2. Enable non-engineers to ship production-quality software by handling technical complexity behind the scenes.
3. Maintain architectural coherence across an entire project by flowing design decisions through every phase.
4. Create a self-improving development flywheel where validation feedback automatically triggers corrective action.

### 3.2 Success Metrics

| Metric                                | Target                                     | Measurement Method              |
| ------------------------------------- | ------------------------------------------ | ------------------------------- |
| Time from idea to working prototype   | < 1 day for standard web apps              | End-to-end session timing       |
| User intervention rate during Execute | < 10% of tasks require manual input        | Task completion telemetry       |
| Sketch-to-code fidelity               | > 90% alignment with PRD                   | Automated PRD compliance checks |
| Feedback loop closure time            | < 30 min from bug report to fix deployed   | Eval-to-Execute cycle tracking  |
| First-time user task completion       | > 80% complete a full Sketch-Execute cycle  | Onboarding funnel analytics     |
| Test coverage                         | > 80% code coverage with passing E2E tests | Automated coverage reporting    |

---

## 4. User Personas

### 4.1 The Product-Minded Founder

A non-technical founder with a clear product vision who wants to build an MVP without hiring a development team. They understand what they want to build but need AI to handle the engineering. They value speed, clear communication about what is being built, and the ability to provide feedback without writing code.

### 4.2 The Solo Developer

An experienced developer who wants to multiply their output. They can code but want to delegate routine implementation to AI while focusing on architecture and product decisions. They value transparency into what the AI is doing, the ability to intervene when needed, and high-quality code output.

### 4.3 The Agency / Consultancy

A small team that builds software for clients. They need to move quickly from client requirements to working software, maintain multiple projects simultaneously, and provide clients with visibility into progress. They value the structured workflow for client communication and the ability to run multiple projects in parallel.

---

## 5. System Architecture

### 5.1 Architecture Overview

OpenSprint consists of three primary layers: a web-based frontend, a backend API server, and a background agent CLI that executes development work. The frontend communicates with the backend via WebSockets for real-time updates and REST APIs for CRUD operations. The backend orchestrates agent CLI instances, manages project state, and maintains the living PRD.

OpenSprint is designed to run entirely offline. The web frontend and backend API server run locally on the user's machine. When using a local agent CLI (such as a locally-hosted LLM), the entire development loop — from Sketch through Deliver — operates without any internet connectivity. Beads is git-based and inherently offline-compatible with no special synchronization logic required.

### 5.2 Technology Stack

**Backend:** Node.js with TypeScript. This provides a shared language and type system with the React frontend, mature WebSocket support, and robust subprocess management for agent CLIs via `child_process`. Beads is invoked via its CLI (`bd`) using `child_process.exec()` with `--json` flags for structured output.

**Frontend:** React with TypeScript.

### 5.3 Core Components

| Component           | Technology                            | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web Frontend        | React + TypeScript                    | User interface for all five phases; real-time agent monitoring; project management                                                                                                                                                                                                                                                                                                                                                               |
| Backend API         | Node.js + TypeScript                  | Project state management, WebSocket relay, PRD versioning, agent orchestration                                                                                                                                                                                                                                                                                                                                                                   |
| Agent CLI           | Pluggable (Claude, Cursor, Custom)    | Executes development tasks: code generation, testing, debugging                                                                                                                                                                                                                                                                                                                                                                                  |
| Orchestration Layer | Node.js (custom, deterministic)       | Always-on agent lifecycle management (spawn, monitor, timeout), context assembly, Summarizer invocation, retry logic, code review triggering. Owns all critical git and beads operations (worktree, commit, merge, issue creation, state transitions). Serialized git commit queue for main-branch operations (Section 5.9). Event-driven dispatch with 5-minute watchdog. Crash recovery via persistent state. See Sections 5.5, 5.7, 5.8, 5.9. |
| Beads               | Git-based issue tracker (CLI: `bd`)   | Issue storage, dependency tracking (blocks/related/parent-child/discovered-from), ready-work detection and prioritization via `bd ready`, agent assignment via `assignee` field, hierarchical epic/task IDs, provenance via audit trail, JSONL-backed distributed state                                                                                                                                                                          |
| Version Control     | Git                                   | Code repository management, branch-per-task strategy                                                                                                                                                                                                                                                                                                                                                                                             |
| Test Runner         | Configurable (Jest, Playwright, etc.) | Automated test execution and coverage reporting                                                                                                                                                                                                                                                                                                                                                                                                  |
| Deployment          | Expo.dev / Custom pipeline            | Automated deployment for supported platforms                                                                                                                                                                                                                                                                                                                                                                                                     |

### 5.4 Beads Integration Details

[Beads](https://github.com/steveyegge/beads) provides the persistence, dependency, and scheduling layer. OpenSprint's orchestration layer is thin and delegates heavily to beads.

**What beads provides natively (and OpenSprint uses directly):**

- Issue CRUD with priorities (0-4), statuses (open/in_progress/closed), assignees, labels, and types (bug/feature/task/epic/chore)
- Four dependency types: blocks, related, parent-child, discovered-from
- `bd ready --json` — finds issues with no open blockers, sorted by priority. This is OpenSprint's execution queue — the orchestrator simply calls `bd ready` and picks the first result
- `assignee` field — the orchestrator uses `bd update <id> --assignee agent-<id>` to track which agent is working on a task
- Hierarchical child IDs (e.g., `bd-a3f8.1`, `bd-a3f8.2`) for epic → task breakdown
- JSON output on all commands for programmatic integration
- Hash-based collision-resistant IDs
- Git-backed JSONL storage (auto-commit disabled — see Section 5.9; orchestrator manages git persistence explicitly)
- Daemon with real-time event capabilities (daemon runs for SQLite performance; git sync handled by orchestrator)
- Full audit trail of every change

**Planning state via gating task:** Each epic gets a gating task (e.g., `bd-a3f8.0 "Plan approval gate"`) that `blocks` all child implementation tasks. While the gate is open, `bd ready` excludes all children. When the user clicks "Execute!", the orchestrator closes the gate, unblocking child tasks based on their own inter-task dependencies. The epic stays open until all children are Done.

**What OpenSprint's orchestration layer adds:**

- Agent lifecycle management (spawn, monitor, 10-min timeout, teardown)
- Context assembly with Summarizer invocation when thresholds exceeded
- Two-agent Coder/Reviewer cycle (Section 7.3.2, 12.5)
- Retry and progressive backoff (Section 9)
- Serialized git commit queue for all main-branch operations (Section 5.9)
- Explicit beads persistence (`bd export` at defined checkpoints)

### 5.5 Orchestrator Trust Boundary

**The orchestrator is a deterministic Node.js process — it executes scripted logic, never LLM inference.** Agents are non-deterministic and may omit, misinterpret, or fail to execute instructions, or be terminated unexpectedly. Any operation that affects project state, version control, or workflow progression must be performed by the orchestrator in code — never delegated to agent prompts.

**Critical operations (orchestrator-only):**

| Operation                    | Phase(s)   | Why Orchestrator Must Own It                                                                                                 |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Worktree + branch management | Execute    | Agent might leave repo in inconsistent state; worktree creation/cleanup must be deterministic                                |
| Committing and merging       | Execute    | Agent might forget, commit partially, or merge incorrectly; all git ops on main serialized via commit queue (Section 5.9)    |
| Triggering the next agent    | All        | Agents have no mechanism to invoke the orchestrator; workflow progression is orchestrator-driven                             |
| Beads state transitions      | Execute    | `bd update`, `bd close` — invoked by orchestrator based on agent _output_, not agent _actions_                               |
| Beads issue creation         | Plan, Eval | `bd create`, `bd dep add` — agents propose as structured data; orchestrator creates actual issues                            |
| PRD file updates             | Plan, Eval | Agents propose updates; orchestrator writes and commits. **Exception:** Dreamer writes `prd.json` directly (user-supervised) |
| Gating task closure          | Plan       | "Execute!" closes the gate via `bd close` — a scripted action triggered by UI button                                         |

**Agent responsibilities:** Agents produce _outputs_ — code files, `result.json`, structured data (task proposals, PRD updates, feedback categorizations). The orchestrator reads these outputs and performs all corresponding critical operations. Agents never touch git or beads directly.

### 5.6 Data Flow

The data flows through the system in a unidirectional pipeline with feedback loops. User input in Sketch creates or updates the PRD. The PRD is decomposed in Plan into feature-level Plan markdown files, each representing an epic. In Execute, Plan markdowns are further broken into individual tasks mapped to beads for dependency tracking. Agent CLIs pick up tasks, execute them, and report results back through the system. In Eval, user feedback is mapped back to the relevant Plan epic and Build tasks, creating new tickets as needed. Any changes at any phase propagate upstream to update the living PRD, ensuring the document always reflects the current state of the project.

### 5.7 Orchestrator Lifecycle & Always-On Loop

**One orchestrator per project, always running.** When the OpenSprint backend starts, it launches an orchestrator instance for each registered project. The orchestrator continuously monitors for available work and dispatches agents — there is no manual "start build" action.

**Single-agent constraint applies only to Coder/Reviewer (v1).** Each project runs one Coder or Reviewer at a time. All other agents (Dreamer, Planner, Harmonizer, Analyst, Summarizer, Auditor, Delta Planner) can run concurrently with each other and with the Coder/Reviewer, since they don't touch code branches.

**Event-driven with watchdog polling:** The orchestrator triggers agents on events (task completion, feedback submission, Plan execution). A **watchdog timer** runs every 5 minutes to catch edge cases: it queries `bd ready --json`, checks for a running Coder/Reviewer, starts one if tasks are waiting, and terminates any agent that has been inactive for 10 minutes (Section 9.4).

### 5.8 Orchestrator State Persistence & Recovery

The orchestrator maintains its state in a local file at `.opensprint/orchestrator-state.json` (added to `.gitignore`). This file is updated atomically on every state transition and contains:

```json
{
  "active_task": {
    "task_id": "bd-a3f8.2",
    "phase": "coding",
    "agent_pid": 12345,
    "branch": "opensprint/bd-a3f8.2",
    "worktree_path": ".opensprint/worktrees/bd-a3f8.2",
    "started_at": "2026-02-14T10:30:00Z",
    "last_output_at": "2026-02-14T10:32:15Z"
  },
  "last_watchdog_run": "2026-02-14T10:35:00Z",
  "pending_feedback_categorizations": []
}
```

**Attempt tracking via beads labels:** The cumulative attempt count for each task is stored as a beads label in the format `attempts:<N>` (e.g., `attempts:3`). The orchestrator reads and updates this label via `bd label add <id> attempts:<N>` after each attempt. This keeps attempt history co-located with the task in beads rather than requiring a separate tracking mechanism, and is fast to read without parsing comment history.

**On startup recovery:** The orchestrator reads `orchestrator-state.json`:

1. **No active task:** Normal startup — begin event loop and watchdog.
2. **Active task, PID alive:** Resume monitoring.
3. **Active task, PID dead:** Auto-recover — revert worktree (`git -C <worktree_path> reset --hard`), remove worktree and branch, add failure comment to bead, re-queue task as `open`, flush pending beads changes to git (Section 5.9), and resume the loop.

### 5.9 Git Concurrency Control

Multiple concurrent agents trigger operations that commit to git on the main branch: beads JSONL exports, PRD updates, Dreamer writes, and worktree merges. Simultaneous commits would contend on `.git/index.lock`. The solution is a **serialized git commit queue**.

**Beads auto-commit disabled:** During `bd init`, OpenSprint runs `bd config set auto-flush false` and `bd config set auto-commit false`. The daemon still runs for SQLite performance, but the orchestrator explicitly manages persistence via `bd export -o .beads/issues.jsonl` after each batch of `bd` commands.

**Commit queue:** The orchestrator owns all git operations on main through an in-process async FIFO queue with one worker. Any component that needs to commit to main enqueues a job rather than running git commands directly.

| Operation                   | Trigger                                                           | Commit Message Pattern                       |
| --------------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| Beads JSONL export + commit | After task creation batch, status transitions, dependency changes | `beads: <summary of changes>`                |
| PRD update (Harmonizer)     | After orchestrator writes Harmonizer's proposed updates           | `prd: updated after Plan <plan-id> built`    |
| PRD update (Dreamer)        | After Dreamer modifies `prd.json` during conversation             | `prd: Sketch session update`                 |
| Worktree merge              | After Reviewer approves a task                                    | `merge: opensprint/<task-id> — <task title>` |

The Dreamer writes `prd.json` directly but does not commit; the orchestrator detects the change and enqueues a commit job. If a commit job fails, it is retried once; if it fails again, the error is logged and the next job proceeds — in-memory/SQLite state is still correct, and the next successful commit captures accumulated changes.

---

## 6. Project Setup & Configuration

### 6.1 Home Screen & Project Management

OpenSprint opens to a home screen that lists all existing projects as cards, each showing the project name, last-modified date, current phase, and overall progress. A prominent "Create New Project" button starts the project setup wizard.

Once inside a project, the project name appears at the top-left of the navbar and functions as a dropdown selector. Clicking it reveals a list of all projects, allowing the user to rapidly switch between projects without returning to the home screen. The navbar also includes a theme toggle (light/dark/system) for quick access to appearance preferences (see 6.6).

### 6.2 Project Setup Wizard

Creating a new project follows a sequential wizard:

1. **Project name and description** — basic metadata.
2. **Agent configuration** — select Planning Agent Slot and Coding Agent Slot (see 6.3).
3. **Deployment configuration** — select deployment mode (see 6.4).
4. **Human-in-the-loop preferences** — configure autonomy thresholds (see 6.5).
5. **Repository initialization** — OpenSprint creates a git repo, runs `bd init` to set up beads, configures beads with `auto-flush` and `auto-commit` disabled (see Section 5.9), creates the `.opensprint/` directory structure, and adds `.opensprint/orchestrator-state.json` and `.opensprint/worktrees/` to `.gitignore`.

After setup, the user lands directly in the Sketch tab.

### 6.3 Agent Configuration

Users configure two agent slots during project setup. Both use the same invocation mechanism — OpenSprint calls the user-selected agent's API or CLI. The only difference is which agent/model is used.

**Planning Agent Slot** (used by: Dreamer, Planner, Harmonizer, Analyst, Summarizer, Auditor, Delta Planner):

- Powers all non-coding agent roles. Each named agent receives a specialized prompt and produces a role-specific output format (see Section 12), but all share the same underlying model configuration.
- Options: Claude (select model: e.g., Sonnet, Opus), Cursor (select model from available options), or Custom (user provides CLI command).
- When Claude or Cursor is selected, OpenSprint queries the provider's API for available models and populates a model dropdown.

**Coding Agent Slot** (used by: Coder, Reviewer):

- Powers task implementation and code review.
- Same options as Planning Agent Slot, configured independently.
- Users may choose the same agent/model for both slots, or different ones (e.g., Opus for planning, Sonnet for coding to manage costs).

**Named agent roles:**

| Agent         | Slot     | Phase             | Purpose                                                                    |
| ------------- | -------- | ----------------- | -------------------------------------------------------------------------- |
| Dreamer       | Planning | Sketch            | Multi-turn PRD creation and refinement via chat                            |
| Planner       | Planning | Plan              | Decomposes PRD into features and tasks; outputs indexed task list          |
| Harmonizer    | Planning | Plan (Execute!)   | Reviews shipped Plan against PRD; proposes PRD section updates             |
| Analyst       | Planning | Eval              | Categorizes feedback; maps to epics; proposes new tasks                    |
| Summarizer    | Planning | Execute           | Condenses context when dependencies or Plan exceed thresholds              |
| Auditor       | Planning | Plan (Re-execute) | Summarizes current app capabilities from codebase and task history         |
| Delta Planner | Planning | Plan (Re-execute) | Compares old/new Plan against Auditor's summary; generates delta task list |
| Coder         | Coding   | Execute           | Implements tasks and writes tests                                          |
| Reviewer      | Coding   | Execute           | Validates implementation against spec; approves or rejects                 |

The agent configuration can be changed at any time from project settings. When switching the Coding Agent Slot mid-project, all pending tasks in the Ready state will be picked up by the newly selected agent. In-progress tasks will complete with their originally assigned agent.

### 6.4 Deployment Configuration

OpenSprint supports two deployment modes that users configure during project setup:

- **Expo.dev integration (default for mobile/web):** OpenSprint can automatically deploy to Expo.dev for React Native and web projects. The system manages EAS Build configuration, over-the-air updates, and preview deployments for the Eval phase. Each completed Execute cycle triggers an automatic preview deployment. Requires internet connectivity.
- **Custom deployment pipeline:** Users can connect their own deployment pipeline by specifying a deployment command or webhook URL. OpenSprint will trigger this pipeline after successful Execute completion and test passage. This supports any CI/CD system (GitHub Actions, Vercel, Netlify, AWS, etc.).

### 6.5 Human-in-the-Loop Configuration

OpenSprint is designed to operate as an autonomous flywheel, but users have granular control over when the system pauses for human input. During project setup (and adjustable at any time), users configure their autonomy preferences via a series of checkboxes organized into three decision categories.

#### 6.5.1 Decision Categories

| Category                 | What It Covers                                                                                                                                                                                        | Default           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Scope Changes            | Any modification that adds, removes, or substantially alters a feature in the PRD. This includes changes triggered by Eval feedback that the AI determines represent new scope rather than bug fixes. | Requires approval |
| Architecture Decisions   | Technology stack changes, new external service integrations, database schema modifications, API contract changes, and significant refactors that alter system structure.                              | Requires approval |
| Dependency Modifications | Changes to task ordering, adding new dependencies between epics, splitting or merging tasks, and re-prioritization of the execution queue.                                                            | Automated         |

**Note:** Test failures and agent errors are always handled automatically via progressive backoff (retry, requeue, deprioritize, and eventually block — see Section 9.1). This is not configurable, as the hands-off recovery strategy is core to the flywheel design.

#### 6.5.2 Notification Behavior

For each category, users choose one of three modes:

- **Automated:** The AI makes the decision autonomously and notifies the user after the fact via a log entry. The flywheel continues without pausing.
- **Notify and proceed:** The AI makes the decision, sends a real-time notification to the user, and continues without waiting. The user can review and override retroactively if needed.
- **Requires approval:** The AI prepares a recommendation with full context, pauses the affected work stream, and waits for explicit user approval before proceeding. Other non-blocked work continues in parallel.

### 6.6 Appearance & Theme

OpenSprint supports Light, Dark, and System (follows OS `prefers-color-scheme`) themes. The preference is global across all projects, persists in `localStorage`, applies immediately to all views, and is toggleable from the navbar. System is the default for new users.

---

## 7. Feature Specification

### 7.1 Sketch Phase

#### 7.1.1 Purpose

The Sketch phase is where the user collaborates with the **Dreamer** agent to define what they are building and why. The output is a living PRD that serves as the single source of truth for the entire project.

#### 7.1.2 Key Capabilities

- **Conversational PRD creation:** The user describes their product vision in natural language. The **Dreamer** asks clarifying questions, challenges assumptions, identifies edge cases, and builds out the PRD. The Dreamer updates `prd.json` directly during conversation (Section 5.5 trust boundary exception — acceptable because the user supervises every change in real-time).
- **Living document:** The PRD is version-controlled and updated whenever changes are made in any phase. Users can view the full change history.
- **Architecture definition:** The Dreamer helps define the technical architecture, including tech stack, system components, data models, and API contracts.
- **Mockup generation:** The Dreamer generates UI mockups or wireframes, which the user can iterate on within the conversation.
- **Proactive challenge:** The Dreamer identifies potential issues (e.g., "What happens when this service is unavailable?").

#### 7.1.3 PRD Structure

The living PRD generated in this phase includes the following sections: Executive Summary, Problem Statement, User Personas, Goals and Success Metrics, Feature List with Priorities, Technical Architecture, Data Model, API Contracts, Non-Functional Requirements, and Open Questions. Each section is independently versioned so that downstream changes only update the relevant portions.

#### 7.1.4 PRD Storage

The PRD is stored as `.opensprint/prd.json` — a structured JSON file with each section as a top-level key containing markdown content. This enables independent section versioning, targeted updates from different phases, and section-level diffing. Git history provides the full version timeline. Section content should NOT include a top-level header (the UI displays section titles).

#### 7.1.5 User Interface

The Sketch tab presents a split-pane interface. The left pane is a chat window where the user converses with the **Dreamer** agent. The right pane displays the live PRD document, updating in real-time as the conversation progresses. Users can click on any section of the PRD to focus the conversation on that area, or edit the PRD directly with changes reflected back into the conversation context.

---

### 7.2 Plan Phase

#### 7.2.1 Purpose

The Plan phase breaks the high-level PRD into discrete, implementable features. Each feature becomes a Plan markdown file that fully specifies what needs to be built, serving as the epic-level unit of work.

#### 7.2.2 Key Capabilities

- **AI-assisted decomposition:** The **Planner** analyzes the PRD and suggests a breakdown into features. The user can accept, modify, merge, or split. The Planner outputs an indexed task list with ordinal dependency references (e.g., `"depends_on": [0, 2]`); the orchestrator resolves these to actual beads IDs and executes all `bd create` / `bd dep add` commands (Sections 5.5, 12.3.2).
- **Plan markdown specification:** Each feature is documented in a structured markdown file at `.opensprint/plans/<plan-id>.md` (see Section 7.2.3 for template).
- **Dependency graph visualization:** A visual graph shows how features relate to each other, highlighting critical paths and implementation order.
- **Upstream propagation:** Plan changes are automatically reflected in the living PRD at two trigger points: (1) "Execute!" flow (steps 3–5 below), and (2) Eval scope-change feedback (Section 7.4.2). Both use the Harmonizer (Section 5.5).
- **"Execute!" transition:** Plans and their decomposed tasks exist in a Planning state — all implementation tasks have a `blocks` dependency on a gating task (`bd-a3f8.0 "Plan approval gate"`), so they do not appear in `bd ready`. Each Plan card in the Plan view has an "Execute!" button. Clicking it triggers the following behavior:

  **Cross-epic dependency check:** Before executing, the orchestrator checks whether any tasks in this epic have `blocks` dependencies on tasks in other epics that are still in Planning state (gating task still open). If so, a **confirmation modal** is shown: _"This feature requires that [Feature X, Feature Y] must be implemented first. Queueing this feature will also queue those features. Proceed?"_ If the user confirms, the orchestrator executes the "Execute!" scripted sequence for all prerequisite epics first (in dependency order), then for the requested epic.

  **Scripted sequence** (all steps are executed by the orchestrator in code, not by an agent):
  1. **Close the gating task:** `bd close <gate-id> --reason "Plan executed"` — this unblocks child tasks.
  2. **Record the timestamp:** Update Plan metadata with `shipped_at`.
  3. **Invoke the Harmonizer** to review the shipped Plan against the current PRD and propose section updates (Section 5.5).
  4. **Apply PRD updates:** The orchestrator writes the Harmonizer's proposed updates to `.opensprint/prd.json`.
  5. **Commit changes:** The orchestrator enqueues a git commit job (Section 5.9) that exports beads state and commits both `.beads/issues.jsonl` and `.opensprint/prd.json`.
  6. **Tasks become available:** Child tasks with no other unresolved dependencies now appear in `bd ready --json` and are picked up by the orchestrator loop automatically.

  **UI feedback:** Clicking "Execute!" immediately shows a **toast notification**: _"Plan queued for execution."_ The Harmonizer is exempt from the Coder/Reviewer single-agent constraint (Section 5.7), so it typically runs immediately. When tasks appear in `bd ready`, a follow-up toast confirms: _"[Feature Name] is now building."_

- **Re-execute behavior:** A Plan can only be re-executed once ALL tasks in its existing epic are Done (or if no work has been started yet, in which case all existing sub-tasks are simply deleted). The "Re-execute" button is disabled if any tasks are currently In Progress or In Review. When clicked, the system uses a two-agent approach:
  1. **Auditor** — receives the codebase snapshot (file tree + key files) and the completed task history for this epic. It produces a structured summary of the app's current capabilities relevant to this feature.
  2. **Delta Planner** — receives the original Plan markdown, the updated Plan markdown, and the Auditor's capability summary. It compares what exists against what the new Plan requires and outputs an indexed task list (same structured format as the Planner) representing only the delta work needed.

  The orchestrator then creates the new tasks from the Delta Planner's output using the standard `bd create` / `bd dep add` flow. The user sees the new tasks appear under the existing epic card, gated behind a new approval gate.

#### 7.2.3 Plan Markdown Structure

Each Plan markdown file follows a standardized template: Feature Title, Overview, Acceptance Criteria (with testable conditions), Technical Approach, Dependencies (references to other Plan files), Data Model Changes, API Specification, UI/UX Requirements, Edge Cases and Error Handling, Testing Strategy, and Estimated Complexity. This structure ensures that every Plan contains sufficient detail for an AI agent to implement it without ambiguity.

#### 7.2.4 User Interface

The Plan tab displays a card-based interface showing all feature Plans, with a dependency graph visualization at the top. Each card shows the feature title, status (Planning/Building/Complete), complexity estimate, and dependency count. Users can click into any Plan to view or edit the full markdown. A sidebar allows conversational interaction with the **Dreamer** agent to refine individual Plans. Each Plan card has a "Execute!" button (or "Re-execute" for completed Plans with pending changes; disabled if any tasks are In Progress or In Review).

---

### 7.3 Execute Phase

#### 7.3.1 Purpose

The Execute phase is where AI agents autonomously implement the planned features. Plan markdowns are decomposed into individual tasks, organized into epic cards with inline status tracking, and executed by background agent CLIs with full dependency awareness.

#### 7.3.2 Key Capabilities

- **Automatic task decomposition:** The **Planner** breaks each Plan into granular tasks, outputting a structured list. The orchestrator creates these as beads child issues under the epic, each gated behind the approval task until "Execute!" is clicked (Section 5.5, 12.3.2).
- **Beads-based tracking:** Each Plan maps to a bead epic; each task maps to a child bead. The epic's description field points to the Plan markdown, making it the authoritative spec. Beads provides dependency tracking, `bd ready` for work detection, and `assignee` for agent assignment.
- **Epic card interface:** Tasks are displayed as collapsible epic cards, each showing its child tasks with inline status indicators. Task statuses include Planning, Backlog, Ready, In Progress, In Review, Done, and Blocked. Tasks update automatically as agents pick them up and complete them. Blocked tasks are visually distinct and require user action to unblock.
- **Two-agent execution cycle:** Each task goes through a **Coder** → **Reviewer** sequence. The Coder implements and writes tests; the Reviewer validates against the spec. All state transitions (Ready → In Progress → In Review → Done) are orchestrator-driven (Section 5.5). If the Reviewer rejects, the Coder retries with feedback. This repeats until approval or retry exhaustion triggers progressive backoff (Section 9.1). Full lifecycle details in Section 12.5.
- **Autonomous execution:** The orchestrator runs one Coder or Reviewer at a time per project (Section 5.7), polling `bd ready --json` for the next task. Planning-slot agents run concurrently without waiting.
- **Real-time agent monitoring:** Users can click on any In Progress or In Review task to see a live stream of the agent's reasoning, code generation, and decision-making. Completed tasks display the full output log and generated artifacts.
- **Context propagation with Summarizer:** When a task has >2 dependencies or the Plan exceeds 2,000 words, the orchestrator invokes the **Summarizer** to condense context before passing it to the Coder (see Section 12.3.5). Below these thresholds, raw context (Plan markdown + dependency diffs) is passed directly.
- **Git worktrees for agent isolation:** Each task runs in a dedicated git worktree at `.opensprint/worktrees/<task-id>/`, isolating agent work from the user's main working directory. Worktrees are cleaned up after completion or failure. Beads commands run from the main repo root, as beads' daemon does not support worktrees. See Section 12.5 for full worktree lifecycle.

#### 7.3.3 Task Lifecycle & State Machine

| State       | Beads Representation                                    | Description                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning    | `status: open` + `blocks` dep on gating task            | Task exists but is not ready for implementation; gating task still open                                                                                                                                                                              |
| Backlog     | `status: open` (gate closed, has other unresolved deps) | Task is approved for implementation; waiting on other task dependencies                                                                                                                                                                              |
| Ready       | Returned by `bd ready`                                  | All blocking dependencies resolved; available for agent pickup                                                                                                                                                                                       |
| In Progress | `status: in_progress` + `assignee: agent-1`             | Coder actively implementing the task. Sub-phase (coding vs review) tracked in `.opensprint/active/<task-id>/config.json` `phase` field.                                                                                                              |
| In Review   | `status: in_progress` + `assignee: agent-1`             | Reviewer validating the implementation. Beads does not have a native `in_review` status, so this is the same beads state as In Progress — the distinction is tracked in the orchestrator's config (`phase: "review"`) and reflected in the frontend. |
| Done        | `status: closed` + `close reason`                       | Task completed; Reviewer approved; all tests passing                                                                                                                                                                                                 |
| Blocked     | `status: blocked`                                       | Retry/deprioritization exhausted (Section 9.1). `bd ready` excludes blocked issues natively. User must investigate and set status back to `open` to unblock.                                                                                         |

**State Transitions & Guards:**

| Transition              | Guard / Trigger                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Planning → Backlog      | User clicks "Execute!" → gating task (`bd-a3f8.0`) is closed                                                            |
| Backlog → Ready         | All `blocks` dependencies resolved (automatic via `bd ready`)                                                           |
| Ready → In Progress     | Orchestrator assigns Coder; no other Coder/Reviewer running (v1)                                                        |
| In Progress → In Review | Coder exits with `result.json` status `success`; tests pass                                                             |
| In Review → Done        | Reviewer approves; all automated tests pass                                                                             |
| In Review → In Progress | Reviewer rejects; feedback added to bead; attempt count incremented; progressive backoff checked (Section 9.1)          |
| In Progress → Ready     | Coder fails or 10-min inactivity timeout; git changes reverted; failure comment added                                   |
| Ready → Blocked         | 3 failed attempts at priority 4 (lowest); `bd update <id> --status blocked`; `task.blocked` WebSocket notification sent |
| Blocked → Ready         | User sets status back to `open` (optionally resets `attempts:<N>` label)                                                |
| Done → (terminal)       | Tasks cannot be reopened; new tasks are created instead                                                                 |

#### 7.3.4 User Interface

The Execute tab presents a list of epic cards, one per Plan feature. Each epic card displays the feature title, an inline progress summary (e.g., "3/8 tasks done"), and a collapsible table of its child tasks showing task title, status badge, assigned agent, and elapsed time. Clicking a task row opens a detail sidebar with the full task specification, live agent output stream (for in-progress or in-review tasks), or completed work artifacts (for done tasks). A top-level progress bar shows overall project completion. Blocked tasks are highlighted with a distinct badge and an "Unblock" action.

---

### 7.4 Eval Phase

#### 7.4.1 Purpose

The Eval phase closes the feedback loop. Users test the built software independently, then submit feedback through OpenSprint.

#### 7.4.2 Key Capabilities

- **Feedback submission & mapping:** Users submit feedback in natural language. The **Analyst** categorizes each item (bug/feature/UX/scope), maps it to a Plan epic, and proposes new tasks. The orchestrator creates the corresponding beads tickets (Section 5.5).
- **Automatic PRD updates:** When feedback is categorized as a scope change, the Harmonizer proposes PRD updates, subject to HIL approval configuration.
- **Flywheel operation:** New tickets automatically enter `bd ready` — no user intervention required.
- **Feedback history:** A scrollable feed shows all feedback items with their categorization, mapped Plan/task, and resolution status.

#### 7.4.3 User Interface

The Eval tab has a text input for feedback at the top and a chronological feed of all submitted items below it. Each entry shows the feedback text, categorization, mapped epic/task, and current status.

---

### 7.5 Deliver Phase

#### 7.5.1 Purpose

The Deliver phase is where the built and validated software is packaged and shipped to its target environment. This phase automates the transition from a working local build to a live, accessible deployment.

#### 7.5.2 Key Capabilities

- **Automated deployment:** Once all tasks in a Plan epic are Done and examination feedback is resolved, the Deliver phase triggers the configured deployment pipeline (Expo.dev or custom). The orchestrator invokes the deployment command and monitors the process.
- **Pre-deployment validation:** Before deploying, the orchestrator runs the full test suite (unit, integration, and E2E) as a final gate. If any tests fail, the deployment is aborted and the orchestrator invokes a planning-slot agent to analyze the test output, create a new epic with sub-tasks to fix all errors and issues encountered, and queue that epic for execution. The user is notified via a `deploy.failed` WebSocket event with a link to the newly created fix epic. Once all fix tasks are completed, the user can re-trigger deployment.
- **Deployment history:** Each deployment is recorded with a timestamp, git commit hash, deployment target, and status (success/failed/rolled back). This history is displayed in the Deliver tab.
- **Rollback support:** If a deployment fails or the user identifies a critical issue post-deploy, a one-click rollback reverts to the last successful deployment.
- **Environment configuration:** Users can configure deployment targets (staging, production) and environment-specific variables during project setup or from the Deliver tab.
- **Deployment notifications:** Users receive real-time notifications when deployments start, succeed, or fail. For custom pipelines, webhook responses are parsed for status.

#### 7.5.3 Deployment Triggers

| Trigger                        | Behavior                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Manual "Deploy!" button        | User initiates deployment from the Deliver tab after reviewing the current state                                                           |
| Auto-deploy on epic completion | When all tasks in an epic are Done and examination feedback is resolved, deployment is triggered automatically (configurable)             |
| Post-Eval deployment           | After an Eval cycle resolves all critical feedback, the orchestrator can auto-trigger deployment if the user has enabled this in settings |

#### 7.5.4 User Interface

The Deliver tab displays the current deployment status, deployment history, and environment configuration. A prominent "Deploy!" button triggers a manual deployment. Each deployment entry in the history shows the timestamp, commit hash, target environment, status, and a rollback button for the most recent successful deployment. A live log panel streams deployment output when a deployment is in progress.

---

## 8. Testing Strategy

### 8.1 Philosophy

OpenSprint takes an aggressive approach to automated testing. Every task completed by the Coder must be accompanied by comprehensive tests. Testing is not optional or best-effort — it is a core requirement of task completion. A task is not considered Done until its tests pass.

### 8.2 Testing Layers

| Layer             | Scope                                                                     | When Generated                                            | When Run                                                 |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Unit Tests        | Individual functions and components                                       | Created by the agent as part of each task                 | On task completion; on every subsequent code change      |
| Integration Tests | Interactions between modules, API contracts, data flow between components | Created when a task involves multi-component interaction  | After dependent tasks complete; on every execution cycle |
| End-to-End Tests  | Full user flows through the application, simulating real user behavior    | Created per Plan epic once all tasks in the epic are Done | After epic completion; on every deployment               |
| Regression Tests  | Fixes from the Eval phase do not break existing functionality             | Auto-generated when an Eval ticket is resolved            | On every subsequent execution                            |

### 8.3 Test Execution

The test runner is configurable during project setup. OpenSprint supports common testing frameworks (Jest, Vitest, Playwright, Cypress, pytest, etc.) and will detect the appropriate framework based on the project's tech stack. **The test command is read from `package.json` scripts** (e.g., `npm test`) — no user configuration is needed. For non-Node.js projects, the test command can be overridden in `.opensprint/settings.json`. Test results are displayed in the Execute tab alongside task status. Failed tests block a task from moving to Done and trigger the automatic retry and progressive backoff flow (see Section 9.1).

### 8.4 Coverage Requirements

OpenSprint targets a minimum of 80% code coverage across all generated code. Coverage reports are generated after each Execute cycle and displayed in the project dashboard. The Coder is instructed to prioritize testing edge cases and error handling paths identified in the Plan markdown, not just happy paths.

---

## 9. Error Handling

### 9.1 Error Recovery Philosophy

OpenSprint follows a hands-off error recovery strategy with progressive deprioritization. When any agent fails, the orchestrator automatically retries once. If the retry also fails, the orchestrator reverts all changes and returns the task to the Ready queue. The user is never prompted to intervene in error recovery — the flywheel keeps running.

To prevent a persistently failing task from monopolizing the queue, the orchestrator tracks a cumulative attempt count on each bead issue and applies **progressive backoff**:

- **Attempts 1–2:** Normal retry cycle. Fail once, retry immediately with failure context. If the retry also fails, revert and requeue at the current priority.
- **After 3 total failed attempts:** The orchestrator lowers the task's beads priority by one level (e.g., priority 1 → 2) via `bd update <id> -p <priority+1>`. This allows higher-priority and untried tasks to be worked on first, while the failing task still gets future attempts.
- **After every subsequent 3 failed attempts:** Priority is lowered by one additional level (e.g., after 6 attempts: 2 → 3, after 9 attempts: 3 → 4).
- **After 3 failed attempts at priority 4 (lowest):** The task cannot be deprioritized further. The orchestrator sets the task's beads status to `blocked` via `bd update <id> --status blocked`, which natively removes it from `bd ready` results. A `task.blocked` notification is sent to the frontend via WebSocket so the user is informed. The task remains in beads with full failure history; the user can unblock it manually by setting its status back to `open` when ready to investigate.

All failed attempts are recorded as comments on the bead issue with full failure context (failure reason, agent output log, attempt number), giving future agent attempts and the user visibility into what went wrong.

### 9.2 Coder Task Failure

When a Coder produces code that fails tests or otherwise errors: (1) git changes are reverted in the worktree, (2) a failure comment is added to the bead issue with full context, (3) on odd attempts, the task is immediately re-queued with failure context in the prompt, (4) on even attempts (completing a retry cycle), the orchestrator checks cumulative attempts and applies progressive backoff per Section 9.1.

### 9.3 Reviewer Rejection

The Reviewer's feedback is added as a comment, and a new Coder is triggered with the rejection feedback included. If that attempt also fails, the task follows the same requeue/backoff flow as 9.2. Rejections and Coder failures share the same cumulative attempt counter.

### 9.4 Agent Process Failures & Timeout

If a Coder/Reviewer CLI process crashes or produces no stdout/stderr for 10 minutes (measured from last output), it is forcefully terminated. The task follows the same requeue/backoff flow as 9.2.

### 9.5 Eval Feedback Mapping

Incorrect Analyst mappings require no special handling — the user can see and correct them in the feedback feed.

---

## 10. Data Model

### 10.1 Entity Relationship Overview

```
User (implicit, single-user)
  └── Project (1:many)
        ├── PRD (1:1, JSON file)
        ├── AgentConfig (1:1, embedded in project settings)
        ├── Conversation (1:many, per phase/context)
        │     └── Message (1:many, ordered)
        ├── Plan (1:many, markdown files)
        │     └── Task (1:many, beads issues with parent-child IDs)
        │           └── AgentSession (1:many, per attempt)
        ├── FeedbackItem (1:many)
        ├── DeploymentRecord (1:many)
        └── Settings (1:1, project configuration)
```

### 10.2 Entity Definitions

#### Project

| Field         | Type          | Description                           |
| ------------- | ------------- | ------------------------------------- |
| id            | string (UUID) | Unique project identifier             |
| name          | string        | Display name                          |
| description   | string        | Brief project description             |
| repo_path     | string        | Absolute path to the git repository   |
| created_at    | datetime      | Creation timestamp                    |
| updated_at    | datetime      | Last modification timestamp           |
| current_phase | enum          | sketch / plan / execute / eval / deliver |

#### PRD (PRDDocument)

Stored as `.opensprint/prd.json`. Top-level fields:

| Field      | Type   | Description                                                                                                                         |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| version    | number | Monotonically increasing document version                                                                                           |
| sections   | object | Keyed by section name (e.g., `executive_summary`); each value has `content` (markdown), `version` (number), `updated_at` (datetime) |
| change_log | array  | Entries with `section`, `version`, `source` (which phase triggered the change), `timestamp`, `diff`                                 |

#### Conversation

Stored as `.opensprint/conversations/<conversation-id>.json`. Created per phase context (one for Sketch chat, one per Plan sidebar). Fields: `id`, `context` (sketch / plan:\<plan-id\>), `messages[]`. Each message: `role` (user/assistant), `content` (markdown), `timestamp`, `prd_changes[]` (optional — PRD sections modified by this message).

#### Plan

Stored as `.opensprint/plans/<plan-id>.md` in the project repo. The Plan markdown file is associated to its bead epic as the design document metadata — the epic's `description` field contains the path to the Plan markdown file (e.g., `.opensprint/plans/auth.md`), making the Plan the authoritative specification that agents reference when implementing child tasks. Additional metadata:
| Field | Type | Description |
|-------|------|-------------|
| plan_id | string | Unique identifier (matches filename) |
| bead_epic_id | string | Corresponding beads epic ID (e.g., `bd-a3f8`). Plan status (planning/building/complete) is derived from the beads epic state — no separate status field needed. |
| gate_task_id | string | The gating task ID (e.g., `bd-a3f8.0`) — closed when user clicks "Execute!" |
| shipped_at | datetime | When the user clicked "Execute!" (null if still in planning) |
| complexity | enum | low / medium / high / very_high |

#### Task

Represented as beads issues (child IDs under the Plan's epic). OpenSprint reads/writes these via `bd` commands. Key fields managed by beads:
| Field | Source | Description |
|-------|--------|-------------|
| id | beads | Hash-based ID (e.g., `bd-a3f8.1`) |
| title | beads | Task title |
| description | beads | Task specification |
| status | beads | open / in_progress / closed |
| priority | beads | 0-4 (0 = highest) |
| assignee | beads | Agent instance ID when in progress |
| labels | beads | User-defined labels for categorization |
| dependencies | beads | `blocks` relationships to other tasks |

#### AgentSession

Stored as `.opensprint/sessions/<task-id>-<attempt>.json`. Fields: `task_id`, `attempt`, `agent_type` (claude/cursor/custom), `agent_model`, `started_at`, `completed_at`, `status` (success/failed/timeout/cancelled/approved/rejected), `output_log` (filepath), `git_branch`, `git_diff` (filepath), `test_results`, `failure_reason`.

#### FeedbackItem

Stored as `.opensprint/feedback/<feedback-id>.json`. Fields: `id`, `text` (user's natural language feedback), `category` (bug/feature/ux/scope), `mapped_plan_id`, `created_task_ids` (beads IDs created from this feedback), `status` (pending/mapped/resolved), `created_at`.

#### DeploymentRecord

Stored as `.opensprint/deployments/<deploy-id>.json`. Fields: `id`, `commit_hash` (git SHA deployed), `target` (staging/production), `mode` (expo/custom), `status` (pending/in_progress/success/failed/rolled_back), `started_at`, `completed_at`, `url` (deployed URL if available), `log_path` (filepath to deployment output log), `rolled_back_by` (deploy ID if this deployment was rolled back).

#### ProjectSettings

Stored as `.opensprint/settings.json`. Fields: `planning_agent` ({ type, model, cli_command }), `coding_agent` ({ type, model, cli_command }), `deployment` ({ mode, expo_config, custom_command }), `hil_config` (per-category notification mode), `test_framework`, `test_command` (auto-detected from `package.json`, default: `npm test`, overridable).

**UserPreferences** (frontend-only): Theme stored in `localStorage` at `opensprint.theme` (light/dark/system).

### 10.3 Storage Strategy

**Project Index:** `~/.opensprint/projects.json` maps project IDs to repo paths (`id`, `name`, `repo_path`, `created_at`). This is the only data stored outside project repos.

**Per-Project Data:** All other data lives in the project's git repository: beads issues in `.beads/`, OpenSprint metadata in `.opensprint/`. This means everything is version-controlled, works offline, and syncs via git push/pull. The backend maintains an in-memory index rebuilt from the filesystem on startup.

---

## 11. API Specification

### 11.1 REST API

All endpoints are prefixed with `/api/v1`. Responses are JSON.

#### Projects

| Method | Endpoint        | Description                                      |
| ------ | --------------- | ------------------------------------------------ |
| GET    | `/projects`     | List all projects                                |
| POST   | `/projects`     | Create a new project (runs setup wizard backend) |
| GET    | `/projects/:id` | Get project details                              |
| PUT    | `/projects/:id` | Update project settings                          |
| DELETE | `/projects/:id` | Delete a project                                 |

#### PRD

| Method | Endpoint                     | Description                   |
| ------ | ---------------------------- | ----------------------------- |
| GET    | `/projects/:id/prd`          | Get full PRD                  |
| GET    | `/projects/:id/prd/:section` | Get a specific PRD section    |
| PUT    | `/projects/:id/prd/:section` | Update a specific PRD section |
| GET    | `/projects/:id/prd/history`  | Get PRD change log            |

#### Plans

| Method | Endpoint                                 | Description                                                  |
| ------ | ---------------------------------------- | ------------------------------------------------------------ |
| GET    | `/projects/:id/plans`                    | List all Plans with status                                   |
| POST   | `/projects/:id/plans`                    | Create a new Plan                                            |
| GET    | `/projects/:id/plans/:planId`            | Get Plan markdown and metadata                               |
| PUT    | `/projects/:id/plans/:planId`            | Update Plan markdown                                         |
| POST   | `/projects/:id/plans/:planId/execute`    | Execute the Plan (transition tasks from Planning to Backlog) |
| POST   | `/projects/:id/plans/:planId/re-execute` | Re-execute an updated Plan (with confirmation)               |
| GET    | `/projects/:id/plans/dependencies`       | Get dependency graph data                                    |

#### Tasks (read-through to beads)

| Method | Endpoint                                        | Description                               |
| ------ | ----------------------------------------------- | ----------------------------------------- |
| GET    | `/projects/:id/tasks`                           | List all tasks (wraps `bd list --json`)   |
| GET    | `/projects/:id/tasks/ready`                     | Get ready tasks (wraps `bd ready --json`) |
| GET    | `/projects/:id/tasks/:taskId`                   | Get task details (wraps `bd show --json`) |
| GET    | `/projects/:id/tasks/:taskId/sessions`          | Get agent sessions for a task             |
| GET    | `/projects/:id/tasks/:taskId/sessions/:attempt` | Get specific agent session output         |

#### Execute Orchestration

| Method | Endpoint                       | Description                                                       |
| ------ | ------------------------------ | ----------------------------------------------------------------- |
| GET    | `/projects/:id/execute/status` | Get orchestrator status (active agent, current task, queue depth) |

#### Eval

| Method | Endpoint                             | Description                           |
| ------ | ------------------------------------ | ------------------------------------- |
| GET    | `/projects/:id/feedback`             | List all feedback items               |
| POST   | `/projects/:id/feedback`             | Submit new feedback                   |
| GET    | `/projects/:id/feedback/:feedbackId` | Get feedback details and mapped tasks |

#### Deploy

| Method | Endpoint                                  | Description                                 |
| ------ | ----------------------------------------- | ------------------------------------------- |
| POST   | `/projects/:id/deploy`                    | Trigger a deployment                        |
| GET    | `/projects/:id/deploy/status`             | Get current deployment status               |
| GET    | `/projects/:id/deploy/history`            | List deployment history                     |
| POST   | `/projects/:id/deploy/:deployId/rollback` | Roll back to a previous deployment          |
| PUT    | `/projects/:id/deploy/settings`           | Update deployment environment configuration |

#### Chat (Sketch & Plan conversation)

| Method | Endpoint                     | Description                                                 |
| ------ | ---------------------------- | ----------------------------------------------------------- |
| POST   | `/projects/:id/chat`         | Send a message to the Dreamer agent; returns agent response |
| GET    | `/projects/:id/chat/history` | Get conversation history                                    |

### 11.2 WebSocket Events

Connection: `ws://localhost:<port>/ws/projects/:id`

**Server → Client events:**
| Event | Payload | Description |
|-------|---------|-------------|
| `task.updated` | `{ taskId, status, assignee }` | Task state changed |
| `task.blocked` | `{ taskId, totalAttempts, lastFailureReason }` | Task blocked after exhausting all retry/deprioritization levels; requires user attention |
| `agent.output` | `{ taskId, chunk }` | Streaming agent output for a task |
| `agent.completed` | `{ taskId, status, testResults }` | Agent finished a task |
| `prd.updated` | `{ section, version }` | PRD section was updated |
| `execute.status` | `{ currentTask, queueDepth }` | Orchestrator status change |
| `hil.request` | `{ category, description, options }` | Human-in-the-loop approval needed |
| `feedback.mapped` | `{ feedbackId, planId, taskIds }` | Feedback was mapped to tasks |
| `deploy.started` | `{ deployId, target, commitHash }` | Deployment started |
| `deploy.completed` | `{ deployId, status, url }` | Deployment finished (success or failed) |
| `deploy.output` | `{ deployId, chunk }` | Streaming deployment log output |

**Client → Server events:**
| Event | Payload | Description |
|-------|---------|-------------|
| `agent.subscribe` | `{ taskId }` | Start streaming agent output for a task |
| `agent.unsubscribe` | `{ taskId }` | Stop streaming agent output |
| `hil.respond` | `{ requestId, approved, notes }` | Respond to a HIL request |

---

## 12. Agent CLI Interface Contract

### 12.1 Overview

The orchestration layer communicates with agents through a standardized file-based interface. Each named agent role (see Section 6.3) receives a role-specific prompt and produces a role-specific output, but all share the same invocation and directory mechanism. Agents in the **Coding Agent Slot** (Coder, Reviewer) operate in git worktrees and are subject to the single-agent constraint. Agents in the **Planning Agent Slot** (Dreamer, Planner, Harmonizer, Analyst, Summarizer, Auditor, Delta Planner) can run concurrently.

### 12.2 Common Input Structure

For all agent invocations, the orchestrator creates a task directory at `.opensprint/active/<invocation-id>/` containing:

```
.opensprint/active/<invocation-id>/
├── prompt.md           # Role-specific prompt (see 12.3)
├── context/            # Role-specific context files
└── config.json         # Invocation configuration
```

**config.json** always includes `invocation_id`, `agent_role`, and `repo_path`. Each agent contract below documents only the role-specific additional fields.

**Default status values:** Unless otherwise noted, all planning-slot agents produce `result.json` with status `"success"` or `"failed"`. Some agents add additional values (e.g., `"no_changes_needed"`) as documented in their contract.

### 12.3 Agent Contracts

#### 12.3.1 Dreamer

**Purpose:** Multi-turn conversational PRD creation and refinement.

The Dreamer is unique — it runs as a persistent, interactive session (not a one-shot task). Each turn receives `context/prd.json`, `context/conversation_history.json`, and the user's new message. When used for Plan sidebar chat, `config.json` includes `scope: "plan"` and a `plan_path` field.

**Output:** Streams conversational responses to stdout (relayed via WebSocket) and **updates `prd.json` directly** — the one trust boundary exception (Section 5.5), acceptable because the user observes every change in real-time.

#### 12.3.2 Planner

**Purpose:** Decompose a Plan into features and tasks.

**Input:** `context/prd.json`, `context/plan.md`. **Additional config:** `plan_id`, `epic_id`.

**Output (`result.json`):**

```json
{
  "status": "success",
  "tasks": [
    {
      "index": 0,
      "title": "Set up database schema",
      "description": "...",
      "priority": 1,
      "depends_on": []
    },
    {
      "index": 1,
      "title": "Implement user model",
      "description": "...",
      "priority": 1,
      "depends_on": [0]
    },
    {
      "index": 2,
      "title": "Build auth endpoints",
      "description": "...",
      "priority": 2,
      "depends_on": [0, 1]
    }
  ]
}
```

The orchestrator creates beads issues from this output, resolving ordinal indices to actual beads IDs (see Section 7.2.2).

#### 12.3.3 Harmonizer

**Purpose:** Review a shipped Plan against the PRD and propose section updates.

**Input:** `context/prd.json`, `context/plan.md`. **Additional config:** `plan_id`, `trigger` (`"build_it"` or `"scope_change"`).

**Output (`result.json`):** `{ "status": "success", "prd_updates": [{ "section": "<name>", "action": "update", "content": "<markdown>", "change_log_entry": "<description>" }] }`. **Additional status:** `no_changes_needed`.

#### 12.3.4 Analyst

**Purpose:** Categorize user feedback and map it to the appropriate Plan epic and tasks.

**Input:** `context/prd.json`, `context/plans_index.json`, `context/feedback.txt`. **Additional config:** `feedback_id`.

**Output (`result.json`):** `{ "status": "success", "category": "<bug|feature|ux|scope>", "mapped_plan_id": "<id>", "mapped_epic_id": "<id>", "proposed_tasks": [<indexed task list, same format as Planner>], "is_scope_change": <bool> }`. When `is_scope_change` is `true`, the orchestrator also invokes the Harmonizer with `trigger: "scope_change"`.

#### 12.3.5 Summarizer

**Purpose:** Condense context into a focused summary when thresholds are exceeded (>2 dependencies or >2,000-word Plan).

**Input:** `context/prd_excerpt.md`, `context/plan.md`, `context/deps/`. **Additional config:** `task_id`, `dependency_count`, `plan_word_count`.

**Output (`result.json`):** `{ "status": "success", "summary": "<markdown>" }` — a condensed context preserving architectural decisions, interface contracts, and key implementation details. The orchestrator replaces the raw context files with this summary when assembling the Coder's prompt.

#### 12.3.6 Auditor

**Purpose:** Summarize the current app's capabilities for a Plan being re-built.

**Input:** `context/file_tree.txt`, `context/key_files/`, `context/completed_tasks.json`. **Additional config:** `plan_id`, `epic_id`.

**Output (`result.json`):** `{ "status": "success", "capability_summary": "<markdown>" }` — a structured summary of implemented features, data models, and API surface relevant to this epic.

#### 12.3.7 Delta Planner

**Purpose:** Compare old and new Plan versions against the Auditor's capability summary and generate only the delta tasks needed.

**Input:** `context/plan_old.md`, `context/plan_new.md`, `context/capability_summary.md`. **Additional config:** `plan_id`, `epic_id`.

**Output (`result.json`):** Same format as the Planner (Section 12.3.2) — an indexed task list with dependencies. **Additional status:** `no_changes_needed`.

#### 12.3.8 Coder

**Purpose:** Implement a task and write tests.

**Input:** `context/plan.md` (or Summarizer output), `context/prd_excerpt.md`, `context/deps/`. **Additional config:** `task_id`, `branch`, `worktree_path`, `test_command`, `attempt`, `previous_failure`, `review_feedback`.

**Prompt (`prompt.md`):**

```markdown
# Task: <task title>

## Objective

<task description from beads>

## Context

You are implementing a task as part of a larger feature. Review the provided context files:

- `context/plan.md` — the full feature specification
- `context/prd_excerpt.md` — relevant product requirements
- `context/deps/` — output from tasks this depends on

## Acceptance Criteria

<from the Plan markdown>

## Technical Approach

<from the Plan markdown>

## Instructions

1. Work in the worktree at `<worktree_path>` (already set up by the orchestrator).
2. Implement the task according to the acceptance criteria.
3. Write comprehensive tests (unit, and integration where applicable).
4. Run `<test_command>` and ensure all tests pass.
5. Do NOT commit — the orchestrator will commit your changes after you exit.
6. Write your completion summary to `.opensprint/active/<invocation-id>/result.json`.

## Previous Attempt (if retry)

<failure reason and output from previous attempt, if applicable>

## Review Feedback (if re-implementation after Reviewer rejection)

<Reviewer's rejection comments, if applicable>
```

**Output (`result.json`):**

```json
{
  "status": "success",
  "summary": "Implemented user authentication endpoint with JWT token generation and validation.",
  "files_changed": ["src/auth/controller.ts", "src/auth/service.ts", "tests/auth/auth.test.ts"],
  "tests_written": 12,
  "tests_passed": 12,
  "notes": "Used bcrypt for password hashing. Rate limiting added as noted in the Plan."
}
```

**Status values:** `success`, `failed`, `partial` (some work done but blocked on an issue).

#### 12.3.9 Reviewer

**Purpose:** Validate a Coder's implementation against the task specification.

**Input:** Same context files as the Coder. **Additional config:** same as Coder minus `attempt`, `previous_failure`, `review_feedback`.

**Prompt:** Same structure as the Coder prompt (Objective, Acceptance Criteria, Context) with these differences: the Instructions section directs the Reviewer to (1) review the diff via `git diff main...<branch>`, (2) verify all acceptance criteria are met, (3) verify tests cover the ticket scope beyond happy paths, (4) run `<test_command>`, (5) check code quality, and (6) write `result.json` with status `"approved"` or `"rejected"`. The Reviewer does NOT merge — the orchestrator merges after approval.

**Output (`result.json`):** On approval: `{ "status": "approved", "summary": "...", "notes": "..." }`. On rejection: `{ "status": "rejected", "summary": "...", "issues": ["..."], "notes": "..." }` with specific, actionable feedback.

If any agent does not produce a `result.json` (crash/timeout), the orchestrator treats it as a failure and follows the error handling flow in Section 9.

### 12.4 Invocation

The orchestrator invokes agents as subprocesses: `claude --task-file <path>`, `cursor-agent --input <path>`, or `<custom-command> <path>` where `<path>` is `.opensprint/active/<invocation-id>/prompt.md`. The Dreamer uses the same CLI in interactive/streaming mode. Agent stdout/stderr is streamed to the frontend via WebSocket. The 10-minute inactivity timeout (Section 9.4) applies to Coder/Reviewer only.

### 12.5 Completion Detection & Flow

**Worktree management:** Each Coder task runs in a dedicated worktree created via `git worktree add .opensprint/worktrees/<task-id> -b opensprint/<task-id>`. The Reviewer operates in the same worktree. After approval, the orchestrator merges to main and removes the worktree. Beads commands run from the main repo root.

**Coding phase:**

1. The orchestrator creates the worktree and sets up the task directory.
2. The Coder CLI process is invoked and runs in the worktree.
3. When the process exits, the orchestrator checks for `result.json`.
4. If `status` is `success`, the orchestrator commits all changes in the worktree (Coder does not commit), then runs the test command as a sanity check.
5. If tests pass, the task moves to In Review and the Reviewer is triggered (same worktree).
6. If tests fail or `status` is `failed`, the error handling flow (Section 9.2) is triggered.

**Review phase:**

1. The Reviewer CLI process is invoked. It reviews the diff via `git diff main...<branch>`.
2. When the process exits, the orchestrator checks for `result.json`.
3. If `status` is `approved`, the orchestrator merges the task branch to main, marks the task Done in beads, and removes the worktree. The Reviewer never performs the merge.
4. If `status` is `rejected`, the rejection feedback is added as a comment on the bead issue, and a new Coder is triggered in the same worktree with the feedback included in the prompt.

**Archival:** After a task reaches Done (or exhausts retries), the task directory is moved to `.opensprint/sessions/<task-id>-<attempt>/` for archival.

---

## 13. How It All Connects — End-to-End Walkthrough

The user creates a project via the setup wizard (Section 6.2), which initializes a git repo and beads. In the **Sketch** tab, the **Dreamer** collaborates conversationally to produce the PRD (Section 7.1). Switching to the **Plan** tab, the **Planner** decomposes the PRD into features and tasks, which the orchestrator creates as beads epics and child issues gated behind approval tasks (Section 7.2). When the user clicks "Execute!", the orchestrator closes the gate, invokes the **Harmonizer** to sync the PRD, and unblocks tasks (Section 7.2.2). The always-on orchestrator loop (Section 5.7) picks up tasks from `bd ready`, creates worktrees, optionally invokes the **Summarizer** for large contexts, then runs the **Coder** → **Reviewer** cycle in the **Execute** phase (Section 7.3, 12.3.8–9). Approved tasks are merged to main; failed tasks follow the progressive backoff flow (Section 9). In the **Eval** tab, users test the built software and submit feedback that the **Analyst** categorizes into new tasks that re-enter the execution queue automatically (Section 7.4) — closing the flywheel. Finally, the **Deliver** phase packages and ships the validated software to its target environment via Expo.dev or a custom deployment pipeline (Section 7.5).

---

## 14. Beads Command Reference

All beads interactions use the `bd` CLI with `--json` flags, invoked via `child_process.exec()` from the Node.js backend.

| Command                                                     | When Used                         | Purpose                                                                        |
| ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `bd init`                                                   | Project setup                     | Initialize beads in the project repo                                           |
| `bd create "<title>" -t <type> -p <priority> --json`        | Plan decomposition, Eval feedback | Create epics, tasks, and bug tickets                                           |
| `bd update <id> --status <status> --json`                   | Orchestrator state transitions    | Move tasks between open/in_progress/blocked/closed                             |
| `bd update <id> --assignee <agent-id> --json`               | Orchestrator task assignment      | Track which agent is working on a task                                         |
| `bd update <id> -d "<description>" --json`                  | Plan creation                     | Set epic description to Plan markdown path                                     |
| `bd update <id> -p <priority> --json`                       | Progressive backoff               | Deprioritize persistently failing tasks                                        |
| `bd label add <id> attempts:<N>`                            | Error handling                    | Track cumulative attempt count on a task                                       |
| `bd close <id> --reason "<reason>" --json`                  | Execute!, task completion         | Close gating tasks, completed tasks                                            |
| `bd ready --json`                                           | Orchestrator execution loop       | Get next available task (priority-sorted, all deps resolved)                   |
| `bd list --json`                                            | Execute tab, task listing         | List all tasks with filters                                                    |
| `bd show <id> --json`                                       | Task detail panel                 | Get full task details                                                          |
| `bd dep add <id> <blocker-id> --json`                       | Plan decomposition                | Add blocks/parent-child dependencies                                           |
| `bd dep add <id> <parent-id> --type discovered-from --json` | Eval feedback                     | Link feedback tasks to source                                                  |
| `bd dep tree <id>`                                          | Dependency graph visualization    | Visualize dependency relationships                                             |
| `bd export -o .beads/issues.jsonl`                          | Git commit queue checkpoints      | Export current beads state to JSONL for git persistence (auto-export disabled) |
| `bd config set auto-flush false`                            | Project setup (`bd init`)         | Disable beads' automatic JSONL export (orchestrator manages explicitly)        |
| `bd config set auto-commit false`                           | Project setup (`bd init`)         | Disable beads' automatic git commits (orchestrator manages via commit queue)   |
| `bd delete <id> --force --json`                             | Plan re-execute (no work started) | Remove obsolete tasks                                                          |

---

## 15. Non-Functional Requirements

| Category        | Requirement                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Performance     | Real-time agent output streaming with < 500ms latency; task status updates within 1 second of state changes |
| Scalability     | Handle projects with up to 500 tasks; single Coder/Reviewer in v1, concurrent Coders planned for v2         |
| Reliability     | Agent failures must not corrupt project state; all state changes are transactional and recoverable          |
| Security        | Code execution in sandboxed environments; user projects isolated at the filesystem level                    |
| Usability       | First-time users can create a Sketch and reach Execute phase within 30 minutes without documentation         |
| Theme Support   | Light, dark, and system themes; preference persists across sessions; no flash of wrong theme on load        |
| Data Integrity  | Full audit trail of every change via PRD versioning and bead provenance; no data loss on agent crash        |
| Testing         | Minimum 80% code coverage; all test layers automated; test results visible in real-time                     |
| Offline Support | All core features (Sketch, Plan, Execute, Eval, Deliver) fully functional without internet connectivity       |

---

## 16. Assumptions

- Users have a basic understanding of software concepts (features, bugs, requirements) even if they cannot code.
- AI agent capabilities will continue to improve, making the autonomous execution phase increasingly reliable over time.
- Initial release targets web and React Native application development; other platforms will follow.
- Users deploying via Expo.dev have or will create an Expo account during project setup (online mode only).
- Offline users have sufficient local compute to run their chosen agent CLI and the OpenSprint application simultaneously.

---

## 17. Milestones & Phased Rollout

| Phase | Scope                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alpha | Sketch + Plan phases with living PRD; Dreamer chat interface; Planner for Plan markdown generation; agent slot selection during setup; project home screen; light/dark/system theme toggle                                                                                                               |
| Beta  | Execute phase with epic card interface, single Coder/Reviewer execution, beads integration, agent CLI contract (all 9 named agents), unit test generation, Summarizer for context management, and error handling with progressive backoff                                                               |
| v1.0  | Full Execute phase with real-time monitoring, comprehensive testing (unit + integration + E2E), HIL configuration, git worktree isolation, cross-epic dependency resolution on "Execute!", and 10-minute timeout handling                                                                               |
| v1.1  | Eval phase with Analyst for feedback ingestion, Harmonizer for scope-change PRD updates, flywheel closure, Re-execute with Auditor + Delta Planner; Deliver phase with Expo.dev integration and custom deployment pipelines                                                                              |
| v2.0  | Concurrent multi-Coder execution with conflict resolution, **Agent Dashboard tab** (view, monitor, and manage all agent status and output), multi-project parallel execution, team collaboration, advanced Deliver features (staging environments, canary deployments), regression test suite management |

---

## 18. Resolved Decisions

This table records architectural decisions where the rationale isn't self-evident from the specification. Implementation details fully described in their home sections (e.g., timeout values, storage paths, naming conventions) are not repeated here.

| Decision                       | Resolution                                                                                                                    | Rationale                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Backend language               | Node.js + TypeScript                                                                                                          | Shared language with React frontend; npm beads package; strong subprocess and WebSocket support             |
| PRD storage                    | JSON file in git (`.opensprint/prd.json`) with markdown inside section wrappers                                               | Structured for section-level diffing and versioning; git-versioned; offline-compatible                      |
| Agent selection                | Pluggable: Claude, Cursor, or Custom CLI command                                                                              | Maximizes flexibility; Custom option future-proofs for new agents                                           |
| Named agent taxonomy           | Two slots (Planning, Coding) with 9 named roles                                                                               | Each role gets a specialized prompt and output schema; slots allow cost optimization per phase              |
| Human-in-the-loop threshold    | 3 configurable categories with 3 notification modes each; error recovery always automatic                                     | Gives users control over product decisions while keeping the flywheel running through errors                |
| Agent concurrency              | Single Coder/Reviewer per project in v1; Planning-slot agents unlimited concurrency                                           | Eliminates merge conflict concerns for MVP; planning agents don't touch code branches                       |
| Context propagation            | Summarizer agent invoked when >2 dependencies or >2,000-word Plan                                                             | Prevents context window overflow; threshold-based invocation avoids unnecessary overhead                    |
| Error handling philosophy      | Auto-retry once, then requeue with progressive backoff; block at lowest priority after 3 failures                             | Hands-off: flywheel never stops for errors; persistent failures deprioritized then blocked                  |
| Planning state via gating task | `bd-a3f8.0` with `blocks` dependency on all child tasks                                                                       | Leverages beads' native `bd ready` — closing the gate unblocks children; epic stays open                    |
| In Review state                | Use beads `in_progress` + orchestrator-tracked sub-phase                                                                      | Beads has no native `in_review` status; avoids extending beads' status enum                                 |
| Blocked task mechanism         | Beads native `blocked` status                                                                                                 | `bd ready` excludes blocked issues natively; no custom filtering needed                                     |
| Sketch vs Plan separation      | Separate phases                                                                                                               | PRD is holistic product doc; Plans are implementation-scoped agent handoffs                                 |
| Branch strategy                | Git worktrees in `.opensprint/worktrees/<task-id>/`                                                                           | Isolates agent work from user's main working directory; eliminates conflicts with uncommitted user changes  |
| PRD trust boundary             | Dreamer writes directly (supervised); Harmonizer proposes, orchestrator applies                                               | Sketch is interactive so direct access is safe; all other phases follow standard trust boundary             |
| Orchestrator design            | Deterministic Node.js process; one per project; always-on; event-driven + 5-min watchdog; persistent state for crash recovery | Not an AI agent — all decision points are coded conditionals; self-healing on crash                         |
| Git concurrency control        | Serialized commit queue; beads auto-commit disabled                                                                           | Multiple concurrent agents produce git-tracked changes; serialization prevents `.git/index.lock` contention |
| Cross-epic dependencies        | "Execute!" checks for blocking deps, shows confirmation modal, queues prerequisites automatically                             | Prevents deadlocked tasks; user is informed and in control; no silent failures                              |
| Re-execute approach            | Two-agent: Auditor + Delta Planner                                                                                            | Splitting the work avoids overloading one agent's context; Auditor output is reusable                       |
| Offline mode                   | Fully supported with local agents                                                                                             | Beads is git-based and inherently offline-compatible; all features work without internet                    |
| Scope exclusions (v1)          | No cost management, multi-tenancy, agent marketplace, logical conflict detection                                              | Keeps v1 focused on the core Sketch → Plan → Execute → Eval → Deliver (SPEED) workflow                      |

---

## 19. Open Questions

_No open questions at this time. All previously identified questions have been resolved and documented in Section 18._

---

_End of Document_
