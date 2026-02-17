import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResizableSidebar } from "./ResizableSidebar";

const STORAGE_KEY = "opensprint-sidebar-width-test";

describe("ResizableSidebar", () => {
  let localStorageMock: Record<string, string>;

  beforeEach(() => {
    localStorageMock = {};
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
      return localStorageMock[key] ?? null;
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
      localStorageMock[key] = value;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children with default width", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY}>
        <div data-testid="sidebar-content">Sidebar content</div>
      </ResizableSidebar>,
    );

    expect(screen.getByTestId("sidebar-content")).toHaveTextContent("Sidebar content");
    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeInTheDocument();
  });

  it("uses persisted width from localStorage when available", () => {
    localStorageMock[`opensprint-sidebar-width-${STORAGE_KEY}`] = "500";

    render(
      <ResizableSidebar storageKey={STORAGE_KEY}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const container = screen.getByText("Content").closest(".relative");
    expect(container).toHaveStyle({ width: "500px" });
  });

  it("uses defaultWidth when no persisted value exists", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY} defaultWidth={360}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const container = screen.getByText("Content").closest(".relative");
    expect(container).toHaveStyle({ width: "360px" });
  });

  it("persists width to localStorage on resize end", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY} defaultWidth={420}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const handle = screen.getByRole("separator", { name: "Resize sidebar" });

    // Simulate mousedown, mousemove (drag left 20px), mouseup
    handle.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(localStorage.setItem).toHaveBeenCalledWith(
      `opensprint-sidebar-width-${STORAGE_KEY}`,
      expect.any(String),
    );
  });

  it("applies responsive classes when responsive prop is true", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY} responsive>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const container = screen.getByText("Content").closest(".relative");
    expect(container).toHaveClass("w-full");
    expect(container).toHaveClass("max-w-[var(--sidebar-mobile-max,420px)]");
    expect(container).toHaveClass("md:max-w-none");
    expect(container).toHaveClass("md:w-[var(--sidebar-width)]");
  });

  it("sets --sidebar-width CSS variable when responsive", () => {
    localStorageMock[`opensprint-sidebar-width-${STORAGE_KEY}`] = "550";

    render(
      <ResizableSidebar storageKey={STORAGE_KEY} responsive>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const container = screen.getByText("Content").closest(".relative");
    expect(container).toHaveStyle({ "--sidebar-width": "550px" });
  });

  it("hides resize handle when visible is false", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY} visible={false}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).not.toBeInTheDocument();
  });

  it("accepts custom className", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY} className="custom-sidebar">
        <span>Content</span>
      </ResizableSidebar>,
    );

    const container = screen.getByText("Content").closest(".relative");
    expect(container).toHaveClass("custom-sidebar");
  });

  it("has accessible resize handle with aria attributes", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY} minWidth={280} maxWidth={800}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "420");
    expect(handle).toHaveAttribute("aria-valuemin", "280");
    expect(handle).toHaveAttribute("aria-valuemax", "800");
  });

  it("uses min 200px and max 80% viewport by default", () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1000, writable: true });

    render(
      <ResizableSidebar storageKey={STORAGE_KEY}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle).toHaveAttribute("aria-valuemin", "200");
    expect(handle).toHaveAttribute("aria-valuemax", "800"); // 80% of 1000

    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, writable: true });
  });

  it("clamps persisted width to min/max when loading", () => {
    localStorageMock[`opensprint-sidebar-width-${STORAGE_KEY}`] = "150"; // below min 200

    render(
      <ResizableSidebar storageKey={STORAGE_KEY} minWidth={200} maxWidth={800}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const container = screen.getByText("Content").closest(".relative");
    expect(container).toHaveStyle({ width: "200px" });
  });

  it("has root with min-h-0 and overflow-hidden for flex shrinking and scroll containment", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const root = screen.getByText("Content").closest(".relative");
    expect(root).toHaveClass("min-h-0");
    expect(root).toHaveClass("overflow-hidden");
  });

  it("has inner wrapper with min-h-0 and overflow-hidden for independent sidebar scroll", () => {
    render(
      <ResizableSidebar storageKey={STORAGE_KEY}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const innerWrapper = screen.getByText("Content").parentElement;
    expect(innerWrapper).toHaveClass("min-h-0");
    expect(innerWrapper).toHaveClass("overflow-hidden");
  });

  it("clamps persisted width when above max (80% viewport)", () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1000, writable: true });
    localStorageMock[`opensprint-sidebar-width-${STORAGE_KEY}`] = "900"; // above 80% of 1000 = 800

    render(
      <ResizableSidebar storageKey={STORAGE_KEY}>
        <span>Content</span>
      </ResizableSidebar>,
    );

    const container = screen.getByText("Content").closest(".relative");
    expect(container).toHaveStyle({ width: "800px" });

    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, writable: true });
  });
});
