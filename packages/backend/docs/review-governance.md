# Review governance

Review governance is opt-in. Start in **shadow** mode with a small manually entered policy and a labeled benchmark; move to **enforced** only after reviewing the pilot evidence. Enabled projects require review on every task. The Governance tab in Project Settings contains configuration, the human docket, approved releases, proposals, and decision history.

## Owner setup

Set `OPENSPRINT_GOVERNANCE_OWNER` to the designated reviewer's name and `OPENSPRINT_GOVERNANCE_APPROVAL_SECRET` to a separate random secret of at least 32 characters on the backend. Enter this capability in the Governance tab when making an authorized decision. The browser keeps it in component memory; it is not the ordinary local bearer token. Task subprocess environments remove these values. Never put the capability in a task, policy text, prompt, tracked file, or project setting.

The local owner workflow is cooperative. Processes with unrestricted access under the same OS identity can inspect server files, memory, or environments. For shared installations, run the backend under a separate OS account and give each authorized reviewer an appropriate protected access path. The capability does not claim to provide a tamper-proof boundary against the machine owner.

Create standards with stable rule and revision IDs, full text and rationale, owner, path/role/component applicability, examples, parent/override relationships, and exception classification. Constraints are non-waivable. Review and activate the initial immutable release, then configure shadow/enforced mode and a separate tool-free API judge. Existing instruction prose is captured as release content; human confirmation is required for imported rules. Future assignments use the approved release; editing an instruction file in a task does not change its authority.

## Dockets and durable holds

Standards findings cite rule revisions and concrete code evidence. Defects need no preexisting standard. Appeals include the requested exception, alternatives analyzed, evidence, risks, and limits. Reviewer reconsideration and judge calls have persistent task-wide budgets. Routine approvals and straightforward fixes do not need a judge.

The docket exposes require-fix, one-time allowance, reusable allowance with explicit path/rule/expiry predicates, request-evidence, and cancellation. Each decision records the named actor and rationale, code and policy binding, finding IDs, and immutable evidence. One-time allowances remain discoverable but do not authorize future exceptions. Revocation preserves the historical event while preventing future reuse and invalidating pending approval.

Waiting cases retain the worktree, release agent slots, and survive restart. Normal task reopening, notification deletion/resolution, and autonomy changes cannot clear a hold. Human allowances do not waive another angle's blocker, failing hard checks, or protected-path scope. Changed code requires renewed review. The final serialized candidate admission checks the durable state rather than trusting a notification's status.

## Congress and amendments

Decision mining has its own durable cursor and runs independently of code-audit change detection. Recurrence nominates a rule for review; it does not justify changing it. A configured API auditor can draft exact substantive standard text from supporting and contrary decisions. Draft claims are durable and bounded; failed drafts stay available for manual follow-up. The UI also permits manually authored exact proposals. None of these paths activates a rule.

Proposals show complete before/after content, supporting and contrary rulings, positive/negative examples, scope, compatibility, and a required landed enforcement commit. Evaluation binds the candidate content hash. Human activation uses optimistic concurrency against both the proposal and current release. Rollback restores a previously approved immutable release only with compatible enforcement. Unlanded or incompatible enforcement requires a normal scoped implementation task; unrelated Git commits are never reverted automatically.

## Offline replay executor

The old synthetic baseline/candidate outcomes are removed. Production replay uses a server-owned `OPENSPRINT_REPLAY_IMAGE` value pinned to an immutable Docker image digest, for example `registry.example/replay@sha256:<64 hex characters>`. There is no network pull: provision the image and its offline model/toolchain before evaluation. Missing Docker, image, original prompt/commit/fixture, unsupported dependencies, or an incomplete evaluator output produces **incomplete evaluation**, never successful evidence.

The image must contain two executables:

1. `/opensprint-replay/agent /replay-input/task.json` invokes an actual offline coding agent against `/workspace`. The input contains the complete original task prompt, full baseline or candidate instructions, and toolchain identity. Emit one JSON object on stdout: `{ "completed": true, "retryCount": 0, "costUsd": 0 }`. Cost must reflect measured execution; zero is appropriate for a local offline model with no API bill. Send logs to stderr.
2. `/opensprint-replay/evaluate /replay-evaluation/rubric.json` runs a fixed independent evaluator and every named deterministic check. Emit `{ "rubricId": "...", "label": "compliant", "reviewPassed": true, "checks": [{ "name": "unit", "passed": true }] }`. The evaluator and rubric must not be supplied or modified by the candidate. The five labels are `compliant`, `exception`, `defect`, `conflict`, and `retrieval_miss`.

The server exports tracked source from the retained original base commit into disposable directories. Untracked environment files, live task stores, Git credentials, connectors, and server capabilities are never mounted. Potentially sensitive tracked inputs are rejected. Containers use no network, a read-only image root, an unprivileged UID, dropped capabilities, no-new-privileges, resource/time limits, and a bounded temporary filesystem. Only the workspace is writable for the coder. The evaluator runs in a fresh container with a read-only candidate workspace and receives a rubric unavailable to the coder. Container names permit forced cleanup after client timeout. The model and required dependencies must already be in the image; downloading them during replay is unsupported.

Use the advanced replay section to label a retained completed task session. The server verifies the session/project/task and reconstructs the original full coder prompt and approved release. Rubrics, labels, and holdout flags are human-authored immutable inputs. Fixtures and full outcome artifacts, including binary code diffs, live under `~/.opensprint/governance-replay/`, outside ordinary session pruning. Original commits have dedicated `refs/opensprint/replay/` retention refs. Treat this evidence as private project data and back it up with the policy database. A missing original session before fixture capture cannot be reconstructed by inventing its prompt.

Evaluation requires at least ten fixtures, all five categories, and held-out positive and negative examples. It compares real measured task success, review outcomes, retries, latency and cost against baseline; regressions prevent activation. This minimum is an activation prerequisite, not evidence of broad improvement. Start with a human-measured baseline and sample routine approvals to detect violations that never escalated. Track human minutes, queue age, reversals, retrieval coverage, escaped regressions, and total cost/latency. Insufficient or conflicting evidence keeps rollout in shadow mode.

API entry points are under `/api/v1/projects/:projectId/governance`. The `/replay/sources` and `/replay/fixtures` reads show available retained inputs; capability-protected fixture labeling and `/replay/proposals/:proposalId/evaluate` run the evaluator. No HTTP endpoint accepts arbitrary evaluation scores.
