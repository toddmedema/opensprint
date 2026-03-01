import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SaveIndicator } from "./SaveIndicator";

describe("SaveIndicator", () => {
  it("shows Saved when status is idle", () => {
    render(<SaveIndicator status="idle" />);
    expect(screen.getByTestId("save-indicator")).toHaveTextContent("Saved");
  });

  it("shows Saved when status is saved", () => {
    render(<SaveIndicator status="saved" />);
    expect(screen.getByTestId("save-indicator")).toHaveTextContent("Saved");
  });

  it("shows Saving with spinner when status is saving", () => {
    render(<SaveIndicator status="saving" />);
    const indicator = screen.getByTestId("save-indicator");
    expect(indicator).toHaveTextContent("Saving");
    expect(indicator.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("uses custom data-testid when provided", () => {
    render(<SaveIndicator status="saved" data-testid="custom-indicator" />);
    expect(screen.getByTestId("custom-indicator")).toBeInTheDocument();
  });
});
