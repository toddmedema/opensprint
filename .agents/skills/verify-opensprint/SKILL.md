---
name: verify-opensprint
description: Choose and run verification for Open Sprint behavior changes, regression fixes, and guardrail improvements. Use when deciding what evidence proves backend, task-store, orchestration, frontend-flow, or Electron behavior beyond routine formatting.
---

# Verify Open Sprint

Read [AGENTS.md](../../../AGENTS.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md) for commands and
required gates. Use the existing test runners and fixtures; this skill guides what to prove without
introducing a parallel verification framework.

## Choose the contract

State the observable failure or invariant before choosing a check. Trace the affected entry points
across shared types, API routes, TaskStoreService, orchestration, React state and UI, or Electron as
applicable. Reuse neighboring suites and their setup rather than building a second implementation.

Prefer types or a single owning API for invalid states. Use the existing ESLint configuration for a
syntactic footgun, and behavioral tests when the contract needs runtime evidence. Add instructions
only for decisions that cannot be enforced cheaply. A new verifier or formal model needs a specific
contract that the current tooling cannot express.

## Prove the check catches a violation

For a regression, reproduce the failure before the fix when practical. For a new guard, exercise a
violating example and a valid neighboring example through the actual typechecker, lint configuration,
parser, or public API. Confirm that failure occurs for the intended reason, then remove temporary
mutations and scratch artifacts.

Assert user-visible behavior, accepted/rejected payloads, persisted task state, or lifecycle invariants.
Avoid source-text matching, tests that repeat implementation logic, incidental copy, and arbitrary
sleeps. Wait for observable readiness and reuse the repository's isolation and cleanup helpers.

For database changes, use the test database setup and cover both SQLite and PostgreSQL when dialect
behavior is affected. For recovery, cancellation, or ownership changes, test the relevant transitions
and delayed completions, including whether stale work can mutate current state. Keep test-only
behavior behind `NODE_ENV=test`; never point test fixtures at a user's production task database.

For UI flows, use the existing Testing Library and frontend E2E suites. A passing component test does
not establish that a real browser layout is correct; capture the finished interface as required by
the [create-pr skill](../create-pr/SKILL.md). Prefer headless checks; routine verification should not
open native Electron windows or take keyboard focus.

## Run and hand off evidence

Use the smallest relevant non-watch checks while iterating, then run the integrated gates required by
CONTRIBUTING.md. Re-run a failed check after fixing its root cause. Reuse earlier passing results only
while their inputs remain unchanged; avoid overlapping full checks, builds, and broad browser runs.

Never weaken an assertion, coverage threshold, timeout, snapshot, or performance baseline just to
turn a failure green. Explain any intentional contract or baseline change and verify the new behavior.
Distinguish defects in the change from missing prerequisites and unrelated failures with evidence.

Report the commands actually run and their outcomes, including skipped or unrun checks. Missing
PostgreSQL or other required infrastructure leaves validation incomplete. Check remote CI after
opening a PR and do not call it ready until every required job passes. Identify specific remaining
review questions, such as whether a lifecycle invariant matches the intended behavior or a migration
preserves existing tasks. Execute agents must use the exact result schema supplied in their prompt.
