# Product Specification

## Executive Summary

OpenSprint is a web application that guides users through the complete software development lifecycle using AI agents. It provides a structured, five-phase workflow — **SPEED**: Sketch, Plan, Execute, Evaluate, and Deliver — that transforms high-level product ideas into working software with minimal manual intervention.

The platform pairs a browser-based interface with a background agent CLI, enabling AI to autonomously execute development tasks while keeping the user in control of strategy and direction. The core philosophy is that humans should focus on _what_ to build and _why_, while AI handles _how_ to build it.

OpenSprint supports multiple agent backends (Claude, Cursor, OpenAI, LM Studio for local models, and custom CLI agents), comprehensive automated testing including end-to-end and integration tests, configurable human-in-the-loop thresholds, and full offline operation for users with local agent setups (including LM Studio).

## Problem Statement

Building software with AI today is fragmented and unstructured. Developers use AI coding assistants for individual tasks, but there is no cohesive system that manages the full journey from idea to deployed product. This leads to several persistent problems:

- **Lack of architectural coherence:** AI-generated code often lacks a unified vision because each prompt is handled in isolation, without awareness of the broader system design.
- **No dependency tracking:** When building features in parallel, there is no mechanism to ensure that work on one feature accounts for dependencies on another.
- **Manual orchestration overhead:** Users spend significant time managing prompts, context windows, and task sequencing rather than focusing on product decisions.
- **No feedback loop:** There is no structured way to validate completed work and feed findings back into the development process.

OpenSprint solves these problems by providing an end-to-end platform that maintains context across the entire lifecycle and automates the orchestration of AI development agents.

## User Personas

### The Product-Minded Founder

A non-technical founder with a clear product vision who wants to build an MVP without hiring a development team. They understand what they want to build but need AI to handle the engineering. They value speed, clear communication about what is being built, and the ability to provide feedback without writing code.

### The Solo Developer

An experienced developer who wants to multiply their output. They can code but want to delegate routine implementation to AI while focusing on architecture and product decisions. They value transparency into what the AI is doing, the ability to intervene when needed, and high-quality code output.

### The Agency / Consultancy

A small team that builds software for clients. They need to move quickly from client requirements to working software, maintain multiple projects simultaneously, and provide clients with visibility into progress. They value the structured workflow for client communication and the ability to run multiple projects in parallel.

## Goals and Success Metrics

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

## Feature List

Add under Sketch Phase (or PRD Storage):

- **SPEC.md as Sketch output:** The Sketch phase PRD is saved as SPEC.md at the repository root—a flat markdown file with standard section headers. This replaces the previous prd.json format to provide a standardized, AI-agent-friendly specification that tools and agents can consume directly.

- **PRD change approval diff view:** When a human-in-the-loop request is for PRD/SPEC approval, the approval UI shows a diff of the proposed SPEC.md changes (unified or split view). Users approve or reject from the same screen.

- **Sketch version-list diff:** From the Sketch page version list (PRD history), users can open "Compare to current" or "View diff" for any previous version to see a diff of that version vs current SPEC.md.

Add under Execute Phase (Code Review):

- **Multi-angle parallel review:** When review angles are empty, one general Reviewer runs (scope + code quality). When 1+ angles are selected, N parallel Reviewers run (one per angle); all must approve for overall approval.

Add under Execute Phase (Git / Worktree):

- **Worktree base branch:** When Git working mode is Worktree, a configurable base branch (default `main`) allows users to create task branches from and merge into a non-main branch (e.g. `beta`). Sync and push use `origin/<baseBranch>`. Reviewer diff uses `baseBranch...taskBranch`. Branches mode ignores this setting.

Add under Agent backends:

- **LM Studio (local):** Users can select LM Studio as an agent type for planning and Execute. Optional base URL (default http://localhost:1234), model selection from models loaded in LM Studio; no API key required. Enables fully offline operation with local models.

## Technical Architecture

Replace all references to `prd.json` with `SPEC.md`. The Sketch phase PRD is stored as **SPEC.md** at the repository root—a flat markdown file with standard section headers (Executive Summary, Problem Statement, User Personas, Goals and Success Metrics, Feature List, Technical Architecture, Data Model, API Contracts, Non-Functional Requirements, Open Questions). This format is standardized and optimized for AI agent consumption. The Dreamer writes SPEC.md directly during conversation (trust boundary exception). The Harmonizer proposes updates; the orchestrator writes and commits SPEC.md. Agent context receives `context/spec.md`. Git commit queue includes SPEC.md. Resolved Decisions table: PRD storage → SPEC.md at repo root (flat markdown) for AI-agent-friendly standardized format.

**Code review flow:** When `reviewAngles` is empty or undefined, one Reviewer runs with a general prompt (scope + code quality). When 1+ angles are selected, N parallel Reviewers run (one per angle); all must approve for overall approval. The single-agent constraint is relaxed for this case: multiple parallel reviewers are allowed for the same task when angles are selected.

**Worktree base branch:** In worktree mode, `worktreeBaseBranch` (project setting, default `main`) controls which branch task branches are created from and merged into. Sync and push use `origin/<baseBranch>`. Reviewer diff uses `baseBranch...taskBranch`. Merger agent prompts reference the configured base branch. Branches mode always uses `main`.

**LM Studio agent:** Agent type `lmstudio` uses the OpenAI-compatible Chat Completions API at a configurable base URL (default `http://localhost:1234`). Optional `baseUrl` in agent config; no API key. Invoke (planning) and spawnWithTaskFile (Coder/Reviewer) use in-process HTTP with custom baseURL. GET /models supports `provider=lmstudio` and optional `baseUrl` query; returns models from the local LM Studio server. Enables fully offline agent execution.

**PRD change approval and version diffs:** When the Harmonizer (or any flow) proposes SPEC.md changes and the user is prompted to approve via the Human Notification System, the UI displays a diff of the proposed changes (GitHub/PR-review style). The backend computes the diff on demand: for HIL approval, between current SPEC.md and the proposed content via `GET /projects/:id/prd/proposed-diff?requestId=<hilRequestId>`; for the Sketch version list, between a selected previous version and current SPEC via `GET /projects/:id/prd/diff?fromVersion=<versionId>`. A line-based diff runs server-side; no diff is embedded in WebSocket payloads. Full SPEC.md snapshots are stored on each write, keyed by version, for version-list diff. A reusable DiffView component is used in the HIL approval UI and in the Sketch page "Compare to current" flow.

## Data Model

**PRD (PRDDocument):** Stored as `SPEC.md` at repository root. A flat markdown file with standard section headers. The backend parses SPEC.md for API responses and structured editing; the canonical on-disk format is markdown. Optional metadata (version, change_log) may be stored in `.opensprint/spec-metadata.json` for versioning and section-level diffing. Entity relationship: PRD (1:1, SPEC.md).

**Snapshot store (version-list diff):** On each SPEC write, full SPEC.md content is saved keyed by version (e.g. in prd_metadata or a dedicated snapshot store). The version-diff endpoint retrieves the snapshot for the requested fromVersion and diffs it against current SPEC.md.

**HIL proposed-diff:** Pending PRD-approval HIL requests may include a reference (e.g. requestId) and proposal reference so the backend can look up proposed content when `GET /projects/:id/prd/proposed-diff?requestId=...` is called; the full diff is not stored in the payload.

**AgentConfig (shared):** Includes optional `baseUrl?: string` when `type === "lmstudio"` (default `http://localhost:1234`). **AgentType** union includes `"lmstudio"`.

**ProjectSettings:** Includes `worktreeBaseBranch?: string` (default `"main"`). Used when `gitWorkingMode === "worktree"`; controls branch creation, merge, sync, and push. Empty or invalid values normalize to `"main"`. Branches mode ignores this field. Agent config (simpleComplexityAgent, complexComplexityAgent) may use `type: "lmstudio"` with optional baseUrl.

**Storage Strategy:** Per-project data includes SPEC.md at repo root. The backend maintains an in-memory index rebuilt from the filesystem on startup.

## API Contracts

**Projects:** GET/POST `/projects`, GET/PUT/DELETE `/projects/:id`

**Project Settings:** GET/PUT `/projects/:id/settings` — Project settings (agent config, deployment, HIL, worktreeBaseBranch, etc.). Does **not** include apiKeys; API keys are managed via global-settings only.

**Global Settings:** GET/PUT `/global-settings` — Returns and accepts `databaseUrl` (masked in response) and `apiKeys` (masked: `{id, masked, limitHitAt}` per provider). Supports multiple keys per provider (ANTHROPIC_API_KEY, CURSOR_API_KEY); merge semantics on PUT (preserve existing when value omitted).

**PRD:** GET/PUT `/projects/:id/prd`, GET `/projects/:id/prd/:section`, GET `/projects/:id/prd/history`, GET `/projects/:id/prd/proposed-diff?requestId=<hilRequestId>` — returns diff for that PRD-approval HIL request (200: diff lines and summary; 404 if not found or not PRD-approval), GET `/projects/:id/prd/diff?fromVersion=<versionId>&toVersion=<versionId|'current'>` — returns diff between fromVersion and toVersion or current (200: fromVersion, toVersion, diff; 404 if version unavailable).

**Plans:** GET/POST `/projects/:id/plans`, GET/PUT `/projects/:id/plans/:planId`, POST `/projects/:id/plans/:planId/execute`, POST `/projects/:id/plans/:planId/re-execute`, GET `/projects/:id/plans/dependencies`

**Models:** GET `/projects/:id/models` (or GET `/models`) supports `provider=lmstudio` and optional `baseUrl` query (default `http://localhost:1234`). Fetches models from LM Studio local server; no API key. Returns `{ data: ModelOption[] }`; on connection error returns empty data or 502 with user-facing message.

**Tasks:** GET `/projects/:id/tasks`, GET `/projects/:id/tasks/ready`, GET `/projects/:id/tasks/:taskId`, GET `/projects/:id/tasks/:taskId/sessions`, GET `/projects/:id/tasks/:taskId/sessions/:attempt`. Task responses include `sourceFeedbackIds?: string[]` when the task has linked feedback (derived from discovered-from dependencies).

**Execute:** GET `/projects/:id/execute/status` — Returns orchestrator status including `activeTasks`. When multi-angle review is active, `activeTasks` may include multiple entries per task (one per angle).

**Evaluate:** GET/POST `/projects/:id/feedback`, GET `/projects/:id/feedback/:feedbackId`

**Deploy:** POST `/projects/:id/deploy`, GET `/projects/:id/deploy/status`, GET `/projects/:id/deploy/history`, POST `/projects/:id/deploy/:deployId/rollback`, PUT `/projects/:id/deploy/settings`

**Chat:** POST `/projects/:id/chat`, GET `/projects/:id/chat/history`

**Agents:** GET `/projects/:id/agents/instructions` — Returns `{ content: string }` (AGENTS.md). PUT `/projects/:id/agents/instructions` — Body `{ content: string }`, writes to repo root AGENTS.md. GET `/projects/:id/agents/active` — Returns active agents; when multi-angle review is active, multiple entries per task may appear (e.g., `Reviewer (Security)`, `Reviewer (Performance)`).

## Non-Functional Requirements

| Category        | Requirement                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Performance     | Agent output streaming < 500ms latency; task status updates within 1 second                                              |
| Scalability     | Up to 500 tasks; single Coder/Reviewer in v1, except multiple parallel reviewers allowed when review angles are selected |
| Reliability     | Agent failures must not corrupt state; transactional, recoverable                                                        |
| Security        | Sandboxed code execution; filesystem isolation                                                                           |
| Usability       | First-time users reach Execute within 30 minutes without docs                                                            |
| Theme Support   | Light/dark/system; persists; no flash on load                                                                            |
| Data Integrity  | Full audit trail; no data loss on agent crash                                                                            |
| Testing         | 80% coverage; all layers automated; real-time results                                                                    |
| Offline Support | All core features work without internet                                                                                  |

## Open Questions

All previously identified questions have been resolved and documented in the Resolved Decisions section of the full PRD. No open questions at this time.

## Competitive Landscape

### Overview

OpenSprint sits in the “AI-assisted product development” space. Alternatives range from no-code chat-to-app builders to IDE-centric coding agents. The comparison below focuses on full-lifecycle and “idea to working product” tools rather than single-step UI generators (e.g. v0, Locofy).

### Lovable (lovable.dev)

- **Positioning:** No-code app builder; “build apps and websites by chatting with AI.”
- **Strengths:** Fast iteration, low friction for non-engineers, chat-first UX.
- **Limitations:** Centered on UI/app generation from conversation; no explicit PRD/spec phase, no dependency-aware task graph or Evaluate → Execute feedback loop. Tied to their hosted experience.
- **OpenSprint differentiator:** Full SPEED lifecycle with a written spec (SPEC.md), dependency-aware planning, human-in-the-loop, and optional use of your repo + local or custom agents (including offline).

### Bolt (bolt.new)

- **Positioning:** “Vibe coding” and professional coding agents; chat-to-build with integrated frontier models, testing/refactoring, and Bolt Cloud (hosting, DB, auth, SEO).
- **Strengths:** Single UI for multiple AI backends, built-in testing and iteration, cloud backend and scaling story.
- **Limitations:** Emphasis on “build in one place” with their stack; less focus on a formal spec phase or on flowing a single PRD through plan → execute → evaluate. Primarily cloud-hosted.
- **OpenSprint differentiator:** SPEC.md as the single source of truth, explicit Sketch → Plan → Execute → Evaluate → Deliver workflow, worktree/branch-based workflow with merger handling, and ability to run fully offline with LM Studio or other local agents.

### Gas Town (gastown.io)

- **Positioning:** AI-powered product or development workflow tool in the idea-to-ship space.
- **OpenSprint differentiator:** OpenSprint emphasizes a phased lifecycle (Sketch/Plan/Execute/Evaluate/Deliver), a file-based spec at repo root, and orchestration that respects task dependencies and feedback loops rather than ad-hoc prompting.

### Other Adjacent Tools

- **Cursor / IDE coding assistants:** Strong for in-editor coding; they do not provide a shared PRD, multi-phase workflow, or structured Evaluate → Execute loop.
- **Replit Agent, etc.:** Often centered on in-environment generation and deployment; typically no first-class spec or dependency-aware task orchestration.

### Summary Table

| Dimension            | OpenSprint                    | Lovable / Bolt-style builders   |
|---------------------|-------------------------------|----------------------------------|
| Spec / PRD          | SPEC.md at repo root; first-class phase | Implicit or lightweight         |
| Lifecycle           | Sketch → Plan → Execute → Evaluate → Deliver | Chat → build (and optionally ship) |
| Task orchestration  | Dependency-aware, priority-ordered tasks | Largely prompt/session-driven   |
| Feedback loop       | Evaluate maps to tasks; fixes re-enter Execute | Manual or tool-specific         |
| Agent choice        | Claude, Cursor, OpenAI, LM Studio, custom CLI | Typically vendor’s models/hosted |
| Offline             | Supported (e.g. LM Studio)    | Generally requires cloud        |
| Repo / Git          | Works with existing repos; worktree + merger | Often tied to platform repos    |
