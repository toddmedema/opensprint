import fs from "fs/promises";
import path from "path";

const LEGACY_BD_TASK_TRACKING_INSTRUCTION = "Use 'bd' for task tracking";
const OPENSPRINT_RUNTIME_CONTRACT_HEADING = "## Open Sprint Runtime Contract";
const OPENSPRINT_RUNTIME_CONTRACT_SECTION = [
  OPENSPRINT_RUNTIME_CONTRACT_HEADING,
  "",
  "Open Sprint manages task state internally. Do not use external task CLIs.",
  "",
  "- Native Claude Code (`claude-cli`) and Codex (`codex`) agents use local subscription sign-in, not API-key settings. Their task prompts are passed on stdin. An optional per-tier effort uses the selected model’s supported levels; omitted effort preserves CLI defaults. Explicit effort is verified before launch and passed through the native CLI configuration, including task-file runs. Sandbox restrictions remain active; if a required action is blocked, report it rather than claiming success. The orchestrator commits remaining worktree changes before merge.",
  "- Pull request delivery uses a shared plan branch; the orchestrator publishes the PR and retains the branch for human merge. Execute agents must leave publication to the orchestrator. PR delivery requires no active or retained review governance; governed projects use direct delivery.",
  "- Execute agents start in a prepared worktree with the task branch already checked out.",
  "- Evaluate automated QA uses the configured auditor agent in one isolated checkout of the configured base revision per selected perspective. Run checks with tool access and write the QA-specific result contract from the prompt; do not implement fixes or publish code. The server files evidence-backed findings as Evaluate feedback and cleans checkouts after runner exit. Report incomplete checks as failures.",
  "- Agent admission is cancellable and FIFO. Recheck attempt generation and owning slot after admission and immediately before launch; cancelled or replaced queued attempts must never launch. Concurrency limit changes preserve active accounting.",
  "- Recovered PIDs are observation-only until ownership is independently verified. Retain uncertain assignments instead of killing or requeueing them. A stop request becomes stopped only after observed completion. A terminal result file alone cannot complete an unverified recovered process. Guidance receipts distinguish durable queue acceptance from inclusion in a model turn.",
  "- Run the smallest relevant non-watch verification for touched workspaces while iterating. Use scoped tests first, add scoped build/typecheck and lint commands when your changes could affect them, and leave the branch in a state where the project’s configured merge quality gates are expected to pass before reporting success.",
  "- If you add, remove, or upgrade dependencies: run the repository’s documented install workflow from the repository root, update manifests/lockfiles required by that ecosystem, and commit dependency metadata changes together with the code that uses them.",
  "- If the project’s build/typecheck includes tests, ensure test-runner globals and typing/runtime configuration are set up so build/typecheck still passes after your changes.",
  "- Report completion or blocking questions by writing the exact `.opensprint/active/<task-id>/result.json` payload requested in the task prompt.",
  "- Commit incremental logical units while working so crash recovery can preserve progress.",
  '- If blocked by ambiguity, return `status: "failed"` with `open_questions` instead of guessing.',
  "- Do not push, merge, or close tasks manually; the orchestrator handles validation, task state, merging, and remote publication.",
  "- When review governance is enabled, use the assignment's pinned policy release and structured findings/appeals. Repository edits cannot alter governing authority. Human governance rulings are separate from ordinary open-question answers; do not resolve dockets or access approval credentials. Hard gates and protected-path scope cannot be waived; under enforcement only an owner's structured scope grant unlocks protected paths, never task wording.",
  "- Governance waiting tasks retain their worktree and durable evidence while releasing agent slots. Only a valid code/policy-bound disposition permits resumption. Policy amendments and rollback require authorized human approval and complete isolated evaluation.",
  "- Prepared remote publication tasks start with fresh review and hard checks against the assigned remote base and original per-file scope; rejected code may then enter a fix cycle. Pending publication cannot trigger automatic deployment.",
].join("\n");

// Runtime and worktree paths must stay local and never be committed.
export const PROJECT_GITIGNORE_ENTRIES = [
  ".opensprint/*.json",
  ".opensprint/orchestrator-state.json",
  ".opensprint/worktrees/",
  ".opensprint/pending-commits.json",
  ".opensprint/sessions/",
  ".opensprint/active/",
  ".opensprint/guidance/",
  ".opensprint/runtime/",
] as const;

function removeLegacyBdTaskTrackingInstruction(content: string): string {
  return content
    .replace(new RegExp(`(^|\\n)${LEGACY_BD_TASK_TRACKING_INSTRUCTION}(?=\\n|$)`, "g"), "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function ensureOpenSprintRuntimeContract(content: string): string {
  const normalized = removeLegacyBdTaskTrackingInstruction(content);
  if (normalized.includes(OPENSPRINT_RUNTIME_CONTRACT_HEADING)) {
    return normalized
      ? `${normalized}\n`
      : `# Agent Instructions\n\n${OPENSPRINT_RUNTIME_CONTRACT_SECTION}\n`;
  }
  if (!normalized.trim()) {
    return `# Agent Instructions\n\n${OPENSPRINT_RUNTIME_CONTRACT_SECTION}\n`;
  }
  return `${normalized}\n\n${OPENSPRINT_RUNTIME_CONTRACT_SECTION}\n`;
}

export async function ensureProjectGitignoreEntries(repoPath: string): Promise<void> {
  const gitignorePath = path.join(repoPath, ".gitignore");
  try {
    let content = await fs.readFile(gitignorePath, "utf-8");
    for (const entry of PROJECT_GITIGNORE_ENTRIES) {
      if (!content.includes(entry)) {
        content += `\n${entry}`;
      }
    }
    await fs.writeFile(gitignorePath, content.trimEnd() + "\n");
  } catch {
    await fs.writeFile(gitignorePath, PROJECT_GITIGNORE_ENTRIES.join("\n") + "\n");
  }
}
