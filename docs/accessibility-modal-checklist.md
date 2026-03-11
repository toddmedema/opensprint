# Modal Accessibility Checklist

Use this checklist when implementing or reviewing modal dialogs and dropdown menus in OpenSprint.

## Modal Dialogs

For modal dialogs (e.g. confirm modals, settings overlay, folder browser):

- [ ] **Escape closes** — Pressing Escape dismisses the modal
- [ ] **Focus trap** — Tab cycles within the modal; focus does not leave to content behind
- [ ] **Focus return** — On close, focus returns to the element that opened the modal (or the previously focused element)
- [ ] **role="dialog"** — The modal container has `role="dialog"`
- [ ] **aria-modal="true"** — The modal is marked as modal
- [ ] **aria-label or aria-labelledby** — The modal has an accessible name (e.g. via `aria-labelledby` pointing to the title)

## Dropdown Menus (e.g. project card kebab menu)

- [ ] **Escape closes** — Pressing Escape closes the menu
- [ ] **Focus return** — On close, focus returns to the trigger button
- [ ] **role="menu"** — The dropdown has `role="menu"`
- [ ] **role="menuitem"** — Each option has `role="menuitem"`
- [ ] **aria-expanded** — The trigger has `aria-expanded` reflecting open/closed state

## Implementation

The `useModalA11y` hook in `packages/frontend/src/hooks/useModalA11y.ts` provides Escape handling, focus trap, and focus return for modal dialogs. Use it with a ref to the modal container and optionally a ref to the trigger element.
