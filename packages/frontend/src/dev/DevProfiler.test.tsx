import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DevProfiler } from "./DevProfiler";

describe("DevProfiler", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "PerformanceObserver",
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders children", () => {
    render(
      <DevProfiler>
        <span data-testid="child">Child content</span>
      </DevProfiler>
    );
    expect(screen.getByTestId("child")).toHaveTextContent("Child content");
  });

  it("does not crash when PerformanceObserver is unavailable", () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    expect(() =>
      render(
        <DevProfiler>
          <span>Child</span>
        </DevProfiler>
      )
    ).not.toThrow();
  });
});
