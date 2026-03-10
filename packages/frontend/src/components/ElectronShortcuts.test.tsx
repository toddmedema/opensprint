import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { ElectronShortcuts } from "./ElectronShortcuts";

function LocationDisplay() {
  const loc = useLocation();
  return <span data-testid="location">{loc.pathname}</span>;
}

function dispatchKeydown(key: string, options?: { code?: string; metaKey?: boolean }) {
  const ev = new KeyboardEvent("keydown", {
    key,
    code: options?.code ?? `Digit${key}`,
    metaKey: options?.metaKey ?? false,
    ctrlKey: false,
    altKey: false,
    bubbles: true,
  });
  document.dispatchEvent(ev);
  return ev;
}

describe("ElectronShortcuts", () => {
  const originalElectron = (window as unknown as { electron?: unknown }).electron;

  beforeEach(() => {
    (window as unknown as { electron?: { isElectron: boolean } }).electron = { isElectron: true };
  });

  afterEach(() => {
    (window as unknown as { electron?: unknown }).electron = originalElectron;
  });

  it("does nothing when not in Electron", async () => {
    (window as unknown as { electron?: { isElectron: boolean } }).electron = { isElectron: false };
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    dispatchKeydown("2");
    await waitFor(() => {}, { timeout: 100 });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
  });

  it("1–5 switch to Sketch/Plan/Execute/Evaluate/Deliver when on a project", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");

    await act(() => {
      dispatchKeydown("2");
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/plan");
    });

    await act(() => {
      dispatchKeydown("3");
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/execute");
    });

    await act(() => {
      dispatchKeydown("4");
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/eval");
    });

    await act(() => {
      dispatchKeydown("5");
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/deliver");
    });

    await act(() => {
      dispatchKeydown("1");
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    });
  });

  it("~ (backquote) navigates to home", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );

    await act(() => {
      dispatchKeydown("`");
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/");
    });
  });

  it("phase shortcuts require no modifier (Cmd+1 does not navigate)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );

    await act(() => {
      dispatchKeydown("2", { metaKey: true });
    });
    await waitFor(() => {}, { timeout: 100 });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
  });

  it("Escape from project route opens project settings (same as settings icon)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/settings");
    });
  });

  it("Escape from outside project opens global settings (same as settings icon)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/" element={<LocationDisplay />} />
          <Route path="/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/settings");
    });
  });

  it("Escape from project settings page stays in project settings", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/settings"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/projects/:projectId/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/settings");
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await waitFor(() => {}, { timeout: 50 });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/settings");
  });

  it("Escape does not open settings when focus is in an input", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <ElectronShortcuts />
        <input data-testid="input" />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    const input = screen.getByTestId("input");
    input.focus();
    await act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await waitFor(() => {}, { timeout: 100 });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
  });

  it("? opens project help when on a project route (same context as help icon)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "?", bubbles: true })
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/help");
    });
  });

  it("F1 opens project help when on a project route (same context as help icon)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/plan"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/plan");
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F1", bubbles: true })
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/help");
    });
  });

  it("? opens global help when not in a project", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/" element={<LocationDisplay />} />
          <Route path="/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "?", bubbles: true })
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/help");
    });
  });

  it("F1 opens global help when not in a project", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <ElectronShortcuts />
        <Routes>
          <Route path="/settings" element={<LocationDisplay />} />
          <Route path="/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F1", bubbles: true })
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/help");
    });
  });
});
