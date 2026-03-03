import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { renderWithProviders } from "../../test/test-utils";
import { SourceFeedbackSection } from "./SourceFeedbackSection";

function renderWithRouter(ui: React.ReactElement) {
  return renderWithProviders(
    <MemoryRouter initialEntries={["/projects/proj-1/execute"]}>
      {ui}
    </MemoryRouter>
  );
}

const mockFeedbackGet = vi.fn();

vi.mock("../../api/client", () => ({
  api: {
    feedback: {
      get: (...args: unknown[]) => mockFeedbackGet(...args),
    },
  },
}));

describe("SourceFeedbackSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeedbackGet.mockResolvedValue(null);
  });

  it("renders collapsible header with Source Feedback label", () => {
    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={false}
        onToggle={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: /source feedback/i })).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("calls onToggle when header is clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={false}
        onToggle={onToggle}
      />
    );

    await user.click(screen.getByRole("button", { name: /source feedback/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("fetches and displays feedback when expanded", async () => {
    mockFeedbackGet.mockResolvedValue({
      id: "fb-1",
      text: "Add dark mode support",
      category: "feature",
      mappedPlanId: "plan-1",
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });

    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={true}
        onToggle={() => {}}
      />
    );

    expect(await screen.findByText("Add dark mode support")).toBeInTheDocument();
    expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();
  });

  it("shows Resolved chip when feedback status is resolved", async () => {
    mockFeedbackGet.mockResolvedValue({
      id: "fb-1",
      text: "Fixed bug",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "resolved",
      createdAt: "2026-02-17T10:00:00Z",
    });

    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={true}
        onToggle={() => {}}
      />
    );

    expect(await screen.findByText("Resolved")).toBeInTheDocument();
  });

  it("does not fetch when collapsed", () => {
    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={false}
        onToggle={() => {}}
      />
    );

    expect(mockFeedbackGet).not.toHaveBeenCalled();
  });

  it("uses same content wrapper and container styling as Live Output (p-4 pt-0, bg-theme-code-bg)", async () => {
    mockFeedbackGet.mockResolvedValue({
      id: "fb-1",
      text: "Test feedback",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });

    const { container } = renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={true}
        onToggle={() => {}}
      />
    );

    await screen.findByText("Test feedback");

    const contentRegion = container.querySelector("#source-feedback-content-fb-1");
    expect(contentRegion).toBeInTheDocument();
    expect(contentRegion).toHaveClass("p-4", "pt-0");

    const card = screen.getByTestId("source-feedback-card");
    expect(card).toHaveClass(
      "bg-theme-code-bg",
      "rounded-lg",
      "border",
      "border-theme-border",
      "overflow-hidden"
    );
    // Content uses p-4 on inner div to match Live Output structure (no extra indentation)
    const innerContent = card.querySelector(".p-4");
    expect(innerContent).toBeInTheDocument();
  });

  it("does not render feedback category chip or Mapped plan in Execute sidebar (reduced clutter)", async () => {
    mockFeedbackGet.mockResolvedValue({
      id: "fb-1",
      text: "Add dark mode support",
      category: "feature",
      mappedPlanId: "plan-1",
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });

    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={true}
        onToggle={() => {}}
      />
    );

    await screen.findByText("Add dark mode support");
    expect(screen.getByTestId("source-feedback-card")).toBeInTheDocument();
    expect(screen.queryByText("Feature")).not.toBeInTheDocument();
    expect(screen.queryByText(/mapped plan:/i)).not.toBeInTheDocument();
  });

  it("does not display formatted date in Source Feedback details", async () => {
    mockFeedbackGet.mockResolvedValue({
      id: "fb-1",
      text: "Fix the bug",
      category: "bug",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });

    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={true}
        onToggle={() => {}}
      />
    );

    await screen.findByText("Fix the bug");
    // Formatted date (e.g. "2/17/2026, 10:00:00 AM") should not be shown
    expect(screen.queryByText(/2\/17\/2026|Feb.*17.*2026|10:00:00/)).not.toBeInTheDocument();
  });

  it("shows link to View feedback in Evaluate that navigates to Evaluate phase with feedback param", async () => {
    mockFeedbackGet.mockResolvedValue({
      id: "fb-1",
      text: "Add dark mode support",
      category: "feature",
      mappedPlanId: "plan-1",
      createdTaskIds: [],
      status: "pending",
      createdAt: "2026-02-17T10:00:00Z",
    });

    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={true}
        onToggle={() => {}}
      />
    );

    await screen.findByText("Add dark mode support");
    const link = screen.getByRole("link", { name: /view feedback in evaluate/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/projects/proj-1/eval?feedback=fb-1");
    expect(link).toHaveClass("text-brand-600");
  });

  it("shows loading state with matching container styling", () => {
    mockFeedbackGet.mockImplementation(() => new Promise(() => {}));

    renderWithRouter(
      <SourceFeedbackSection
        projectId="proj-1"
        feedbackId="fb-1"
        expanded={true}
        onToggle={() => {}}
      />
    );

    expect(screen.getByTestId("source-feedback-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading feedback…")).toBeInTheDocument();
  });
});
