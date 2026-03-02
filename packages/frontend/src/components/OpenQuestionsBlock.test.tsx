import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { OpenQuestionsBlock } from "./OpenQuestionsBlock";
import type { Notification } from "@opensprint/shared";
import { api } from "../api/client";

function LocationCapture() {
  const loc = useLocation();
  return <div data-testid="current-location">{loc.pathname}{loc.search}</div>;
}

function renderWithRouter(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <LocationCapture />
      {ui}
    </MemoryRouter>
  );
}

vi.mock("../api/client", () => ({
  api: {
    notifications: {
      resolve: vi.fn(),
      retryRateLimit: vi.fn(),
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
    renderWithRouter(
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
    renderWithRouter(
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
    renderWithRouter(
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
    renderWithRouter(
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
    renderWithRouter(
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
    renderWithRouter(
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

  it("renders API-blocked rate_limit variant with Retry and Dismiss (no Answer input)", () => {
    vi.mocked(api.notifications.retryRateLimit).mockResolvedValue({ ok: true, resolvedCount: 1 });

    const apiBlockedNotification: Notification = {
      ...mockNotification,
      id: "ab-1",
      questions: [{ id: "q1", text: "Rate limit exceeded. Add more API keys.", createdAt: "2025-01-01T00:00:00Z" }],
      kind: "api_blocked",
      errorCode: "rate_limit",
    };

    renderWithRouter(
      <OpenQuestionsBlock
        notification={apiBlockedNotification}
        projectId="proj-1"
        source="execute"
        sourceId="task-1"
        onResolved={onResolved}
        onAnswerSent={onAnswerSent}
      />
    );

    expect(screen.getByText("API blocked")).toBeInTheDocument();
    expect(screen.getByText(/Rate limit: Fix in Global settings/)).toBeInTheDocument();
    expect(screen.getByTestId("open-global-settings-link")).toHaveTextContent("Open Global settings");
    expect(screen.getByText(/Rate limit exceeded/)).toBeInTheDocument();
    expect(screen.queryByTestId("open-questions-answer-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("open-questions-retry-btn")).toBeInTheDocument();
    expect(screen.getByTestId("open-questions-dismiss-btn")).toBeInTheDocument();
  });

  it("navigates to project settings with Global tab when Open Global settings clicked on rate_limit", async () => {
    const apiBlockedNotification: Notification = {
      ...mockNotification,
      id: "ab-1",
      questions: [{ id: "q1", text: "Rate limit exceeded.", createdAt: "2025-01-01T00:00:00Z" }],
      kind: "api_blocked",
      errorCode: "rate_limit",
    };

    renderWithRouter(
      <OpenQuestionsBlock
        notification={apiBlockedNotification}
        projectId="proj-1"
        source="execute"
        sourceId="task-1"
        onResolved={onResolved}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId("open-global-settings-link"));

    await waitFor(() => {
      const loc = screen.getByTestId("current-location");
      expect(loc).toHaveTextContent("/projects/proj-1/settings");
      expect(loc).toHaveTextContent("level=global");
    });
  });

  it("calls retryRateLimit and onResolved when Retry clicked on rate_limit notification", async () => {
    const user = userEvent.setup();
    vi.mocked(api.notifications.retryRateLimit).mockResolvedValue({ ok: true, resolvedCount: 1 });

    const apiBlockedNotification: Notification = {
      ...mockNotification,
      id: "ab-1",
      questions: [{ id: "q1", text: "Rate limit exceeded.", createdAt: "2025-01-01T00:00:00Z" }],
      kind: "api_blocked",
      errorCode: "rate_limit",
    };

    renderWithRouter(
      <OpenQuestionsBlock
        notification={apiBlockedNotification}
        projectId="proj-1"
        source="execute"
        sourceId="task-1"
        onResolved={onResolved}
      />
    );

    await user.click(screen.getByTestId("open-questions-retry-btn"));

    await waitFor(() => {
      expect(api.notifications.retryRateLimit).toHaveBeenCalledWith("proj-1", "ab-1");
      expect(onResolved).toHaveBeenCalled();
    });
  });

  it("renders API-blocked auth variant with Dismiss only (no Retry)", () => {
    const apiBlockedNotification: Notification = {
      ...mockNotification,
      id: "ab-2",
      questions: [{ id: "q1", text: "Invalid API key.", createdAt: "2025-01-01T00:00:00Z" }],
      kind: "api_blocked",
      errorCode: "auth",
    };

    renderWithRouter(
      <OpenQuestionsBlock
        notification={apiBlockedNotification}
        projectId="proj-1"
        source="execute"
        sourceId="task-1"
        onResolved={onResolved}
      />
    );

    expect(screen.getByText("API blocked")).toBeInTheDocument();
    expect(screen.queryByTestId("open-questions-retry-btn")).not.toBeInTheDocument();
    expect(screen.getByTestId("open-questions-dismiss-btn")).toBeInTheDocument();
  });

  it("shows error message when Retry fails on rate_limit notification", async () => {
    const user = userEvent.setup();
    vi.mocked(api.notifications.retryRateLimit).mockRejectedValue(
      new Error("No API keys available. Add more keys in Settings or wait 24h.")
    );

    const apiBlockedNotification: Notification = {
      ...mockNotification,
      id: "ab-1",
      questions: [{ id: "q1", text: "Rate limit exceeded.", createdAt: "2025-01-01T00:00:00Z" }],
      kind: "api_blocked",
      errorCode: "rate_limit",
    };

    renderWithRouter(
      <OpenQuestionsBlock
        notification={apiBlockedNotification}
        projectId="proj-1"
        source="execute"
        sourceId="task-1"
        onResolved={onResolved}
      />
    );

    await user.click(screen.getByTestId("open-questions-retry-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("open-questions-retry-error")).toHaveTextContent(
        "No API keys available. Add more keys in Settings or wait 24h."
      );
    });
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("returns null when notification has no questions", () => {
    const emptyNotification: Notification = {
      ...mockNotification,
      questions: [],
    };

    renderWithRouter(
      <OpenQuestionsBlock
        notification={emptyNotification}
        projectId="proj-1"
        source="plan"
        sourceId="plan-1"
        onResolved={onResolved}
        onAnswerSent={onAnswerSent}
      />
    );

    expect(screen.queryByTestId("open-questions-block")).not.toBeInTheDocument();
  });
});
