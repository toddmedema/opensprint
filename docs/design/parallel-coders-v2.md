# Design: Concurrent Multi-Coder Execution (v2)

**Status:** Draft  
**Author:** OpenSprint Design  
**PRD Reference:** §5.7, §15, §17 (v2.0 milestone)

---

## 1. Problem Statement

Today's orchestrator enforces a **single-agent constraint**: one Coder or Reviewer runs at a time per project (PRD §5.7). This is the primary throughput bottleneck — a project with 20 ready tasks processes them serially even when many tasks are completely independent.

The goal is to allow **N concurrent Coder agents** executing independent tasks in parallel while preventing merge conflicts, wasted work, and state corruption.

### 1.1 What Already Works

The v1 architecture provides strong foundations:

| Primitive                                                   | How it helps                                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Git worktrees** (`branch-manager.ts`)                     | Each task already gets an isolated filesystem at `/tmp/opensprint-worktrees/<task-id>` on branch `opensprint/<task-id>`. Agents never share a working directory. |
| **Serialized commit queue** (`git-commit-queue.service.ts`) | All merges to `main` flow through a FIFO queue, preventing `.git/index.lock` contention.                                                                         |
| **Merger agent** (`orchestrator.service.ts:1205`)           | When `pushMain` hits rebase conflicts, a conflict-resolution agent is already spawned.                                                                           |
| **Branch-per-task**                                         | Every task works on its own branch, so git-level isolation is already in place.                                                                                  |
| **Dependency tracking** (beads `blocks` relation)           | `bd ready` already filters to tasks whose dependencies are all resolved.                                                                                         |

### 1.2 What's Missing

| Gap                           | Risk if unaddressed                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| No file-overlap analysis      | Two agents modify the same files → guaranteed merge conflicts                                    |
| No parallel scheduling logic  | Orchestrator loop picks one task, blocks on it, picks the next                                   |
| State model is single-agent   | `OrchestratorState` tracks one `activeProcess`, one `activeBranchName`, one `activeWorktreePath` |
| Merge queue is serial         | Fine for one agent, becomes a bottleneck with N agents finishing concurrently                    |
| No base-state synchronization | Agent B starts from the same `main` as Agent A; A's changes are invisible to B until merge       |
| Reviewer is sequential        | Creates a review queue behind the single-reviewer gate                                           |

---

## 2. Design Principles

1. **Conflict avoidance over conflict resolution.** Preventing two agents from touching the same files is far cheaper than resolving merge conflicts after the fact. The merger agent is a safety net, not the primary strategy.

2. **Incremental adoption.** The system should support `maxConcurrentCoders: 1` (today's behavior) through `maxConcurrentCoders: N` via a single configuration knob. No behavioral change for v1 users.

3. **Optimistic with guardrails.** We predict conflicts using static analysis of the Plan's file scope, but still handle unexpected conflicts gracefully via the existing merger agent.

4. **Preserve the commit queue.** Merges to main remain serialized. This is cheap (merges are fast) and eliminates an entire class of concurrency bugs. The queue just needs to handle higher throughput.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Orchestrator Loop                        │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Task Picker  │───▶│   Scheduler  │───▶│  Agent Pool  │  │
│  │  (bd ready)   │    │ (conflict-   │    │ (N workers)  │  │
│  │              │    │  aware)      │    │              │  │
│  └──────────────┘    └──────────────┘    └──────┬───────┘  │
│                                                  │          │
│                              ┌────────────────────┘          │
│                              ▼                               │
│                    ┌──────────────────┐                      │
│                    │   Merge Queue    │                      │
│                    │  (serial, FIFO)  │                      │
│                    └────────┬─────────┘                      │
│                             │                                │
│                    ┌────────▼─────────┐                      │
│                    │  Rebase + Push   │                      │
│                    │  (merger agent   │                      │
│                    │   on conflict)   │                      │
│                    └──────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

Three new components are introduced:

1. **File Scope Analyzer** — predicts which files a task will touch
2. **Conflict-Aware Scheduler** — selects non-overlapping tasks for parallel execution
3. **Agent Pool** — manages N concurrent agent slots (replacing the single-agent state)

---

## 4. File Scope Analyzer

### 4.1 Purpose

Before dispatching a task, predict the set of files it will modify. This prediction doesn't need to be perfect — false positives (predicting a file that won't be touched) reduce parallelism but don't cause failures. False negatives (missing a file that will be touched) may cause merge conflicts, which the merger agent handles.

### 4.2 Prediction Sources (layered, from most to least reliable)

**Layer 1 — Explicit Plan annotations (highest confidence).** The Planner agent already produces a `Technical Approach` section in each Plan markdown. We extend the Planner's output schema to include a `files` field:

```json
{
  "title": "Add user avatar upload",
  "depends_on": [0],
  "files": {
    "modify": ["src/services/user.service.ts", "src/routes/user.routes.ts"],
    "create": ["src/services/avatar.service.ts", "src/routes/avatar.routes.ts"],
    "test": ["src/__tests__/avatar.test.ts"]
  }
}
```

This is the cheapest and most reliable source because the Planner already reasons about implementation details. The orchestrator stores these annotations on the bead issue as structured metadata.

**Layer 2 — Dependency-chain inference (medium confidence).** If task B depends on task A, and task A modified `src/services/user.service.ts`, task B likely touches the same file or its neighbors. The orchestrator already collects dependency diffs (`context-assembler.ts:170`); we extract the file list from those diffs.

**Layer 3 — Heuristic directory scoping (low confidence, broad).** If no file-level data is available, fall back to directory-level scoping based on the task title and description. A task titled "Add avatar upload endpoint" likely touches `src/routes/` and `src/services/`. This is deliberately broad to avoid false negatives.

### 4.3 Interface

```typescript
interface FileScope {
  taskId: string;
  /** Files predicted to be modified or created */
  files: Set<string>;
  /** Directories predicted to be affected (broader fallback) */
  directories: Set<string>;
  /** Confidence: "explicit" (from Planner), "inferred" (from deps), "heuristic" */
  confidence: "explicit" | "inferred" | "heuristic";
}

class FileScopeAnalyzer {
  /** Predict file scope for a task before dispatching */
  async predict(repoPath: string, task: BeadsIssue, beads: BeadsService): Promise<FileScope>;

  /** Record actual files modified after a task completes (improves future predictions) */
  async recordActual(repoPath: string, taskId: string, changedFiles: string[]): Promise<void>;

  /** Check if two file scopes overlap */
  overlaps(a: FileScope, b: FileScope): boolean;
}
```

### 4.4 Overlap Detection

Two scopes overlap if:

- Any files in `a.files` appear in `b.files`, OR
- Any files in `a.files` are within directories in `b.directories` (or vice versa), AND the lower-confidence scope is the directory-level one

When both scopes are `explicit` confidence, we use strict file-set intersection. When either is `heuristic`, we use the broader directory intersection. This errs on the side of caution.

---

## 5. Conflict-Aware Scheduler

### 5.1 Purpose

Replace the "pick one task" logic in `runLoop()` with a scheduler that selects up to `maxConcurrentCoders` non-overlapping tasks from the ready queue.

### 5.2 Algorithm

```
function selectTasks(readyTasks, activeScopes, maxSlots):
    available = maxSlots - activeAgentCount
    if available <= 0: return []

    selected = []
    combinedScope = union(activeScopes)  // files already being worked on

    for task in readyTasks (priority order):
        scope = fileScopeAnalyzer.predict(task)
        if not overlaps(scope, combinedScope):
            selected.push({ task, scope })
            combinedScope = union(combinedScope, scope)
            if selected.length >= available: break

    return selected
```

Key properties:

- **Priority-preserving.** Higher-priority tasks are considered first, same as today.
- **Greedy but safe.** A task is only selected if it doesn't overlap with any currently running or already-selected task.
- **Degrades gracefully.** If all remaining tasks overlap with active work, the scheduler waits — identical to v1 behavior but with more tasks running.

### 5.3 Configuration

```typescript
interface ExecutionSettings {
  /** Max concurrent Coder agents. 1 = v1 behavior. Default: 1. */
  maxConcurrentCoders: number;
  /** Max concurrent Reviewer agents. Default: 1. */
  maxConcurrentReviewers: number;
  /** Strategy when file scope is unknown: "conservative" (don't parallelize) | "optimistic" (allow, rely on merger) */
  unknownScopeStrategy: "conservative" | "optimistic";
}
```

---

## 6. Agent Pool (State Model Changes)

### 6.1 Problem with Current State

`OrchestratorState` tracks a single agent:

```typescript
// Current: single agent
interface OrchestratorState {
  agent: AgentRunState; // ONE active process
  activeBranchName: string | null;
  activeWorktreePath: string | null;
  // ...
}
```

### 6.2 New: Per-Task Agent Slots

```typescript
interface AgentSlot {
  taskId: string;
  branchName: string;
  worktreePath: string;
  agent: AgentRunState;
  fileScope: FileScope;
  phase: "coding" | "review";
  attempt: number;
  phaseResult: PhaseResult;
  infraRetries: number;
  timers: TimerRegistry; // per-slot timers (heartbeat, inactivity)
}

interface OrchestratorState {
  status: OrchestratorStatus;
  loopActive: boolean;
  globalTimers: TimerRegistry; // watchdog, loop scheduling
  slots: Map<string, AgentSlot>; // taskId → slot
  pendingFeedbackCategorizations: PendingFeedbackCategorization[];
}
```

Each running agent gets its own `AgentSlot` with independent timers, output logs, and lifecycle state. The orchestrator loop checks `slots.size < maxConcurrentCoders` instead of checking a single `agent.activeProcess`.

### 6.3 Lifecycle Manager Changes

`AgentLifecycleManager.run()` currently writes to a shared `AgentRunState`. With the pool model, each invocation gets its own `AgentRunState` within its `AgentSlot`. The lifecycle manager doesn't need to change — it already takes `runState` as a parameter. The orchestrator just passes the slot's state instead of the global state.

### 6.4 Status Broadcasting

Today, `OrchestratorStatus` has a single `currentTask`. With multiple agents:

```typescript
interface OrchestratorStatus {
  activeTasks: Array<{
    taskId: string;
    phase: "coding" | "review";
    startedAt: string;
  }>;
  queueDepth: number;
  totalDone: number;
  totalFailed: number;
}
```

WebSocket broadcasts (`execute.status`) include the full `activeTasks` array so the frontend can show all running agents simultaneously.

---

## 7. Merge Strategy

### 7.1 Serial Merge Queue (unchanged)

The existing `GitCommitQueueService` remains the single point of serialization for all main-branch mutations. When Agent A finishes, its merge is enqueued. If Agent B finishes while A is merging, B's merge waits in the queue. This is simple and correct.

### 7.2 Rebase-Before-Merge

When a merge job reaches the front of the queue:

1. **Rebase the task branch onto current main.** Since other tasks may have merged since this branch was created, the branch may be behind. A fast `git rebase main` in the worktree brings it up to date.
2. **Fast-forward merge to main.** After rebase, the merge is a fast-forward (no merge commit noise).
3. **If rebase conflicts:** Invoke the merger agent (already implemented). If resolution fails, abort and mark the task for retry with `merge_conflict` failure type (already handled by progressive backoff).

This is an enhancement over the current flow, which only rebases when pushing to `origin/main`. Rebasing onto local `main` first catches conflicts earlier.

### 7.3 Post-Merge Notification to Running Agents

After a successful merge, the orchestrator should notify other running agents that `main` has advanced. Options (in order of preference):

1. **Do nothing (recommended for v2.0).** Each agent works on its isolated branch. Conflicts are resolved at merge time. This is the simplest approach and matches how human developers work on parallel branches.

2. **Optimistic rebase (future enhancement).** After task A merges, automatically rebase task B's worktree onto the new main. This reduces merge conflicts at completion time but risks disrupting the agent mid-work. Only safe if the agent is between operations (detected via output inactivity).

---

## 8. Orchestrator Loop Changes

### 8.1 Current Loop (simplified)

```
runLoop():
    if agent running: return
    task = pickOne(bd ready)
    createWorktree(task)
    spawnAgent(task)
    // onDone: handleResult → merge → runLoop()
```

### 8.2 New Loop

```
runLoop():
    readyTasks = bd ready (filtered)
    activeScopes = getActiveScopes()
    available = maxConcurrentCoders - slots.size

    if available <= 0: return

    selected = scheduler.selectTasks(readyTasks, activeScopes, available)

    for each { task, scope } in selected:
        slot = createSlot(task, scope)
        createWorktree(task)
        spawnAgent(slot)

    // Each slot's onDone callback:
    //   handleResult → enqueue merge → on merge done:
    //     remove slot from pool
    //     runLoop()   // check if more tasks can be dispatched
```

Key difference: `runLoop()` is now **non-blocking**. It dispatches up to N agents and returns immediately. Each agent's completion callback triggers another `runLoop()` to fill any freed slots.

### 8.3 Nudge Semantics

`nudge()` currently exits if any agent is running. With the pool:

```typescript
nudge(projectId: string): void {
    const state = this.getState(projectId);
    if (state.loopActive) return;
    if (state.slots.size >= maxConcurrentCoders) return;  // all slots full
    this.runLoop(projectId);
}
```

---

## 9. State Persistence Changes

### 9.1 Multi-Slot Persistence

The persisted state file (`.opensprint/orchestrator-state.json`) needs to track multiple active agents:

```json
{
  "projectId": "...",
  "slots": [
    {
      "taskId": "bd-a3f8.2",
      "phase": "coding",
      "branchName": "opensprint/bd-a3f8.2",
      "worktreePath": "/tmp/opensprint-worktrees/bd-a3f8.2",
      "agentPid": 12345,
      "attempt": 1,
      "startedAt": "2025-01-15T10:00:00Z"
    },
    {
      "taskId": "bd-b7c2.1",
      "phase": "review",
      "branchName": "opensprint/bd-b7c2.1",
      "worktreePath": "/tmp/opensprint-worktrees/bd-b7c2.1",
      "agentPid": 12346,
      "attempt": 2,
      "startedAt": "2025-01-15T10:02:00Z"
    }
  ],
  "queueDepth": 5,
  "totalDone": 12,
  "totalFailed": 1,
  "lastTransition": "2025-01-15T10:02:00Z"
}
```

### 9.2 Crash Recovery

On restart, the crash recovery service iterates over all persisted slots (instead of a single task) and applies the same PID-alive / worktree-exists checks for each. Slots with dead PIDs are recovered independently.

---

## 10. Reviewer Parallelism

### 10.1 Approach

Reviewers are also bound by the single-agent constraint today. With the pool model, each `AgentSlot` transitions independently through coding → review. A task in the review phase occupies a "reviewer slot" rather than a "coder slot."

The simplest approach: a shared pool of `maxConcurrentCoders` slots where each slot can be in either coding or review phase. This means a project with `maxConcurrentCoders: 3` can run 2 coders + 1 reviewer simultaneously, or 1 coder + 2 reviewers, etc.

Alternatively, separate coder and reviewer pools (`maxConcurrentCoders` + `maxConcurrentReviewers`) allow finer control but add complexity.

**Recommendation:** Start with a single shared pool. Add separate pools later if users request it.

---

## 11. Implementation Plan

### Phase 1: Foundation (no behavior change)

1. **Refactor `OrchestratorState` to use `AgentSlot` map.** The map starts with `maxSize: 1`, so behavior is identical to v1. This is the riskiest change and should be landed first.
2. **Extract scheduling logic** from `runLoop()` into a `TaskScheduler` class with a `selectTasks()` method. Initially, it selects exactly one task (v1 parity).
3. **Update state persistence** to the multi-slot format. Maintain backward compatibility by reading the old single-task format during migration.

### Phase 2: File Scope Analyzer

4. **Extend the Planner output schema** to include `files` predictions. Update the Planner prompt template and the orchestrator's task-creation logic to store file metadata on beads issues.
5. **Implement `FileScopeAnalyzer`** with all three prediction layers. Add unit tests with known Plan structures.
6. **Record actual files changed** after each task completes (from `getChangedFiles()`). Store as bead metadata for future inference.

### Phase 3: Parallel Dispatch

7. **Update `TaskScheduler.selectTasks()`** to use overlap detection and return multiple tasks.
8. **Update `runLoop()`** to dispatch multiple agents per iteration.
9. **Update `nudge()`** to allow entry when slots are available (not just when idle).
10. **Update `handleTaskFailure` and `performMergeAndDone`** to operate on the correct slot without affecting other running agents.

### Phase 4: Merge Hardening

11. **Add rebase-before-merge** to the `worktree_merge` job in the commit queue.
12. **Improve merger agent context** — include the list of recently-merged tasks so it understands why conflicts exist.
13. **Add merge conflict metrics** — track conflict rate by task pair to improve future file scope predictions.

### Phase 5: UI & Observability

14. **Update `OrchestratorStatus`** WebSocket payload to include `activeTasks` array.
15. **Frontend: show multiple active agents** in the Execute view.
16. **Add parallel execution dashboard** showing slot utilization, conflict rate, and throughput.

---

## 12. Risks & Mitigations

| Risk                                            | Impact                             | Mitigation                                                                                                   |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| File scope prediction misses overlapping files  | Merge conflicts, wasted agent work | Merger agent resolves; `recordActual()` improves future predictions; conservative fallback for unknown scope |
| Test interference (shared test fixtures, ports) | Flaky tests, false failures        | Worktree isolation already helps; add test isolation docs; long-term: per-worktree test ports                |
| Agent cost increases with parallelism           | Higher API bills for hosted models | `maxConcurrentCoders` defaults to 1; user opts in; UI shows cost projection                                  |
| Merge queue becomes bottleneck                  | Agents idle waiting for merge      | Merges are fast (< 1s for non-conflicting); conflict resolution is the only slow path                        |
| Rebase disrupts agent mid-work                  | Corrupted working tree             | Do not rebase active worktrees (v2.0); add post-merge rebase as a future enhancement                         |
| Crash recovery complexity                       | Orphaned agents, stuck tasks       | Each slot recovers independently; same PID-alive check; orphan recovery already handles stale heartbeats     |

---

## 13. Success Metrics

- **Throughput:** Tasks completed per hour with N=3 should be ~2.5x single-agent (accounting for some serial merges).
- **Conflict rate:** < 10% of parallel merges should require the merger agent.
- **File scope accuracy:** > 80% of tasks should have explicit file annotations from the Planner.
- **No regressions:** Setting `maxConcurrentCoders: 1` produces identical behavior to v1.

---

## 14. Out of Scope (v2.0)

- Cross-project parallelism (separate orchestrator instances already handle this)
- Agent-to-agent communication during execution
- Dynamic slot scaling based on API rate limits
- Logical conflict detection (two tasks making semantically incompatible changes to different files)
- Optimistic mid-work rebasing of active worktrees

---

## 15. Decision Log

| Decision                                                   | Rationale                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Conflict avoidance via file scope, not reactive resolution | Merger agent success rate is uncertain at scale; preventing conflicts is strictly better               |
| Serial merge queue preserved                               | Eliminates concurrency bugs for a component that's fast anyway; proven in v1                           |
| Shared coder/reviewer pool (not separate)                  | Simpler; tasks naturally flow through phases at different rates                                        |
| Greedy scheduler (not optimal)                             | Optimal task selection is NP-hard (weighted set packing); greedy with priority ordering is good enough |
| No mid-work rebase                                         | Too risky; agents don't expect the working tree to change under them                                   |
| File scope stored as bead metadata                         | Natural location; survives restarts; accessible to context assembler                                   |
