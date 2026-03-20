import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ModelSelect } from "./ModelSelect";

const mockModelsList = vi.fn();

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      models: {
        list: (...args: unknown[]) => mockModelsList(...args),
      },
    },
  };
});

describe("ModelSelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders custom provider as text input", () => {
    render(<ModelSelect provider="custom" value={null} onChange={() => {}} />);
    expect(screen.getByPlaceholderText("CLI command handles model")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /custom cli command/i })).toBeInTheDocument();
  });

  it("shows loading state for claude provider", () => {
    mockModelsList.mockImplementation(() => new Promise(() => {}));
    render(<ModelSelect provider="claude" value={null} onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: /model selection/i })).toBeInTheDocument();
    expect(screen.getByText("Loading models…")).toBeInTheDocument();
  });

  it("shows error state when models list fails", async () => {
    mockModelsList.mockRejectedValue(new Error("Invalid API key"));
    render(<ModelSelect provider="claude" value={null} onChange={() => {}} />);
    await screen.findByText(/Invalid API key/);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows Global Settings hint for claude when models list fails", async () => {
    mockModelsList.mockRejectedValue(new Error("Invalid API key"));
    render(<ModelSelect provider="claude" value={null} onChange={() => {}} />);
    const globalSettingsCopy = await screen.findByText(/Global Settings → API keys/);
    expect(globalSettingsCopy).toBeInTheDocument();
  });

  it("renders model options and calls onChange when selection changes", async () => {
    mockModelsList.mockResolvedValue([
      { id: "claude-3-5-sonnet", displayName: "Claude 3.5 Sonnet" },
      { id: "claude-3-opus", displayName: "Claude 3 Opus" },
    ]);
    const onChange = vi.fn();
    render(<ModelSelect provider="claude" value={null} onChange={onChange} />);
    await screen.findByText("Claude 3.5 Sonnet");
    const select = screen.getByRole("combobox", { name: /model selection/i });
    fireEvent.change(select, { target: { value: "claude-3-opus" } });
    expect(onChange).toHaveBeenCalledWith("claude-3-opus");
  });

  it("shows Select model for cursor when no model is selected", async () => {
    mockModelsList.mockResolvedValue([{ id: "gpt-4", displayName: "gpt-4" }]);
    const onChange = vi.fn();

    render(<ModelSelect provider="cursor" value={null} onChange={onChange} />);

    await screen.findByRole("combobox", { name: /model selection/i });
    expect(screen.getByRole("option", { name: "Select model" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Auto" })).not.toBeInTheDocument();
  });

  it("maps the cursor empty option back to null", async () => {
    mockModelsList.mockResolvedValue([{ id: "gpt-4", displayName: "gpt-4" }]);
    const onChange = vi.fn();

    render(<ModelSelect provider="cursor" value="gpt-4" onChange={onChange} />);

    await screen.findByRole("option", { name: "gpt-4" });
    const select = screen.getByRole("combobox", { name: /model selection/i });
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows No models available for cursor when list is empty", async () => {
    mockModelsList.mockResolvedValue([]);
    render(<ModelSelect provider="cursor" value={null} onChange={() => {}} />);
    await screen.findByRole("option", { name: "No models available" });
  });

  it("fetches models for lmstudio with baseUrl and shows loading state", () => {
    mockModelsList.mockImplementation(() => new Promise(() => {}));
    render(
      <ModelSelect
        provider="lmstudio"
        value={null}
        onChange={() => {}}
        projectId="proj-1"
        baseUrl="http://localhost:1234"
      />
    );
    expect(mockModelsList).toHaveBeenCalledWith("lmstudio", "proj-1", "http://localhost:1234");
    expect(screen.getByText("Loading models…")).toBeInTheDocument();
  });

  it("shows LM Studio unreachable message when fetch fails with connection error", async () => {
    mockModelsList.mockRejectedValue(new Error("Failed to fetch"));
    render(
      <ModelSelect
        provider="lmstudio"
        value={null}
        onChange={() => {}}
        baseUrl="http://localhost:1234"
      />
    );
    await screen.findByText(/LM Studio is not reachable. Check the server URL in Settings./);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "LM Studio is not reachable. Check the server URL in Settings."
    );
  });

  it("shows no models message for lmstudio when fetch fails with non-connection error", async () => {
    mockModelsList.mockRejectedValue(new Error("Internal server error"));
    render(
      <ModelSelect
        provider="lmstudio"
        value={null}
        onChange={() => {}}
        baseUrl="http://localhost:1234"
      />
    );
    await screen.findByText(/No models — start LM Studio and load a model/);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No models — start LM Studio and load a model"
    );
  });

  it("renders lmstudio model options when fetch succeeds", async () => {
    mockModelsList.mockResolvedValue([
      { id: "local/llama", displayName: "Llama 3 Local" },
      { id: "local/mistral", displayName: "Mistral 7B" },
    ]);
    const onChange = vi.fn();
    render(
      <ModelSelect
        provider="lmstudio"
        value={null}
        onChange={onChange}
        baseUrl="http://localhost:1234"
      />
    );
    await screen.findByText("Llama 3 Local");
    expect(screen.getByRole("option", { name: "Mistral 7B" })).toBeInTheDocument();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("local/llama"));
  });
});
