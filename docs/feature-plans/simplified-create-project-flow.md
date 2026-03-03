# Simplified Create Project Flow

## Overview

Improve user onboarding by separating the project creation experience into two distinct flows: **Create New** (scaffold from template) and **Add Existing** (existing Project Setup wizard). The homepage is redesigned to show projects as individual cards (like the Evaluate Feedback list) instead of a table, with "Create New" and "Add Existing" buttons in the header next to the project page title.

## Acceptance Criteria

- [ ] Remove "Create project" row from the projects table inline
- [ ] Redesign projects list: each project is a card (like Evaluate Feedback cards), not a table row
- [ ] "Create New" and "Add Existing" buttons appear in the top right, inline with the "Projects" page title
- [ ] Add Existing links to existing Project Setup flow; route `/projects/new`; title bar shows "Add Existing Project"
- [ ] Create New links to new 3-page wizard at `/projects/create-new`; title bar shows "Create New Project"
- [ ] Create New Page 1: Project Name, Project Folder (with browse), Template dropdown (only "Web App (Expo/React)" for now)
- [ ] Create New Page 2: Simplified agent config — API keys + provider/model selection only; no git work mode, no parallelism (use defaults in background)
- [ ] Create New Page 3: Loading spinner while scaffolding runs; then show OS-dependent run instructions derived from the project path (Windows: `pushd "<folder>"` then `npm run web`; macOS/Linux: `cd "<folder>"` then `npm run web`); "I'm Ready" navigates to project
- [ ] Scaffolding includes `npm install` and creates a runnable Expo/React web app

## Technical Approach

### Homepage

- Replace table layout with a grid of project cards. Each card uses `card p-4` (same as FeedbackCard). Cards are clickable.
- Add header row: `flex justify-between items-center` with `h1` "Projects" on left and `Create New` + `Add Existing` buttons on right.
- Add Existing: `navigate("/projects/new")`. Create New: `navigate("/projects/create-new")`.

### Add Existing Flow

- Rename `ProjectSetup` page title from "Create New Project" to "Add Existing Project" when used as Add Existing.
- Route `/projects/new` remains; no code path changes beyond title and copy.

### Create New Flow

- New route: `/projects/create-new` → new page `CreateNewProjectPage`.
- Three steps: `basics` | `agents` | `scaffold`.
- **Page 1 (basics):** Project name, project folder (FolderBrowser), template dropdown (single option: "Web App (Expo/React)").
- **Page 2 (agents):** Simplified `AgentsStep` variant — only API keys + provider/model for Simple and Complex; omit git work mode, parallelism, unknown scope strategy.
- **Page 3 (scaffold):** Call `POST /projects/scaffold` with body `{ name, parentPath, template, simpleComplexityAgent, complexComplexityAgent }`. Backend scaffolds project folder, runs `npm install`, registers project in index, and returns `{ project }`. The frontend renders OS-dependent run instructions from `project.repoPath`.

### Backend Scaffolding

- New endpoint: `POST /api/v1/projects/scaffold`.
- Body: `{ name, parentPath, template, simpleComplexityAgent, complexComplexityAgent }`.
- For template "web-app-expo-react": create folder at `parentPath/name`, run `npx create-expo-app@latest . --template blank --yes` (or equivalent) in that folder, then `npm install`.

- After scaffolding, call existing `createProject` logic (or a shared helper) to add `.opensprint` structure, register in project index, and persist settings. Use defaults: `gitWorkingMode: "worktree"`, `maxConcurrentCoders: 1`, `deployment: DEFAULT_DEPLOYMENT_CONFIG`, `hilConfig: DEFAULT_HIL_CONFIG`, `testFramework: null`.

- Return `{ project }`. The client derives platform-specific run instructions from `project.repoPath`: Windows uses `pushd "<path>"` then `npm run web`; other platforms use `cd "<path>"` then `npm run web`.

### Simplified Agent Config

- Extract a `SimplifiedAgentsStep` component (or reuse `AgentsStep` with props to hide git/parallelism sections). Only show: API key inputs, provider selection, model selection for Simple and Complex.

## Dependencies

- `create-expo-app` (via npm/npx) — must be available on user machine
- Node.js for `npm install`
- No new npm packages

## Data Model Changes

- None. Project index and settings schema unchanged.

## API Specification

### POST /api/v1/projects/scaffold

**Request:** `application/json`

```json
{
  "name": "Project Name",
  "parentPath": "/absolute/path/to/parent",
  "template": "web-app-expo-react",
  "simpleComplexityAgent": {
    "type": "cursor",
    "model": "claude-sonnet-4-20250514",
    "cliCommand": ""
  },
  "complexComplexityAgent": {
    "type": "cursor",
    "model": "claude-sonnet-4-20250514",
    "cliCommand": ""
  }
}
```

**Response:** `201 Created`

```json
{
  "data": {
    "project": {
      "id": "...",
      "name": "...",
      "repoPath": "...",
      "currentPhase": "sketch",
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
}
```

**Errors:** `400` if path invalid, folder exists, or template unknown; `500` if scaffold fails.

## UI/UX Requirements

- Projects list: card grid, responsive; each card shows name, path (truncated), phase badge. Kebab menu for Archive/Delete.
- Header: "Projects" title left; "Create New" (primary) and "Add Existing" (secondary) right.
- Create New wizard: step 1 of 3, 2 of 3, 3 of 3 progress bar; Back/Next navigation.
- Page 3: Spinner with "Building your project..." during scaffold; on success: "Your project is ready!" with OS-aware run instructions in a code block; "I'm Ready" primary button.

## Edge Cases and Error Handling

- Project folder already exists: validate before scaffold; return 409 with message.
- Parent path doesn't exist or isn't writable: 400.
- `create-expo-app` or `npm install` fails: 500 with user-friendly message; suggest checking Node/npm.
- Existing project at same path: same behavior as Add Existing — check for `.opensprint` and adopt or open existing.
- API keys missing on Page 2: show warning (same as current AgentsStep); allow proceeding but warn.

## Testing Strategy

- Unit: `CreateNewProjectPage` step rendering; `SimplifiedAgentsStep` renders only API/provider/model.
- Integration: `POST /projects/scaffold` with temp dir; verify folder created, `.opensprint` present, and project metadata returned. Frontend tests verify the rendered run instructions for Windows and non-Windows platforms.
- E2E: Create New flow end-to-end; Add Existing flow still works.
- Update `HomeScreen.test.tsx`: remove create-project-row; add create-new/add-existing button tests.

## Estimated Complexity

**Plan-level:** medium

**Task-level:** simple (UI/refactor) or complex (scaffold/backend)

---

## Mockups

### Main Screen (Projects List)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Projects                          [ Create New ]  [ Add Existing ]          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────┐  ┌─────────────────────────────────┐│
│  │ My Project                          │  │ Another App                      ││
│  │ /Users/todd/projects/my-project     │  │ /Users/todd/projects/another     ││
│  │ Sketch                    ⋮         │  │ Execute                  ⋮       ││
│  └─────────────────────────────────────┘  └─────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────┐                                     │
│  │ Third Project                       │                                     │
│  │ /Users/todd/projects/third          │                                     │
│  │ Plan                    ⋮           │                                     │
│  └─────────────────────────────────────┘                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Create New Project — Page 3 (Success)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Create New Project — Building your project                                  │
│  Step 3 of 3  ████████████████████████████████████████ 100%                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  ✓ Your project is ready!                                            │   │
│  │                                                                      │   │
│  │  Run your app:                                                        │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │ cd /Users/todd/projects/my-app && npm run web                │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  │                                                                      │   │
│  │  [ I'm Ready ]                                                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Create New Project — Page 3 (Loading)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Create New Project — Building your project                                  │
│  Step 3 of 3  ████████████████████████████████████████ 100%                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │                    ⟳  Building your project...                       │   │
│  │                                                                      │   │
│  │                    Creating scaffolding and installing dependencies  │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```
