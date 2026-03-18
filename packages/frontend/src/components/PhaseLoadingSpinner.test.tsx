import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PhaseLoadingSpinner } from "./PhaseLoadingSpinner";

describe("PhaseLoadingSpinner", () => {
  it("renders with role status and aria-label", () => {
    render(<PhaseLoadingSpinner aria-label="Loading plans" />);
    const spinner = screen.getByRole("status", { name: "Loading plans" });
    expect(spinner).toBeInTheDocument();
  });

  it("uses animate-logo-pulse for loading indication (affected by prefers-reduced-motion)", () => {
    render(<PhaseLoadingSpinner />);
    const polygons = document.querySelectorAll(".animate-logo-pulse");
    expect(polygons.length).toBe(3);
  });

  it("accepts custom data-testid", () => {
    render(<PhaseLoadingSpinner data-testid="custom-spinner" />);
    expect(screen.getByTestId("custom-spinner")).toBeInTheDocument();
  });

  it("shows status text below logo by default", () => {
    render(<PhaseLoadingSpinner data-testid="spinner" />);
    expect(screen.getByTestId("spinner-status")).toHaveTextContent("Loading…");
  });

  it("shows custom status when provided", () => {
    render(<PhaseLoadingSpinner data-testid="spinner" status="Loading plans…" />);
    expect(screen.getByTestId("spinner-status")).toHaveTextContent("Loading plans…");
  });

  it("hides status when status is empty string", () => {
    render(<PhaseLoadingSpinner data-testid="spinner" status="" />);
    expect(screen.queryByTestId("spinner-status")).not.toBeInTheDocument();
  });
});
