import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { REVIEW_AGENT_OPTIONS, type AutomatedQaResult } from "@opensprint/shared";
import { AutomatedQaButton } from "./AutomatedQaButton";
import { api } from "../../api/client";

vi.mock("../../api/client", () => ({ api: { feedback: { runAutomatedQa: vi.fn() } } }));

describe("AutomatedQaButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers all code review perspectives, requires a selection, and submits additional instructions", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.mocked(api.feedback.runAutomatedQa).mockResolvedValue({
      runId: "run-1",
      results: [
        {
          perspective: "performance",
          status: "completed",
          summary: "Checked page loads",
          feedbackIds: ["feedback-1"],
        },
      ],
    });
    render(<AutomatedQaButton projectId="project-1" onComplete={onComplete} />);
    await user.click(screen.getByRole("button", { name: "Run automated QA" }));
    const dialog = screen.getByRole("dialog");
    for (const option of REVIEW_AGENT_OPTIONS)
      expect(within(dialog).getByRole("checkbox", { name: option.label })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "General" }));
    expect(screen.getByRole("button", { name: "Run QA" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Performance impact" }));
    await user.type(
      screen.getByLabelText("Additional instructions (optional)"),
      "  Focus on slow page loads  "
    );
    await user.click(screen.getByRole("button", { name: "Run QA" }));
    await waitFor(() =>
      expect(api.feedback.runAutomatedQa).toHaveBeenCalledWith("project-1", {
        perspectives: ["performance"],
        instructions: "Focus on slow page loads",
      })
    );
    expect(await screen.findByText(/1 issue added to Evaluate/)).toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("prevents duplicate submissions, keeps running after closing the dialog, and reports partial failures", async () => {
    let resolve!: (result: AutomatedQaResult) => void;
    vi.mocked(api.feedback.runAutomatedQa).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    render(<AutomatedQaButton projectId="project-1" onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run automated QA" }));
    fireEvent.click(screen.getByRole("button", { name: "Run QA" }));
    expect(screen.getByRole("button", { name: "Running QA…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close automated QA" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "QA running…" }));
    expect(screen.getByRole("checkbox", { name: "General" })).toBeDisabled();
    resolve({
      runId: "run-1",
      results: [
        {
          perspective: "general",
          status: "failed",
          summary: "Browser unavailable",
          feedbackIds: [],
        },
      ],
    });
    expect(await screen.findByText(/1 perspective could not complete/)).toBeInTheDocument();
    expect(screen.getByText(/Browser unavailable/)).toBeInTheDocument();
    expect(api.feedback.runAutomatedQa).toHaveBeenCalledOnce();
  });

  it("retains input and permits retry after API failure; Escape closes the dialog", async () => {
    vi.mocked(api.feedback.runAutomatedQa).mockRejectedValueOnce(
      new Error("QA is already running")
    );
    const onComplete = vi.fn();
    render(<AutomatedQaButton projectId="project-1" onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Run automated QA" }));
    fireEvent.change(screen.getByLabelText("Additional instructions (optional)"), {
      target: { value: "Check mobile layout" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run QA" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("QA is already running");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Additional instructions (optional)")).toHaveValue(
      "Check mobile layout"
    );
    expect(screen.getByRole("button", { name: "Run QA" })).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["success", "failure"])("does not refresh after unmount on %s", async (outcome) => {
    let reject!: (error: Error) => void;
    let resolve!: (result: AutomatedQaResult) => void;
    vi.mocked(api.feedback.runAutomatedQa).mockReturnValue(
      new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      })
    );
    const onComplete = vi.fn();
    const { unmount } = render(<AutomatedQaButton projectId="project-1" onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Run automated QA" }));
    fireEvent.click(screen.getByRole("button", { name: "Run QA" }));
    unmount();
    if (outcome === "success") resolve({ runId: "run-1", results: [] });
    else reject(new Error("Request failed"));
    await Promise.resolve();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
