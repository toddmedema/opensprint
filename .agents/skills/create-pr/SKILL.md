---
name: create-pr
description: Prepare or update Open Sprint pull requests with verification evidence and required screenshots for user-visible UI changes. Use when writing a PR description, capturing review images, or checking that a PR has the relevant evidence.
---

# Create an Open Sprint PR

Read [AGENTS.md](../../../AGENTS.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md) for repository
contracts and required checks. Follow the task's authorization: this skill does not authorize a push,
PR, merge, or message by itself. Open Sprint Execute agents must keep their prepared branch and exact
`result.json` contract and leave publication to the orchestrator.

## Prepare the evidence

Inspect the branch diff against the intended base (`main` for this repository). Stage explicit task
files and review the staged diff; exclude unrelated edits, generated output, and scratch artifacts.
Use [verify-opensprint](../verify-opensprint/SKILL.md) for behavior changes. Describe what changed, why,
the checks actually run, and any remaining validation gaps. Distinguish passing, failing, skipped, and
unrun checks; never imply that a partial check establishes that every gate passed.

## Required screenshots

Every PR that changes user-visible UI must embed screenshots of the finished interface in the PR
description. Decide from the effect of the change, not its directory: frontend, Electron, and backend
changes can all alter a visible screen or interaction. Layout, styling, copy, navigation, charts, and
loading, empty, or error states are examples. Changes with no visible effect need no screenshots.

- Capture the actual app running the branch under review. Confirm the server belongs to the intended
  checkout; an existing server may serve another worktree. Follow the two-clone development guidance
  in CONTRIBUTING.md and choose unused ports rather than stopping someone else's server.
- Use available browser capture tools or the repository's existing Puppeteer dependency, preferably
  headless. Show the changed screen or interaction after it is ready, using safe sample data. A test
  runner screenshot, mockup, or unrelated landing page does not demonstrate the finished interface.
- Usually 1–3 focused images suffice. Include desktop and mobile layouts when responsive behavior is
  relevant, and light/dark or loading/error states when those are what changed. Add short captions with
  the state and viewport; include a comparable before view when it helps explain a visual fix.
- Refresh screenshots when subsequent commits change the interface they show so the images match the
  latest PR revision.
- Inspect each image before uploading. Check that the intended change is visible and remove secrets,
  API keys, personal project data, debug overlays, unrelated windows, and unintended transient errors.
- Keep review screenshots in a task-specific temporary directory or ignored `artifacts/` directory.
  Do not commit images that exist only to illustrate the PR.

## Attach and confirm

GitHub CLI 2.99 or newer supports image uploads with `gh pr create --attach` and `gh pr edit --attach`.
Check `gh --version` and command help before relying on attachment support. Write multiline PR text to
a temporary body file and pass `--body-file`. For example, after the branch is pushed and PR creation
is authorized:

```sh
gh pr create --repo toddmedema/opensprint --base main --head YOUR_BRANCH --title "Describe the change" --body-file pr-body.md --attach "artifacts/pr-review/desktop.png#Changed Execute view at desktop width"
```

Repeat `--attach` for additional images. To place an image next to its caption, reference its local
path in the body, such as `![Execute view at desktop width](./artifacts/pr-review/desktop.png)`; the CLI
rewrites the reference to the uploaded URL. For an existing PR, `gh pr edit PR_NUMBER --attach PATH`
appends the attachment without replacing the current body. A comment attachment alone does not satisfy
the description requirement; include its uploaded image URL in the description too.

Inspect the saved PR body to confirm every intended image has a GitHub-hosted URL that renders for
reviewers. The CLI can create or update the PR with partial uploads and still return a nonzero exit
code: inspect the existing PR before retrying so that failures do not create duplicate PRs. Remove
temporary images only after verifying the upload; stop preview servers started for this task.

If capture or upload is unavailable, put the exact limitation and missing views in a Screenshots
section of the PR description and tell the user. Do not silently omit the images, substitute local
filesystem links, or claim visual verification is complete.

Report the PR URL and current remote CI status. Check all required jobs before calling the PR ready;
if checks are pending, say so. Monitor to completion when the user requests monitoring or green CI.
