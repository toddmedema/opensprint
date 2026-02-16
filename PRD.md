# OpenSprint — Product Requirements Document

**Version:** 1.7
**Date:** February 14, 2026
**Status:** Draft

---

## 1. Executive Summary

OpenSprint is a web application that guides users through the complete software development lifecycle using AI agents. It provides a structured, four-phase workflow — Dream, Plan, Build, and Verify — that transforms high-level product ideas into working software with minimal manual intervention.

The platform pairs a browser-based interface with a background agent CLI, enabling AI to autonomously execute development tasks while keeping the user in control of strategy and direction. The core philosophy is that humans should focus on _what_ to build and _why_, while AI handles _how_ to build it.

OpenSprint supports multiple agent backends (Claude, Cursor, and custom CLI agents), comprehensive automated testing including end-to-end and integration tests, configurable human-in-the-loop thresholds, and full offline operation for users with local agent setups.

---

## 2. Problem Statement

Building software with AI today is fragmented and unstructured. Developers use AI coding assistants for individual tasks, but there is no cohesive system that manages the full journey from idea to deployed product. This leads to several persistent problems:

- **Lack of architectural coherence:** AI-generated code often lacks a unified vision because each prompt is handled in isolation, without awareness of the broader system design.
- **No dependency tracking:** When building features in parallel, there is no mechanism to ensure that work on one feature accounts for dependencies on another.
- **Manual orchestration overhead:** Users spend significant time managing prompts, context windows, and task sequencing rather than focusing on product decisions.
- **No feedback loop:** There is no structured way to verify completed work and feed findings back into the development process.

OpenSprint solves these problems by providing an end-to-end platform that maintains context across the entire lifecycle and automates the orchestration of AI development agents.

---

## 3. Goals & Success Metrics

### 3.1 Primary Goals

1. Reduce the time from idea to working prototype by 10x compared to traditional AI-assisted development workflows.
2. Enable non-engineers to ship production-quality software by handling technical complexity behind the scenes.
3. Maintain architectural coherence across an entire project by flowing design decisions through every phase.
4. Create a self-improving development flywheel where validation feedback automatically triggers corrective action.

### 3.2 Success Metrics

| Metric                              | Target                                     | Measurement Method              |
| ----------------------------------- | ------------------------------------------ | ------------------------------- |
| Time from idea to working prototype | < 1 day for standard web apps              | End-to-end session timing       |
| User intervention rate during Build | < 10% of tasks require manual input        | Task completion telemetry       |
| Dream-to-code fidelity              | > 90% alignment with PRD                   | Automated PRD compliance checks |
| Feedback loop closure time          | < 30 min from bug report to fix deployed   | Verify-to-Build cycle tracking  |
| First-time user task completion     | > 80% complete a full Dream-Build cycle    | Onboarding funnel analytics     |
| Test coverage                       | > 80% code coverage with passing E2E tests | Automated coverage reporting    |

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

OpenSprint is designed to run entirely offline. The web frontend and backend API server run locally on the user's machine. When using a local agent CLI (such as a locally-hosted LLM), the entire development loop — from Dream through Verify — operates without any internet connectivity. Beads is git-based and inherently offline-compatible with no special synchronization logic required.

### 5.2 Technology Stack

**Backend:** Node.js with TypeScript. This provides a shared language and type system with the React frontend, mature WebSocket support, and robust subprocess management for agent CLIs via `child_process`. Beads is invoked via its CLI (`bd`) using `child_process.exec()` with `--json` flags for structured output.

**Frontend:** React with TypeScript.

### 5.3 Core Components

| Component           | Technology                            | Responsibility                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Frontend        | React + TypeScript                    | User interface for all four phases; real-time agent monitoring; project management                                                                                                                                                                                      |
| Backend API         | Node.js + TypeScript                  | Project state management, WebSocket relay, PRD versioning, agent orchestration                                                                                                                                                                                          |
| Agent CLI           | Pluggable (Claude, Cursor, Custom)    | Executes development tasks: code generation, testing, debugging                                                                                                                                                                                                         |
| Orchestration Layer | Node.js (custom)                      | Agent lifecycle management (spawn, monitor, timeout), context assembly, retry logic, code review triggering. Owns all critical git operations (branch, commit, merge). Delegates task prioritization and readiness to beads. See Section 5.5 (trust boundary).          |
| Beads               | Git-based issue tracker (CLI: `bd`)   | Issue storage, dependency tracking (blocks/related/parent-child/discovered-from), ready-work detection and prioritization via `bd ready`, agent assignment via `assignee` field, hierarchical epic/task IDs, provenance via audit trail, JSONL-backed distributed state |
| Version Control     | Git                                   | Code repository management, branch-per-task strategy                                                                                                                                                                                                                    |
| Test Runner         | Configurable (Jest, Playwright, etc.) | Automated test execution and coverage reporting                                                                                                                                                                                                                         |
| Deployment          | Expo.dev / Custom pipeline            | Automated deployment for supported platforms                                                                                                                                                                                                                            |

### 5.4 Beads Integration Details

[Beads](https://github.com/steveyegge/beads) provides the persistence, dependency, and scheduling layer. OpenSprint's orchestration layer is thin and delegates heavily to beads.

**What beads provides natively (and OpenSprint uses directly):**

- Issue CRUD with priorities (0-4), statuses (open/in_progress/closed), assignees, labels, and types (bug/feature/task/epic/chore)
- Four dependency types: blocks, related, parent-child, discovered-from
- `bd ready --json` — finds issues with no open blockers, sorted by priority. This is OpenSprint's build queue — the orchestrator simply calls `bd ready` and picks the first result
- `assignee` field — the orchestrator uses `bd update <id> --assignee agent-<id>` to track which agent is working on a task
- Hierarchical child IDs (e.g., `bd-a3f8.1`, `bd-a3f8.2`) for epic → task breakdown
- JSON output on all commands for programmatic integration
- Hash-based collision-resistant IDs
- Git-backed JSONL storage with auto-sync
- Daemon with real-time event capabilities
- Full audit trail of every change

**Planning state via gating task:** When a Plan is created and its tasks are decomposed, the orchestrator creates a special gating task as the first child of the epic (e.g., `bd-a3f8.0` titled "Plan approval gate"). All real implementation tasks have a `blocks` dependency on this gate. While the gate is open, `bd ready` will not return any of the implementation tasks. When the user clicks "Build It!", the gate task is closed, which unblocks all child tasks and makes them eligible for `bd ready` based on their own inter-task dependencies. The epic itself stays open throughout the build process and is only closed when all child tasks are Done.

**What OpenSprint's orchestration layer adds:**

- Agent lifecycle management: spawning, monitoring, 5-minute timeout handling, and teardown of CLI processes
- Context assembly: gathering PRD sections, Plan markdowns, and upstream task outputs into a prompt for each agent
- Two-agent review cycle: coding agent implements, review agent validates (see Section 7.3.2)
- Retry and failure handling: reverting failed attempts, adding failure context to bead comments, re-queuing tasks

### 5.5 Orchestrator Trust Boundary

**Agents cannot be trusted to execute specific steps.** LLMs are non-deterministic and may omit, misinterpret, or fail to execute instructions. Any operation that affects project state, version control, or workflow progression must be performed by the orchestrator in code — never delegated to agent prompts.

**Critical operations (orchestrator-only):**

| Operation                    | Why Orchestrator Must Own It                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Branch creation and checkout | Agent might not create the branch, might check out the wrong branch, or might leave the repo in an inconsistent state        |
| Committing changes           | Agent might forget to commit, commit with wrong message, commit partial changes, or commit to the wrong branch               |
| Merging to main              | Agent might merge incorrectly, merge the wrong branch, or leave merge conflicts unresolved                                   |
| Triggering the next agent    | Agent has no mechanism to invoke the orchestrator; workflow progression is entirely orchestrator-driven                      |
| Beads state transitions      | `bd update`, `bd close`, `bd dep add` — all must be invoked by the orchestrator based on agent _output_, not agent _actions_ |

**Agent responsibilities:** Agents produce _outputs_ — code files, `result.json`, and reasoning. The orchestrator reads these outputs and performs the corresponding critical operations. For example: when the review agent writes `result.json` with `status: "approved"`, the orchestrator performs the merge, updates beads, and triggers the next task — the agent never touches git or beads directly for these steps.

### 5.6 Data Flow

The data flows through the system in a unidirectional pipeline with feedback loops. User input in Dream creates or updates the PRD. The PRD is decomposed in Plan into feature-level Plan markdown files, each representing an epic. In Build, Plan markdowns are further broken into individual tasks mapped to beads for dependency tracking. Agent CLIs pick up tasks, execute them, and report results back through the system. In Verify, user feedback is mapped back to the relevant Plan epic and Build tasks, creating new tickets as needed. Any changes at any phase propagate upstream to update the living PRD, ensuring the document always reflects the current state of the project.

---

## 6. Project Setup & Configuration

### 6.1 Home Screen & Project Management

OpenSprint opens to a home screen that lists all existing projects as cards, each showing the project name, last-modified date, current phase, and overall progress. A prominent "Create New Project" button starts the project setup wizard.

Once inside a project, the project name appears at the top-left of the navbar and functions as a dropdown selector. Clicking it reveals a list of all projects, allowing the user to rapidly switch between projects without returning to the home screen. The navbar also includes a theme toggle (light/dark/system) for quick access to appearance preferences (see 6.6).

### 6.2 Project Setup Wizard

Creating a new project follows a sequential wizard:

1. **Project name and description** — basic metadata.
2. **Agent configuration** — select planning agent and coding agent (see 6.3).
3. **Deployment configuration** — select deployment mode (see 6.4).
4. **Human-in-the-loop preferences** — configure autonomy thresholds (see 6.5).
5. **Repository initialization** — OpenSprint creates a git repo and runs `bd init` to set up beads.

After setup, the user lands directly in the Dream tab.

### 6.3 Agent Configuration

Users configure two separate agents during project setup. Both use the same invocation mechanism — OpenSprint calls the user-selected agent's API or CLI for all phases (Dream conversations, Plan decomposition, Build coding, Build review). The only difference is which agent/model is used.

**Planning Agent** (used in Dream and Plan phases):

- Handles conversational PRD creation, feature decomposition, Plan markdown generation, PRD update reviews, and feedback analysis in the Verify phase.
- Options: Claude (select model: e.g., Sonnet, Opus), Cursor (select model from available options), or Custom (user provides CLI command).
- When Claude or Cursor is selected, OpenSprint queries the provider's API for available models and populates a model dropdown.

**Coding Agent** (used in Build phase):

- Handles task implementation, code generation, testing, debugging, and code review.
- Same options as Planning Agent, configured independently.
- Users may choose the same agent/model for both, or different ones (e.g., Opus for planning, Sonnet for coding to manage costs).

The agent configuration can be changed at any time from project settings. When switching coding agents mid-project, all pending tasks in the Ready state will be picked up by the newly selected agent. In-progress tasks will complete with their originally assigned agent.

### 6.4 Deployment Configuration

OpenSprint supports two deployment modes that users configure during project setup:

- **Expo.dev integration (default for mobile/web):** OpenSprint can automatically deploy to Expo.dev for React Native and web projects. The system manages EAS Build configuration, over-the-air updates, and preview deployments for the Verify phase. Each completed Build cycle triggers an automatic preview deployment. Requires internet connectivity.
- **Custom deployment pipeline:** Users can connect their own deployment pipeline by specifying a deployment command or webhook URL. OpenSprint will trigger this pipeline after successful Build completion and test passage. This supports any CI/CD system (GitHub Actions, Vercel, Netlify, AWS, etc.).

### 6.5 Human-in-the-Loop Configuration

OpenSprint is designed to operate as an autonomous flywheel, but users have granular control over when the system pauses for human input. During project setup (and adjustable at any time), users configure their autonomy preferences via a series of checkboxes organized into four decision categories.

#### 6.5.1 Decision Categories

| Category                 | What It Covers                                                                                                                                                                                          | Default                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Scope Changes            | Any modification that adds, removes, or substantially alters a feature in the PRD. This includes changes triggered by Verify feedback that the AI determines represent new scope rather than bug fixes. | Requires approval                         |
| Architecture Decisions   | Technology stack changes, new external service integrations, database schema modifications, API contract changes, and significant refactors that alter system structure.                                | Requires approval                         |
| Dependency Modifications | Changes to task ordering, adding new dependencies between epics, splitting or merging tasks, and re-prioritization of the build queue.                                                                  | Automated                                 |
| Test Failures & Retries  | How to handle tasks where automated tests fail after agent completion: retry with the same agent, retry with modified instructions, or escalate to the user.                                            | Automated (retry up to 2x, then escalate) |

#### 6.5.2 Notification Behavior

For each category, users choose one of three modes:

- **Automated:** The AI makes the decision autonomously and notifies the user after the fact via a log entry. The flywheel continues without pausing.
- **Notify and proceed:** The AI makes the decision, sends a real-time notification to the user, and continues without waiting. The user can review and override retroactively if needed.
- **Requires approval:** The AI prepares a recommendation with full context, pauses the affected work stream, and waits for explicit user approval before proceeding. Other non-blocked work continues in parallel.

This configuration ensures that users who want full autonomy can get it, while users who want tight control over critical decisions have that option. The system defaults to requiring approval for the two highest-impact categories (Scope Changes, Architecture Decisions) and automating the two more operational categories.

### 6.6 Appearance & Theme

OpenSprint supports light and dark mode theming to accommodate user preference and reduce eye strain during extended development sessions.

**Theme options:**

- **Light** — Light background, dark text; suitable for bright environments.
- **Dark** — Dark background, light text; suitable for low-light environments and developer preference.
- **System** — Follows the user's operating system or browser preference (`prefers-color-scheme`). Default for new users.

**Behavior:**

- Theme preference is global (applies across all projects) and persists across sessions.
- A theme toggle is available in the navbar (or settings) for quick switching without opening project settings.
- The selected theme applies immediately to the entire UI: home screen, all four phase tabs, modals, and agent output panels.
- When "System" is selected, the UI responds to OS/browser theme changes in real time.

**Storage:** Theme preference is stored in `localStorage` (frontend-only) under a key such as `opensprint.theme`. No backend changes are required. This keeps the preference local to the browser and avoids polluting project or global config files.

---

## 7. Feature Specification

### 7.1 Dream Phase

#### 7.1.1 Purpose

The Dream phase is where the user collaborates with the planning agent to define what they are building and why. The output is a living PRD that serves as the single source of truth for the entire project.

#### 7.1.2 Key Capabilities

- **Conversational PRD creation:** The user describes their product vision in natural language. The AI asks clarifying questions, challenges assumptions, identifies edge cases, and collaboratively builds out the PRD.
- **Living document:** The PRD is version-controlled and automatically updated whenever changes are made in the Plan, Build, or Verify phases. Users can view the full change history and understand why each change was made.
- **Architecture definition:** The AI helps define the technical architecture, including tech stack selection, system components, data models, and API contracts.
- **Mockup generation:** The AI generates UI mockups or wireframes based on the product description, which the user can iterate on within the conversation.
- **Proactive challenge:** The AI actively identifies potential issues, asking questions like "What happens when this service is unavailable?" or "Have you considered rate limiting on this endpoint?"

#### 7.1.3 PRD Structure

The living PRD generated in this phase includes the following sections: Executive Summary, Problem Statement, User Personas, Goals and Success Metrics, Feature List with Priorities, Technical Architecture, Data Model, API Contracts, Non-Functional Requirements, and Open Questions. Each section is independently versioned so that downstream changes only update the relevant portions.

#### 7.1.4 PRD Storage

The living PRD is stored as a structured JSON file within the project's git repository at `.opensprint/prd.json`. Each section is a top-level key with its content stored as markdown text, enabling independent versioning and targeted updates. The JSON wrapper allows the backend to subscribe to changes at the section level, diff individual sections, and merge updates from different phases without conflicts. Git history provides the full version timeline. The frontend renders each section's markdown content as a readable document. Section content should NOT include a top-level header (e.g. `## 1. Executive Summary`) — the UI already displays the section title for each card.

#### 7.1.5 User Interface

The Dream tab presents a split-pane interface. The left pane is a chat window where the user converses with the planning agent. The right pane displays the live PRD document, updating in real-time as the conversation progresses. Users can click on any section of the PRD to focus the conversation on that area.

**Inline editing:** PRD sections support direct inline editing — no Edit/Save flow. The experience is Google Docs–style: users edit text directly in place. The frontend uses a WYSIWYG-style editor (e.g., Ctrl+B for bold renders as bold on screen) while the backend stores content as markdown. Changes are reflected back into the conversation context automatically.

---

### 7.2 Plan Phase

#### 7.2.1 Purpose

The Plan phase breaks the high-level PRD into discrete, implementable features. Each feature becomes a Plan markdown file that fully specifies what needs to be built, serving as the epic-level unit of work.

#### 7.2.2 Key Capabilities

- **AI-assisted decomposition:** The planning agent analyzes the PRD and suggests a breakdown into features. The user can accept, modify, merge, or split the suggested features.
- **Plan markdown specification:** Each feature is documented in a structured markdown file stored at `.opensprint/plans/<plan-id>.md`, containing: overview, acceptance criteria, technical approach, dependencies on other Plans, data model changes, API endpoints, UI components, edge cases, and testing strategy.
- **Dependency graph visualization:** A visual graph shows how features relate to each other, highlighting critical paths and potential bottlenecks. This helps the user understand implementation order before committing to the Build phase.
- **Suggested implementation order:** The AI recommends a build sequence based on dependency analysis, risk assessment, and foundational priority — building the riskiest and most foundational pieces first.
- **Upstream propagation:** Any changes made to Plans (additions, modifications, scope changes) are automatically reflected back in the living PRD. When a Plan is approved for build, the orchestrator invokes the planning agent to review the Plan against the current PRD and update any affected sections. The agent receives the full PRD and the approved Plan as context and produces targeted section updates with change log entries.
- **"Plan it" / "Replan it" transition:** Before any plan has been generated, the Plan tab shows a "Plan it" button. When clicked, the planning agent analyzes the PRD and creates the initial feature breakdown. If the user subsequently edits the PRD in the Dream phase and returns to Plan, the button becomes "Replan it" — the planning agent reviews the changes to the PRD since the last plan (using versioned snapshots for diffing) and creates or updates plans as necessary. If the plan has already been generated and there are no new PRD changes, the button is not shown.
- **"Build It!" transition:** Plans and their decomposed tasks exist in a Planning state — all implementation tasks have a `blocks` dependency on a gating task (`bd-a3f8.0 "Plan approval gate"`), so they do not appear in `bd ready`. Each Plan card in the Plan view has a "Build It!" button that closes the gating task, allowing child tasks to become eligible for `bd ready` based on their own inter-task dependencies. This prevents agents from working on features that are still being refined.
- **Rebuild behavior:** A Plan can only be rebuilt once ALL tasks in its existing epic are Done (or if no work has been started yet, in which case all existing sub-tasks are simply deleted). The "Rebuild" button is disabled if any tasks are currently In Progress or In Review. When clicked, the system generates new tasks representing the delta between the updated Plan and the completed work. The AI reasons about this as it would any new feature, but with the context of what has already been built.

#### 7.2.3 Plan Markdown Structure

Each Plan markdown file follows a standardized template: Feature Title, Overview, Acceptance Criteria (with testable conditions), Technical Approach, Dependencies (references to other Plan files), Data Model Changes, API Specification, UI/UX Requirements, Edge Cases and Error Handling, Testing Strategy, and Estimated Complexity. This structure ensures that every Plan contains sufficient detail for an AI agent to implement it without ambiguity.

#### 7.2.4 User Interface

The Plan tab displays a card-based interface showing all feature Plans, with a dependency graph visualization at the top. Each card shows the feature title, status (Planning/Building/Complete), complexity estimate, and dependency count. Users can click into any Plan to view or edit the full markdown. A sidebar allows conversational interaction with the planning agent to refine individual Plans. Each Plan card has a "Build It!" button (or "Rebuild" for completed Plans with pending changes; disabled if any tasks are In Progress or In Review).

---

### 7.3 Build Phase

#### 7.3.1 Purpose

The Build phase is where AI agents autonomously implement the planned features. Plan markdowns are decomposed into individual tasks, organized on a kanban board, and executed by background agent CLIs with full dependency awareness.

#### 7.3.2 Key Capabilities

- **Automatic task decomposition:** Each Plan markdown is broken down into granular, atomic tasks. The planning agent determines task boundaries to maximize future parallelism while respecting dependencies. Tasks are created as beads child issues under the Plan's epic (e.g., `bd-a3f8.1`, `bd-a3f8.2`), each with a `blocks` dependency on the epic's gating task (`bd-a3f8.0`) to keep them in Planning state until the user clicks "Build It!".
- **Beads-based tracking:** Each Plan maps to a bead epic. The Plan markdown file (`.opensprint/plans/<plan-id>.md`) is attached to the bead epic as its design document metadata — the epic's description field contains the path to the Plan markdown, making the Plan the authoritative specification for all child tasks under that epic. Each task maps to a child bead within that epic. Beads provides dependency tracking, ready-work detection via `bd ready`, agent assignment via the `assignee` field, and the distributed git-backed storage.
- **Kanban board interface:** Tasks are displayed across columns: Planning, Backlog, Ready, In Progress, In Review, Done. Tasks move automatically as agents pick them up and complete them.
- **Two-agent build cycle:** Each task is processed by two agents sequentially. First, a **coding agent** picks up the task, moves it to In Progress, implements the solution, writes tests, and moves it to In Review. Then, a **review agent** is automatically triggered to verify the implementation against the ticket specification, verify that tests pass and adequately cover the ticket scope, and check code quality. If the review agent approves, it moves the task to Done. If it rejects, it adds detailed feedback as a comment on the bead issue and moves the task back to In Progress, triggering a new coding agent with the original prompt plus the review feedback. This cycle repeats until the review agent approves or the retry limit is reached.
- **Autonomous single-agent execution:** The orchestration layer runs one agent at a time (coding or review). It polls `bd ready --json` to find the next available task, assigns it via `bd update <id> --assignee agent-1`, and manages the full execution lifecycle. This is designed as a flywheel that runs in the background without requiring constant user intervention.
- **Real-time agent monitoring:** Users can click on any In Progress or In Review task to see a live stream of the agent's reasoning, code generation, and decision-making. Completed tasks display the full output log and generated artifacts.
- **Context propagation:** When Task B depends on Task A, the agent picking up Task B receives not just the Plan, but also the actual output and code produced by Task A. This ensures agents build on reality, not just plans. (Note: for v1, context is assembled from the Plan markdown plus the git diff/files produced by dependency tasks. A dedicated "conductor" agent for intelligent context summarization is planned for v2 to support large projects.)

#### 7.3.3 Task Lifecycle & State Machine

| State       | Beads Representation                                    | Description                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning    | `status: open` + `blocks` dep on gating task            | Task exists but is not ready for implementation; gating task still open                                                                                                                                                                                  |
| Backlog     | `status: open` (gate closed, has other unresolved deps) | Task is approved for implementation; waiting on other task dependencies                                                                                                                                                                                  |
| Ready       | Returned by `bd ready`                                  | All blocking dependencies resolved; available for agent pickup                                                                                                                                                                                           |
| In Progress | `status: in_progress` + `assignee: agent-1`             | Coding agent actively implementing the task. Sub-phase (coding vs review) tracked in `.opensprint/active/<task-id>/config.json` `phase` field.                                                                                                           |
| In Review   | `status: in_progress` + `assignee: agent-1`             | Review agent validating the implementation. Beads does not have a native `in_review` status, so this is the same beads state as In Progress — the distinction is tracked in the orchestrator's config (`phase: "review"`) and reflected in the frontend. |
| Done        | `status: closed` + `close reason`                       | Task completed; review agent approved; all tests passing                                                                                                                                                                                                 |

**Valid State Transitions:**

```
Planning → Backlog          (user clicks "Build It!" — gating task closed)
Backlog → Ready             (all blocking dependencies resolve — automatic via bd ready)
Ready → In Progress         (orchestrator assigns coding agent)
In Progress → In Review     (coding agent completes — review agent triggered)
In Review → Done            (review agent approves)
In Review → In Progress     (review agent rejects — feedback added to bead, new coding agent triggered)
In Progress → Ready         (coding agent fails — changes rolled back, comment added to bead)
Done → (terminal)           (tasks cannot be reopened; new tasks are created instead)
```

**Transition Guards:**

- `Planning → Backlog`: Requires the gating task (`bd-a3f8.0`) to be closed (via "Build It!").
- `Backlog → Ready`: Checked by `bd ready` — all `blocks` dependencies must be `closed`.
- `Ready → In Progress`: Orchestrator must not have another agent currently running (single-agent execution in v1).
- `In Progress → In Review`: Coding agent process has exited and produced a `result.json` with `status: success`.
- `In Review → Done`: Review agent approves the implementation; all automated tests pass.
- `In Review → In Progress`: Review agent rejects; feedback comment is added to bead issue; attempt count incremented. If retry limit reached, escalates per HIL config.
- `In Progress → Ready`: Coding agent fails or times out (5-minute inactivity timeout); all git changes reverted; failure comment added to bead issue.

#### 7.3.4 User Interface

The Build tab presents a kanban board with swimlanes grouped by Plan epic. Each task card shows the task title, status, assigned agent, and elapsed time. Clicking a card opens a detail panel with the full task specification, live agent output stream (for in-progress or in-review tasks), or completed work artifacts (for done tasks). A top-level progress bar shows overall project completion.

---

### 7.4 Verify Phase

#### 7.4.1 Purpose

The Verify phase closes the feedback loop. Users test the built software on their own, then provide feedback, bug reports, and improvement suggestions through OpenSprint. The AI maps this feedback to the appropriate Plan epics and Build tasks, automatically creating new tickets to address issues.

#### 7.4.2 Key Capabilities

- **Feedback submission:** Users submit feedback in natural language via a simple input prompt. The AI categorizes feedback as bug reports, feature requests, UX improvements, or scope changes.
- **Intelligent mapping:** The planning agent analyzes each piece of feedback and determines which Plan epic and Build task(s) it relates to. It then creates new bead tickets under the appropriate epic with full context about the issue.
- **Automatic PRD updates:** When feedback is submitted and the planning agent categorizes it as a scope change, the agent reviews the feedback against the current PRD and determines if updates are necessary. If so, it produces targeted section updates. Scope changes require user approval based on the Human-in-the-Loop configuration before the PRD is modified.
- **Flywheel operation:** Once new tickets are created from validation feedback, they automatically enter the Build phase task queue. Agents pick them up and implement fixes without requiring the user to manually manage the process. This creates a continuous improvement cycle.
- **Feedback history:** A scrollable feed tracks all submitted feedback items, their mapped location in the project (which Plan/task), and the current resolution status.

#### 7.4.3 User Interface

The Verify tab presents a simple interface. At the top is a text input area where the user describes their feedback. Below it is a chronological feed of all submitted feedback items, each showing: the original feedback text, the AI's categorization (bug/feature/UX/scope), the mapped Plan epic and created task(s), and the current status of those tasks. Users test their application independently outside OpenSprint and return here to report findings.

---

## 8. Testing Strategy

### 8.1 Philosophy

OpenSprint takes an aggressive approach to automated testing. Every task completed by an AI agent must be accompanied by comprehensive tests. Testing is not optional or best-effort — it is a core requirement of task completion. A task is not considered Done until its tests pass.

### 8.2 Testing Layers

| Layer             | Scope                                                                     | When Generated                                            | When Run                                            |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| Unit Tests        | Individual functions and components                                       | Created by the agent as part of each task                 | On task completion; on every subsequent code change |
| Integration Tests | Interactions between modules, API contracts, data flow between components | Created when a task involves multi-component interaction  | After dependent tasks complete; on every build      |
| End-to-End Tests  | Full user flows through the application, simulating real user behavior    | Created per Plan epic once all tasks in the epic are Done | After epic completion; on every deployment          |
| Regression Tests  | Ensure that fixes from Verify do not break existing functionality         | Auto-generated when a Verify ticket is resolved           | On every subsequent build                           |

### 8.3 Test Execution

The test runner is configurable during project setup. OpenSprint supports common testing frameworks (Jest, Vitest, Playwright, Cypress, pytest, etc.) and will detect or recommend the appropriate framework based on the project's tech stack. Test results are displayed in the Build tab alongside task status. Failed tests block a task from moving to Done and trigger either an automatic retry or escalation based on the Human-in-the-Loop configuration.

### 8.4 Coverage Requirements

OpenSprint targets a minimum of 80% code coverage across all generated code. Coverage reports are generated after each Build cycle and displayed in the project dashboard. The AI agent is instructed to prioritize testing edge cases and error handling paths identified in the Plan markdown, not just happy paths.

---

## 9. Error Handling

### 9.1 Coding Agent Task Failure

When a coding agent produces code that does not pass automated tests or otherwise fails:

1. All git changes from the agent's attempt are reverted (hard reset of the task branch).
2. The task's beads status is set back to `open` (returning it to the Ready queue).
3. A comment is added to the bead issue documenting: the failure reason, the agent's output log, and the attempt number.
4. The orchestrator checks the attempt count:
   - If under the retry limit (default: 2 retries), the task is re-queued. The next coding agent attempt receives the previous failure context in its prompt.
   - If the retry limit is reached, behavior follows the Human-in-the-Loop configuration for "Test Failures & Retries" (default: escalate to user).

### 9.2 Review Agent Rejection

When a review agent rejects an implementation:

1. The review agent's detailed feedback is added as a comment on the bead issue.
2. The task is moved back to In Progress and a new coding agent is triggered with the original prompt plus the review feedback.
3. The attempt count is incremented. If the retry limit is reached (across both coding failures and review rejections combined), escalate per HIL config.

### 9.3 Agent Process Failures & Timeout

If an agent CLI process (coding or review) crashes, hangs, or produces no output for more than 5 minutes:

1. The process is forcefully terminated.
2. Any partial git changes are reverted.
3. The task follows the same retry/escalation flow as 9.1.
4. The orchestrator logs the process failure details for debugging.

The 5-minute inactivity timeout is measured from the last output received from the agent process (stdout/stderr). If the agent is actively producing output, it is not timed out regardless of total elapsed time.

### 9.4 Verify Feedback Mapping

If the planning agent maps feedback to the wrong Plan epic or task, no special error handling is required. The user can see the mapping in the feedback feed and can manually correct it or submit clarifying feedback. The cost of an incorrect mapping is low — a task gets created in the wrong epic, which the user can notice and redirect.

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
        └── Settings (1:1, project configuration)
```

### 10.2 Entity Definitions

#### Project

| Field         | Type          | Description                         |
| ------------- | ------------- | ----------------------------------- |
| id            | string (UUID) | Unique project identifier           |
| name          | string        | Display name                        |
| description   | string        | Brief project description           |
| repo_path     | string        | Absolute path to the git repository |
| created_at    | datetime      | Creation timestamp                  |
| updated_at    | datetime      | Last modification timestamp         |
| current_phase | enum          | dream / plan / build / verify       |

#### PRD

Stored as `.opensprint/prd.json` in the project repo. Each section's content is stored as markdown. Structure:

```json
{
  "version": 12,
  "sections": {
    "executive_summary": { "content": "This product...", "version": 5, "updated_at": "..." },
    "problem_statement": { "content": "Users face...", "version": 3, "updated_at": "..." },
    "user_personas": { "content": "### Persona 1...", "version": 2, "updated_at": "..." }
  },
  "change_log": [
    { "section": "executive_summary", "version": 5, "source": "verify", "timestamp": "...", "diff": "..." }
  ]
}
```

**PRD snapshots for Replan it:** The system stores versioned copies of the PRD to support the "Replan it" flow. The current working version lives in `prd.json`. Each time the user clicks "Plan it" or "Replan it", a snapshot is saved (e.g., at `.opensprint/prd_snapshots/<plan-version>.json` or equivalent). The planning agent receives the diff between the last snapshot and the current PRD when "Replan it" is triggered.

#### Conversation

Stored as `.opensprint/conversations/<conversation-id>.json`. Conversations are created per phase context (one for the main Dream chat, one per Plan sidebar chat).
| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Unique conversation identifier |
| context | enum | dream / plan:<plan-id> | Which phase/plan this conversation belongs to |
| messages | array | Ordered list of messages |

Each message in the array:
| Field | Type | Description |
|-------|------|-------------|
| role | enum | user / assistant | Who sent the message |
| content | string | Message text (markdown) |
| timestamp | datetime | When the message was sent |
| prd_changes | object[] | Optional: PRD sections modified as a result of this message |

#### Plan

Stored as `.opensprint/plans/<plan-id>.md` in the project repo. The Plan markdown file is associated to its bead epic as the design document metadata — the epic's `description` field contains the path to the Plan markdown file (e.g., `.opensprint/plans/auth.md`), making the Plan the authoritative specification that agents reference when implementing child tasks. Additional metadata:
| Field | Type | Description |
|-------|------|-------------|
| plan_id | string | Unique identifier (matches filename) |
| bead_epic_id | string | Corresponding beads epic ID (e.g., `bd-a3f8`). Plan status (planning/building/complete) is derived from the beads epic state — no separate status field needed. |
| gate_task_id | string | The gating task ID (e.g., `bd-a3f8.0`) — closed when user clicks "Build It!" |
| shipped_at | datetime | When the user clicked "Build It!" (null if still in planning) |
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

Stored as `.opensprint/sessions/<task-id>-<attempt>.json`:
| Field | Type | Description |
|-------|------|-------------|
| task_id | string | The beads task ID |
| attempt | number | Attempt number (1, 2, 3...) |
| agent_type | string | claude / cursor / custom |
| agent_model | string | Specific model used |
| started_at | datetime | When the agent began |
| completed_at | datetime | When the agent finished |
| status | enum | success / failed / timeout / cancelled / approved / rejected |
| output_log | string (filepath) | Path to full agent output log |
| git_branch | string | Branch the agent worked on |
| git_diff | string (filepath) | Path to the produced diff |
| test_results | object | Test pass/fail counts and details |
| failure_reason | string | If failed, why |

#### FeedbackItem

Stored as `.opensprint/feedback/<feedback-id>.json`:
| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Unique feedback identifier |
| text | string | User's feedback in natural language |
| category | enum | bug / feature / ux / scope |
| mapped_plan_id | string | Plan epic the feedback maps to |
| created_task_ids | string[] | Beads task IDs created from this feedback |
| status | enum | pending / mapped / resolved |
| created_at | datetime | Submission timestamp |

#### ProjectSettings

Stored as `.opensprint/settings.json`:
| Field | Type | Description |
|-------|------|-------------|
| planning_agent | object | `{ type, model, cli_command }` |
| coding_agent | object | `{ type, model, cli_command }` |
| deployment | object | `{ mode, expo_config, custom_command }` |
| hil_config | object | Per-category notification mode settings |
| test_framework | string | Detected or user-selected test framework |

#### UserPreferences (frontend-only)

Theme and other global UI preferences are stored in the browser's `localStorage`, not in project or backend storage:

| Key                | Type | Description                                           |
| ------------------ | ---- | ----------------------------------------------------- |
| `opensprint.theme` | enum | `light` / `dark` / `system` — color scheme preference |

This keeps theme as a purely client-side concern. If cross-device sync is needed in the future, a `~/.opensprint/preferences.json` file could be introduced and synced by the backend.

### 10.3 Storage Strategy

**Project Index:** A global project index is stored at `~/.opensprint/projects.json` on the user's machine. This file maps project IDs to their repository paths, enabling the home screen to discover and list all projects:

```json
{
  "projects": [
    { "id": "uuid-1", "name": "MyApp", "repo_path": "/Users/me/projects/myapp", "created_at": "..." },
    { "id": "uuid-2", "name": "ClientSite", "repo_path": "/Users/me/projects/clientsite", "created_at": "..." }
  ]
}
```

This file is the only OpenSprint data stored outside of project repositories. It is not version-controlled.

**Per-Project Data:** All other OpenSprint data is stored as files within the project's git repository under the `.opensprint/` directory. This means:

- Everything is version-controlled automatically.
- Everything works offline with no external database.
- Everything syncs via git push/pull if the user has a remote.
- Beads issues are stored in `.beads/` (managed by beads itself).
- OpenSprint metadata is stored in `.opensprint/` (managed by OpenSprint).

The OpenSprint backend maintains an in-memory index of project data for fast queries, rebuilt from the filesystem on startup (similar to how beads uses SQLite as a cache over JSONL).

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

| Method | Endpoint                             | Description                                           |
| ------ | ------------------------------------ | ----------------------------------------------------- |
| GET    | `/projects/:id/plans`                | List all Plans with status                            |
| POST   | `/projects/:id/plans`                | Create a new Plan                                     |
| GET    | `/projects/:id/plans/:planId`        | Get Plan markdown and metadata                        |
| PUT    | `/projects/:id/plans/:planId`        | Update Plan markdown                                  |
| POST   | `/projects/:id/plans/:planId/ship`   | Build It! (transition tasks from Planning to Backlog) |
| POST   | `/projects/:id/plans/:planId/reship` | Rebuild an updated Plan (with confirmation)           |
| GET    | `/projects/:id/plans/dependencies`   | Get dependency graph data                             |

#### Tasks (read-through to beads)

| Method | Endpoint                                        | Description                               |
| ------ | ----------------------------------------------- | ----------------------------------------- |
| GET    | `/projects/:id/tasks`                           | List all tasks (wraps `bd list --json`)   |
| GET    | `/projects/:id/tasks/ready`                     | Get ready tasks (wraps `bd ready --json`) |
| GET    | `/projects/:id/tasks/:taskId`                   | Get task details (wraps `bd show --json`) |
| GET    | `/projects/:id/tasks/:taskId/sessions`          | Get agent sessions for a task             |
| GET    | `/projects/:id/tasks/:taskId/sessions/:attempt` | Get specific agent session output         |

#### Build Orchestration

| Method | Endpoint                     | Description                                                          |
| ------ | ---------------------------- | -------------------------------------------------------------------- |
| POST   | `/projects/:id/build/start`  | Start the build orchestrator                                         |
| POST   | `/projects/:id/build/pause`  | Pause the build orchestrator                                         |
| GET    | `/projects/:id/build/status` | Get orchestrator status (running/paused, active agents, queue depth) |

#### Verify

| Method | Endpoint                             | Description                           |
| ------ | ------------------------------------ | ------------------------------------- |
| GET    | `/projects/:id/feedback`             | List all feedback items               |
| POST   | `/projects/:id/feedback`             | Submit new feedback                   |
| GET    | `/projects/:id/feedback/:feedbackId` | Get feedback details and mapped tasks |

#### Chat (Dream & Plan conversation)

| Method | Endpoint                     | Description                                                  |
| ------ | ---------------------------- | ------------------------------------------------------------ |
| POST   | `/projects/:id/chat`         | Send a message to the planning agent; returns agent response |
| GET    | `/projects/:id/chat/history` | Get conversation history                                     |

### 11.2 WebSocket Events

Connection: `ws://localhost:<port>/ws/projects/:id`

**Server → Client events:**
| Event | Payload | Description |
|-------|---------|-------------|
| `task.updated` | `{ taskId, status, assignee }` | Task state changed |
| `agent.output` | `{ taskId, chunk }` | Streaming agent output for a task |
| `agent.completed` | `{ taskId, status, testResults }` | Agent finished a task |
| `prd.updated` | `{ section, version }` | PRD section was updated |
| `build.status` | `{ running, currentTask, queueDepth }` | Orchestrator status change |
| `hil.request` | `{ category, description, options }` | Human-in-the-loop approval needed |
| `feedback.mapped` | `{ feedbackId, planId, taskIds }` | Feedback was mapped to tasks |

**Client → Server events:**
| Event | Payload | Description |
|-------|---------|-------------|
| `agent.subscribe` | `{ taskId }` | Start streaming agent output for a task |
| `agent.unsubscribe` | `{ taskId }` | Stop streaming agent output |
| `hil.respond` | `{ requestId, approved, notes }` | Respond to a HIL request |

---

## 12. Agent CLI Interface Contract

### 12.1 Overview

The orchestration layer communicates with agents through a standardized file-based interface. This contract applies to all agent types (Claude, Cursor, Custom) and is used for both the coding agent and the review agent. The two agents receive different prompts but use the same invocation and output mechanism.

### 12.2 Input

The orchestrator creates a task directory at `.opensprint/active/<task-id>/` containing:

```
.opensprint/active/<task-id>/
├── prompt.md           # Full task prompt (see 12.3)
├── context/
│   ├── prd_excerpt.md  # Relevant PRD sections
│   ├── plan.md         # The parent Plan markdown
│   └── deps/           # Output from dependency tasks
│       ├── <dep-task-id>.diff
│       └── <dep-task-id>.summary.md
└── config.json         # Agent configuration
```

**config.json:**

```json
{
  "task_id": "bd-a3f8.2",
  "repo_path": "/path/to/project",
  "branch": "opensprint/bd-a3f8.2",
  "test_command": "npm test",
  "attempt": 1,
  "phase": "coding",
  "previous_failure": null,
  "review_feedback": null
}
```

The `phase` field is either `"coding"` or `"review"`. The `review_feedback` field contains the review agent's rejection comments when a coding agent is retrying after a failed review.

### 12.3 Prompt Structure

**Coding agent prompt (`phase: "coding"`):**

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

1. Work on branch `<branch>` (already checked out by the orchestrator).
2. Implement the task according to the acceptance criteria.
3. Write comprehensive tests (unit, and integration where applicable).
4. Run `<test_command>` and ensure all tests pass.
5. Do NOT commit — the orchestrator will commit your changes after you exit.
6. Write your completion summary to `.opensprint/active/<task-id>/result.json`.

## Previous Attempt (if retry)

<failure reason and output from previous attempt, if applicable>

## Review Feedback (if re-implementation after review rejection)

<review agent's rejection comments, if applicable>
```

**Review agent prompt (`phase: "review"`):**

```markdown
# Review Task: <task title>

## Objective

Review the implementation of this task against its specification and acceptance criteria.

## Task Specification

<task description from beads>

## Acceptance Criteria

<from the Plan markdown>

## Implementation

The coding agent has produced changes on branch `<branch>`. The orchestrator has already committed them before invoking you.
Run `git diff main...<branch>` to review the committed changes.

## Instructions

1. Review the diff between main and the task branch using `git diff main...<branch>`.
2. Verify the implementation meets ALL acceptance criteria.
3. Verify tests exist and cover the ticket scope (not just happy paths).
4. Run `<test_command>` and confirm all tests pass.
5. Check code quality: no obvious bugs, reasonable error handling, consistent style.
6. If approving: write your result to `.opensprint/active/<task-id>/result.json` with status "approved". Do NOT merge — the orchestrator will merge after you exit.
7. If rejecting: write your result to `.opensprint/active/<task-id>/result.json` with status "rejected" and provide specific, actionable feedback.
```

### 12.4 Invocation

The orchestrator invokes the agent CLI as a subprocess:

- **Claude:** `claude --task-file .opensprint/active/<task-id>/prompt.md`
- **Cursor:** `cursor-agent --input .opensprint/active/<task-id>/prompt.md`
- **Custom:** `<user-provided-command> .opensprint/active/<task-id>/prompt.md`

The agent's stdout/stderr is captured and streamed to the frontend in real-time via WebSocket. The orchestrator monitors output activity — if no stdout/stderr is received for 5 minutes, the agent process is assumed to have crashed and is forcefully terminated (see Section 9.3).

### 12.5 Output

The agent writes a result file to `.opensprint/active/<task-id>/result.json`:

**Coding agent result:**

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

**Review agent result:**

```json
{
  "status": "approved",
  "summary": "Implementation meets all acceptance criteria. Tests cover primary flows and edge cases.",
  "notes": "Code quality is good. Minor style suggestions left as comments but not blocking."
}
```

Or if rejected:

```json
{
  "status": "rejected",
  "summary": "Implementation missing error handling for expired tokens.",
  "issues": [
    "No test for expired JWT tokens — acceptance criteria #3 requires this",
    "The /refresh endpoint returns 200 on invalid tokens instead of 401"
  ],
  "notes": "Core implementation is solid. Two specific issues need addressing."
}
```

**Coding agent status values:** `success`, `failed`, `partial` (some work done but blocked on an issue).
**Review agent status values:** `approved`, `rejected`.

If the agent does not produce a `result.json` (crash/timeout), the orchestrator treats it as a failure and follows the error handling flow in Section 9.

### 12.6 Completion Detection & Flow

**Branch management:** The orchestrator creates the task branch (`git checkout -b opensprint/<task-id>` from main) before invoking the coding agent. The coding agent works on this branch and produces file changes; the orchestrator commits them. The review agent produces only `result.json`; the orchestrator performs the merge upon approval (see Section 5.5).

**Coding phase:**

1. The orchestrator creates the task branch and sets up the task directory.
2. The coding agent CLI process is invoked and runs on the task branch.
3. When the process exits, the orchestrator checks for `result.json`.
4. If `status` is `success`, the orchestrator commits all changes on the task branch (agent does not commit), then runs the test command as a sanity check.
5. If tests pass, the task moves to In Review and the review agent is triggered (still on the task branch).
6. If tests fail or `status` is `failed`, the error handling flow (Section 9.1) is triggered.

**Review phase:**

1. The review agent CLI process is invoked. It reviews the diff via `git diff main...<branch>`.
2. When the process exits, the orchestrator checks for `result.json`.
3. If `status` is `approved`, the orchestrator merges the task branch to main, marks the task Done in beads, and deletes the task branch. The review agent never performs the merge.
4. If `status` is `rejected`, the rejection feedback is added as a comment on the bead issue, and a new coding agent is triggered on the same branch with the feedback included in the prompt.

**Archival:** After a task reaches Done (or exhausts retries), the task directory is moved to `.opensprint/sessions/<task-id>-<attempt>/` for archival.

---

## 13. How It All Connects — End-to-End Walkthrough

This section traces a complete journey from project creation to verified feature, showing how every component interacts.

**1. Project Creation**
The user clicks "Create New Project" on the home screen. The setup wizard collects the project name, agent configuration (e.g., Claude Opus for planning, Claude Sonnet for coding), deployment mode, and HIL preferences. OpenSprint creates a git repo, runs `bd init` to set up beads, creates the `.opensprint/` directory structure, and adds an entry to `~/.opensprint/projects.json`. The user lands in the Dream tab.

**2. Dream Phase — PRD Creation**
The user describes their product vision in the chat pane. The planning agent (invoked via the configured API) responds conversationally — asking clarifying questions, suggesting architecture, and challenging assumptions. As the conversation progresses, the planning agent generates and updates sections of `.opensprint/prd.json`. Each section is stored as markdown content. The right pane renders the PRD live with inline WYSIWYG editing — the user can edit any section directly without an Edit/Save flow. The conversation is stored in `.opensprint/conversations/<id>.json`.

**3. Plan Phase — Feature Decomposition**
The user switches to the Plan tab. If no plan exists yet, they click "Plan it" to trigger the planning agent. If they have edited the PRD since the last plan, they see "Replan it" instead; the agent receives the diff since the last snapshot and creates or updates plans. If the plan is current and unchanged, no button is shown. The planning agent analyzes the PRD and suggests a breakdown into features. For each accepted feature, OpenSprint:

- Creates a Plan markdown file at `.opensprint/plans/<plan-id>.md`
- Creates a beads epic: `bd create "Feature Name" -t epic` → returns `bd-a3f8`
- Sets the epic's description to the Plan file path: `bd update bd-a3f8 -d ".opensprint/plans/auth.md"`
- Creates a gating task: `bd create "Plan approval gate" -t task` → returns `bd-a3f8.0`
- Decomposes the Plan into tasks: `bd create "Implement login endpoint" -t task` → returns `bd-a3f8.1`, etc.
- Adds `blocks` dependencies: `bd dep add bd-a3f8.1 bd-a3f8.0`, `bd dep add bd-a3f8.2 bd-a3f8.0`, etc.
- Adds inter-task dependencies where needed: `bd dep add bd-a3f8.3 bd-a3f8.1` (task 3 depends on task 1)

The dependency graph visualization shows these relationships. All tasks are in Planning state (gated behind `bd-a3f8.0`).

**4. Build It!**
The user reviews a Plan and clicks "Build It!". OpenSprint closes the gating task: `bd close bd-a3f8.0 --reason "Plan approved for build"`. Child tasks with no other unresolved dependencies now appear in `bd ready --json`. The planning agent is invoked to review the approved Plan against the PRD and update any affected PRD sections.

**5. Build Phase — Orchestrator Loop**
The orchestrator starts its loop (triggered by `POST /projects/:id/build/start`):

1. Calls `bd ready --json` — gets the highest-priority unblocked task (e.g., `bd-a3f8.1`).
2. Assigns it: `bd update bd-a3f8.1 --status in_progress --assignee agent-1`.
3. Creates the task branch: `git checkout -b opensprint/bd-a3f8.1`.
4. Assembles the task directory at `.opensprint/active/bd-a3f8.1/` with `prompt.md`, `config.json`, and `context/` (PRD excerpt, Plan markdown, dependency outputs).
5. Spawns the coding agent CLI as a subprocess. Stdout/stderr are streamed to the frontend via WebSocket.
6. Monitors for 5-minute inactivity timeout.

**6. Coding Agent Completes**
The coding agent implements the feature, writes tests, and writes `result.json` with `status: success` (it does not commit). The orchestrator commits the changes to the task branch, runs the test command as a sanity check, and tests pass.

**7. Review Agent Triggered**
The orchestrator updates `config.json` to `phase: "review"` and generates a review prompt. The review agent is spawned, reviews `git diff main...opensprint/bd-a3f8.1`, verifies tests cover the acceptance criteria, and approves by writing `result.json` with `status: approved` (it does not merge). The orchestrator performs the merge to main, marks the task Done: `bd close bd-a3f8.1 --reason "Implemented and reviewed"`, deletes the branch, and archives the session to `.opensprint/sessions/bd-a3f8.1-1/`.

**8. Next Task**
The orchestrator loops back to step 5.1. If `bd-a3f8.2` was blocked on `bd-a3f8.1`, it now appears in `bd ready` since its dependency is closed. The orchestrator picks it up, and its context includes the diff from `bd-a3f8.1`.

**9. Verify Phase — Feedback Loop**
Once features are built, the user tests the application independently, then submits feedback in the Verify tab: "The login form doesn't show an error message when the password is wrong." The planning agent categorizes this as a bug, maps it to epic `bd-a3f8`, and creates a new task: `bd create "Show error on failed login" -t bug -p 1`. If the agent determines the feedback represents a scope change, it reviews the PRD and proposes updates (pending HIL approval if configured).

The new task enters the build queue. The orchestrator picks it up on its next loop iteration, and the flywheel continues.

---

## 14. Beads Command Reference

All beads interactions use the `bd` CLI with `--json` flags, invoked via `child_process.exec()` from the Node.js backend.

| Command                                                     | When Used                           | Purpose                                                      |
| ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `bd init`                                                   | Project setup                       | Initialize beads in the project repo                         |
| `bd create "<title>" -t <type> -p <priority> --json`        | Plan decomposition, Verify feedback | Create epics, tasks, and bug tickets                         |
| `bd update <id> --status <status> --json`                   | Orchestrator state transitions      | Move tasks between open/in_progress/closed                   |
| `bd update <id> --assignee <agent-id> --json`               | Orchestrator task assignment        | Track which agent is working on a task                       |
| `bd update <id> -d "<description>" --json`                  | Plan creation                       | Set epic description to Plan markdown path                   |
| `bd close <id> --reason "<reason>" --json`                  | Build It!, task completion          | Close gating tasks, completed tasks                          |
| `bd ready --json`                                           | Orchestrator build loop             | Get next available task (priority-sorted, all deps resolved) |
| `bd list --json`                                            | Build tab, task listing             | List all tasks with filters                                  |
| `bd show <id> --json`                                       | Task detail panel                   | Get full task details                                        |
| `bd dep add <id> <blocker-id> --json`                       | Plan decomposition                  | Add blocks/parent-child dependencies                         |
| `bd dep add <id> <parent-id> --type discovered-from --json` | Verify feedback                     | Link feedback tasks to source                                |
| `bd dep tree <id>`                                          | Dependency graph visualization      | Visualize dependency relationships                           |
| `bd delete <id> --force --json`                             | Plan rebuild (no work started)      | Remove obsolete tasks                                        |

---

## 15. Cross-Cutting Concerns

### 15.1 Living PRD Synchronization

The living PRD is the backbone of OpenSprint. Changes propagate to the PRD at two trigger points: (1) when a Plan is approved for build, the planning agent reviews the Plan against the PRD and updates affected sections; (2) when Verify feedback is categorized as a scope change, the planning agent reviews the feedback and proposes PRD updates (subject to HIL approval). Both invocations use the same agent calling system as all other agent interactions. All PRD changes are recorded in the `change_log` with source attribution (which phase triggered the change) and full diff history. Users can view any historical version of the PRD in the Dream tab.

**PRD-to-Plan flow:** When the user edits the PRD in Dream and triggers "Plan it" (first time) or "Replan it" (after plans exist), the system stores a PRD snapshot for that plan version. On "Replan it", the planning agent receives the diff between the last snapshot and the current PRD, enabling it to create or update plans based on what changed.

### 15.2 Agent Orchestration

The agent orchestration layer manages the lifecycle of agent instances. All agents — planning, coding, and review — are invoked through the same mechanism: the user-configured agent API or CLI for that mode (see Section 6.3). The orchestrator runs a single agent at a time (v1), handling: task selection via `bd ready`, agent assignment via beads' `assignee` field, context assembly (gathering PRD sections, Plan markdowns, and outputs from dependency tasks into the task directory), the two-agent coding/review cycle, **all critical git operations** (branch creation, commit, merge, branch deletion — see Section 5.5), 5-minute inactivity timeout monitoring, and retry logic for failed tasks.

### 15.3 Work Provenance (Beads)

Every piece of work in OpenSprint is traceable. The beads system captures: which design decision led to a feature, which Plan markdown specified the feature, which tasks implemented it, what the agent reasoned during implementation (via agent session logs), and what feedback was received post-build. Users can query this provenance at any time by asking "Why was this built this way?" and receive a full trace from design decision to deployed code. Beads' built-in audit trail and `discovered-from` dependency type support this traceability natively.

---

## 16. Non-Functional Requirements

| Category        | Requirement                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Performance     | Real-time agent output streaming with < 500ms latency; kanban board updates within 1 second of state changes |
| Scalability     | Handle projects with up to 500 tasks; single-agent execution in v1, concurrent agents planned for v2         |
| Reliability     | Agent failures must not corrupt project state; all state changes are transactional and recoverable           |
| Security        | Code execution in sandboxed environments; user projects isolated at the filesystem level                     |
| Usability       | First-time users can create a Dream and reach Build phase within 30 minutes without documentation            |
| Theme Support   | Light, dark, and system themes; preference persists across sessions; no flash of wrong theme on load         |
| Data Integrity  | Full audit trail of every change via PRD versioning and bead provenance; no data loss on agent crash         |
| Testing         | Minimum 80% code coverage; all test layers automated; test results visible in real-time                      |
| Offline Support | All core features (Dream, Plan, Build, Verify) fully functional without internet connectivity                |

---

## 17. Technical Constraints & Assumptions

### 17.1 Constraints

- The agent CLI must operate within a sandboxed environment with controlled filesystem and network access.
- Agent context windows are finite; the system must manage context efficiently, providing only the relevant PRD sections, Plan details, and dependency outputs for each task. V1 uses a simple context assembly strategy (Plan + dependency diffs); v2 will introduce a conductor agent for intelligent summarization.
- Real-time streaming of agent output requires persistent WebSocket connections.
- Beads integration is git-based and inherently offline-compatible; no special synchronization logic is required.
- Custom agent support requires the agent to accept a file path argument pointing to the task prompt and produce a `result.json` file on completion.
- OpenSprint must be fully functional without an internet connection; all core features (Dream, Plan, Build, Verify) must work offline when paired with a local agent.
- V1 runs a single agent at a time to eliminate merge conflict concerns. Concurrent agent execution is a v2 feature.
- Critical operations (branch create/checkout, commit, merge, beads state transitions, next-agent trigger) must be performed by the orchestrator in code. Agents cannot be trusted to execute these steps reliably (see Section 5.5).

### 17.2 Assumptions

- Users have a basic understanding of software concepts (features, bugs, requirements) even if they cannot code.
- AI agent capabilities will continue to improve, making the autonomous build phase increasingly reliable over time.
- Initial release targets web and React Native application development; other platforms will follow.
- Users deploying via Expo.dev have or will create an Expo account during project setup (online mode only).
- Offline users have sufficient local compute to run their chosen agent CLI and the OpenSprint application simultaneously.

---

## 18. Milestones & Phased Rollout

| Phase | Scope                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alpha | Dream + Plan phases with living PRD; chat interface with planning agent; Plan markdown generation; agent selection during setup; project home screen; light/dark/system theme toggle                                                                                                                                      |
| Beta  | Build phase with kanban board, single-agent task execution with coding/review cycle, beads integration, agent CLI contract, unit test generation, and error handling                                                                                                                                                      |
| v1.0  | Full Build phase with real-time monitoring, comprehensive testing (unit + integration + E2E), HIL configuration, and 5-minute timeout handling                                                                                                                                                                            |
| v1.1  | Verify phase with feedback ingestion, intelligent mapping, flywheel closure, and Expo.dev deployment integration                                                                                                                                                                                                          |
| v2.0  | Concurrent multi-agent Build execution with conflict resolution, conductor agent for context summarization, **Agent Dashboard tab** (view, monitor, and manage all agent status and output including conductor), multi-project support, team collaboration, custom deployment pipelines, regression test suite management |

---

## 19. Resolved Decisions

| Decision                               | Resolution                                                                                            | Rationale                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Product name                           | OpenSprint (opensprint.dev)                                                                           | Clear, memorable, conveys speed                                                                  |
| Backend language                       | Node.js + TypeScript                                                                                  | Shared language with React frontend; npm beads package; strong subprocess and WebSocket support  |
| PRD storage                            | JSON file in git (`.opensprint/prd.json`)                                                             | Structured for section-level diffing; git-versioned; offline-compatible                          |
| Agent selection                        | Pluggable: Claude, Cursor, or Custom CLI command                                                      | Maximizes flexibility; Custom option future-proofs for new agents                                |
| Planning vs coding agents              | Separate configuration with model selection                                                           | Users can optimize cost/quality per phase (e.g., Opus for planning, Sonnet for coding)           |
| Cost management                        | Out of scope for v1                                                                                   | Focus on core workflow; cost tracking can be added later                                         |
| Deployment integration                 | Expo.dev (built-in) + custom pipeline support                                                         | Expo covers the primary target (web/mobile); custom supports any other setup                     |
| Testing strategy                       | Comprehensive: unit, integration, E2E, and regression                                                 | Higher test coverage = more reliable autonomous operation                                        |
| Human-in-the-loop threshold            | 4 configurable categories with 3 notification modes each                                              | Gives users full control while defaulting to a sensible autonomous balance                       |
| Multi-tenancy                          | Not needed for v1; single-user only                                                                   | Keeps scope focused on the core workflow                                                         |
| Agent marketplace                      | Not needed                                                                                            | Three built-in options (Claude, Cursor, Custom) provide sufficient flexibility                   |
| Offline mode                           | Fully supported — OpenSprint runs offline with local agents                                           | Beads is git-based and inherently offline-compatible                                             |
| Agent concurrency                      | Single agent in v1; concurrent execution deferred to v2                                               | Eliminates merge conflict concerns for MVP                                                       |
| Plan rebuild behavior                  | Only when all tasks Done (or none started); rebuild button disabled during In Progress/In Review      | Simplifies reasoning; AI treats delta like a new feature with existing context                   |
| Logical conflict detection             | Removed from scope                                                                                    | Git-level conflicts are sufficient; logical detection too complex                                |
| Merge conflict resolution              | Removed from v1 scope                                                                                 | Single-agent execution eliminates merge conflicts entirely                                       |
| Context propagation for large projects | V2 conductor agent for intelligent summarization                                                      | V1 uses simple Plan + dependency diff assembly; conductor agent avoids premature complexity      |
| Error handling (task failure)          | Revert changes, return to queue, add failure comment to bead                                          | Clean rollback preserves project integrity; failure context aids subsequent attempts             |
| Error handling (feedback mapping)      | No special handling; user can see and correct                                                         | Low-cost error; over-engineering detection adds complexity without proportional value            |
| Agent assignment tracking              | Use beads native `assignee` field                                                                     | No need for custom assignment logic                                                              |
| Planning state implementation          | Gating task (`bd-a3f8.0`) with `blocks` dependency on all child tasks                                 | Leverages beads' native `bd ready` — closing the gate unblocks children; epic stays open         |
| Build queue logic                      | Delegate to `bd ready --json`                                                                         | Beads handles priority + dependency resolution natively                                          |
| In Review state                        | Use beads `in_progress` status; track coding vs review sub-phase in orchestrator config               | Beads has no native `in_review` status; keeping beads usage clean with `open/in_progress/closed` |
| Build review process                   | Two-agent cycle: coding agent + review agent per task                                                 | Catches quality issues before marking Done; reduces user intervention                            |
| Agent timeout                          | 5-minute inactivity timeout (no output)                                                               | Prevents hung agents from blocking the pipeline                                                  |
| Dream vs Plan separation               | Keep as separate phases                                                                               | PRD is holistic product doc; Plans are implementation-scoped agent handoffs                      |
| V2 Agent Dashboard                     | Dedicated tab for agent monitoring and management                                                     | Provides visibility into all agents including conductor; essential for concurrent execution      |
| Unified agent invocation               | All agents (planning, coding, review) use the same invocation mechanism — the user-configured API/CLI | Simplifies architecture; no separate integration path for planning vs build agents               |
| Project index                          | Global file at `~/.opensprint/projects.json`                                                          | Enables home screen project discovery; only data stored outside project repos                    |
| PRD content format                     | Markdown stored inside JSON section wrappers                                                          | Markdown is readable and renderable; JSON wrapper enables section-level versioning               |
| Theme preference storage               | `localStorage` (frontend-only), key `opensprint.theme`                                                | Theme is purely UI; no backend needed; keeps preference local to browser                         |
| Conversation history                   | Stored per phase/context at `.opensprint/conversations/<id>.json`                                     | Preserves Dream and Plan chat context; enables conversation resumption                           |
| Review agent diff access               | Review agent uses `git diff main...<branch>`                                                          | No need to copy files; git provides authoritative diff natively                                  |
| Branch strategy                        | Orchestrator creates branch, commits after coding agent, merges after review approval                 | Agents cannot be trusted to execute git operations; orchestrator owns all critical steps (5.5)   |
| PRD upstream propagation               | Planning agent invoked at Plan ship and scope-change feedback to review and update PRD                | Explicit trigger points; uses same agent system as all other invocations                         |
| Orchestrator trust boundary            | All critical ops (branch, commit, merge, beads, next-agent) performed by orchestrator in code         | Agents cannot be trusted to execute specific steps; they produce outputs, orchestrator acts      |
| Dream PRD editing UX                   | Inline WYSIWYG editing (Google Docs–style); markdown stored in backend; no Edit/Save flow             | Reduces friction; users edit directly in place                                                  |
| Plan it / Replan it                    | "Plan it" for first plan; "Replan it" when PRD changed after plan exists; button hidden if no changes | Mirrors Build It!/Rebuild pattern; versioned PRD snapshots enable agent diff for Replan it        |

---

## 20. Open Questions

_No open questions at this time. All previously identified questions have been resolved and documented in Section 19._

---

_End of Document_
