import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComplexityIcon } from "./ComplexityIcon";

describe("ComplexityIcon", () => {
  it("renders one blue dot for low (plan complexity)", () => {
    const { container } = render(<ComplexityIcon complexity="low" />);

    expect(screen.getByRole("img", { name: "low complexity" })).toBeInTheDocument();
    const circle = container.querySelector("circle");
    expect(circle).toBeInTheDocument();
    expect(circle).toHaveAttribute("fill", "#0065ff");
  });

  it("renders three yellow dots for high (task complexity 7)", () => {
    const { container } = render(<ComplexityIcon complexity={7} />);

    expect(screen.getByRole("img", { name: "Complexity 7" })).toBeInTheDocument();
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(3);
    circles.forEach((c) => expect(c).toHaveAttribute("fill", "#FFAB00"));
  });

  it("renders three yellow dots for medium (plan complexity)", () => {
    const { container } = render(<ComplexityIcon complexity="medium" />);

    expect(screen.getByRole("img", { name: "medium complexity" })).toBeInTheDocument();
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(3);
  });

  it("renders three yellow dots for very_high (plan complexity)", () => {
    const { container } = render(<ComplexityIcon complexity="very_high" />);

    expect(screen.getByRole("img", { name: "very_high complexity" })).toBeInTheDocument();
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(3);
  });

  it("renders one blue dot for task complexity 3 (simple)", () => {
    const { container } = render(<ComplexityIcon complexity={3} />);

    expect(screen.getByRole("img", { name: "Simple complexity" })).toBeInTheDocument();
    const circle = container.querySelector("circle");
    expect(circle).toHaveAttribute("fill", "#0065ff");
  });

  it("returns null when complexity is undefined", () => {
    const { container } = render(<ComplexityIcon complexity={undefined} />);

    expect(container.firstChild).toBeNull();
  });

  it("applies sm size classes by default", () => {
    render(<ComplexityIcon complexity="low" />);

    const svg = screen.getByRole("img", { name: "low complexity" });
    expect(svg).toHaveClass("w-4", "h-4");
  });

  it("applies xs size classes", () => {
    render(<ComplexityIcon complexity="low" size="xs" />);

    const svg = screen.getByRole("img", { name: "low complexity" });
    expect(svg).toHaveClass("w-3", "h-3");
  });

  it("applies md size classes", () => {
    render(<ComplexityIcon complexity="low" size="md" />);

    const svg = screen.getByRole("img", { name: "low complexity" });
    expect(svg).toHaveClass("w-5", "h-5");
  });

  it("applies custom className", () => {
    render(<ComplexityIcon complexity="low" className="ml-2" />);

    const svg = screen.getByRole("img", { name: "low complexity" });
    expect(svg).toHaveClass("ml-2");
  });

  it("always includes shrink-0 to prevent flex squishing", () => {
    render(<ComplexityIcon complexity="low" />);

    const svg = screen.getByRole("img", { name: "low complexity" });
    expect(svg).toHaveClass("shrink-0");
  });
});
