# Validation failures: five-whys investigation

Investigated on 2026-11-08. Evidence came from read-only local task/session records,
orchestrator events, the affected project's command wrappers, and GitHub Actions.
Local records and personal filesystem paths are deliberately not attached.

## What failed

The affected project's 12 failed coding/review sessions on November 6–8 involved
three tasks. Count sessions once, rather than counting `task.failed`, `task.requeued`,
and `task.blocked` as separate failures for the same attempt.

| Observed signature                                                        | Failed sessions | Finding                                                                                                                                       |
| ------------------------------------------------------------------------- | --------------: | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24 required, runner selected Node 26                                 |               4 | Runtime selection ignored the project engine requirement. Two agents explicitly reported passing validation under Node 24.                    |
| Test command stayed running or gate waited for another validation process |               6 | Two test timeouts reported “No tests found related to files changed since last commit”; four timeouts reported waiting for a validation slot. |
| Checkout reserved by another task                                         |               1 | A project ownership guard rejected the command; dependency installation cannot resolve ownership.                                             |
| `Cannot find module '../package.json'` from a dependency                  |               1 | A dependency stack trace was classified as a compiler error, preventing the existing environment repair.                                      |

One task reached five cumulative attempts and was blocked after three consecutive
`merge_quality_gate` failures. The most recent 30 GitHub Actions runs contained 25
successes, three failures, and two cancellations; the newest failure was November 5
and was followed by a successful run of the same branch. The current recurring
cluster is local orchestration validation, rather than a new widespread CI outage.

## Five whys

1. **Why did completed coding work repeatedly fail or become blocked?** Server-side
   build/test gates failed, timed out, or could not acquire validation resources.
   The retry policy then retried coding and eventually applied its circuit breaker.
2. **Why did validation fail independently of the submitted code?** The runner used
   an incompatible Node executable; test commands could enter watch mode; later
   attempts waited on occupied project validation slots. A checkout reservation
   and a missing dependency manifest supplied two further environment failures.
3. **Why could a bounded gate keep affecting subsequent attempts?** The command
   runner terminated only its direct child, commonly npm. Descendant shells,
   runners, and workers could survive. Closing the parent also cancelled the
   escalation timer, even if a descendant ignored termination.
4. **Why did those conditions get treated as new coding problems?** Gates had no
   enforced noninteractive environment. The classifier interpreted any source-like
   `file.js:line:column` location as a compiler diagnostic, including dependency
   stack frames. Validation contention had no distinct environment diagnosis.
5. **Why were the defects able to recur?** The validation boundary did not enforce
   the complete contract: project-compatible runtime, one-shot commands, ownership
   of cancellation, and evidence-based failure classification. Existing tests did
   not exercise a watch-by-default command or a surviving descendant after its
   parent closed. Retrying task code could not repair that boundary.

## Changes and regression evidence

- Include the existing Node-engine correction from commit `6bd74367`: resolve
  Node/npm/npx using the project engine requirement and preserve the chosen PATH
  for child commands. Keep explicit executable selection intact and fail clearly
  when no compatible runtime exists.
- Set `CI=true` for merge-gate execution, including custom/default gate profiles,
  so common test runners use noninteractive, one-shot behavior.
- Start POSIX commands in an owned process group and signal the whole group on a
  timeout or output limit. Finish descendant cleanup when the parent closes early.
  On Windows, request tree termination with `taskkill /T /F`.
- Require a diagnostic severity for file-location compiler heuristics. A dependency
  require stack can now reach the existing bounded dependency repair/retry; actual
  TypeScript/lint errors and missing worktree source remain code failures.
- Classify validation-slot timeouts and checkout reservations as environment
  conditions. Preserve their original output and skip dependency reinstall/retry
  for those conditions; never bypass a project's ownership guard.

Six new regression cases failed before the changes and passed afterward: a real
watch-by-default npm script, two real descendant-cleanup cases, two contention/
reservation cases, and repair of a dependency manifest error containing a stack
location. Neighboring runtime, output-bound, compiler-diagnostic, and missing-source
tests also pass. See the PR description for integrated gate results.

## Limits and recovery

The records establish that validation slots were occupied, but do not establish
that every recorded owner was an orphan; some belonged to other active worktrees.
The descendant leak is independently reproduced. The missing dependency manifest
was present when inspected later, so its original deletion/corruption mechanism
is unproven. The fix restores correct classification and the existing repair path
without claiming that a particular install race caused it.

No live task records, reservations, dependencies, or unrelated processes were
changed during this investigation. After the updated backend is running, retry
the affected tasks once their project-owned validation reservations are clear.
Existing unrelated validation processes must finish or be stopped by their owner.
The real process-group regression tests run on POSIX; Windows tree termination
requires separate platform validation.
