# Agent Question Protocol

## Overview

Agents (Analyst, Dreamer, Planner, Coder) can emit **open questions** when they need human clarification before proceeding. The server parses these, creates notifications, and surfaces them through the Human Notification System. The autonomy level (hilConfig) is passed to all agents so they know when to ask (confirm all vs major only vs full autonomy).

## Protocol Format

### Structured Output (JSON)

Agents emit questions via a standard JSON field in their output:

```json
{
  "open_questions": [
    { "id": "q1", "text": "Which database should we use: PostgreSQL or SQLite?" },
    { "id": "q2", "text": "Should the API support pagination?" }
  ]
}
```

**Field names:** Both `open_questions` (snake_case) and `openQuestions` (camelCase) are accepted.

**Per-question shape:**
- `id` (optional): Unique identifier. If omitted, the server generates one.
- `text` (required): The question text shown to the user.
- `createdAt` (optional): ISO8601 timestamp; server sets if omitted.

### Agent-Specific Usage

| Agent | Source | sourceId | When to emit |
|-------|--------|----------|--------------|
| **Analyst** | eval | feedbackId | Feedback too vague to categorize; do NOT create tasks until answered |
| **Dreamer** | prd | sectionKey | Requirements unclear; wait for clarification before PRD update |
| **Planner** | plan | planId | Plan requirements ambiguous; emit before decomposing |
| **Coder** | execute | taskId | Task spec ambiguous; pause (or use HIL) rather than guessing |

### Fail-Early Behavior

- **Analyst:** When feedback is too vague, return `open_questions` instead of creating tasks. Do not create a ticket until questions are answered. At most one "Are you sure?"-style confirmation per feedback cycle; no duplicate re-prompts. Prefer tradeoff questions when appropriate (options A/B/C with pros and cons).
- **Dreamer/Planner:** When requirements are unclear, emit open questions and wait for clarification before proceeding.
- **Coder:** When task spec is ambiguous, emit open questions and pause rather than guessing.

## Server Integration

1. **NotificationService.create()** — Creates a notification in `open_questions` table.
2. **WebSocket** — Broadcasts `notification.added` to project clients.
3. **On resolve** — Broadcasts `notification.resolved`; for Execute source, unblocks the task.

### Execute (Coder) Flow

When Coder returns `status: "failed"` with non-empty `open_questions`:

1. Create notification (source=execute, sourceId=taskId).
2. Broadcast `notification.added`.
3. Unassign task (assignee=null), set status=blocked, block_reason="Open Question".
4. Task is excluded from `ready()` until user answers and notification is resolved.

When user answers via OpenQuestionsBlock:

1. Answer is sent to task chat.
2. PATCH `/projects/:id/notifications/:id` resolves the notification.
3. Server unblocks the task (status=open, block_reason=null).
4. Broadcast `notification.resolved` and `task.updated`.
5. Orchestrator picks task from `ready()` on next loop.

## Autonomy Level (hilConfig)

Project settings include `hilConfig`:

```ts
{
  scopeChanges: "automated" | "notify_and_proceed" | "requires_approval",
  architectureDecisions: "automated" | "notify_and_proceed" | "requires_approval",
  dependencyModifications: "automated" | "notify_and_proceed" | "requires_approval"
}
```

**Passed to agents via:**
- `config.json` in task directory (Coder/Reviewer)
- Prompt context (all agents)

**Human-readable mapping:**
- `automated` → "Full autonomy: proceed without confirmation"
- `notify_and_proceed` → "Notify user but proceed"
- `requires_approval` → "Confirm all changes before proceeding"

Agents use this to decide when to emit open questions vs. proceed autonomously.
