# Redux SPA Project Page Rearchitecture

## Overview

Rearchitect the frontend project page so that switching between phases (Design, Plan, Build, Validate) never loses context. Introduce Redux Toolkit for central state management, consolidate to a single WebSocket connection via Redux middleware, and mount all phase components simultaneously with CSS display toggling to preserve ephemeral DOM state.

## Problem

Today each phase component is mounted/unmounted when the user switches tabs. This causes:

1. **State loss** — chat messages, scroll positions, input field values, selected items, and loaded data are destroyed on every phase switch.
2. **Redundant WebSocket connections** — `DesignPhase`, `PlanPhase`, and `AgentDashboard` each create their own WebSocket via `useWebSocket()`, separate from `ProjectWebSocketProvider`. Up to 3–4 concurrent connections exist.
3. **No data caching** — every phase fetches its data from the API on mount. Returning to a visited phase re-fetches everything, causing loading flashes.
4. **No shared state layer** — all state is component-local (`useState`). Cross-phase communication requires prop threading through `ProjectView`.

## Requirements

1. The current phase must still be captured in the URL (e.g. `/projects/:projectId/build`), and loading the URL directly must render the correct phase.
2. Other pages (Home, Login, ProjectSetup) remain unaffected — the SPA behavior is scoped to within a single project.
3. Once in the project SPA, all context, WebSocket connections, and data are loaded on page load and remembered as you switch phases. There should never be a flash of unloaded content.

## Architecture

### Strategy: Redux + Mount-All + WebSocket Middleware

Two complementary mechanisms:

- **Redux Toolkit** for all domain data and cross-phase state (single source of truth, survives component re-renders, enables DevTools).
- **Mount-all with CSS display toggle** for ephemeral DOM state (scroll positions, input field values, focus, refs — things Redux can't preserve).

```
main.tsx
└── Redux Provider (store)
    └── ThemeProvider
        └── BrowserRouter
            └── App (Routes)
                ├── Home, Login, ProjectSetup (unchanged)
                └── ProjectView
                    ├── on mount: dispatch fetchAllProjectData() + wsConnect()
                    ├── Layout + Navbar
                    └── All 4 phases rendered, active shown via CSS
                        ├── DesignPhase  → useSelector(designSlice)
                        ├── PlanPhase    → useSelector(planSlice)
                        ├── BuildPhase   → useSelector(buildSlice)
                        └── ValidatePhase→ useSelector(validateSlice)
```

### Redux Store Shape

```typescript
interface RootState {
  // Cross-cutting
  project: {
    data: Project | null;
    loading: boolean;
    error: string | null;
  };
  websocket: {
    connected: boolean;
    hilRequest: HilRequestEvent | null;
    hilNotification: HilRequestEvent | null;
  };

  // Design phase
  design: {
    messages: Message[];
    prdContent: Record<string, string>;
    prdHistory: PrdChangeLogEntry[];
    sendingChat: boolean;
    savingSection: string | null;
    error: string | null;
  };

  // Plan phase
  plan: {
    plans: Plan[];
    dependencyGraph: PlanDependencyGraph | null;
    selectedPlanId: string | null;
    chatMessages: Record<string, Message[]>; // keyed by plan context
    loading: boolean;
    decomposing: boolean;
    error: string | null;
  };

  // Build phase
  build: {
    tasks: TaskCard[];
    plans: Plan[];
    orchestratorRunning: boolean;
    awaitingApproval: boolean;
    selectedTaskId: string | null;
    taskDetail: Task | null;
    agentOutput: string[];
    completionState: { status: string; testResults: TestResults | null } | null;
    archivedSessions: AgentSession[];
    loading: boolean;
    error: string | null;
  };

  // Validate phase
  validate: {
    feedback: FeedbackItem[];
    loading: boolean;
    error: string | null;
  };
}
```

**What stays local in components** (preserved by mount-all, not in Redux):
- Text input values (`input`, `chatInput`, `editDraft`)
- UI toggles (`historyExpanded`, `showAddPlanModal`)
- Resize pane percentage (`chatPct` — persisted to localStorage)
- Refs (`messagesEndRef`, `containerRef`)
- Scroll positions

### Redux Slices (6 slices)

Each uses `createSlice` + `createAsyncThunk` from `@reduxjs/toolkit`:

| Slice | Thunks | WS-Driven Reducers |
|-------|--------|--------------------|
| `projectSlice` | `fetchProject` | — |
| `websocketSlice` | — | `setConnected`, `setHilRequest`, `clearHilRequest`, etc. |
| `designSlice` | `fetchDesignChat`, `fetchPrd`, `fetchPrdHistory`, `sendDesignMessage`, `savePrdSection` | `prdUpdated` → refetch |
| `planSlice` | `fetchPlans`, `decomposePlans`, `shipPlan`, `reshipPlan`, `fetchPlanChat`, `sendPlanMessage` | `planUpdated` → refetch |
| `buildSlice` | `fetchTasks`, `fetchBuildPlans`, `fetchBuildStatus`, `fetchTaskDetail`, `fetchArchivedSessions`, `startBuild`, `pauseBuild`, `markTaskComplete` | `appendAgentOutput`, `setOrchestratorRunning`, `setCompletionState`, `taskUpdated` |
| `validateSlice` | `fetchFeedback`, `submitFeedback` | `feedbackMapped` → refetch |

### WebSocket Middleware

A custom Redux middleware replaces `useWebSocket`, `ProjectWebSocketProvider`, and all per-phase WS connections with a **single connection**.

- Listens for `wsConnect(projectId)` action → opens WebSocket
- Listens for `wsDisconnect()` action → closes WebSocket
- On each incoming `ServerEvent`, dispatches to the appropriate slice
- Handles `wsSend(event)` for outgoing messages (subscribe, unsubscribe, hil.respond)
- Reconnection with exponential backoff

### Mount-All with CSS Display Toggle

All four phases are rendered simultaneously inside `ProjectView`. The active phase gets `display: contents`; inactive ones get `display: none`.

```tsx
{VALID_PHASES.map((phase) => (
  <div key={phase} style={{ display: phase === currentPhase ? 'contents' : 'none' }}>
    {phase === 'design' && <DesignPhase projectId={projectId} />}
    {phase === 'plan' && <PlanPhase projectId={projectId} />}
    {phase === 'build' && <BuildPhase projectId={projectId} />}
    {phase === 'validate' && <ValidatePhase projectId={projectId} />}
  </div>
))}
```

### Data Loading Strategy

When `ProjectView` mounts, dispatch a batch of fetches for ALL phases:

```typescript
useEffect(() => {
  dispatch(wsConnect({ projectId }));
  dispatch(fetchProject(projectId));
  dispatch(fetchDesignChat(projectId));
  dispatch(fetchPrd(projectId));
  dispatch(fetchPrdHistory(projectId));
  dispatch(fetchPlans(projectId));
  dispatch(fetchTasks(projectId));
  dispatch(fetchBuildStatus(projectId));
  dispatch(fetchFeedback(projectId));
  return () => dispatch(wsDisconnect());
}, [projectId, dispatch]);
```

By the time a user clicks from Design → Build, tasks are already in the Redux store. Zero loading flash.

### URL Routing (Unchanged)

```tsx
// App.tsx — no changes needed
<Route path="/projects/:projectId/:phase?" element={<ProjectView />} />
```

The `phase` URL param determines which div gets `display: contents`. Direct URL navigation works — data is fetched on mount, active phase renders once thunk resolves.

## Implementation Tasks

### Task 1: Install Redux dependencies
Add `@reduxjs/toolkit` and `react-redux`. Create the store with typed hooks (`useAppDispatch`, `useAppSelector`). Wire up `<Provider>` in `main.tsx`.

### Task 2: WebSocket middleware
Create `src/store/middleware/websocketMiddleware.ts`. Single WS connection per project. Dispatches to domain slices on incoming events. Handles send/subscribe/unsubscribe. Exponential backoff reconnection.

### Task 3: Create Redux slices — project + websocket
`projectSlice` with `fetchProject` thunk (replaces `useProject` hook). `websocketSlice` for connection state and HIL request/notification.

### Task 4: Create Redux slices — design
`designSlice` with thunks for PRD, chat history, message sending, section editing. WS event `prd.updated` triggers refetch.

### Task 5: Create Redux slices — plan
`planSlice` with thunks for plans list, decompose, ship, reship, plan chat. WS event `plan.updated` triggers refetch.

### Task 6: Create Redux slices — build
`buildSlice` with thunks for tasks, build status, task detail, archived sessions, start/pause build, mark complete. WS events for agent output, task updates, build status.

### Task 7: Create Redux slices — validate
`validateSlice` with thunks for feedback list and submit. WS event `feedback.mapped` triggers refetch.

### Task 8: Refactor ProjectView — upfront loading + mount-all
Dispatch all fetches on mount. Render all 4 phases with CSS display toggle. Remove `ProjectWebSocketProvider` usage.

### Task 9: Refactor DesignPhase to use Redux
Replace `useState` + `useWebSocket` with `useAppSelector` + `useAppDispatch`. Keep input values and UI toggles local.

### Task 10: Refactor PlanPhase to use Redux
Same pattern. Replace `useWebSocket` with middleware events.

### Task 11: Refactor BuildPhase to use Redux
Same pattern. Replace `useProjectWebSocket` with Redux selectors/dispatch.

### Task 12: Refactor ValidatePhase to use Redux
Same pattern. Replace `useProjectWebSocket` with Redux selectors/dispatch.

### Task 13: Cleanup deprecated files
Remove `ProjectWebSocketContext.tsx`, `useWebSocket.ts`, `useProject.ts`. Update any remaining imports.

## Files Changed

| File | Action |
|------|--------|
| `src/store/index.ts` | Create — configureStore, typed hooks |
| `src/store/middleware/websocketMiddleware.ts` | Create |
| `src/store/slices/projectSlice.ts` | Create |
| `src/store/slices/websocketSlice.ts` | Create |
| `src/store/slices/designSlice.ts` | Create |
| `src/store/slices/planSlice.ts` | Create |
| `src/store/slices/buildSlice.ts` | Create |
| `src/store/slices/validateSlice.ts` | Create |
| `main.tsx` | Modify — add Redux Provider |
| `ProjectView.tsx` | Modify — upfront fetches, mount-all, remove WS context |
| `DesignPhase.tsx` | Modify — Redux selectors/dispatch |
| `PlanPhase.tsx` | Modify — Redux selectors/dispatch |
| `BuildPhase.tsx` | Modify — Redux selectors/dispatch |
| `ValidatePhase.tsx` | Modify — Redux selectors/dispatch |
| `ProjectWebSocketContext.tsx` | Delete |
| `useWebSocket.ts` | Delete |
| `useProject.ts` | Delete |

## Dependencies

- `@reduxjs/toolkit`
- `react-redux`

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Large refactor across all 4 phases | One slice + phase at a time; each step is independently testable |
| Upfront fetches = more API calls on initial load | Parallel and lightweight; data is needed anyway |
| `agentOutput` array grows unbounded | Cap at last N chunks or use ring buffer |
| WS reconnection logic missing | Add exponential backoff in middleware |
| Store not cleared between projects | Dispatch reset on `projectId` change |
| Shared `plans` data between Plan and Build | Both slices store own copy, or extract shared `plansSlice` |
