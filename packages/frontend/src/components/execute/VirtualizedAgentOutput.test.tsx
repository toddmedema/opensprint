import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VirtualizedAgentOutput } from "./VirtualizedAgentOutput";

describe("VirtualizedAgentOutput", () => {
  it("renders content with ReactMarkdown when useMarkdown is true", () => {
    const containerRef = { current: null as HTMLDivElement | null };
    render(
      <VirtualizedAgentOutput
        content="**Bold** and `code`"
        useMarkdown={true}
        containerRef={containerRef}
        data-testid="output"
      />
    );

    const el = screen.getByTestId("output");
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent("Bold");
    expect(el).toHaveTextContent("code");
  });

  it("renders content as plain text when useMarkdown is false", () => {
    const containerRef = { current: null as HTMLDivElement | null };
    render(
      <VirtualizedAgentOutput
        content="**Bold** and `code`"
        useMarkdown={false}
        containerRef={containerRef}
        data-testid="output"
      />
    );

    const el = screen.getByTestId("output");
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent("**Bold** and `code`");
  });

  it("renders empty content as empty string", () => {
    const containerRef = { current: null as HTMLDivElement | null };
    render(
      <VirtualizedAgentOutput
        content=""
        useMarkdown={true}
        containerRef={containerRef}
        data-testid="output"
      />
    );

    const el = screen.getByTestId("output");
    expect(el).toBeInTheDocument();
  });

  it("applies prose-execute-task class for markdown mode", () => {
    const containerRef = { current: null as HTMLDivElement | null };
    render(
      <VirtualizedAgentOutput
        content="Hello"
        useMarkdown={true}
        containerRef={containerRef}
        data-testid="output"
      />
    );

    const el = screen.getByTestId("output");
    expect(el).toHaveClass("prose-execute-task");
  });

  it("calls onScroll when user scrolls", () => {
    const containerRef = React.createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    render(
      <VirtualizedAgentOutput
        content="Hello"
        useMarkdown={true}
        containerRef={containerRef}
        onScroll={onScroll}
        data-testid="output"
      />
    );

    const el = screen.getByTestId("output");
    fireEvent.scroll(el);
    expect(onScroll).toHaveBeenCalled();
  });
});
