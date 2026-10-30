import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandBar } from "./CommandBar";
import { api } from "../../api/client";

vi.mock("../../api/client", () => ({
  api: {
    commands: {
      interpret: vi.fn(),
      preview: vi.fn(),
      apply: vi.fn(),
    },
  },
}));

function Navigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/projects/p2/execute")}>Switch project</button>;
}

function mount(path = "/projects/p1/execute") {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<Navigation />} />
        </Routes>
        {/* This sibling placement matches App: useParams cannot see project matches. */}
        <CommandBar />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const interpretation = { intent: { commandType: "list_tasks" }, riskLevel: "mutating-low-risk" };
const preview = { description: "Preview for p1", mutations: [], warnings: [] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.commands.interpret).mockResolvedValue({
    interpretation,
    commandRunId: "interpret-p1",
  } as never);
  vi.mocked(api.commands.preview).mockResolvedValue({
    preview,
    commandRunId: "preview-p1",
  } as never);
});

describe("CommandBar project location context", () => {
  it("submits the real project when mounted outside Routes", async () => {
    mount();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByTestId("command-input");
    fireEvent.change(input, { target: { value: "show tasks" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.commands.interpret).toHaveBeenCalledWith("p1", "show tasks"));
    expect(await screen.findByTestId("command-confirm")).toBeInTheDocument();
  });

  it("does not open outside a project", () => {
    mount("/");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByTestId("command-input")).not.toBeInTheDocument();
    expect(api.commands.interpret).not.toHaveBeenCalled();
  });

  it("discards an in-flight A response after switching to B and starts a fresh session", async () => {
    let resolveOld!: (value: unknown) => void;
    vi.mocked(api.commands.interpret).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }) as never
    );
    mount();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByTestId("command-input"), { target: { value: "old command" } });
    fireEvent.keyDown(screen.getByTestId("command-input"), { key: "Enter" });
    await waitFor(() => expect(api.commands.interpret).toHaveBeenCalledWith("p1", "old command"));
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    expect(screen.queryByTestId("command-input")).not.toBeInTheDocument();
    resolveOld({ interpretation, commandRunId: "old-run" });
    await waitFor(() => expect(api.commands.preview).not.toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByTestId("command-input")).toHaveValue("");
    fireEvent.change(screen.getByTestId("command-input"), { target: { value: "new command" } });
    fireEvent.keyDown(screen.getByTestId("command-input"), { key: "Enter" });
    await waitFor(() => expect(api.commands.interpret).toHaveBeenCalledWith("p2", "new command"));
  });
});
