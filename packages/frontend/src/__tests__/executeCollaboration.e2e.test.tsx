import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GlobalKeyboardShortcuts } from "../components/GlobalKeyboardShortcuts";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { ExecutePhase } from "../pages/phases/ExecutePhase";
import { NAVBAR_HEIGHT } from "../lib/constants";
import { mockViewport } from "../test/test-utils";
import { renderWithProviders } from "../test/test-utils";
import { initialExecuteState, toTasksByIdAndOrder } from "../store/slices/executeSlice";

const task = {
  id: "os-task",
  title: "Keep filters when navigating",
  epicId: "epic-1",
  kanbanColumn: "in_progress" as const,
  priority: 1,
  assignee: "agent",
  description: "Restore filter selection",
  type: "task" as const,
  status: "in_progress" as const,
  labels: [],
  dependencies: [],
  createdAt: "2026-11-06T10:00:00Z",
  updatedAt: "2026-11-06T10:00:00Z",
};
const activeRun = {
  taskId: task.id,
  attemptId: "attempt-one",
  attempt: 1,
  supported: true,
  reason: null,
  control: { runId: "attempt-one", controllerId: "local-user", revision: 1 },
};
const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
let fetchMock: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;

function CurrentRoute() {
  return <output aria-label="Current route">{useLocation().pathname}</output>;
}

/** Mount Execute with isolated queries and optional board selection for workspace flow checks. */
function renderExecute(selected = true) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderWithProviders(
    <MemoryRouter initialEntries={["/projects/project-a/execute"]}>
      <GlobalKeyboardShortcuts />
      <ExecutePhase projectId="project-a" />
      <CurrentRoute />
    </MemoryRouter>,
    {
      queryClient,
      preloadedState: {
        execute: {
          ...initialExecuteState,
          ...toTasksByIdAndOrder([task] as never),
          selectedTaskId: selected ? task.id : null,
        },
      },
    }
  );
}
beforeEach(() => {
  vi.stubGlobal("AbortSignal", {
    timeout: AbortSignal.timeout.bind(AbortSignal),
    any: (signals: AbortSignal[]) => signals.at(-1)!,
  });
  window.__OPENSPRINT_LOCAL_SESSION__ = "local-secret";
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/collaboration/")) {
      if (url.endsWith("/snapshot"))
        return reply({
          projectId: "project-a",
          sessionId: "default",
          cursor: 0,
          messages: [],
          messagesHasMore: false,
          runs: [],
          runsHasMore: false,
          principal: { actorId: "local-user", displayName: "Local user", role: "controller" },
        });
      if (url.endsWith("/overview"))
        return reply({
          projectName: "Sample project",
          observedAt: "2026-11-06T10:00:00Z",
          tasks: [task],
        });
      if (url.endsWith("/presence"))
        return reply([
          {
            actorId: "local-user",
            displayName: "Local user",
            role: "controller",
            clientId: "local-browser",
            taskId: task.id,
            lastSeenAt: "2026-11-06T10:00:00Z",
          },
          {
            actorId: "maya",
            displayName: "Maya",
            role: "controller",
            clientId: "maya-browser",
            taskId: task.id,
            lastSeenAt: "2026-11-06T10:00:00Z",
          },
        ]);
      if (url.includes("/presence/")) return new Response(null, { status: 204 });
      if (url.endsWith("/context"))
        return reply({
          task,
          activeRun,
          output: "Checking filters",
          diff: "+++ b/src/filters.ts\n+keepFilters()",
          source: "active",
          sourceAttemptId: "attempt-one",
          sourceAttempt: 1,
          diffRevision: "revision-one",
        });
      if (url.includes("/runs/")) return reply(activeRun);
      if (url.endsWith("/preferences"))
        return reply(
          init?.method === "PUT"
            ? JSON.parse(String(init.body))
            : { seenCursor: 0, subscribedTaskIds: [], seenAt: null }
        );
      if (url.includes("/events?")) return reply({ events: [], nextCursor: 0, hasMore: false });
      if (url.endsWith("/notifications") || url.endsWith("/invites") || url.includes("/guidance/"))
        return reply([]);
    }
    if (url.endsWith("/tasks")) return reply([task]);
    if (url.endsWith("/tasks/os-task")) return reply(task);
    if (url.endsWith("/settings")) return reply({ teamMembers: [] });
    if (
      url.endsWith("/sessions") ||
      url.endsWith("/agents/active") ||
      url.endsWith("/notifications")
    )
      return reply([]);
    if (url.endsWith("/output")) return reply({ output: "Checking filters" });
    if (url.endsWith("/diagnostics")) return reply(null);
    if (url.endsWith("/chat-history")) return reply({ messages: [] });
    if (url.endsWith("/chat-support")) return reply({ supported: true });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  queryClient?.clear();
  vi.unstubAllGlobals();
  delete window.__OPENSPRINT_LOCAL_SESSION__;
});

describe("Shared Execute task workspace", () => {
  it("opens the selected task in Work by default with one title and its original task actions", async () => {
    const user = userEvent.setup();
    renderExecute();
    expect(await screen.findByRole("tab", { name: "Work" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await screen.findByText("Restore filter selection");
    expect(screen.getAllByRole("heading", { name: task.title })).toHaveLength(1);
    expect(screen.queryByLabelText("Selected task")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Activity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Agent" })).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("execute-filter-toolbar")).queryByRole("button", { name: "Share" })
    ).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "Share" });
    expect(screen.getAllByRole("button", { name: "Share" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Task actions" }));
    expect(screen.getByTestId("sidebar-mark-done-btn")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-delete-task-btn")).toBeInTheDocument();
  });

  it("keeps native Work inspection available when collaboration cannot connect", async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string, init?: RequestInit) =>
      String(input).endsWith("/collaboration/snapshot")
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "UNAVAILABLE", message: "Collaboration unavailable" },
              }),
              { status: 503 }
            )
          )
        : fallback(input, init)
    );
    renderExecute();
    await screen.findByText("Restore filter selection");
    expect(screen.getByRole("tab", { name: "Work" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Task actions" })).toBeEnabled();
    expect(await screen.findByText("Collaboration unavailable")).toBeInTheDocument();
  });

  it("dismisses the mobile workspace with Escape without leaving Execute", async () => {
    const restoreViewport = mockViewport(390, 844);
    try {
      const user = userEvent.setup();
      renderExecute();
      const panel = await screen.findByRole("dialog", { name: "Sidebar panel" });
      await within(panel).findByRole("heading", { name: task.title });
      within(panel).getByRole("button", { name: "Close task workspace" }).focus();
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Sidebar panel" })).not.toBeInTheDocument()
      );
      expect(screen.getByLabelText("Current route")).toHaveTextContent(
        "/projects/project-a/execute"
      );
    } finally {
      restoreViewport();
    }
  });

  it("places mobile content below the Navbar and exposes a single close button", async () => {
    const restoreViewport = mockViewport(390, 844);
    try {
      const user = userEvent.setup();
      renderExecute();
      const panel = await screen.findByRole("dialog", { name: "Sidebar panel" });
      expect(panel).toHaveStyle({ top: String(NAVBAR_HEIGHT) + "px", "--sidebar-overlay-z": "40" });
      await within(panel).findByRole("heading", { name: task.title });
      expect(
        within(panel).queryByRole("button", { name: "Close sidebar", exact: true })
      ).not.toBeInTheDocument();
      expect(
        within(panel).queryByRole("button", { name: "Close task detail" })
      ).not.toBeInTheDocument();
      await user.click(within(panel).getByRole("button", { name: "Close task workspace" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Sidebar panel" })).not.toBeInTheDocument()
      );
    } finally {
      restoreViewport();
    }
  });

  it("retains separate team and agent drafts when the task workspace is closed and reopened", async () => {
    const user = userEvent.setup();
    renderExecute();
    await user.click(await screen.findByRole("tab", { name: "Discussion" }));
    const message = await screen.findByLabelText("Message team");
    await user.type(message, "@Maya keep this team draft");
    await user.click(await screen.findByRole("button", { name: "Guide agent…" }));
    const guidance = await screen.findByRole("dialog", { name: "Guide agent" });
    await user.type(
      within(guidance).getByLabelText("Guide the active agent"),
      "Keep this instruction draft"
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(guidance).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Close task workspace" }));
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Work" })).not.toBeInTheDocument()
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).includes("/presence/") && init?.method === "DELETE"
        )
      ).toBe(true)
    );

    await user.click(screen.getByText(task.title));
    expect(await screen.findByRole("tab", { name: "Work" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await user.click(screen.getByRole("tab", { name: "Discussion" }));
    expect(await screen.findByLabelText("Message team")).toHaveValue("@Maya keep this team draft");
    await user.click(await screen.findByRole("button", { name: "Guide agent…" }));
    expect(await screen.findByLabelText("Guide the active agent")).toHaveValue(
      "Keep this instruction draft"
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/guidance") && init?.method === "POST"
      )
    ).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/commands") && init?.method === "POST"
      )
    ).toHaveLength(0);
  });

  it.each([
    [1280, 800],
    [390, 844],
  ])("restores keyboard focus after temporary Share closes at %i×%i", async (width, height) => {
    const restoreViewport = mockViewport(width, height);
    try {
      const user = userEvent.setup();
      renderExecute(false);
      const toolbar = screen.getByTestId("execute-filter-toolbar");
      const originalShare = within(toolbar).getByRole("button", { name: "Share" });
      await user.click(originalShare);
      const sharing = await screen.findByRole("dialog", { name: /Share/ });
      expect(within(toolbar).queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(sharing).not.toBeInTheDocument());
      const restoredShare = await within(toolbar).findByRole("button", { name: "Share" });
      expect(restoredShare).not.toBe(originalShare);
      await waitFor(() => expect(restoredShare).toHaveFocus());
      // Modal cleanup restores on the next frame; the replacement trigger must keep focus.
      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          })
      );
      expect(restoredShare).toHaveFocus();
      expect(screen.queryByRole("tab", { name: "Work" })).not.toBeInTheDocument();
      await user.keyboard("{Enter}");
      expect(await screen.findByRole("dialog", { name: /Share/ })).toBeInTheDocument();
    } finally {
      restoreViewport();
    }
  });
});
