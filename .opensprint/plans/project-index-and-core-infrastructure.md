# Project Index and Core Infrastructure

## Overview

Establish the foundational storage and discovery layer for OpenSprint. The project index at `~/.opensprint/projects.json` maps project IDs to repository paths, enabling the home screen to list all projects. The backend provides a minimal Node.js + TypeScript server with project CRUD operations.

## Acceptance Criteria

- [ ] `~/.opensprint/projects.json` is created on first run if missing
- [ ] Projects can be added, listed, and removed from the index
- [ ] Each project entry includes: id (UUID), name, repo_path, created_at
- [ ] Backend server starts and serves `/api/v1/projects` endpoints
- [ ] GET /projects returns all projects from the index
- [ ] POST /projects creates a new project entry (repo setup deferred to project-setup)

## Technical Approach

- Use Node.js with TypeScript
- Store project index as JSON at `~/.opensprint/projects.json`
- Implement in-memory index rebuilt from filesystem on startup
- REST API with Express or similar framework

## Dependencies

None (foundational).

## Data Model Changes

Project index schema:
```json
{
  "projects": [
    { "id": "uuid", "name": "string", "repo_path": "string", "created_at": "ISO8601" }
  ]
}
```

## API Specification

- GET `/api/v1/projects` — List all projects
- POST `/api/v1/projects` — Create project (body: name, description; returns id, repo_path placeholder)
- GET `/api/v1/projects/:id` — Get project details
- PUT `/api/v1/projects/:id` — Update project
- DELETE `/api/v1/projects/:id` — Delete project and remove from index

## UI/UX Requirements

None for this plan (backend-only).

## Edge Cases and Error Handling

- Missing `~/.opensprint/` directory: create on first access
- Corrupt JSON: log error, return empty list, optionally repair
- Duplicate repo_path: allow (user may have multiple projects in same repo—unusual but valid)

## Testing Strategy

- Unit tests for index read/write operations
- API integration tests for CRUD endpoints

## Estimated Complexity

low