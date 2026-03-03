import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../contexts/ThemeContext";
import { AgentsMdSection } from "./AgentsMdSection";

const mockGetAgentsInstructions = vi.fn();
const mockUpdateAgentsInstructions = vi.fn();

vi.mock("prettier", () => ({
  format: (content: string) => Promise.resolve(content),
}));
vi.mock("prettier/plugins/markdown", () => ({ default: {} }));

vi.mock("../api/client", () => ({
  api: {
    projects: {
      getAgentsInstructions: (...args: unknown[]) => mockGetAgentsInstructions(...args),
      updateAgentsInstructions: (...args: unknown[]) => mockUpdateAgentsInstructions(...args),
    },
  },
}));

vi.mock("@uiw/react-md-editor", () => {
  const MockMDEditor = ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string | undefined) => void;
  }) => (
    <div data-testid="mock-md-editor">
      <button type="button" aria-label="Bold">
        Bold
      </button>
      <textarea
        data-testid="mock-md-editor-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
  return new Promise<{ default: typeof MockMDEditor }>((resolve) => {
    setTimeout(() => resolve({ default: MockMDEditor }), 50);
  });
});

describe("AgentsMdSection lazy-loading", () => {
  const projectId = "proj-1";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    mockGetAgentsInstructions.mockResolvedValue({
      content: "# Agent Instructions\n\nUse bd for tasks.",
    });
    mockUpdateAgentsInstructions.mockResolvedValue({ saved: true });
  });

  it("shows Loading editor... while MDEditor chunk is loading", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <AgentsMdSection projectId={projectId} />
      </ThemeProvider>
    );

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    expect(screen.getByTestId("agents-md-editor-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading editor...")).toBeInTheDocument();
  });

  it("shows editor after lazy load completes", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <AgentsMdSection projectId={projectId} />
      </ThemeProvider>
    );

    await screen.findByTestId("agents-md-view");
    await user.click(screen.getByTestId("agents-md-edit"));

    expect(await screen.findByTestId("mock-md-editor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /bold/i })).toBeInTheDocument();
  });
});
