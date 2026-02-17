import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloseButton } from "./CloseButton";

describe("CloseButton", () => {
  it("renders an X icon button with aria-label Close", () => {
    render(<CloseButton onClick={() => {}} />);

    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn).toBeInTheDocument();
  });

  it("calls onClick when clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<CloseButton onClick={onClick} />);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("accepts custom ariaLabel", () => {
    render(<CloseButton onClick={() => {}} ariaLabel="Dismiss" />);

    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("accepts custom className", () => {
    render(<CloseButton onClick={() => {}} className="custom-class" />);

    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn).toHaveClass("custom-class");
  });
});
