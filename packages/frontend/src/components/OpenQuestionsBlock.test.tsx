import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenQuestionsBlock } from "./OpenQuestionsBlock";
import type { Notification } from "@opensprint/shared";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    notifications: {
      resolve: vi.fn(),
    },
  },
}));

const mockNotification: Notification = {
  id: "oq-abc123",
  projectId: "proj-1",
  source: "plan",
  sourceId: "plan-1",
  questions: [
    { id: "q1", text: "What is the target platform?", createdAt: "2025-01-01T00:00:00Z" },
    { id: "q2", text: "Should we support dark mode?", createdAt: "2025-01-01T00:01:00Z" },
  ],
  status: "open",
  createdAt: "2025-01-01T00:00:00Z",
  resolvedAt: null,
};

describe("OpenQuestionsBlock", () => {
  const onResolved = vi.fn();
  const onAnswerSent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.notifications.resolve).mockResolvedValue({
      ...mockNotification,
      status: "resolved",
      resolvedAt: "2025-01-01T00:02:00Z",
    });
  });

  it("renders open questions with Answer and Dismiss", () => {
    render(
      <OpenQuestionsBlock
        notification={mockNotification}
        projectId="proj-1"
        source="plan"
        sourceId="plan-1"
        onResolved={onResolved}
        onAnswerSent={onAnswerSent}
      />
    );

    expect(screen.getByTestId("open-questions-block")).toBeInTheDocument();
    expect(screen.getByText("Open questions")).toBeInTheDocument();
    expect(screen.getByText("What is the target platform?")).toBeInTheDocument();
    expect(screen.getByText("Should we support dark mode?")).toBeInTheDocument();
    expect(screen.getByTestId("open-questions-answer-input")).toBeInTheDocument();
    expect(screen.getByTestId("open-questions-answer-btn")).toBeInTheDocument();
    expect(screen.getByTestId("open-questions-dismiss-btn")).toBeInTheDocument();
  });

  it("has data-question-id for scroll-to-target", () => {
    render(
      <OpenQuestionsBlock
        notification={mockNotification}
        projectId="proj-1"
        source="plan"
        sourceId="plan-1"
        onResolved={onResolved}
        onAnswerSent={onAnswerSent}
      />
    );

    const block = screen.getByTestId("open-questions-block");
    expect(block).toHaveAttribute("data-question-id", "oq-abc123");
  });

  it("calls api.notifications.resolve and onResolved when Dismiss clicked", async () => {
    const user = userEvent.setup();
    render(
      <OpenQuestionsBlock
        notification={mockNotification}
        projectId="proj-1"
        source="plan"
        sourceId="plan-1"
        onResolved={onResolved}
        onAnswerSent={onAnswerSent}
      />
    );

    await user.click(screen.getByTestId("open-questions-dismiss-btn"));

    await waitFor(() => {
      expect(api.notifications.resolve).toHaveBeenCalledWith("proj-1", "oq-abc123");
      expect(onResolved).toHaveBeenCalled();
    });
  });

  it("calls onAnswerSent, resolve, and onResolved when Answer submitted", async () => {
    const user = userEvent.setup();
    onAnswerSent.mockResolvedValue(undefined);
    render(
      <OpenQuestionsBlock
        notification={mockNotification}
        projectId="proj-1"
        source="plan"
        sourceId="plan-1"
        onResolved={onResolved}
        onAnswerSent={onAnswerSent}
      />
    );

    await user.type(screen.getByTestId("open-questions-answer-input"), "Web and mobile");
    await user.click(screen.getByTestId("open-questions-answer-btn"));

    await waitFor(() => {
      expect(onAnswerSent).toHaveBeenCalledWith("Web and mobile");
      expect(api.notifications.resolve).toHaveBeenCalledWith("proj-1", "oq-abc123");
      expect(onResolved).toHaveBeenCalled();
    });
  });

  it("Answer button is disabled when input is empty", () => {
    render(
      <OpenQuestionsBlock
        notification={mockNotification}
        projectId="proj-1"
        source="plan"
        sourceId="plan-1"
        onResolved={onResolved}
        onAnswerSent={onAnswerSent}
      />
    );

    expect(screen.getByTestId("open-questions-answer-btn")).toBeDisabled();
  });

  it("does not render Answer input when onAnswerSent is not provided", () => {
    render(
      <OpenQuestionsBlock
        notification={mockNotification}
        projectId="proj-1"
        source="execute"
        sourceId="task-1"
        onResolved={onResolved}
      />
    );

    expect(screen.queryByTestId("open-questions-answer-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("open-questions-answer-btn")).not.toBeInTheDocument();
    expect(screen.getByTestId("open-questions-dismiss-btn")).toBeInTheDocument();
  });

  it("returns null when notification has no questions", () => {
    const emptyNotification: Notification = {
      ...mockNotification,
      questions: [],
    };

    const { container } = render(
      <OpenQuestionsBlock
        notification={emptyNotification}
        projectId="proj-1"
        source="plan"
        sourceId="plan-1"
        onResolved={onResolved}
        onAnswerSent={onAnswerSent}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});
