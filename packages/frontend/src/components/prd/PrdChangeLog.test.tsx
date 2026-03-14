// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrdChangeLog, type PrdHistoryEntry } from "./PrdChangeLog";

const mockGetVersionDiff = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    prd: {
      getVersionDiff: (...args: unknown[]) => mockGetVersionDiff(...args),
    },
  },
  isApiError: (err: unknown) =>
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "NOT_FOUND",
}));

const entryWithDocVersion: PrdHistoryEntry = {
  section: "problem_statement",
  version: 2,
  timestamp: "2025-01-15T12:00:00Z",
  source: "sketch",
  diff: "Updated section",
  documentVersion: 3,
};

const entryWithoutDocVersion: PrdHistoryEntry = {
  section: "goals_and_metrics",
  version: 1,
  timestamp: "2025-01-14T10:00:00Z",
  source: "sketch",
  diff: "Initial",
};

describe("PrdChangeLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders change history toggle and entries when expanded", () => {
    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("Change history")).toBeInTheDocument();
    expect(screen.getByText("1 entry")).toBeInTheDocument();
    expect(screen.getByText("Updated section")).toBeInTheDocument();
  });

  it("shows Compare to current only for entries with documentVersion", () => {
    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion, entryWithoutDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );
    const compareButtons = screen.getAllByTestId("compare-to-current");
    expect(compareButtons).toHaveLength(1);
  });

  it("opens diff modal and fetches version diff when Compare to current is clicked", async () => {
    const user = userEvent.setup();
    mockGetVersionDiff.mockResolvedValue({
      fromVersion: "3",
      toVersion: "current",
      diff: {
        lines: [{ type: "context", text: "line", oldLineNumber: 1, newLineNumber: 1 }],
        summary: { additions: 0, deletions: 0 },
      },
    });

    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );

    await user.click(screen.getByTestId("compare-to-current"));

    expect(mockGetVersionDiff).toHaveBeenCalledWith("proj-1", "3");
    expect(screen.getByTestId("version-diff-modal-content")).toBeInTheDocument();
    expect(screen.getByText("Diff: v3 → current")).toBeInTheDocument();
    expect(screen.getByTestId("version-diff-modal-close")).toBeInTheDocument();
  });

  it("shows loading then diff content in modal", async () => {
    const user = userEvent.setup();
    let resolveDiff: ((value: unknown) => void) | null = null;
    mockGetVersionDiff.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDiff = resolve;
        })
    );

    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );

    await user.click(screen.getByTestId("compare-to-current"));
    expect(await screen.findByTestId("version-diff-loading")).toBeInTheDocument();

    resolveDiff?.({
      fromVersion: "3",
      toVersion: "current",
      diff: {
        lines: [
          {
            type: "add",
            text: "New line",
            newLineNumber: 1,
          },
        ],
        summary: { additions: 1, deletions: 0 },
      },
    });

    await screen.findByTestId("server-diff-view");
    expect(screen.queryByTestId("version-diff-loading")).not.toBeInTheDocument();
    expect(screen.getByText(/New line/)).toBeInTheDocument();
  });

  it("closes modal when Close is clicked", async () => {
    const user = userEvent.setup();
    mockGetVersionDiff.mockResolvedValue({
      fromVersion: "3",
      toVersion: "current",
      diff: { lines: [], summary: { additions: 0, deletions: 0 } },
    });

    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );

    await user.click(screen.getByTestId("compare-to-current"));
    expect(screen.getByTestId("version-diff-modal-content")).toBeInTheDocument();

    await user.click(screen.getByTestId("version-diff-modal-close"));
    expect(screen.queryByTestId("version-diff-modal-content")).not.toBeInTheDocument();
  });

  it("closes modal when backdrop is clicked", async () => {
    const user = userEvent.setup();
    mockGetVersionDiff.mockResolvedValue({
      fromVersion: "3",
      toVersion: "current",
      diff: { lines: [] },
    });

    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );

    await user.click(screen.getByTestId("compare-to-current"));
    await user.click(screen.getByTestId("version-diff-modal-backdrop"));
    expect(screen.queryByTestId("version-diff-modal-content")).not.toBeInTheDocument();
  });

  it("shows error when getVersionDiff fails", async () => {
    const user = userEvent.setup();
    mockGetVersionDiff.mockRejectedValue(new Error("Network error"));

    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );

    await user.click(screen.getByTestId("compare-to-current"));
    expect(await screen.findByTestId("version-diff-error")).toHaveTextContent("Network error");
  });

  it("shows Version not found and Close when getVersionDiff returns 404", async () => {
    const user = userEvent.setup();
    const notFoundError = Object.assign(new Error("No snapshot found for version 99"), {
      code: "NOT_FOUND",
    });
    mockGetVersionDiff.mockRejectedValue(notFoundError);

    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );

    await user.click(screen.getByTestId("compare-to-current"));
    expect(await screen.findByTestId("version-diff-error-block")).toBeInTheDocument();
    expect(screen.getByTestId("version-diff-error")).toHaveTextContent("Version not found.");
    expect(screen.getByTestId("version-diff-error-close")).toBeInTheDocument();

    await user.click(screen.getByTestId("version-diff-error-close"));
    expect(screen.queryByTestId("version-diff-modal-content")).not.toBeInTheDocument();
  });

  it("shows No changes in diff when version diff returns empty lines", async () => {
    const user = userEvent.setup();
    mockGetVersionDiff.mockResolvedValue({
      fromVersion: "3",
      toVersion: "current",
      diff: { lines: [], summary: { additions: 0, deletions: 0 } },
    });

    render(
      <PrdChangeLog
        projectId="proj-1"
        entries={[entryWithDocVersion]}
        expanded={true}
        onToggle={() => {}}
      />
    );

    await user.click(screen.getByTestId("compare-to-current"));
    expect(await screen.findByTestId("server-diff-view")).toBeInTheDocument();
    expect(screen.getByTestId("server-diff-no-changes")).toHaveTextContent("No changes");
  });
});
