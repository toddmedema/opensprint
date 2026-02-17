import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddPlanModal } from "./AddPlanModal";

const mockCreate = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    plans: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

describe("AddPlanModal", () => {
  const onClose = vi.fn();
  const onCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not show a complexity dropdown (agent-evaluated complexity)", () => {
    render(
      <AddPlanModal projectId="proj-1" onClose={onClose} onCreated={onCreated} />,
    );

    expect(screen.getByText("Feature Title")).toBeInTheDocument();
    expect(screen.getByText("Plan Markdown")).toBeInTheDocument();
    expect(screen.queryByLabelText(/complexity/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("calls create with title and content only (no complexity - backend evaluates)", async () => {
    mockCreate.mockResolvedValueOnce({
      metadata: { planId: "new-feature", beadEpicId: "e1", gateTaskId: "e1.0", complexity: "medium" },
      content: "# New Feature\n\nContent.",
      status: "planning",
      taskCount: 0,
      doneTaskCount: 0,
      dependencyCount: 0,
    });

    const user = userEvent.setup();
    render(
      <AddPlanModal projectId="proj-1" onClose={onClose} onCreated={onCreated} />,
    );

    await user.type(screen.getByPlaceholderText(/user authentication/i), "New Feature");
    await user.click(screen.getByRole("button", { name: /create plan/i }));

    expect(mockCreate).toHaveBeenCalledWith("proj-1", {
      title: "New Feature",
      content: expect.any(String),
    });
    expect(mockCreate.mock.calls[0][1]).not.toHaveProperty("complexity");
  });
});
