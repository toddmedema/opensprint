#!/usr/bin/env bash
# Agent Chain: Complete one bd task, commit, then kick off the next agent.
# Orchestrator loop: bd ready -> bd update --claim -> create branch -> spawn agent.
# Run: ./scripts/agent-chain.sh
# Requires: Cursor CLI (agent) - install: curl https://cursor.com/install -fsSL | bash
# Output: stream-json for real-time progress (tool calls, messages). Pipe through jq for readability.

set -e
cd "$(dirname "$0")/.."

# 1. Get next ready task (dependency-aware, priority-sorted)
READY_JSON=$(bd ready --json 2>/dev/null || echo "[]")
# Filter out Plan approval gate (user closes via Ship it!) and epics (containers, not work items)
READY_TASKS=$(echo "$READY_JSON" | jq 'if type == "array" then [.[] | select((.title // "") != "Plan approval gate") | select((.issue_type // .type // "") != "epic")] else [] end' 2>/dev/null)

# Find first task with all blockers closed (bd ready may return in_progress blockers as resolved)
NEXT_TASK=""
for task in $(echo "$READY_TASKS" | jq -c '.[]' 2>/dev/null); do
  TID=$(echo "$task" | jq -r '.id')
  if npm run check-blockers -w packages/backend -- "$TID" 2>/dev/null; then
    NEXT_TASK="$task"
    break
  fi
  echo "⏭️  Skipping $TID: not all blockers closed"
done

if [[ -z "$NEXT_TASK" || "$NEXT_TASK" == "null" ]]; then
  echo "✅ No ready bd tasks (all have unresolved blockers). Agent chain complete."
  exit 0
fi

TASK_ID=$(echo "$NEXT_TASK" | jq -r '.id')
TASK_TITLE=$(echo "$NEXT_TASK" | jq -r '.title')
TASK_DESC=$(echo "$NEXT_TASK" | jq -r '.description // ""')
TASK_PRIORITY=$(echo "$NEXT_TASK" | jq -r '.priority // 2')

echo "📋 Next task: $TASK_ID - $TASK_TITLE"
echo ""

# 2. Claim the task (atomic: assignee + in_progress)
bd update "$TASK_ID" --claim 2>/dev/null || true

# 3. Create task branch (git checkout -b opensprint/<task-id>)
git checkout main 2>/dev/null || git checkout master 2>/dev/null || true
git checkout -b "opensprint/${TASK_ID}" 2>/dev/null || git checkout "opensprint/${TASK_ID}" 2>/dev/null || true

# 4. Prepare task directory and spawn coding agent (context assembly + output streaming)
if command -v agent &>/dev/null; then
  echo "🤖 Starting agent for $TASK_ID (task dir + stream)..."
  set +e
  npm run run-task -w packages/backend -- "$TASK_ID"
  EXIT_CODE=$?
  set -e

  # Exit codes 143 (SIGTERM) and 130 (SIGINT) are expected when the agent
  # finishes — the CLI may signal its process group during cleanup.
  # Treat them as success if the agent completed its work.
  if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 143 ] && [ $EXIT_CODE -ne 130 ]; then
    echo "❌ Agent failed with exit code $EXIT_CODE"
    exit $EXIT_CODE
  fi
  echo "✅ Agent finished for $TASK_ID"
else
  echo "⚠️  Cursor CLI (agent) not installed. Install with:"
  echo "   curl https://cursor.com/install -fsSL | bash"
  echo ""
  echo "Or run manually: npm run run-task -w packages/backend -- $TASK_ID"
  exit 1
fi
