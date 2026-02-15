# Project Setup Wizard

## Overview

A sequential wizard that guides users through creating a new OpenSprint project. Steps: (1) project name and description, (2) agent configuration, (3) deployment configuration, (4) human-in-the-loop preferences, (5) repository initialization (git + bd init).

## Acceptance Criteria

- [ ] Wizard has 5 sequential steps with next/back navigation
- [ ] Step 1: Collect project name and description
- [ ] Step 2: Select planning agent and coding agent (Claude/Cursor/Custom) with model dropdown when applicable
- [ ] Step 3: Select deployment mode (Expo.dev or Custom pipeline)
- [ ] Step 4: Configure HIL preferences for 4 categories with 3 modes each
- [ ] Step 5: Create git repo, run bd init, create .opensprint/ structure, add to project index
- [ ] On completion, user lands in Design tab
- [ ] POST /projects with full wizard payload triggers setup flow

## Technical Approach

- Multi-step form component with validation per step
- Backend: create directory, `git init`, `bd init`, create .opensprint/ subdirs (prd, plans, conversations, feedback, sessions, active, settings)
- Store settings in .opensprint/settings.json

## Dependencies

Depends on: Project Index and Core Infrastructure, Agent Configuration (for agent selection UI).

## Data Model Changes

- ProjectSettings in .opensprint/settings.json
- Project entry in ~/.opensprint/projects.json with repo_path

## API Specification

- POST `/api/v1/projects` — Accept full wizard payload; create repo, run bd init, create .opensprint structure, persist settings, add to index; return project id

## UI/UX Requirements

- Clear step indicators (1/5, 2/5, etc.)
- Validation before advancing
- Loading state during repo initialization
- Error display if bd init or git init fails

## Edge Cases and Error Handling

- Directory already exists: prompt user or use subdirectory
- bd not installed: show clear error with install instructions
- git init fails: rollback, report error

## Testing Strategy

- E2E test: complete wizard flow
- Unit tests for setup logic (mock child_process)

## Estimated Complexity

high