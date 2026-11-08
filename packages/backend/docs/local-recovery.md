# Local validation recovery

The controller suspends a failing server-side validation call while keeping completed code, the
assignment, its phase result and any finished reviews. The caller continues from that validation
boundary when the original gates pass; no new coder is needed for a recoverable execution fault.
Ordinary compiler, lint and missing-source failures retain the existing coding/review behavior.

## Execution contract

Project `toolchainProfile` settings define the authority. Recovery pins their normalized hash before
coding and refuses changed authority during that attempt. Commands use explicit argv; shell operators
require an explicit shell command such as `sh -c "make build && make test"`.

```json
{
  "dependencyStrategy": "none",
  "workingDirectory": "service",
  "runtimeTools": ["python3"],
  "executionEnvironment": { "CI": "true" },
  "mergeQualityGateCommands": ["make verify"],
  "dependencyHealthCheckCommand": "make dependencies-ready",
  "dependencyInstallCommand": "make dependencies",
  "resourceProbeCommand": "./scripts/validation-resource-ready"
}
```

This works with project-owned wrappers for any stack. `workingDirectory` must resolve inside the
retained checkout. Probes signal readiness with exit zero. Resource probes must be read-only;
installers must be safe to rerun after interruption. Configure these before starting a task so its
pinned authority includes them. Environment values are execution inputs; use the existing secret
configuration facilities for credentials rather than committing them to project configuration.

Dependency installation requires both an explicit installer and a failing health probe. A healthy
probe cannot authorize reinstalling dependencies for an unrelated error. Host `node_modules` links
are detached before a node dependency repair; the installer runs in the owned validation checkout.
Validation workspace preparation can borrow an existing usable dependency tree without repairing
the control checkout. The original required checks run after every repair.

## Discovery and memory

With `agenticRepairEnabled` enabled (the existing default), an unfamiliar execution failure can ask
the configured auditor for a read-only diagnosis. Supported read-only planning paths are Claude,
OpenAI, native Claude Code and Codex. Unsupported providers preserve the failure for intervention.
Diagnosis gets bounded redacted logs, declared commands, installed candidates and immutable base
revision documents. It may request up to eight additional tracked evidence files, at most 16 KB each;
secret-like paths, binary, missing and oversized files are unavailable.

`runtimeTools` declares additional tool names used by wrappers (for example Python launched by make).
Verified bindings prepend their installed directories for nested processes too. Without that declaration,
discovery can bind only the configured commands’ direct executables.

The controller accepts only retry, dependency repair, wait, escalation, or an installed runtime
binding. A binding must select an enumerated executable for an already declared tool and cite a
specific semver constraint on a line naming that tool in immutable base evidence. The server probes
`--version`, requires an unambiguous complete version satisfying that constraint, then reruns the
unchanged checks. Versions without this evidence are held rather than guessed. No discovery action
can supply a new validator, installer or arbitrary shell command.

Successful verification persists the binding and repair recipe in SQLite/PostgreSQL. Runtime,
command, platform, environment and project configuration evidence restrict reuse. Reused bindings
are probed again; cached recipes never count as a passing gate. Full validation fingerprints also
include tracked and nonignored untracked changes, the base revision and executable identities.
Unavailable fingerprints disable merge-gate artifact reuse.

## Durable ownership and limits

Incident state, generation, command receipt, budgets, phase checkpoint and review outcomes live in
the local task database. Workspace admission is serialized, including queued cancellations. Claims
use atomic generation fencing. A dead backend's work can resume only on the same host after the old
backend and recorded command group are observed gone. Uncertain PIDs or another host remain retained;
a timeout alone never grants ownership. A reserved single diagnosis admission prevents recovery from
waiting behind every coding slot it is trying to unblock.

A trusted process bootstrap waits for a durable PID receipt before launching a configured command.
Cancellation terminates only this owned process group (or Windows task tree), waits for command close
and fences late results. Cleanup retains a cancelled workspace while its command receipt is present.
Foreign processes and their locks are never killed or removed by recovery.

Defaults are two repair/revalidation iterations, twenty recovery commands, and ten minutes of active
repair time. Diagnosis has a sixty-second abort deadline and at most two model responses for evidence
inspection. Resource waiting has a separate twenty-four-hour / 2,048-probe limit with backoff up to
sixty seconds; its unused repair budget survives restart. Waiting can release coding admission only
after all task/review workers stop, while retaining workspace reservations. Branches mode keeps the
shared root checkout reserved.

Exhaustion, missing authority or missing prerequisites blocks the task with its work retained. Recovery
does not install arbitrary runtimes, edit source/configuration, weaken checks, resolve governance
holds, or normalize an unsuccessful coding agent's result into success. Restart resumes active
post-coding, review and merge validation; already-finished rejected reviews remain blockers. Explicit
intervention is required for held incidents. Changing execution inputs can permit a fresh incident;
repeating the same held inputs does not silently reset the budget.

## Verification boundaries

Regression tests exercise SQLite and PostgreSQL persistence, actual orchestration continuations,
foreign resource waiting, repair probe/installer rules, restart budgets, cancellation and stale-owner
fencing, changed authority/source, runtime evidence and nested child PATH selection, and supervised
process cleanup. Unix process groups are exercised locally; Windows task-tree behavior requires
Windows CI or a Windows host.
