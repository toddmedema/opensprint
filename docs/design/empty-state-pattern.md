# Empty State Pattern

Empty states appear when a phase has no content yet (e.g. no plans, no tasks, no feedback, no deliveries). This document defines a consistent pattern so the product feels unified and actionable across all SPEED phases.

## Quick Reference

| Element | Required | Notes |
| ------- | -------- | ----- |
| **Copy** | Yes | Title + description from `EMPTY_STATE_COPY` |
| **Illustration** | Optional | Use `PhaseEmptyStateLogo` for consistency |
| **Primary action** | When actionable | Button label from `EMPTY_STATE_COPY.<phase>.primaryActionLabel` |

## Pattern Structure

Each empty state has three elements:

1. **Copy** — A short title and supporting description explaining what to do next
2. **Optional illustration** — Phase icon or OpenSprint logo (keeps layout light; use `PhaseEmptyStateLogo` for consistency)
3. **Primary action** — A clear button that advances the user (omit only when the user cannot take action)

## Copy Constants

All phase-specific copy lives in `packages/frontend/src/lib/emptyStateCopy.ts` as `EMPTY_STATE_COPY`. Use these constants in phase components so copy stays aligned with this spec.

```ts
import { EMPTY_STATE_COPY } from "../../lib/emptyStateCopy";
// EMPTY_STATE_COPY.plan.title, .plan.description, .plan.primaryActionLabel, etc.
```

## When to Use

- **Phase-level empty states** — Use `PhaseEmptyState` when the main content area of a phase is empty (no plans, no tasks, no feedback, no deliveries).
- **Sketch exception** — Sketch uses a custom full-onboarding layout (textarea + primary action button) because it requires free-form input; it follows the same conceptual pattern (copy + logo + primary action). Use `EMPTY_STATE_COPY.sketch` for title, description, and `primaryActionLabel` (for the button text, `title`, and `aria-label`).
- **Filtered-empty states** — When content exists but filters return no results (e.g. "No plans match your search"), use a simpler treatment: explanatory copy only, no illustration, no primary action.

## Component

Use `PhaseEmptyState` from `packages/frontend/src/components/PhaseEmptyState`:

```tsx
import { EMPTY_STATE_COPY } from "../../lib/emptyStateCopy";

<PhaseEmptyState
  title={EMPTY_STATE_COPY.plan.title}
  description={EMPTY_STATE_COPY.plan.description}
  illustration={<PhaseEmptyStateLogo />}
  primaryAction={{
    label: EMPTY_STATE_COPY.plan.primaryActionLabel,
    onClick: () => setAddPlanModalOpen(true),
    "data-testid": "empty-state-new-plan",
  }}
/>
```

## Phase-Specific Copy and Actions

| Phase   | Title              | Description                                                       | Primary Action        |
| ------- | ------------------ | ----------------------------------------------------------------- | --------------------- |
| Sketch  | What do you want to build? | Describe your app idea and Open Sprint will generate a PRD. | Sketch it (textarea + button) |
| Plan    | No plans yet       | Create a plan to break down your spec into tasks.                 | New Plan              |
| Execute | No tasks yet       | Ship a plan from the Plan phase to start generating tasks.        | Go to Plan            |
| Eval    | No feedback yet    | Test your app and report findings using the form above.           | Report a finding      |
| Deliver | No deliveries yet  | Configure targets in settings, then deploy from the toolbar.      | Configure targets     |

## Filtered-Empty States

When the user has applied filters or search and no items match, show explanatory copy only:

- Plan: "No plans match your search." / "No plans match the \"X\" filter."
- Execute: "No tasks match your search." / "No tasks match this filter." / "All tasks completed." (when all tasks are done)
- Eval: "No feedback or plan reviews match your search." / status-specific messages
- Deliver: "No deployments match this filter."

Do not use `PhaseEmptyState` for filtered-empty; use a simple centered `text-theme-muted` paragraph.

## Guidelines

- **Always include a primary action** when the user can do something (Plan, Execute, Eval, Deliver). Omit only when the action is unavailable (e.g. Deliver without settings access).
- **Keep copy concise** — one sentence for description.
- **Illustration** — Use `PhaseEmptyStateLogo` for consistency across phases; omit only for minimal layout.
- **data-testid** — Use phase-specific test IDs for the primary action (e.g. `empty-state-new-plan`, `empty-state-go-to-plan`).

## Implementation Checklist

When adding or updating a phase empty state:

- [ ] Import `EMPTY_STATE_COPY` from `lib/emptyStateCopy`
- [ ] Import `PhaseEmptyState` and `PhaseEmptyStateLogo` from `components/PhaseEmptyState`
- [ ] Use `EMPTY_STATE_COPY.<phase>.title` and `.description` for copy
- [ ] Use `EMPTY_STATE_COPY.<phase>.primaryActionLabel` for the primary action button
- [ ] Pass `illustration={<PhaseEmptyStateLogo />}` for consistency
- [ ] Add a phase-specific `data-testid` on the primary action (e.g. `empty-state-new-plan`)
