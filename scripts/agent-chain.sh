#!/usr/bin/env bash
# Agent Chain: Complete one bd task, commit, then kick off the next agent.
# Uses git worktrees so agents never modify the main working tree.
# Run: ./scripts/agent-chain.sh
# Requires: Cursor CLI (agent) - install: curl https://cursor.com/install -fsSL | bash
# Output: stream-json for real-time progress (tool calls, messages). Pipe through jq for readability.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 0. Pre-flight: recover orphaned tasks (in_progress + agent assignee but no active process)
npm run recover-orphans -w packages/backend 2>/dev/null || true

# 1. Get next ready task (dependency-aware, priority-sorted)
READY_JSON=$(bd ready --json 2>/dev/null || echo "[]")
# Filter out Plan approval gate (user closes via Build It!) and epics (containers, not work items)
READY_TASKS=$(echo "$READY_JSON" | jq 'if type == "array" then [.[] | select((.title // "") != "Plan approval gate") | select((.issue_type // .type // "") != "epic")] else [] end' 2>/dev/null)

# Find first task with all blockers closed (bd ready may return in_progress blockers as resolved)
# Use while-read with process substitution to avoid word-splitting JSON on spaces
NEXT_TASK=""
while IFS= read -r task; do
  TID=$(echo "$task" | jq -r '.id')
  if npm run check-blockers -w packages/backend -- "$TID" 2>/dev/null; then
    NEXT_TASK="$task"
    break
  fi
  echo "⏭️  Skipping $TID: not all blockers closed"
done < <(echo "$READY_TASKS" | jq -c '.[]' 2>/dev/null)

if [[ -z "$NEXT_TASK" || "$NEXT_TASK" == "null" ]]; then
  echo "✅ No ready bd tasks (all have unresolved blockers). Agent chain complete."
  exit 0
fi

TASK_ID=$(echo "$NEXT_TASK" | jq -r '.id')
TASK_TITLE=$(echo "$NEXT_TASK" | jq -r '.title')
TASK_DESC=$(echo "$NEXT_TASK" | jq -r '.description // ""')
TASK_PRIORITY=$(echo "$NEXT_TASK" | jq -r '.priority // 2')
BRANCH_NAME="opensprint/${TASK_ID}"
WORKTREE="/tmp/opensprint-worktrees/${TASK_ID}"

echo "📋 Next task: $TASK_ID - $TASK_TITLE"
echo ""

# 2. Claim the task (atomic: assignee + in_progress)
bd update "$TASK_ID" --claim 2>/dev/null || true

# 3. Create worktree (main working tree stays on main, no checkout)
#    Create branch from main if it doesn't exist
git branch "$BRANCH_NAME" main 2>/dev/null || true
#    Clean up stale worktree if exists
git worktree remove "$WORKTREE" --force 2>/dev/null || rm -rf "$WORKTREE" 2>/dev/null || true
git worktree prune 2>/dev/null || true
#    Create fresh worktree
mkdir -p "$(dirname "$WORKTREE")"
git worktree add "$WORKTREE" "$BRANCH_NAME"

# 4. Prepare task directory and spawn coding agent in worktree
if command -v agent &>/dev/null; then
  echo "🤖 Starting agent for $TASK_ID in worktree $WORKTREE..."
  set +e
  (cd "$WORKTREE" && npm run run-task -w packages/backend -- "$TASK_ID")
  EXIT_CODE=$?
  set -e

  # Exit codes 143 (SIGTERM) and 130 (SIGINT) are expected when the agent
  # finishes — the CLI may signal its process group during cleanup.
  if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 143 ] && [ $EXIT_CODE -ne 130 ]; then
    echo "❌ Agent failed with exit code $EXIT_CODE"
    # Clean up worktree on failure
    git worktree remove "$WORKTREE" --force 2>/dev/null || true
    git branch -D "$BRANCH_NAME" 2>/dev/null || true
    exit $EXIT_CODE
  fi
  echo "✅ Agent finished for $TASK_ID"

  # 5. Post-agent: commit in worktree, merge to main, clean up.

  # Commit any uncommitted work the agent left behind (in worktree)
  if ! git -C "$WORKTREE" diff --quiet HEAD 2>/dev/null || ! git -C "$WORKTREE" diff --cached --quiet HEAD 2>/dev/null; then
    echo "📦 Committing agent's uncommitted changes..."
    git -C "$WORKTREE" add -A
    git -C "$WORKTREE" commit -m "Complete $TASK_ID: $TASK_TITLE" || true
  fi

  # Merge to main (from the main working tree, which is always on main)
  echo "🔀 Merging $BRANCH_NAME to main..."
  cd "$REPO_ROOT"
  git merge "$BRANCH_NAME" || true

  # Mark the task done (idempotent — no-op if agent already did it)
  bd update "$TASK_ID" --status done 2>/dev/null || true

  # Sync beads and push
  bd sync 2>/dev/null || true
  git push origin main 2>/dev/null || true

  # Clean up worktree and branch
  git worktree remove "$WORKTREE" --force 2>/dev/null || true
  git branch -d "$BRANCH_NAME" 2>/dev/null || true

  # 6. Continue the chain — exec replaces this process to avoid deep recursion
  echo ""
  echo "🔄 Continuing agent chain..."
  exec ./scripts/agent-chain.sh
else
  echo "⚠️  Cursor CLI (agent) not installed. Install with:"
  echo "   curl https://cursor.com/install -fsSL | bash"
  echo ""
  echo "Or run manually: npm run run-task -w packages/backend -- $TASK_ID"
  # Clean up worktree on bail
  git worktree remove "$WORKTREE" --force 2>/dev/null || true
  exit 1
fi
