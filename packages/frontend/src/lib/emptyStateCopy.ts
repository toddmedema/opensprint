/**
 * Canonical copy for phase empty states.
 * Single source of truth — keep in sync with docs/design/empty-state-pattern.md.
 * Pattern: title, description, primary action label.
 */

export const EMPTY_STATE_COPY = {
  sketch: {
    title: "What do you want to build?",
    description: "Describe your app idea and Open Sprint will generate a PRD.",
    /** Sketch uses custom layout (textarea + button); action label not used in PhaseEmptyState */
    primaryActionLabel: "Sketch it",
  },
  plan: {
    title: "No plans yet",
    description: "Create a plan to break down your spec into tasks.",
    primaryActionLabel: "New Plan",
  },
  execute: {
    title: "No tasks yet",
    description: "Ship a plan from the Plan phase to start generating tasks.",
    primaryActionLabel: "Go to Plan",
  },
  eval: {
    title: "No feedback yet",
    description: "Test your app and report findings using the form above.",
    primaryActionLabel: "Report a finding",
  },
  deliver: {
    title: "No deliveries yet",
    description: "Configure targets in settings, then deploy from the toolbar.",
    primaryActionLabel: "Configure targets",
  },
} as const;
