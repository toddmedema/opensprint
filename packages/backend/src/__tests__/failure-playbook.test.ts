import { describe, it, expect } from "vitest";
import { playbookLookup } from "../services/failure-playbook.js";

describe("failure-playbook", () => {
  it("maps dispatch worktree contention to defer resolution", () => {
    expect(playbookLookup("dispatch", "worktree_branch_in_use")).toBe(
      "defer_dispatch_same_worktree"
    );
  });

  it("falls back to requeue for unknown keys", () => {
    expect(playbookLookup("coding", "unknown_xyz")).toBe("requeue_with_retry_context");
  });

  it("exports baseline and merge entries", () => {
    expect(playbookLookup("global", "baseline_red")).toBe("baseline_pause_merge_and_dispatch");
    expect(playbookLookup("merge", "merge_quality_gate")).toBe("merge_requeue_or_block");
  });
});
