import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddPlanModal } from "./AddPlanModal";

describe("AddPlanModal", () => {
  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    const onGenerate = vi.fn();
    render(<AddPlanModal onGenerate={onGenerate} onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: /add plan/i });
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
