import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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

function renderExecute() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderWithProviders(
    <MemoryRouter>
      <ExecutePhase projectId="project-a" selectedTaskId="os-task" />
    </MemoryRouter>,
    {
      queryClient,
      preloadedState: {
        execute: {
          ...initialExecuteState,
          ...toTasksByIdAndOrder([task] as never),
          selectedTaskId: task.id,
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

describe("Execute collaboration dock", () => {
  it("places the mobile dock below the Navbar and keeps its close action available", async () => {
    const restoreViewport = mockViewport(390, 844);
    try {
      const user = userEvent.setup();
      renderExecute();
      await user.click(
        within(screen.getByTestId("execute-filter-toolbar")).getByRole("button", {
          name: "Collaborate",
        })
      );
      const panel = await screen.findByRole("dialog", { name: "Sidebar panel" });
      expect(panel).toHaveStyle({ top: `${NAVBAR_HEIGHT}px`, "--sidebar-overlay-z": "40" });
      await within(panel).findByRole("heading", { name: "Collaborate" });
      await user.click(within(panel).getByRole("button", { name: "Close sidebar" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Sidebar panel" })).not.toBeInTheDocument()
      );
    } finally {
      restoreViewport();
    }
  });

  it("retains discussion, source, mentions, decision and guidance drafts across closing and reopening", async () => {
    const user = userEvent.setup();
    renderExecute();
    const toolbar = screen.getByTestId("execute-filter-toolbar");
    await user.click(within(toolbar).getByRole("button", { name: "Collaborate" }));
    await screen.findByRole("heading", { name: "Collaborate" });
    expect(screen.getByLabelText("Selected task")).toHaveValue(task.id);
    await user.click(screen.getByRole("tab", { name: "Changes" }));
    await user.selectOptions(await screen.findByLabelText("Comment on a file"), "src/filters.ts");
    await user.click(screen.getByRole("button", { name: "Discuss line" }));
    await user.type(
      screen.getByLabelText("Discuss with participants"),
      "Discuss this specific line"
    );
    await user.click(screen.getByLabelText("Record as a decision"));
    await user.selectOptions(screen.getByLabelText("Mention"), "maya");
    await user.click(screen.getByRole("tab", { name: "Agent" }));
    await user.type(
      await screen.findByLabelText("Guide the active agent"),
      "Retain this agent draft"
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Collaborate" })).not.toBeInTheDocument()
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).includes("/presence/") && init?.method === "DELETE"
        )
      ).toBe(true)
    );
    await user.click(within(toolbar).getByRole("button", { name: "Collaborate" }));
    await screen.findByLabelText("Discuss with participants");
    expect(screen.getByLabelText("Discuss with participants")).toHaveValue(
      "Discuss this specific line"
    );
    expect(screen.getByText(/Commenting on src\/filters.ts:1/)).toBeInTheDocument();
    expect(screen.getByLabelText("Record as a decision")).toBeChecked();
    expect(screen.getByRole("button", { name: "Remove mention of Maya" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Agent" }));
    expect(await screen.findByLabelText("Guide the active agent")).toHaveValue(
      "Retain this agent draft"
    );
  });

  it("opens invitations again after the panel header dismissed them", async () => {
    const user = userEvent.setup();
    renderExecute();
    const toolbar = screen.getByTestId("execute-filter-toolbar");
    await user.click(within(toolbar).getByRole("button", { name: "Invite" }));
    await screen.findByRole("heading", { name: "Invite to this project" });
    const panel = screen.getByRole("region", { name: "Shared Execute session" });
    await user.click(within(panel).getByRole("button", { name: "Invite" }));
    expect(
      screen.queryByRole("heading", { name: "Invite to this project" })
    ).not.toBeInTheDocument();
    await user.click(within(toolbar).getByRole("button", { name: "Invite" }));
    await screen.findByRole("heading", { name: "Invite to this project" });
  });
});
