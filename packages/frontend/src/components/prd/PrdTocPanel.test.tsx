import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrdTocPanel } from "./PrdTocPanel";

describe("PrdTocPanel", () => {
  const prdContent = {
    executive_summary: "Summary",
    problem_statement: "Problem",
    goals_and_metrics: "Goals",
  };

  function createScrollContainer() {
    const div = document.createElement("div");
    div.className = "overflow-y-auto";
    div.style.height = "400px";
    div.style.overflow = "auto";
    document.body.appendChild(div);

    const section1 = document.createElement("div");
    section1.dataset.prdSection = "executive_summary";
    section1.textContent = "Executive Summary content";
    section1.style.height = "200px";

    const section2 = document.createElement("div");
    section2.dataset.prdSection = "problem_statement";
    section2.textContent = "Problem Statement content";
    section2.style.height = "200px";

    const section3 = document.createElement("div");
    section3.dataset.prdSection = "goals_and_metrics";
    section3.textContent = "Goals content";
    section3.style.height = "200px";

    div.appendChild(section1);
    div.appendChild(section2);
    div.appendChild(section3);

    return { container: div, section1, section2, section3 };
  }

  it("renders section titles when expanded", () => {
    const scrollRef = { current: null as HTMLDivElement | null };
    const { container } = createScrollContainer();
    scrollRef.current = container;

    render(
      <PrdTocPanel
        prdContent={prdContent}
        scrollContainerRef={scrollRef}
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />
    );

    expect(screen.getByText("Contents")).toBeInTheDocument();
    expect(screen.getByText("Executive Summary")).toBeInTheDocument();
    expect(screen.getByText("Problem Statement")).toBeInTheDocument();
    expect(screen.getByText("Goals And Metrics")).toBeInTheDocument();

    document.body.removeChild(container);
  });

  it("renders section numbers only when collapsed", () => {
    const scrollRef = { current: null as HTMLDivElement | null };
    const { container } = createScrollContainer();
    scrollRef.current = container;

    render(
      <PrdTocPanel
        prdContent={prdContent}
        scrollContainerRef={scrollRef}
        collapsed={true}
        onCollapsedChange={vi.fn()}
      />
    );

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("Executive Summary")).not.toBeInTheDocument();

    document.body.removeChild(container);
  });

  it("calls onCollapsedChange when expand button clicked (collapsed state)", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    const scrollRef = { current: null as HTMLDivElement | null };
    const { container } = createScrollContainer();
    scrollRef.current = container;

    render(
      <PrdTocPanel
        prdContent={prdContent}
        scrollContainerRef={scrollRef}
        collapsed={true}
        onCollapsedChange={onCollapsedChange}
      />
    );

    await user.click(screen.getByRole("button", { name: "Expand table of contents" }));
    expect(onCollapsedChange).toHaveBeenCalledWith(false);

    document.body.removeChild(container);
  });

  it("calls onCollapsedChange when collapse button clicked (expanded state)", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    const scrollRef = { current: null as HTMLDivElement | null };
    const { container } = createScrollContainer();
    scrollRef.current = container;

    render(
      <PrdTocPanel
        prdContent={prdContent}
        scrollContainerRef={scrollRef}
        collapsed={false}
        onCollapsedChange={onCollapsedChange}
      />
    );

    await user.click(screen.getByRole("button", { name: "Collapse table of contents" }));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    document.body.removeChild(container);
  });

  it("scrolls to section when section link clicked", async () => {
    const user = userEvent.setup();
    const scrollRef = { current: null as HTMLDivElement | null };
    const { container, section2 } = createScrollContainer();
    scrollRef.current = container;

    const scrollIntoViewMock = vi.fn();
    section2.scrollIntoView = scrollIntoViewMock;

    render(
      <PrdTocPanel
        prdContent={prdContent}
        scrollContainerRef={scrollRef}
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />
    );

    await user.click(screen.getByTestId("toc-section-problem_statement"));
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    document.body.removeChild(container);
  });

  it("renders empty when prdContent has no sections", () => {
    const scrollRef = { current: null as HTMLDivElement | null };

    render(
      <PrdTocPanel
        prdContent={{}}
        scrollContainerRef={scrollRef}
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />
    );

    expect(screen.getByText("Contents")).toBeInTheDocument();
    expect(screen.queryByTestId("toc-section-executive_summary")).not.toBeInTheDocument();
  });
});
