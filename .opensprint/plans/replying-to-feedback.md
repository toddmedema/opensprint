# Replying to Feedback

## Overview

Add the ability for users to reply to existing feedback items, creating threaded conversations. A reply button appears on each feedback card, opening an inline composer. The categorization agent receives parent feedback as context when processing replies. Child feedback is displayed nested below its parent in the list.

## Acceptance Criteria

- A reply button with a reply icon appears in the bottom-right corner of each feedback card
- Clicking the reply button opens an inline reply composer directly below the card
- Submitting a reply creates a new feedback item linked to the parent
- The categorization agent receives the parent feedback's content, category, and metadata as additional context
- Child feedback is displayed nested (indented) below its parent in the feedback list
- Nested replies can go at least 2 levels deep
- Collapsing a parent hides its nested children
- Reply composer can be dismissed without submitting

## Technical Approach

- Add a `parent_id` field to the feedback data model (nullable, references another feedback ID)
- Modify the feedback list query to return a tree structure (or flat list with `parent_id` for client-side nesting)
- Extend the categorization agent prompt to include parent feedback context when `parent_id` is set
- Frontend renders feedback as a recursive tree component

## Dependencies

- Existing feedback card component
- Existing feedback creation flow
- Categorization agent pipeline

## Data Model Changes

| Field       | Type            | Description                                      |
|-------------|-----------------|--------------------------------------------------|
| parent_id   | string \| null  | ID of the parent feedback (null for top-level)   |
| depth       | number          | Nesting depth (0 for top-level, computed)        |

## API Specification

| Method | Endpoint                              | Description                                              |
|--------|---------------------------------------|----------------------------------------------------------|
| POST   | `/projects/:id/feedback`              | Create feedback — now accepts optional `parent_id` field |
| GET    | `/projects/:id/feedback`              | Returns feedback list with `parent_id` for tree building |

## UI/UX Requirements

- Reply button uses a standard reply icon (↩ / arrow-bend-up-left)
- Reply composer appears inline, not in a modal
- Nested feedback is indented with a subtle left border to show threading
- Parent context is shown as a quote snippet above the reply composer
- Maximum visual nesting depth of 3 levels to avoid excessive indentation

## Mockups

### Feedback List with Reply Button

```
┌─────────────────────────────────────────────────────┐
│  Feedback                                           │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 🐛 Bug  #FB-042                     2h ago  │    │
│  │                                              │    │
│  │ The login page crashes when I enter a long   │    │
│  │ email address with special characters.       │    │
│  │                                              │    │
│  │ Status: Categorized    Ticket: OS-128        │    │
│  │                                      [ ↩ ]   │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 💡 Feature  #FB-041                  5h ago  │    │
│  │                                              │    │
│  │ It would be great to have dark mode support  │    │
│  │ in the Plan tab.                             │    │
│  │                                              │    │
│  │ Status: New                                  │    │
│  │                                      [ ↩ ]   │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Reply Composer (after clicking ↩ on a card)

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 🐛 Bug  #FB-042                     2h ago  │    │
│  │                                              │    │
│  │ The login page crashes when I enter a long   │    │
│  │ email address with special characters.       │    │
│  │                                              │    │
│  │ Status: Categorized    Ticket: OS-128        │    │
│  │                                      [ ↩ ]   │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐    │
│  │  Replying to #FB-042:                       │    │
│  │  ┊ "The login page crashes when I enter..." │    │
│  │                                             │    │
│  │  ┌───────────────────────────────────────┐  │    │
│  │  │ I can reproduce this — it also happens│  │    │
│  │  │ on the signup page with emails over   │  │    │
│  │  │ 64 chars.                             │  │    │
│  │  │                                       │  │    │
│  │  └───────────────────────────────────────┘  │    │
│  │                                             │    │
│  │                    [ Cancel ]  [ Submit ↩ ] │    │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Nested Replies in Feedback List

```
┌─────────────────────────────────────────────────────┐
│  Feedback                                           │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 🐛 Bug  #FB-042                     2h ago  │    │
│  │                                              │    │
│  │ The login page crashes when I enter a long   │    │
│  │ email address with special characters.       │    │
│  │                                              │    │
│  │ Status: Categorized    Ticket: OS-128        │    │
│  │ 2 replies                            [ ↩ ]   │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│    ┃ ┌──────────────────────────────────────┐       │
│    ┃ │ #FB-045                      1h ago  │       │
│    ┃ │                                      │       │
│    ┃ │ I can reproduce this — it also       │       │
│    ┃ │ happens on the signup page with      │       │
│    ┃ │ emails over 64 chars.                │       │
│    ┃ │                                      │       │
│    ┃ │ Status: Categorized  Ticket: OS-128  │       │
│    ┃ │                              [ ↩ ]   │       │
│    ┃ └──────────────────────────────────────┘       │
│    ┃                                                │
│    ┃   ┃ ┌──────────────────────────────┐           │
│    ┃   ┃ │ #FB-048              30m ago │           │
│    ┃   ┃ │                              │           │
│    ┃   ┃ │ Confirmed: the validator     │           │
│    ┃   ┃ │ regex doesn't handle the     │           │
│    ┃   ┃ │ "+" symbol either.           │           │
│    ┃   ┃ │                              │           │
│    ┃   ┃ │ Status: New          [ ↩ ]   │           │
│    ┃   ┃ └──────────────────────────────┘           │
│    ┃                                                │
│    ┃ ┌──────────────────────────────────────┐       │
│    ┃ │ #FB-046                      45m ago │       │
│    ┃ │                                      │       │
│    ┃ │ This only happens in Chrome, Firefox │       │
│    ┃ │ handles it fine.                     │       │
│    ┃ │                                      │       │
│    ┃ │ Status: New                  [ ↩ ]   │       │
│    ┃ └──────────────────────────────────────┘       │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 💡 Feature  #FB-041                  5h ago  │    │
│  │                                              │    │
│  │ It would be great to have dark mode support  │    │
│  │ in the Plan tab.                             │    │
│  │                                              │    │
│  │ Status: New                                  │    │
│  │                                      [ ↩ ]   │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Edge Cases

- Deeply nested replies (3+ levels) should flatten visually at max depth but retain the data relationship
- Replying to a reply that has already been categorized and ticketed — the agent should still receive full ancestor chain
- Deleting a parent feedback that has replies — children should be re-parented to top level or shown as orphaned
- Long reply threads should be collapsible ("Show 5 more replies")
- Concurrent replies to the same parent from different users

## Testing Strategy

- Unit: Reply composer renders with parent context quote
- Unit: Feedback tree correctly nests children under parents
- Unit: Collapse/expand hides and shows nested children
- Integration: Creating a reply sets `parent_id` and appears nested
- Integration: Categorization agent receives parent context in its prompt
- E2E: Full flow — click reply, type, submit, see nested result

## Estimated Complexity

Medium — requires data model change, recursive UI component, and agent prompt modification.