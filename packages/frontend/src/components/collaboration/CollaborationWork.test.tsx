import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollaborationTaskContext } from "@opensprint/shared";
import { CollaborationWork } from "./CollaborationWork";

const diff = `diff --git a/src/first.ts b/src/first.ts
--- a/src/first.ts
+++ b/src/first.ts
@@ -1 +1 @@
-old first
+new first
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
--- a/src/removed.ts
+++ /dev/null
@@ -8,2 +0,0 @@
-remove one
-remove two
diff --git a/src/last.ts b/src/last.ts
--- a/src/last.ts
+++ b/src/last.ts
@@ -2,2 +2,2 @@
 keep line
-old last
+new last
`;
const context: CollaborationTaskContext = {
  task: { id: "os-task", title: "Review changes", status: "in_progress" },
  activeRun: null,
  output: "",
  diff,
  source: "active",
  sourceAttemptId: "attempt-one",
  sourceAttempt: 1,
  diffRevision: "reviewed-revision",
};
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});
function selectLine(content: string) {
  const target = screen.getByRole("textbox", { name: "Task diff" });
  const node = target.querySelector("pre")!.firstChild!;
  const start = node.textContent!.indexOf(content);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + content.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(target);
}
describe("contextual shared work comments", () => {
  it.each([
    { content: "-- Old comment", line: 10, removed: true },
    { content: "DROP TABLE old_table;", line: 11, removed: true },
    { content: "++ new value", line: 10, removed: false },
  ])("keeps header-shaped hunk content on its real file and line: $content", async (sample) => {
    const discuss = vi.fn();
    const sqlDiff = `diff --git a/migration.sql b/migration.sql
--- a/migration.sql
+++ b/migration.sql
@@ -10,2 +10,2 @@
--- Old comment
-DROP TABLE old_table;
+++ new value
+SELECT 2;
`;
    render(
      <CollaborationWork
        context={{ ...context, diff: sqlDiff }}
        loading={false}
        mayDiscuss
        onDiscuss={discuss}
      />
    );
    selectLine(sample.content);
    const label = `migration.sql:${sample.line}${sample.removed ? " (removed)" : ""}`;
    await userEvent.click(screen.getByRole("button", { name: "Comment on " + label }));
    expect(discuss).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        path: "migration.sql",
        line: sample.line,
        label,
      })
    );
  });

  it("attributes a deleted-file selection to its removed path and original line", async () => {
    const discuss = vi.fn();
    render(<CollaborationWork context={context} loading={false} mayDiscuss onDiscuss={discuss} />);
    selectLine("remove two");
    await userEvent.click(
      screen.getByRole("button", { name: "Comment on src/removed.ts:9 (removed)" })
    );
    expect(discuss).toHaveBeenCalledWith({
      kind: "file",
      label: "src/removed.ts:9 (removed)",
      path: "src/removed.ts",
      line: 9,
      attemptId: "attempt-one",
      attempt: 1,
      diffRevision: "reviewed-revision",
    });
  });
  it("resets paths between files and counts the selected added line", async () => {
    const discuss = vi.fn();
    render(<CollaborationWork context={context} loading={false} mayDiscuss onDiscuss={discuss} />);
    selectLine("new last");
    await userEvent.click(screen.getByRole("button", { name: "Comment on src/last.ts:3" }));
    expect(discuss).toHaveBeenCalledWith(expect.objectContaining({ path: "src/last.ts", line: 3 }));
  });
  it("does not turn a viewer's selection into a discussion action", () => {
    const discuss = vi.fn();
    render(
      <CollaborationWork context={context} loading={false} mayDiscuss={false} onDiscuss={discuss} />
    );
    selectLine("remove one");
    expect(screen.queryByRole("button", { name: /Comment on/ })).not.toBeInTheDocument();
    expect(discuss).not.toHaveBeenCalled();
  });
});
