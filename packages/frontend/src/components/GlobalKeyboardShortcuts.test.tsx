import { useRef, useState } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { describe, it, expect } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { GlobalKeyboardShortcuts } from "./GlobalKeyboardShortcuts";

function DismissibleModal() {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ containerRef: ref, isOpen: open, onClose: () => setOpen(false) });
  return open ? (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Dismissible modal">
      <button type="button" onClick={() => setOpen(false)}>
        Close modal
      </button>
    </div>
  ) : null;
}

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

function dispatchCtrlTab(options?: { shiftKey?: boolean }) {
  const ev = new KeyboardEvent("keydown", {
    key: "Tab",
    code: "Tab",
    ctrlKey: true,
    shiftKey: options?.shiftKey ?? false,
    metaKey: false,
    altKey: false,
    bubbles: true,
  });
  document.dispatchEvent(ev);
  return ev;
}

describe("GlobalKeyboardShortcuts", () => {
  it("1–5 switch to Sketch/Plan/Execute/Evaluate/Deliver when on a project", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
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

  it("Ctrl+Tab cycles phases forward with wrap (Deliver → Sketch)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/deliver"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/deliver");
    await act(() => {
      dispatchCtrlTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    });
  });

  it("Ctrl+Shift+Tab cycles phases backward with wrap (Sketch → Deliver)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    await act(() => {
      dispatchCtrlTab({ shiftKey: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/deliver");
    });
  });

  it("Ctrl+Tab advances Sketch → Plan → Execute in order", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    await act(() => {
      dispatchCtrlTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/plan");
    });
    await act(() => {
      dispatchCtrlTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/execute");
    });
  });

  it("Ctrl+Tab still navigates when focus is in an input", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <input data-testid="input" />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    const input = screen.getByTestId("input");
    input.focus();
    await act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          code: "Tab",
          ctrlKey: true,
          shiftKey: false,
          metaKey: false,
          altKey: false,
          bubbles: true,
        })
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/plan");
    });
  });

  it("Ctrl+Tab does nothing when not in a project", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    await act(() => {
      dispatchCtrlTab();
    });
    await waitFor(() => {}, { timeout: 50 });
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });

  it("Cmd+Tab does not cycle phases (reserved for macOS app switcher pattern)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          code: "Tab",
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
          altKey: false,
          bubbles: true,
        })
      );
    });
    await waitFor(() => {}, { timeout: 50 });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
  });

  it("~ (backquote) navigates to home", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
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
        <GlobalKeyboardShortcuts />
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
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/settings");
    });
  });

  it("Escape from outside project opens global settings (same as settings icon)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/" element={<LocationDisplay />} />
          <Route path="/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/settings");
    });
  });

  it("Escape from project settings page stays in project settings", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/settings"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/settings");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => {}, { timeout: 50 });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/settings");
  });

  it("Escape does not open settings when focus is in an input", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
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
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => {}, { timeout: 100 });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
  });

  it("Escape when a modal is open does not open settings (modal can close instead)", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <div role="dialog" aria-modal="true" data-testid="mock-modal">
          Mock modal
        </div>
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("mock-modal")).toBeInTheDocument();
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => {}, { timeout: 100 });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    unmount();
  });

  it("lets a dialog owner dismiss Escape during bubbling without opening settings", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/execute"]}>
        <GlobalKeyboardShortcuts />
        <DismissibleModal />
        <LocationDisplay />
      </MemoryRouter>
    );
    const button = screen.getByRole("button", { name: "Close modal" });
    button.focus();
    await act(() =>
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Dismissible modal" })).not.toBeInTheDocument()
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/execute");
  });

  it("? opens project help when on a project route (same context as help icon)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/help");
    });
  });

  it("F1 opens project help when on a project route (same context as help icon)", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/plan"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/plan");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "F1", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/help");
    });
  });

  it("? opens global help when not in a project", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/" element={<LocationDisplay />} />
          <Route path="/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/help");
    });
  });

  it("F1 opens global help when not in a project", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/settings" element={<LocationDisplay />} />
          <Route path="/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "F1", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/help");
    });
  });

  it("in Electron, Escape opens project settings", async () => {
    const prev =
      typeof window !== "undefined"
        ? (window as unknown as { electron?: unknown }).electron
        : undefined;
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          electron: {
            isElectron: true;
            onNavigateHelp: () => () => void;
            onNavigateSettings: () => () => void;
          };
        }
      ).electron = {
        isElectron: true,
        onNavigateHelp: () => () => {},
        onNavigateSettings: () => () => {},
      };
    }
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/settings");
    });
    if (typeof window !== "undefined") (window as unknown as { electron: unknown }).electron = prev;
  });

  it("in Electron, ? opens project help", async () => {
    const prev =
      typeof window !== "undefined"
        ? (window as unknown as { electron?: unknown }).electron
        : undefined;
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          electron: {
            isElectron: true;
            onNavigateHelp: () => () => void;
            onNavigateSettings: () => () => void;
          };
        }
      ).electron = {
        isElectron: true,
        onNavigateHelp: () => () => {},
        onNavigateSettings: () => () => {},
      };
    }
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/help");
    });
    if (typeof window !== "undefined") (window as unknown as { electron: unknown }).electron = prev;
  });

  it("in Electron, Escape opens global settings when not in a project", async () => {
    const prev =
      typeof window !== "undefined"
        ? (window as unknown as { electron?: unknown }).electron
        : undefined;
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          electron: {
            isElectron: true;
            onNavigateHelp: () => () => void;
            onNavigateSettings: () => () => void;
          };
        }
      ).electron = {
        isElectron: true,
        onNavigateHelp: () => () => {},
        onNavigateSettings: () => () => {},
      };
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/" element={<LocationDisplay />} />
          <Route path="/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/settings");
    });
    if (typeof window !== "undefined") (window as unknown as { electron: unknown }).electron = prev;
  });

  it("in Electron, ? opens global help when not in a project", async () => {
    const prev =
      typeof window !== "undefined"
        ? (window as unknown as { electron?: unknown }).electron
        : undefined;
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          electron: {
            isElectron: true;
            onNavigateHelp: () => () => void;
            onNavigateSettings: () => () => void;
          };
        }
      ).electron = {
        isElectron: true,
        onNavigateHelp: () => () => {},
        onNavigateSettings: () => () => {},
      };
    }
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/settings" element={<LocationDisplay />} />
          <Route path="/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/help");
    });
    if (typeof window !== "undefined") (window as unknown as { electron: unknown }).electron = prev;
  });

  it("Electron app menu: Help callback navigates to /help when not in project", async () => {
    let helpCallback: (() => void) | undefined;
    const prev =
      typeof window !== "undefined"
        ? (window as unknown as { electron?: unknown }).electron
        : undefined;
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          electron: {
            isElectron: true;
            onNavigateHelp: (cb: () => void) => () => void;
            onNavigateSettings: (cb: () => void) => () => void;
          };
        }
      ).electron = {
        isElectron: true,
        onNavigateHelp: (cb) => {
          helpCallback = cb;
          return () => {};
        },
        onNavigateSettings: () => () => {},
      };
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/" element={<LocationDisplay />} />
          <Route path="/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    await waitFor(() => {
      expect(helpCallback).toBeDefined();
    });
    await act(() => {
      helpCallback!();
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/help");
    if (typeof window !== "undefined") (window as unknown as { electron: unknown }).electron = prev;
  });

  it("Electron app menu: Help callback navigates to project help when in project", async () => {
    let helpCallback: (() => void) | undefined;
    const prev =
      typeof window !== "undefined"
        ? (window as unknown as { electron?: unknown }).electron
        : undefined;
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          electron: {
            isElectron: true;
            onNavigateHelp: (cb: () => void) => () => void;
            onNavigateSettings: (cb: () => void) => () => void;
          };
        }
      ).electron = {
        isElectron: true,
        onNavigateHelp: (cb) => {
          helpCallback = cb;
          return () => {};
        },
        onNavigateSettings: () => () => {},
      };
    }
    render(
      <MemoryRouter initialEntries={["/projects/p1/sketch"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/help" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/sketch");
    await waitFor(() => {
      expect(helpCallback).toBeDefined();
    });
    await act(() => {
      helpCallback!();
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/help");
    if (typeof window !== "undefined") (window as unknown as { electron: unknown }).electron = prev;
  });

  it("Electron app menu: Settings callback navigates to /settings when not in project", async () => {
    let settingsCallback: (() => void) | undefined;
    const prev =
      typeof window !== "undefined"
        ? (window as unknown as { electron?: unknown }).electron
        : undefined;
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          electron: {
            isElectron: true;
            onNavigateHelp: (cb: () => void) => () => void;
            onNavigateSettings: (cb: () => void) => () => void;
          };
        }
      ).electron = {
        isElectron: true,
        onNavigateHelp: () => () => {},
        onNavigateSettings: (cb) => {
          settingsCallback = cb;
          return () => {};
        },
      };
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/" element={<LocationDisplay />} />
          <Route path="/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    await waitFor(() => {
      expect(settingsCallback).toBeDefined();
    });
    await act(() => {
      settingsCallback!();
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
    if (typeof window !== "undefined") (window as unknown as { electron: unknown }).electron = prev;
  });

  it("Electron app menu: Settings callback navigates to project settings when in project", async () => {
    let settingsCallback: (() => void) | undefined;
    const prev =
      typeof window !== "undefined"
        ? (window as unknown as { electron?: unknown }).electron
        : undefined;
    if (typeof window !== "undefined") {
      (
        window as unknown as {
          electron: {
            isElectron: true;
            onNavigateHelp: (cb: () => void) => () => void;
            onNavigateSettings: (cb: () => void) => () => void;
          };
        }
      ).electron = {
        isElectron: true,
        onNavigateHelp: () => () => {},
        onNavigateSettings: (cb) => {
          settingsCallback = cb;
          return () => {};
        },
      };
    }
    render(
      <MemoryRouter initialEntries={["/projects/p1/plan"]}>
        <GlobalKeyboardShortcuts />
        <Routes>
          <Route path="/projects/:projectId/:phase" element={<LocationDisplay />} />
          <Route path="/projects/:projectId/settings" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/plan");
    await waitFor(() => {
      expect(settingsCallback).toBeDefined();
    });
    await act(() => {
      settingsCallback!();
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/settings");
    if (typeof window !== "undefined") (window as unknown as { electron: unknown }).electron = prev;
  });
});
