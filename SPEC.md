# Product Specification

## Executive Summary

During **Plan**, large or cross-cutting plans are automatically decomposed into **hierarchical sub-plans**—each with its own bounded scope, epic, and dependency edges—capped at **~15 actionable tasks per plan node** and a maximum tree depth of **four levels**. This keeps each planning batch small enough for reliable agent output and human review while enabling complex initiatives to be structured top-down.

During **Execute**, users can **open the task worktree in VS Code or Cursor** for live file and diff inspection, and—when using **in-process API agent backends**—**chat with the running agent** between turns for mid-flight guidance. **CLI-based agent backends** do not support reliable mid-flight messaging; the product surfaces a clear disabled state and directs users to API mode. A **browser-only** fallback exposes the worktree path and copyable shell commands when the desktop app cannot launch an editor.

When proposed **PRD/SPEC** changes require **human-in-the-loop** approval, the product shows a **rendered markdown diff** of current vs proposed SPEC.md (block-level changes with **word-level** highlights inside modified blocks) and a **[Rendered | Raw]** toggle to a traditional line-based diff. On **Sketch**, the **PRD version history** list includes **View Diff** on each entry to compare that saved snapshot to the **current** SPEC.md.

During **Evaluate**, projects can connect **external feedback sources**—starting with **Todoist**—to automatically import new tasks as feedback items. A provider-agnostic integration framework supports OAuth-based connections, background polling, idempotent import with provenance tracking, and cleanup of imported items from the source. This closes the feedback loop between field observations and the Execute phase without manual data entry.

## Problem Statement

Building software with AI today is fragmented and unstructured. Developers use AI coding assistants for individual tasks, but there is no cohesive system that manages the full journey from idea to deployed product. This leads to several persistent problems:

- **Lack of architectural coherence:** AI-generated code often lacks a unified vision because each prompt is handled in isolation, without awareness of the broader system design.
- **No dependency tracking:** When building features in parallel, there is no mechanism to ensure that work on one feature accounts for dependencies on another.
- **Manual orchestration overhead:** Users spend significant time managing prompts, context windows, and task sequencing rather than focusing on product decisions.
- **No feedback loop:** There is no structured way to validate completed work and feed findings back into the development process.

Open Sprint solves these problems by providing an end-to-end platform that maintains context across the entire lifecycle and automates the orchestration of AI development agents.

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

**Coverage enforcement in CI:** The merge gate (`.github/workflows/merge-gate.yml`) runs `npm run test:coverage` for the shared, backend, and frontend workspaces. Vitest is configured with coverage thresholds: backend uses 80% for statements, lines, and functions and 70% for branches; frontend uses 80% for statements and lines, 70% for branches, and 73% for functions (raised toward 80% as coverage improves). The CI job fails if any workspace is below its threshold. Frontend E2E tests (`*.e2e.test.tsx`) are run as part of the frontend test suite in the same job; the test step is bounded by a 20-minute timeout so the gate does not hang. The SPEC target of >80% coverage with passing E2E tests is thus enforced in CI.

## Assumptions and Constraints

- **SPEC.md markdown:** PRD content is standard markdown suitable for **remark**/**unified** parsing; non-standard extensions may force **raw** diff fallback for affected regions.
- **PRD size:** Full `fromContent` / `toContent` in diff API responses is acceptable for typical SPEC sizes; extremely large PRDs may later need chunking, pagination, or virtualization.
- **Frontend dependencies:** A rendered diff pipeline may add **remark**, **unified**, a markdown renderer (e.g. **react-markdown**), and **diff** or **diff-match-patch** for word-level highlighting within the existing frontend budget.
- **HIL transport:** PRD approval **WebSocket** payloads do **not** carry full diffs; clients fetch diff data via **GET** when the user opens the approval UI.
- **Todoist API v1 + official SDK:** The Todoist integration uses `@doist/todoist-api-typescript` (v7.6.0+). OAuth issues **long-lived access tokens** with no refresh token and no expiry; tokens persist until explicitly revoked. The SDK provides OAuth helpers and typed REST methods for projects, tasks, and token revocation.
- **One integration connection per provider per project:** A single `(project_id, provider)` pair is the v1 scope. Multi-account bindings per provider are out of scope.
- **Integration credentials:** `TODOIST_CLIENT_ID`, `TODOIST_CLIENT_SECRET`, and `TODOIST_REDIRECT_URI` are configured via environment variables per deployment. Tokens are stored encrypted at rest; never logged or returned to clients.
- **Polling-first sync:** Primary sync uses short-interval polling (60–120 s); Todoist webhooks and the incremental Sync API are deferred enhancements for latency-sensitive or high-volume deployments.
- **Sub-plan task cap:** Each plan node targets 8–15 tasks; the system enforces a hard upper bound of **15 tasks per plan node** and repairs or rejects planner output that exceeds it.
- **Sub-plan depth limit:** A maximum of **four plan levels** on any root-to-leaf path (root plan = level 1; deepest leaf plan = level 4). Deeper decomposition is blocked with a user-visible message suggesting scope narrowing in the SPEC.
- **Planning latency:** Recursive sub-planning adds LLM round-trips proportional to tree breadth × depth; concurrent LLM calls are limited per project and PRD context is cached per session to bound cost and latency.

## Feature List

Add under **Plan** phase:

- **GitHub issues as plans:** In project settings → Integrations, connect GitHub with a personal access token, select one repository, and explicitly sync its open issues into plans. Each issue creates a planning-state plan with its original title, description, and a visible GitHub source link. Imports fetch all issue pages, exclude pull requests, and use stable issue identity so repeat syncs and repository changes do not create duplicates or overwrite local plan edits. Imported plans require the normal task-generation and execution actions. This is a one-way import: it does not update or close GitHub issues. Sync results distinguish plans created from errors, with actionable reconnect and retry states.
- **Hierarchical sub-plans:** When a plan is too large or cross-cutting for a single batch of tasks, the planner decomposes it into **child sub-plans**—each with its own epic, scoped markdown content, and inter-plan dependency edges (`depends_on_plans`). Sub-plans can recurse up to **four levels** deep (root = level 1). Each leaf plan node generates at most **~15 implementation tasks**, keeping batches actionable for both agent execution and human review.
- **Complexity gate:** Before task generation, a pre-pass classifies the plan body to decide between **direct task generation** (plan is leaf-sized) and **sub-plan split** (plan is too broad). Heuristics include section count, estimated workstreams, and optional user or planner hints (`strategy: "tasks" | "sub_plans"`).
- **Plan tree UX:** The Plan phase UI shows the plan hierarchy as **nested rows** (indentation, expand/collapse) with per-node status, task count per epic, and a cap indicator. Users can trigger **Plan Tasks** on any node; at max depth the split action is disabled with an explanatory tooltip. New child plans without tasks show a **Generate tasks** CTA; blocked nodes explain upstream sub-plan dependencies.

Add under **Sketch** and **human-in-the-loop**:

- **PRD/SPEC approval diff:** For PRD/SPEC approval requests, the UI shows a **rendered markdown** diff by default (headings, lists, tables, code blocks) with **green** emphasis for additions, **red** strikethrough for deletions, and **word-level** highlights inside modified blocks. A **[Rendered | Raw]** toggle switches to a monospace line diff with line numbers and `+` / `-` markers. **Approve** and **Reject** (or equivalent) remain on the same surface; if markdown parsing fails, the UI **falls back to raw diff** with a short notice.
- **Sketch version history diff:** The version list at the bottom of **Sketch** includes **View Diff** on **each** history entry; it opens the same diff experience comparing that **fromVersion** snapshot to the **current** SPEC.md (optional explicit `toVersion`; default **current**).

Add under **Execute** phase:

- **Open in Editor:** In-progress task cards and the task detail sidebar expose an **Open in Editor** control when a worktree path is available; it opens the worktree (or repo root in **branches** mode with a **shared-checkout** warning) in the user's preferred editor (**VS Code**, **Cursor**, or **auto** from global settings). If the path is missing, the task is not in progress, or the editor CLI is unavailable, the control is disabled with tooltips or inline guidance; pure web clients get **copy path** / pasteable commands.
- **Live Chat with Execute agent:** For **Claude API, OpenAI, Google/Gemini, LM Studio, and Ollama** (shared `runAgenticLoop`), users send messages that are **queued and injected between agentic turns** as real user turns (replacing the default continuation). **Claude CLI, Cursor CLI, and Custom CLI** backends disable chat with an explicit **switch to API mode** message. The Execute sidebar combines **Output** (streaming logs) and **Chat** (Sketch/Plan-style `PrdChatPanel` pattern): optimistic send, **Waiting for response…** while the agent processes, persisted **per-attempt** history (survives refresh), bounded pending-message queue, and WebSocket delivery/receipt events.

Add under **Evaluate** phase:

- **Todoist integration for feedback import:** From project settings (**Integrations** subsection), users connect a Todoist account via OAuth, select **one Todoist project** as the feedback source, and enable background sync. New Todoist tasks are automatically imported as Evaluate feedback items (text from task title, description and labels preserved as provenance metadata). After **durable persistence** of the feedback row and import ledger entry, the source task is **permanently deleted** from Todoist to keep the inbox clean. An optional **Import existing open tasks** toggle controls whether pre-existing tasks are included on first connect. The settings surface shows connection status, selected project, last sync time, and error/reconnect states.
- **Provider-agnostic integration framework:** The integration data model (`integration_connections`, `integration_import_ledger`) is designed for reuse across future providers (Slack, GitHub Issues, email) without schema changes. Adding a provider requires a new `provider` value, a provider-specific sync service, and OAuth route handlers—no new tables.

## Technical Architecture

**Plan sub-plan decomposition**

- **Complexity gate:** Before full task generation, classify plan body (section count, estimated workstreams, user hints, or explicit planner JSON `strategy: "tasks" | "sub_plans"`) to decide leaf generation vs sub-plan split.
- **Sub-plan creation:** When splitting, the planner returns **N sub-plan specs** (title, overview, scoped markdown slices, `depends_on_plans` between siblings/peers). Backend creates **child plan rows** + **child epics**, wires `parent_plan_id`, and increments depth. Each child plan's depth is validated against the max (4).
- **Recursive task generation:** For each leaf plan node, run task generation with prompt context including truncated ancestor chain, sibling summaries, and PRD excerpt—extending the existing `plan.content` + `prdContext` pattern in `plan-task-generation.ts`. Task count is validated ≤ 15; over-cap output is repaired (merge/drop prompt) or rejected.
- **Cross-epic dependencies:** Existing task/plan dependency mechanisms (`blocks` edges between tasks or epics) are used across sub-plans when the planner declares cross-subplan ordering; title/id normalization follows `planner-normalize.ts` patterns.
- **Depth enforcement:** At max depth (level 4), force leaf task generation only with consolidated instructions; refuse further splits. If the agent cannot comply, surface a user-facing message suggesting scope narrowing in the SPEC.
- **Partial failure:** Child plans created but task gen fails on one node leave consistent statuses; retry is per-node; `plan.updated` WebSocket events fire per successful node.
- **Performance:** Limit concurrent LLM calls per project during recursive decomposition; cache PRD context string per session; sequence sub-plan creation to avoid conflicting epic IDs.

**Execute inspect and live chat**

- **Open in Editor:** Backend resolves **worktree path** from `BranchManager` and/or active assignment, validates on-disk existence, and returns path plus resolved **editor preference** (`vscode` | `cursor` | `auto`). Desktop/Electron uses `child_process` or **URI schemes** (`vscode://file/…`, `cursor://file/…`); browser-only clients use path + copy command fallback. Editor CLI availability is detected for UX messaging.
- **Agentic loop:** `runAgenticLoop` accepts an optional **async pending-messages channel**; after tool results and before the next `adapter.send`, the loop drains the channel and uses the concatenated user text as the next user message instead of **Continue.** Multiple queued messages are merged in order with delimiters; the channel is **bounded** to cap backlog.
- **`AgentChatService`:** Validates task/agent liveness and **API vs CLI** backend; **persists** turns to `.opensprint/active/<taskId>/chat-log.jsonl` (JSONL: `id`, ISO `timestamp`, `role`, `content`, `attempt`); pushes to the active loop's channel; exposes **history** and **`supportsChat`**. `ActiveAgentsService` holds the channel reference for the running API agent only.
- **Real-time:** WebSocket types **`agent.chat.send`** (client→server), **`agent.chat.received`**, **`agent.chat.response`**, **`agent.chat.unsupported`** (defensive for CLI). Execute **status/active task** payloads should reliably include **`worktreePath`** where applicable.
- **Frontend:** **Open in Editor** on `TaskDetailHeader` and kanban task cards (`BuildEpicCard`); Execute sidebar **Output | Chat** tabs reusing **`PrdChatPanel`** patterns (draft persistence, Enter / Shift+Enter, delivery indicator).

**PRD diff (HIL + Sketch history)**

- **Server-side diff:** Compute a **line-level** diff between two full SPEC.md strings and return **`fromContent`**, **`toContent`**, and **`diff.lines`** (`add` | `remove` | `context`, optional old/new line numbers, optional summary counts). Prefer server-side generation for consistency and to keep the HIL WebSocket payload free of large diff blobs.
- **Rendered pipeline (client):** Reusable **DiffView** — **block-level** comparison on markdown ASTs (**remark**/**unified**), then **word-level** diff inside blocks that changed (**diff** or **diff-match-patch**). Entirely new or removed blocks use block-level green/red styling; incompatible structural changes are treated as remove + add. **Raw** mode renders `diff.lines` only.
- **Integration:** **DiffView** is used for (1) PRD/SPEC **HIL** approvals when the request type indicates SPEC changes, and (2) **Sketch** version history **View Diff**. Sticky or floating actions keep **Approve**/**Reject** usable on long diffs.
- **Edge behavior:** Identical or empty sides show a **No changes** state; stale bases (SPEC changed after proposal) warrant a warning and refresh path; invalid `requestId` or missing snapshots return **404** with dismissible UI errors.

**Evaluate integrations (Todoist and provider-agnostic framework)**

- **OAuth flow:** Three-step OAuth (authorize → callback → token exchange) using the Todoist SDK (`getAuthorizationUrl`, `getAuthToken`). Backend generates and validates a CSRF `state` parameter with server-side expiry. Tokens are encrypted before storage; `revokeToken` is called on disconnect.
- **Sync worker:** A `TodoistSyncService` polls `api.getTasks({ projectId })` at a configurable interval (default 60–120 s). Each sync cycle: fetch tasks → filter by ledger (skip already-imported `external_item_id` values) → process in `addedAt` order → for each task, INSERT ledger claim + create `FeedbackItem` (with `extra.source = "todoist"` provenance) + enqueue categorization → on DB commit, call `api.deleteTask(id)` and mark ledger `completed`. Cycle is capped (e.g. 50 tasks) to bound duration.
- **Failure handling:** If `deleteTask` fails, ledger stays at `pending_delete` with incremented `retry_count`; retried on next cycle. 404 on delete treated as success (task already removed). 401/403 from Todoist sets connection `status = 'needs_reconnect'` and pauses sync. 429 triggers backoff using `retry_after`.
- **Idempotency:** `UNIQUE(project_id, provider, external_item_id)` on the import ledger prevents duplicate feedback. Crashes between feedback insert and Todoist delete are reconciled on next sync via `pending_delete` status.
- **Frontend:** Project settings **Integrations** card with OAuth connect/disconnect, Todoist project picker (`api.getProjects()`), **Import existing open tasks** toggle, last-sync status, error banner, and **Sync Now** manual trigger.

## Data Model

**Plan hierarchy (sub-plans):** Extend the `plans` table with nullable **`parent_plan_id`** (`TEXT`, same `project_id` scope) referencing a parent plan's `plan_id`. Index on `(project_id, parent_plan_id)`. Depth is derived by walking the parent chain (or optionally stored/cached). Shared types (`Plan`, `PlanMetadata`) gain **`parentPlanId`** (nullable string), **`depth`** (integer, root = 1), and **`childPlanIds`** (computed array). `plan_versions` snapshots apply per plan node; splitting a plan into sub-plans creates version 1 for each child. Tasks continue storing `parentId` = owning epic; no change to task ID format required since each sub-plan keeps its own epic.

**Global settings:** Extend `GlobalSettings` with optional **`preferredEditor`**: `'vscode' | 'cursor' | 'auto'` (default/auto behavior as implemented).

**Chat log (file-backed, no core DB migration):** `.opensprint/active/<taskId>/chat-log.jsonl` — one JSON object per line with `id`, `timestamp`, `role` (`user` | `assistant`), `content`, `attempt` (execution attempt number). Undelivered user messages may be recorded when the agent completes before delivery (per product rules).

**WebSocket / shared types:** Extend `WebSocketEventType` (or equivalent) with **`agent.chat.send`**, **`agent.chat.received`**, **`agent.chat.response`**, **`agent.chat.unsupported`**.

**Execute telemetry:** Active task / execute status events include **`worktreePath`** consistently when a worktree exists, supporting editor open and diagnostics.

**SPEC version snapshots:** On each SPEC.md save, persist **full file text** keyed by the **version identifier** returned from PRD history (e.g. `GET .../prd/history`) so `GET .../prd/diff` can reconstruct `fromContent` for any prior version. Add snapshot-on-write if not already present; initial scope does **not** require changing the public history list response schema.

**Pending PRD HIL proposals:** Store or reference enough state (e.g. **`requestId`**, proposal content handle) for **`GET .../prd/proposed-diff`** to resolve **proposed** text vs **current** repo SPEC; avoid embedding full diff objects in **`hil.request`** payloads.

**Integration connections (`integration_connections` table):** Provider-agnostic table — one row per connected provider per project. Key columns: `id` (UUID PK), `project_id`, `provider` (`'todoist'`, future `'slack'`/`'github'`/`'email'`), `provider_user_id`, `provider_user_email`, `provider_resource_id` (selected Todoist project ID), `provider_resource_name`, `access_token_enc` (encrypted), `refresh_token_enc` (NULL for Todoist), `token_expires_at` (NULL for non-expiring), `scopes` (JSON array), `status` (`'active'` / `'needs_reconnect'` / `'disabled'`), `last_sync_at`, `last_error`, `config` (provider-specific JSON — poll interval, backfill flag, etc.), `created_at`, `updated_at`. **UNIQUE** `(project_id, provider)`. Indexes on `project_id` and `(project_id, provider, status)`.

**Integration import ledger (`integration_import_ledger` table):** Tracks every imported item for idempotency and delete-retry. Columns: `id` (auto PK), `project_id`, `provider`, `external_item_id` (Todoist task ID, etc.), `feedback_id` (created feedback row), `import_status` (`'pending_delete'` / `'completed'` / `'failed_delete'`), `last_error`, `retry_count`, `created_at`, `updated_at`. **UNIQUE** `(project_id, provider, external_item_id)`. Index on `(project_id, provider, import_status)` for retry queries.

**Feedback provenance:** `feedback.extra` JSON (existing column, no migration) gains Todoist provenance fields: `source`, `todoistTaskId`, `todoistProjectId`, `importedAt`.

**Environment variables:** `TODOIST_CLIENT_ID`, `TODOIST_CLIENT_SECRET`, `TODOIST_REDIRECT_URI` — required for Todoist OAuth; per-deployment configuration.

## API Contracts

The statement that **no new REST endpoints are required for quality-gate diagnostics** remains true for merge/gate failures; **additional REST and WebSocket contracts** apply to Plan hierarchy, Execute inspect/chat, and PRD diff:

**Plan hierarchy endpoints:**

- **`POST .../plans/:planId/plan-tasks`:** Existing endpoint; behavior expands to **orchestrate** sub-plan creation + nested task generation when the complexity gate triggers a split. For leaf-sized plans, behavior is unchanged (one epic, one batch of tasks). Returns task/sub-plan creation results.
- **`GET /api/projects/:projectId/plans/:planId/hierarchy`:** Returns `{ planId, epicId, depth, parentPlanId?, children: [{ planId, epicId, depth, taskCount, status, children }] }` tree for UI rendering without N+1 calls.
- **`POST .../plans/:planId/split-subplans`** _(optional, if split is separated from task gen):_ Idempotent split suggestion application; returns created child plan IDs and their epic IDs.
- **Plan list/detail payloads** include **`parentPlanId`** and **`depth`** so clients can render trees or filter by hierarchy level.
- **Errors:** **`400`** with machine-readable code when depth limit (4) exceeded or task batch over cap (15) after repair attempts; **`409`** if split would orphan plan versions. Aligns with existing `AppError` patterns.

**Execute inspect and chat endpoints:**

- **`GET` / `PUT /api/global-settings`:** Include **`preferredEditor`** (`vscode` | `cursor` | `auto`); validate on write.
- **`POST /api/projects/:projectId/tasks/:taskId/open-editor`:** Returns `{ worktreePath, editor, opened }` when the task is actively executing and the path exists; **404** if task/worktree missing, **409** if not in an executable in-progress state. _(Exact path prefix must match the product's `/api` routing convention.)_
- **`GET .../tasks/:taskId/chat-history`:** Query `attempt` (optional); response `{ messages[], attempt, chatSupported }`.
- **`GET .../tasks/:taskId/chat-support`:** Response `{ supported, backend, reason | null }` for gating the Chat tab.

**PRD diff endpoints:**

- **`GET /api/projects/:projectId/prd/proposed-diff?requestId=<hilRequestId>`:** Returns **`200`** with `{ requestId, fromContent, toContent, diff: { lines[], summary? } }` for PRD/SPEC approval UI; **`fromContent`** is current SPEC, **`toContent`** is proposed. **`404`** if the request is unknown or not a PRD-approval type.
- **`GET /api/projects/:projectId/prd/diff?fromVersion=<versionId>&toVersion=<versionId|'current'>`:** Omit or set **`toVersion`** to **`current`** to compare a historical snapshot to the live SPEC. **`200`** body mirrors the proposed-diff shape plus `fromVersion` / `toVersion`. **`404`** if a version or stored snapshot is missing.

**WebSocket events:**

- Client **`agent.chat.send`** `{ taskId, message }`; server **`agent.chat.received`**, **`agent.chat.response`**, **`agent.chat.unsupported`** with task and message identifiers as specified in the implementation plan. **`hil.request` / `hil.respond`** behavior stays the same for approve/reject; consumers **ignore unknown fields** for forward compatibility.

**Todoist integration endpoints** (under `/api/projects/:projectId/integrations/todoist`):

- **`GET .../integrations/todoist/status`:** Returns `{ connected, todoistUser?: { id, email? }, selectedProject?: { id, name }, lastSyncAt?, lastError?, status }`. No tokens exposed.
- **`POST .../integrations/todoist/oauth/start`:** Returns `{ authorizationUrl, state }` (state stored server-side with expiry).
- **`GET .../integrations/todoist/oauth/callback`:** Query params `code`, `state`; validates state, exchanges code for token via SDK `getAuthToken()`, encrypts and stores in `integration_connections`, redirects to app settings with success/error flash.
- **`GET .../integrations/todoist/projects`:** Returns `{ projects: [{ id, name, taskCount? }] }` for project picker UI.
- **`PUT .../integrations/todoist/project`:** Body `{ todoistProjectId }`, validates against fetched list, persists `provider_resource_id` and `provider_resource_name`.
- **`POST .../integrations/todoist/sync`:** Manual sync trigger; returns `{ imported, errors }` (rate-limited).
- **`DELETE .../integrations/todoist`:** Disconnect — revokes token via SDK, deletes `integration_connections` row. Optional prompt about `pending_delete` ledger entries.

## Non-Functional Requirements

| Category                | Requirement                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usability               | Plan tree UI shows **nested rows** with expand/collapse, per-node status, task count per epic, and a cap indicator (**~15 max per batch**); split action is disabled at max depth with an explanatory tooltip; new child plans show a **Generate tasks** CTA.           |
| Usability               | Execute **Output** and **Chat** share familiar Sketch/Plan chat patterns (bubbles, keyboard shortcuts, draft persistence, clear disabled states for non-running tasks and CLI backends).                                                                                |
| Usability               | PRD diff UIs reuse one **DiffView**: **Rendered** default, **Raw** toggle, keyboard-accessible controls, and non-color-only cues (strikethrough, labels/ARIA) for additions and deletions.                                                                              |
| Usability               | Integration settings surface clear connection status, **Sync Now** manual trigger, and actionable error/reconnect states; **Import existing open tasks** toggle prevents surprise mass imports on first connect.                                                        |
| Reliability             | Planner output exceeding **15 tasks** per node is **repaired** (merge/drop prompt) or hard-rejected; circular `depends_on_plans` edges are validated as a DAG before persistence.                                                                                       |
| Reliability             | Partial sub-plan tree failures (some child plans created, task generation fails on one node) leave consistent statuses and allow **per-node retry** without data loss; `plan.updated` WebSocket events fire per successful node.                                        |
| Reliability             | User chat messages are **queued at turn boundaries**; **bounded** pending queue prevents unbounded memory; if the agent finishes before delivery, persisted history reflects **undelivered** user messages per product rules.                                           |
| Reliability             | PRD diff responses remain consistent if the client toggles modes; large SPEC files may use pagination, caps, or virtualization to protect responsiveness.                                                                                                               |
| Reliability             | Todoist sync is **idempotent**: `UNIQUE(project_id, provider, external_item_id)` prevents duplicate feedback; `pending_delete` ledger status with retry ensures no data loss when Todoist delete fails; crashes between insert and delete are reconciled on next cycle. |
| Compatibility           | **Open in Editor** degrades gracefully: missing CLI → install guidance + **copy path**; **branches** mode warns about **shared checkout**; multiple browser tabs deduplicate by **message id**.                                                                         |
| Compatibility           | PRD **rendered** diff falls back to **raw** when markdown parsing fails; structural markdown changes may appear as block remove+add rather than cross-type word diff.                                                                                                   |
| Compatibility           | Todoist integration detects **token revocation** (401/403) and transitions to `needs_reconnect` with a user-facing reconnect prompt; **rate-limit** (429) responses trigger backoff without data loss.                                                                  |
| Security / privacy      | Chat content is stored **locally** under `.opensprint/active/<taskId>/` (JSONL) alongside assignment artifacts—treat as sensitive project data in backups and retention policies.                                                                                       |
| Security / privacy      | SPEC snapshots and proposal text used for diffs are **project-local** data; apply the same backup and access controls as SPEC.md and `.opensprint` metadata.                                                                                                            |
| Security / privacy      | Todoist OAuth tokens are stored **encrypted at rest** in `integration_connections`; never logged or returned to API clients. Imported task content (titles, descriptions) may contain PII—apply the same retention and access controls as other feedback data.          |
| Theming / accessibility | Diff highlight colors respect **light/dark/system** themes with sufficient contrast; screen readers should be able to perceive added vs removed text.                                                                                                                   |
| Theming / accessibility | Plan tree supports **keyboard navigation** (arrow keys for expand/collapse/focus), visible focus indicators, and non-color-only status cues for sub-plan states.                                                                                                        |

## Review governance and policy evolution

Review governance is opt-in and progresses from shadow recommendations to bounded enforcement and human-approved amendments. Enabled projects review every task. A project that was never enabled, or is disabled with no pinned work, open docket, or pending publication, keeps ordinary review behavior; disabling does not release work that governance already retains, which stays governed until it completes or a human rules on it. Each assignment pins a complete immutable approved release, rendered instructions, trusted task scope, and its merge base before spawning. Each task is judged at the stricter of its pinned mode and the current mode, and enforced mode admits only pinned tasks. Rule resolution deterministically includes applicable rules, mandatory parents, and explicit same-layer overrides; conflicts, repository policy drift, missing policy, and mandatory context overflow withhold approval in enforced mode. Drift in Open Sprint's own runtime is audited, not blocking, and shadow mode records drift, missing source approval, and unstructured review without changing the review outcome. Review coverage refreshes when changed paths expand.

Reviewers return concrete structured findings. Blocking standards findings cite approved rule revisions; defects and hard-gate failures remain independently reportable. Coders may appeal with alternatives analyzed, evidence, risks, and requested limits. One reviewer reconsideration and independent tool-free judge cycle per material finding is bounded by persistent task-wide budgets. Model authority is limited to findings whose rule does not bind the file, judged from approved paths and `mandatory` alone rather than which roles receive the rule, and to unrevoked reusable precedent from the same release. A model cannot withdraw a finding on a rule that applies, even an exception-eligible one; that case escalates. Uncertainty and novel exceptions go to humans. Recommendations cannot waive deterministic scope checks or merge gates.

Durable dockets record the policy, code fingerprint, complete evidence, competing arguments, precedent, and recommendation. Authorized humans require a fix, allow once, allow under explicit reusable conditions and expiry, request evidence, cancel, or abandon the work (closing the task unmerged). Stale or human-cancelled cases cannot request evidence or grant an allowance. Actions use optimistic concurrency and idempotency. Rulings and corrections are append-only events. A waiting task releases agent slots, retains its worktree and evidence lease, and recovers after restart. Ordinary notification/task operations, review disablement, and the autonomy slider cannot release governance holds. Serialized final admission checks actual candidate code, unresolved findings/cases, revocation, policy compatibility, trusted scope, and hard gates before publication; changed code invalidates stale dispositions.

Remote conflict-resolution changes receive fresh review and hard checks against the actual remote base, preserving original per-file scope and compatible approved policy. Retained review tasks recover without re-running the initial coder; rejected code may enter a fix cycle. Pending publication suppresses automatic deployment. Deferred deployment survives restart and binds execution to verified published code. Governed project archive/deletion requires owner authority and completed governed work with no outstanding docket or publication.

Governance mutation requires a separate server-enforced named human capability that task subprocesses do not inherit. Local same-OS-account use is cooperative; stronger shared-host isolation requires separate operating-system authority. Decisions and replay fixtures have retention independent of pruned session logs. Precedent is project-local, exact-rule-compatible, revocable, and reusable only when trusted facts satisfy the approved versioned predicate language.

Congress consumes decision events independently of code-audit changes. Repeated conflicts nominate standards for review without changing them. Amendments include exact executable before/after rule and instruction content, supporting and contrary decisions, positive/negative examples, scope, and enforcement compatibility. A pinned offline executor runs real baseline/candidate agents and independent deterministic evaluation against original retained inputs, including held-out positive and negative examples. Unsupported isolation or missing inputs is incomplete; synthetic outcomes cannot justify activation. All policy-affecting changes need human approval regardless of autonomy. Atomic activation/rollback changes the complete immutable release content and requires compatible landed enforcement; incompatible code changes need normal scoped implementation tasks and quality gates.

Pilot evaluation tracks queue age, human attention, reversals, sampled missed violations, context coverage, retries, cost and latency against the existing workflow. A small replay sample is a smoke test; insufficient or conflicting evidence keeps deployment in shadow mode.

## Open Questions

All previously identified questions have been resolved and documented in the Resolved Decisions section of the full PRD. No open questions at this time.

## Competitive Landscape

### Overview

Open Sprint sits in the “AI-assisted product development” space. Alternatives range from no-code chat-to-app builders to IDE-centric coding agents. The comparison below focuses on full-lifecycle and “idea to working product” tools rather than single-step UI generators (e.g. v0, Locofy).

### Lovable (lovable.dev)

- **Positioning:** No-code app builder; “build apps and websites by chatting with AI.”
- **Strengths:** Fast iteration, low friction for non-engineers, chat-first UX.
- **Limitations:** Centered on UI/app generation from conversation; no explicit PRD/spec phase, no dependency-aware task graph or Evaluate → Execute feedback loop. Tied to their hosted experience.
- **Open Sprint differentiator:** Full SPEED lifecycle with a written spec (SPEC.md), dependency-aware planning, human-in-the-loop, and optional use of your repo + local or custom agents (including offline).

### Bolt (bolt.new)

- **Positioning:** “Vibe coding” and professional coding agents; chat-to-build with integrated frontier models, testing/refactoring, and Bolt Cloud (hosting, DB, auth, SEO).
- **Strengths:** Single UI for multiple AI backends, built-in testing and iteration, cloud backend and scaling story.
- **Limitations:** Emphasis on “build in one place” with their stack; less focus on a formal spec phase or on flowing a single PRD through plan → execute → evaluate. Primarily cloud-hosted.
- **Open Sprint differentiator:** SPEC.md as the single source of truth, explicit Sketch → Plan → Execute → Evaluate → Deliver workflow, worktree/branch-based workflow with merger handling, and ability to run fully offline with LM Studio or other local agents.

### Gas Town (gastown.io)

- **Positioning:** AI-powered product or development workflow tool in the idea-to-ship space.
- **Open Sprint differentiator:** Open Sprint emphasizes a phased lifecycle (Sketch/Plan/Execute/Evaluate/Deliver), a file-based spec at repo root, and orchestration that respects task dependencies and feedback loops rather than ad-hoc prompting.

### Other Adjacent Tools

- **Cursor / IDE coding assistants:** Strong for in-editor coding; they do not provide a shared PRD, multi-phase workflow, or structured Evaluate → Execute loop.
- **Replit Agent, etc.:** Often centered on in-environment generation and deployment; typically no first-class spec or dependency-aware task orchestration.

### Summary Table

| Dimension          | Open Sprint                                    | Lovable / Bolt-style builders      |
| ------------------ | ---------------------------------------------- | ---------------------------------- |
| Spec / PRD         | SPEC.md at repo root; first-class phase        | Implicit or lightweight            |
| Lifecycle          | Sketch → Plan → Execute → Evaluate → Deliver   | Chat → build (and optionally ship) |
| Task orchestration | Dependency-aware, priority-ordered tasks       | Largely prompt/session-driven      |
| Feedback loop      | Evaluate maps to tasks; fixes re-enter Execute | Manual or tool-specific            |
| Agent choice       | Claude, Cursor, OpenAI, LM Studio, custom CLI  | Typically vendor’s models/hosted   |
| Offline            | Supported (e.g. LM Studio)                     | Generally requires cloud           |
| Repo / Git         | Works with existing repos; worktree + merger   | Often tied to platform repos       |
