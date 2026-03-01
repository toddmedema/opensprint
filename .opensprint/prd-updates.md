# Structured PRD Updates — Generated from PRD.md

The following PRD_UPDATE blocks extract the OpenSprint PRD into the Sketch phase structured format.

---

[PRD_UPDATE:executive_summary]
OpenSprint is a web application that guides users through the complete software development lifecycle using AI agents. It provides a structured, five-phase workflow — **SPEED**: Sketch, Plan, Execute, Evaluate, and Deliver — that transforms high-level product ideas into working software with minimal manual intervention.

The platform pairs a browser-based interface with a background agent CLI, enabling AI to autonomously execute development tasks while keeping the user in control of strategy and direction. The core philosophy is that humans should focus on _what_ to build and _why_, while AI handles _how_ to build it.

OpenSprint supports multiple agent backends (Claude, Cursor, OpenAI, and custom CLI agents), comprehensive automated testing including end-to-end and integration tests, configurable human-in-the-loop thresholds, and full offline operation for users with local agent setups.
[/PRD_UPDATE]

[PRD_UPDATE:problem_statement]
Building software with AI today is fragmented and unstructured. Developers use AI coding assistants for individual tasks, but there is no cohesive system that manages the full journey from idea to deployed product. This leads to several persistent problems:

- **Lack of architectural coherence:** AI-generated code often lacks a unified vision because each prompt is handled in isolation, without awareness of the broader system design.
- **No dependency tracking:** When building features in parallel, there is no mechanism to ensure that work on one feature accounts for dependencies on another.
- **Manual orchestration overhead:** Users spend significant time managing prompts, context windows, and task sequencing rather than focusing on product decisions.
- **No feedback loop:** There is no structured way to validate completed work and feed findings back into the development process.

OpenSprint solves these problems by providing an end-to-end platform that maintains context across the entire lifecycle and automates the orchestration of AI development agents.
[/PRD_UPDATE]

[PRD_UPDATE:user_personas]

### The Product-Minded Founder

A non-technical founder with a clear product vision who wants to build an MVP without hiring a development team. They understand what they want to build but need AI to handle the engineering. They value speed, clear communication about what is being built, and the ability to provide feedback without writing code.

### The Solo Developer

An experienced developer who wants to multiply their output. They can code but want to delegate routine implementation to AI while focusing on architecture and product decisions. They value transparency into what the AI is doing, the ability to intervene when needed, and high-quality code output.

### The Agency / Consultancy

A small team that builds software for clients. They need to move quickly from client requirements to working software, maintain multiple projects simultaneously, and provide clients with visibility into progress. They value the structured workflow for client communication and the ability to run multiple projects in parallel.
[/PRD_UPDATE]

[PRD_UPDATE:goals_and_metrics]

### Primary Goals

1. Reduce the time from idea to working prototype by 10x compared to traditional AI-assisted development workflows.
2. Enable non-engineers to ship production-quality software by handling technical complexity behind the scenes.
3. Maintain architectural coherence across an entire project by flowing design decisions through every phase.
4. Create a self-improving development flywheel where validation feedback automatically triggers corrective action.

### Success Metrics

| Metric                                | Target                                     | Measurement Method                 |
| ------------------------------------- | ------------------------------------------ | ---------------------------------- |
| Time from idea to working prototype   | < 1 day for standard web apps              | End-to-end session timing          |
| User intervention rate during Execute | < 10% of tasks require manual input        | Task completion telemetry          |
| Sketch-to-code fidelity               | > 90% alignment with PRD                   | Automated PRD compliance checks    |
| Feedback loop closure time            | < 30 min from bug report to fix deployed   | Evaluate-to-Execute cycle tracking |
| First-time user task completion       | > 80% complete a full Sketch-Execute cycle | Onboarding funnel analytics        |
| Test coverage                         | > 80% code coverage with passing E2E tests | Automated coverage reporting       |

[/PRD_UPDATE]

[PRD_UPDATE:feature_list]

### Sketch Phase

- Conversational PRD creation with Dreamer agent
- Living document with section-level versioning
- Architecture definition (tech stack, data models, API contracts)
- Mockup generation and iteration
- Proactive challenge of assumptions and edge cases
- Split-pane UI: chat + live PRD

### Plan Phase

- AI-assisted decomposition into features and tasks
- Plan markdown specification (`.opensprint/plans/<plan-id>.md`)
- Dependency graph visualization
- "Execute!" transition with cross-epic dependency check
- Harmonizer for PRD sync on Execute!
- Re-execute with Auditor for delta task generation

### Execute Phase

- Automatic task decomposition via Planner
- Epic card interface with task status (Planning, Backlog, Ready, In Progress, In Review, Done, Blocked)
- Two-agent Coder → Reviewer cycle
- Real-time agent monitoring and output streaming
- Summarizer for context when >2 deps or >2,000-word Plan
- Git worktrees for agent isolation
- Progressive backoff on failures

### Evaluate Phase

- Feedback submission in natural language
- Analyst categorization (bug/feature/UX/scope) and mapping to epics
- Harmonizer for scope-change PRD updates
- Feedback history feed

### Deliver Phase

- Automated deployment (Expo.dev or custom pipeline)
- Pre-deployment test gate with fix epic on failure
- Deployment history and rollback
- Environment configuration (staging, production)

### Project Setup & Configuration

- Home screen with project cards
- Setup wizard: name, agents, deployment, HIL, repo init
- Two agent slots: Planning (Dreamer, Planner, Harmonizer, Analyst, Summarizer, Auditor) and Coding (Coder, Reviewer)
- HIL: Scope Changes, Architecture Decisions, Dependency Modifications — each with Automated / Notify and proceed / Requires approval
- Light/dark/system theme
  [/PRD_UPDATE]

[PRD_UPDATE:technical_architecture]

### Architecture Overview

Three primary layers: web frontend, backend API server, and background agent CLI. Frontend uses WebSockets for real-time updates and REST for CRUD. Backend orchestrates agent CLIs, manages project state, and maintains the living PRD. Fully offline-capable with local agents.

### Technology Stack

- **Backend:** Node.js + TypeScript (subprocess management, WebSocket, TaskService via sql.js)
- **Frontend:** React + TypeScript
- **Task store:** TaskService (sql.js/SQLite at `~/.opensprint/tasks.db`), in-process, no external CLI
- **Version control:** Git, branch-per-task, worktrees in `.opensprint/worktrees/<task-id>/`

### Core Components

| Component           | Responsibility                                                               |
| ------------------- | ---------------------------------------------------------------------------- |
| Web Frontend        | UI for all five phases; real-time agent monitoring                           |
| Backend API         | Project state, WebSocket relay, PRD versioning, agent orchestration          |
| Agent CLI           | Code generation, testing, debugging (Claude/Cursor/OpenAI/Custom)           |
| Orchestration Layer | Deterministic Node.js; agent lifecycle; git/task ops; commit queue; watchdog |
| TaskService         | Issue CRUD, dependencies, `ready()`, assignee, hierarchical IDs              |
| Test Runner         | Jest, Playwright, etc. — auto-detected from `package.json`                   |
| Deployment          | Expo.dev or custom pipeline                                                  |

### Orchestrator Trust Boundary

Orchestrator owns: worktree/branch management, commits/merges, agent triggering, task store state transitions, task creation, PRD updates (except Dreamer direct write), gating task closure. Agents produce outputs; orchestrator performs all critical operations.

### Data Flow

Sketch → PRD. Plan → Plan markdowns (epics). Execute → tasks in TaskService. Agent CLIs execute tasks. Evaluate → feedback mapped to epics/tasks. Changes propagate upstream to PRD.

### Orchestrator Lifecycle

One orchestrator per project, always on. Single Coder/Reviewer at a time (v1); Planning-slot agents concurrent. Event-driven + 5-min watchdog. State in `.opensprint/orchestrator-state.json`; recovery on crash.

### Git Concurrency

Serialized commit queue for main-branch ops. Task data in global store; orchestrator manages git persistence for PRD and worktree merges only.
[/PRD_UPDATE]

[PRD_UPDATE:data_model]

### Entity Relationship

```
User (implicit)
  └── Project (1:many)
        ├── PRD (1:1, SPEC.md at repo root)
        ├── Conversation (1:many, per phase)
        ├── Plan (1:many, .opensprint/plans/*.md)
        │     └── Task (TaskService, parent-child IDs e.g. os-xxxx.1)
        │           └── AgentSession (1:many)
        ├── FeedbackItem (1:many)
        ├── DeploymentRecord (1:many)
        └── Settings (1:1)
```

### Key Entities

- **Project:** id, name, repo_path, current_phase
- **PRD:** version, sections (content, version, updated_at), change_log
- **Plan:** plan_id, epic_id, gate_task_id, shipped_at, complexity
- **Task (TaskService):** id, title, description, status, priority, assignee, labels, dependencies
- **AgentSession:** task_id, attempt, status, output_log, test_results
- **FeedbackItem:** text, category, mapped_plan_id, created_task_ids, status
- **DeploymentRecord:** commit_hash, target, mode, status, url

### Storage

- **Project index:** `~/.opensprint/projects.json`
- **Per-project:** `.opensprint/` — version-controlled; task data in `~/.opensprint/tasks.db` (global)
  [/PRD_UPDATE]

[PRD_UPDATE:api_contracts]

### REST API (`/api/v1`)

**Projects:** GET/POST `/projects`, GET/PUT/DELETE `/projects/:id`

**PRD:** GET/PUT `/projects/:id/prd`, GET `/projects/:id/prd/:section`, GET `/projects/:id/prd/history`

**Plans:** GET/POST `/projects/:id/plans`, GET/PUT `/projects/:id/plans/:planId`, POST `/projects/:id/plans/:planId/execute`, POST `/projects/:id/plans/:planId/re-execute`, GET `/projects/:id/plans/dependencies`

**Tasks:** GET `/projects/:id/tasks`, GET `/projects/:id/tasks/ready`, GET `/projects/:id/tasks/:taskId`, GET `/projects/:id/tasks/:taskId/sessions`, GET `/projects/:id/tasks/:taskId/sessions/:attempt`

**Execute:** GET `/projects/:id/execute/status`

**Evaluate:** GET/POST `/projects/:id/feedback`, GET `/projects/:id/feedback/:feedbackId`

**Deploy:** POST `/projects/:id/deploy`, GET `/projects/:id/deploy/status`, GET `/projects/:id/deploy/history`, POST `/projects/:id/deploy/:deployId/rollback`, PUT `/projects/:id/deploy/settings`

**Chat:** POST `/projects/:id/chat`, GET `/projects/:id/chat/history`

### WebSocket (`ws://localhost:<port>/ws/projects/:id`)

**Server → Client:** `task.updated`, `task.blocked`, `agent.output`, `agent.completed`, `prd.updated`, `execute.status`, `hil.request`, `feedback.mapped`, `deploy.started`, `deploy.completed`, `deploy.output`

**Client → Server:** `agent.subscribe`, `agent.unsubscribe`, `hil.respond`
[/PRD_UPDATE]

[PRD_UPDATE:non_functional_requirements]
| Category | Requirement |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Performance | Agent output streaming < 500ms latency; task status updates within 1 second |
| Scalability | Up to 500 tasks; single Coder/Reviewer in v1 |
| Reliability | Agent failures must not corrupt state; transactional, recoverable |
| Security | Sandboxed code execution; filesystem isolation |
| Usability | First-time users reach Execute within 30 minutes without docs |
| Theme Support | Light/dark/system; persists; no flash on load |
| Data Integrity | Full audit trail; no data loss on agent crash |
| Testing | 80% coverage; all layers automated; real-time results |
| Offline Support | All core features work without internet |
[/PRD_UPDATE]

[PRD_UPDATE:open_questions]
All previously identified questions have been resolved and documented in the Resolved Decisions section of the full PRD. No open questions at this time.
[/PRD_UPDATE]
