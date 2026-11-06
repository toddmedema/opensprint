import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import type { CollaborationSnapshot } from "@opensprint/shared";
import { CollaborationPage } from "./CollaborationPage";

const response = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const snapshot = (
  projectId = "project-a",
  role: "viewer" | "participant" | "controller" = "controller"
): CollaborationSnapshot => ({
  projectId,
  sessionId: "default",
  cursor: 0,
  messages: [],
  runs: [],
  messagesHasMore: false,
  runsHasMore: false,
  principal: { actorId: "alice", displayName: "Alice", role },
});
const activeRun = {
  taskId: "os-task",
  attemptId: "attempt-new",
  attempt: 2,
  supported: true,
  reason: null,
  control: { runId: "attempt-new", controllerId: "alice", revision: 4 },
};
const tasks = [
  { id: "os-task", title: "Keep filters when navigating", status: "in_progress" },
  { id: "os-other", title: "Improve search results", status: "open" },
];
const people = [
  {
    actorId: "alice",
    displayName: "Alice",
    role: "controller",
    clientId: "alice-browser",
    taskId: "os-task",
    lastSeenAt: "2026-11-06T10:00:00Z",
  },
  {
    actorId: "bob",
    displayName: "Bob",
    role: "controller",
    clientId: "bob-browser",
    taskId: "os-other",
    lastSeenAt: "2026-11-06T10:00:00Z",
  },
];
let client: QueryClient;
let handler: (url: string, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
function setup() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/collaborate/project-a"]}>
        <Link to="/collaborate/project-b">Other project</Link>
        <Routes>
          <Route path="/collaborate/:projectId" element={<CollaborationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
async function join(user: ReturnType<typeof userEvent.setup>, token = "alice-project-token") {
  await user.type(screen.getByLabelText("Project access token"), token);
  await user.click(screen.getByRole("button", { name: "Join session" }));
  await screen.findByRole("heading", { name: "Collaborate" });
  await screen.findByText(/Live · Alice/);
}
async function inspect(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(screen.getByRole("option", { name: tasks[0].title })).toBeInTheDocument()
  );
  await user.selectOptions(screen.getByLabelText("Selected task"), "os-task");
  await user.click(screen.getByRole("tab", { name: "Agent" }));
}
const submissions = (ending: string) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith(ending) && init?.body)
    .map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
  // jsdom lacks AbortSignal.any. Fetch is mocked here; preserve the query cancellation signal.
  vi.stubGlobal("AbortSignal", {
    timeout: AbortSignal.timeout.bind(AbortSignal),
    any: (signals: AbortSignal[]) => signals.at(-1)!,
  });
  delete window.__OPENSPRINT_LOCAL_SESSION__;
  window.history.replaceState(null, "", "/");
  handler = async (url, init) => {
    if (url.endsWith("/snapshot"))
      return response(snapshot(url.includes("project-b") ? "project-b" : "project-a"));
    if (url.includes("/events?")) return response({ events: [], nextCursor: 0, hasMore: false });
    if (url.endsWith("/overview"))
      return response({ projectName: "Sample project", observedAt: "2026-11-06T10:00:00Z", tasks });
    if (url.includes("/context"))
      return response({
        task: tasks[0],
        activeRun,
        output: "Checking filter tests",
        diff: "diff --git a/src/filters.ts b/src/filters.ts\n+++ b/src/filters.ts\n+keepFilters();",
        source: "active",
        sourceAttemptId: "attempt-new",
        sourceAttempt: 2,
        diffRevision: "revision-safe",
      });
    if (url.includes("/runs/")) return response(activeRun);
    if (url.endsWith("/presence")) return response(people);
    if (url.includes("/presence/")) return new Response(null, { status: 204 });
    if (url.endsWith("/preferences"))
      return response(
        init?.method === "PUT"
          ? JSON.parse(String(init.body))
          : { seenCursor: 0, subscribedTaskIds: [], seenAt: null }
      );
    if (url.endsWith("/notifications")) return response([]);
    if (url.includes("/guidance/")) return response([]);
    if (url.endsWith("/guidance")) return response({ delivered: true, status: "queued" });
    if (url.endsWith("/commands")) return response({});
    if (url.endsWith("/invites")) return response([]);
    throw new Error(`Unexpected request: ${url}`);
  };
  fetchMock = vi.fn((url: string, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  delete window.__OPENSPRINT_LOCAL_SESSION__;
  window.history.replaceState(null, "", "/");
});

describe("Execute collaboration", () => {
  it("joins the local session immediately without a token prompt", async () => {
    window.__OPENSPRINT_LOCAL_SESSION__ = "local-secret";
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/snapshot")
        ? response({
            ...snapshot(),
            principal: { actorId: "local-user", displayName: "Local user", role: "controller" },
          })
        : fallback(url, init);
    setup();
    await screen.findByRole("heading", { name: "Collaborate" });
    expect(screen.queryByLabelText("Project access token")).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "Invite" });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer local-secret"
    );
  });

  it("uses named credentials only on collaboration APIs and never includes credentials in query identities", async () => {
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    await screen.findByLabelText("Guide the active agent");
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain("/projects/project-a/collaboration/");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer alice-project-token");
    }
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey)
      )
    ).not.toContain("alice-project-token");
    expect(localStorage.getItem("alice-project-token")).toBeNull();
  });

  it("accepts an invitation fragment, removes it immediately and clears access when leaving", async () => {
    window.history.replaceState(null, "", "/collaborate/project-a#invite=private-invite-token");
    const user = userEvent.setup();
    setup();
    await screen.findByRole("heading", { name: "Collaborate" });
    expect(window.location.hash).toBe("");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer private-invite-token"
    );
    await user.click(screen.getByRole("button", { name: "Leave session" }));
    await screen.findByRole("heading", { name: "Join collaboration" });
    expect(screen.getByLabelText("Project access token")).toHaveValue("");
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
  });

  it("preserves a failed discussion and retries uncertain acceptance with the same command identity", async () => {
    const fallback = handler;
    let attempts = 0;
    handler = async (url, init) => {
      if (url.endsWith("/commands") && ++attempts === 1) throw new Error("Network response lost");
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    const field = screen.getByLabelText("Discuss with participants");
    await user.type(field, "Keep my draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Network response lost");
    expect(field).toHaveValue("Keep my draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(submissions("/commands")).toHaveLength(2);
    expect(submissions("/commands")[1]).toEqual(submissions("/commands")[0]);
  });

  it("offers control by name using the current attempt and authoritative revision", async () => {
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    await user.selectOptions(await screen.findByLabelText("Next controller"), "bob");
    await user.click(screen.getByRole("button", { name: "Offer control" }));
    expect(submissions("/commands")[0]).toMatchObject({
      type: "request_control",
      taskId: "os-task",
      runId: "attempt-new",
      expectedRevision: 4,
      targetActorId: "bob",
    });
  });

  it("records distinct repeated guidance submissions after successful queue acceptance", async () => {
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    const field = await screen.findByLabelText("Guide the active agent");
    for (let i = 0; i < 2; i++) {
      await user.type(field, "Continue");
      await user.click(screen.getByRole("button", { name: "Send to agent" }));
      await waitFor(() => expect(field).toHaveValue(""));
    }
    const commands = submissions("/guidance");
    expect(commands).toHaveLength(2);
    expect(commands[1].attemptId).toBe(commands[0].attemptId);
    expect(commands[1].clientMessageId).not.toBe(commands[0].clientMessageId);
  });

  it("shows persisted guidance dispositions after the active attempt ends", async () => {
    const fallback = handler;
    handler = async (url, init) => {
      if (url.includes("/runs/")) return response(null);
      if (url.includes("/context"))
        return response({
          task: tasks[0],
          activeRun: null,
          output: "Archived",
          diff: "",
          source: "archived",
          sourceAttempt: 2,
        });
      if (url.includes("/guidance/"))
        return response([
          {
            id: "included",
            actorId: "alice",
            attempt: 1,
            content: "Earlier guidance",
            status: "included",
          },
          {
            id: "ended",
            actorId: "bob",
            attempt: 2,
            content: "Pending guidance",
            status: "run-ended",
            error: "Run ended before inclusion.",
          },
        ]);
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    await screen.findByText(/No active run for this task/);
    const history = await screen.findByRole("list", { name: "Agent guidance history" });
    expect(within(history).getByText(/Attempt 1 · Included in agent turn/)).toBeInTheDocument();
    expect(within(history).getByText(/Attempt 2 · Run ended before inclusion/)).toBeInTheDocument();
    expect(within(history).getByText("Run ended before inclusion.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
  });

  it("uses a fresh instruction identity after definite rejection and preserves the rejected draft", async () => {
    const fallback = handler;
    let attempts = 0;
    handler = async (url, init) =>
      url.endsWith("/guidance") && ++attempts === 1
        ? response({ delivered: false, status: "failed", error: "Queue is full" })
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    const field = await screen.findByLabelText("Guide the active agent");
    await user.type(field, "Preserve this guidance");
    await user.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByText("Queue is full");
    expect(field).toHaveValue("Preserve this guidance");
    await user.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(submissions("/guidance")[1].clientMessageId).not.toBe(
      submissions("/guidance")[0].clientMessageId
    );
  });

  it("keeps the guidance identity stable when the acceptance response is lost", async () => {
    const fallback = handler;
    let attempts = 0;
    handler = async (url, init) => {
      if (url.endsWith("/guidance") && ++attempts === 1) throw new Error("Guidance response lost");
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    const field = await screen.findByLabelText("Guide the active agent");
    await user.type(field, "Preserve this guidance");
    await user.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByText("Guidance response lost");
    expect(field).toHaveValue("Preserve this guidance");
    await user.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(submissions("/guidance")[1]).toEqual(submissions("/guidance")[0]);
  });

  it("hides discussion and steering for downgraded viewers even with persisted ownership", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/snapshot") ? response(snapshot("project-a", "viewer")) : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    await screen.findByText(/Alice \(you\) is guiding/);
    expect(screen.queryByLabelText("Discuss with participants")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Guide the active agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release control" })).not.toBeInTheDocument();
  });

  it("clears credentials on project navigation and ignores an old project's late response", async () => {
    let resolveOld!: (value: Response) => void;
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const fallback = handler;
    handler = (url, init) =>
      url.includes("project-a") && url.endsWith("/snapshot") ? old : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("Project access token"), "alice-project-token");
    await user.click(screen.getByRole("button", { name: "Join session" }));
    await user.click(screen.getByRole("link", { name: "Other project" }));
    await screen.findByRole("heading", { name: "Join collaboration" });
    await act(async () =>
      resolveOld(
        response({
          ...snapshot(),
          messages: [
            {
              id: "old",
              actorId: "alice",
              displayName: "Alice",
              createdAt: "2026-10-20T00:00:00Z",
              cursor: 0,
              content: "Old project private message",
            },
          ],
        })
      )
    );
    expect(screen.queryByText("Old project private message")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("project-b"))).toBe(false);
    expect(screen.getByLabelText("Project access token")).toHaveValue("");
  });

  it("preserves task-specific discussion drafts and follows a named teammate’s selected task", async () => {
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.selectOptions(await screen.findByLabelText("Selected task"), "os-task");
    await user.type(screen.getByLabelText("Discuss with participants"), "Task A draft");
    await user.selectOptions(screen.getByLabelText("Selected task"), "os-other");
    expect(screen.getByLabelText("Discuss with participants")).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("Selected task"), "os-task");
    expect(screen.getByLabelText("Discuss with participants")).toHaveValue("Task A draft");
    await user.click(screen.getByText(/people here/));
    await user.click(screen.getByRole("button", { name: "Follow Bob" }));
    expect(screen.getByLabelText("Selected task")).toHaveValue("os-other");
    await screen.findByText(/Following Bob’s selected task/);
    await user.click(screen.getByRole("button", { name: "Stop following" }));
    expect(screen.getByLabelText("Selected task")).toHaveValue("os-other");
  });

  it("attaches file/attempt provenance, mentions and decisions and prepares an attributed guidance draft", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/snapshot")
        ? response({
            ...snapshot(),
            messages: [
              {
                id: "m",
                actorId: "bob",
                displayName: "Bob",
                content: "Keep filters in the URL",
                taskId: "os-task",
                context: {
                  kind: "file",
                  label: "src/filters.ts:12",
                  path: "src/filters.ts",
                  line: 12,
                  attempt: 1,
                  diffRevision: "old-revision",
                },
                createdAt: "2026-11-06T10:00:00Z",
                cursor: 0,
              },
            ],
          })
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    await user.click(screen.getByRole("tab", { name: "Changes" }));
    await user.selectOptions(screen.getByLabelText("Comment on a file"), "src/filters.ts");
    await user.clear(screen.getByLabelText("Line"));
    await user.type(screen.getByLabelText("Line"), "12");
    await user.click(screen.getByRole("button", { name: "Discuss line" }));
    await user.type(screen.getByLabelText("Discuss with participants"), "Agreed");
    await user.click(screen.getByLabelText("Record as a decision"));
    await user.selectOptions(screen.getByLabelText("Mention"), "bob");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0]).toMatchObject({
      taskId: "os-task",
      decision: true,
      mentionActorIds: ["bob"],
      context: {
        path: "src/filters.ts",
        line: 12,
        attemptId: "attempt-new",
        attempt: 2,
        diffRevision: "revision-safe",
      },
    });
    await user.click(screen.getByRole("button", { name: "Use as agent guidance" }));
    expect(
      (screen.getByLabelText("Guide the active agent") as HTMLTextAreaElement).value
    ).toContain("From Bob");
    expect(
      (screen.getByLabelText("Guide the active agent") as HTMLTextAreaElement).value
    ).toContain("attempt 1");
    expect(
      (screen.getByLabelText("Guide the active agent") as HTMLTextAreaElement).value
    ).toContain("old-revision");
    expect(submissions("/guidance")).toHaveLength(0);
  });

  it("marks only displayed activity as read, preserves observed completion time and supports task subscriptions", async () => {
    const fallback = handler;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot")) return response({ ...snapshot(), cursor: 20 });
      if (url.endsWith("/overview"))
        return response({
          projectName: "Sample project",
          observedAt: "2026-11-06T10:00:00Z",
          tasks: [
            ...tasks,
            {
              id: "done",
              title: "Finished navigation",
              status: "closed",
              completedAt: "2026-11-06T09:00:00Z",
              summary: "Navigation now restores filters",
              questions: [],
            },
            {
              id: "question",
              title: "Search decision",
              status: "blocked",
              questions: ["Which fields should be searchable?"],
            },
          ],
        });
      if (url.includes("/events?"))
        return response({
          events: [
            {
              projectId: "project-a",
              cursor: 3,
              type: "message_appended",
              actorId: "bob",
              createdAt: "2026-11-06T09:30:00Z",
              payload: {
                id: "event",
                content: "Ready for review",
                actorId: "bob",
                displayName: "Bob",
                createdAt: "2026-11-06T09:30:00Z",
                cursor: 3,
              },
            },
          ],
          nextCursor: 3,
          hasMore: false,
        });
      if (url.endsWith("/notifications"))
        return response([
          {
            id: "n",
            cursor: 3,
            taskId: "os-task",
            actorId: "bob",
            kind: "mention",
            content: "Please review",
            createdAt: "2026-11-06T09:30:00Z",
          },
        ]);
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.click(screen.getByRole("tab", { name: /Activity/ }));
    await screen.findByText("Navigation now restores filters");
    await screen.findByText("Which fields should be searchable?");
    await screen.findByText("Please review");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mark caught up" })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: "Mark caught up" }));
    expect(submissions("/preferences")[0]).toMatchObject({
      seenCursor: 3,
      markSeen: true,
      markSeenAt: "2026-11-06T10:00:00Z",
    });
    await user.selectOptions(screen.getByLabelText("Selected task"), "os-task");
    await user.click(screen.getByRole("button", { name: "Follow task" }));
    expect(submissions("/preferences").at(-1)).toMatchObject({ subscribedTaskIds: ["os-task"] });
    expect(submissions("/preferences").at(-1)).not.toHaveProperty("markSeen");
  });
  it("creates expiring named invitations, copies their links and revokes active access", async () => {
    const fallback = handler;
    const invited = {
      id: "invite-one",
      actorId: "invite-one",
      displayName: "Maya",
      role: "participant",
      createdAt: "2026-11-06T10:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      revokedAt: null,
    };
    let created = false;
    let revoked = false;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({
          ...snapshot(),
          principal: { actorId: "local-user", displayName: "Local user", role: "controller" },
        });
      if (url.endsWith("/invites") && init?.method === "POST") {
        created = true;
        return response({ invite: invited, token: "invite-secret" });
      }
      if (url.endsWith("/invites"))
        return response(
          created ? [{ ...invited, revokedAt: revoked ? "2026-11-06T11:00:00Z" : null }] : []
        );
      if (url.endsWith("/invites/invite-one")) {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      return fallback(url, init);
    };
    window.__OPENSPRINT_LOCAL_SESSION__ = "local-secret";
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "Invite" }));
    await user.type(screen.getByLabelText("Person’s name"), "Maya");
    await user.selectOptions(screen.getByLabelText("Access"), "participant");
    await user.selectOptions(screen.getByLabelText("Expires"), "24");
    await user.click(screen.getByRole("button", { name: "Create invite" }));
    const link = await screen.findByLabelText("Private invitation link");
    expect((link as HTMLInputElement).value).toContain(
      "/collaborate/project-a#invite=invite-secret"
    );
    expect(submissions("/invites")[0]).toEqual({
      displayName: "Maya",
      role: "participant",
      expiresInHours: 24,
    });
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await screen.findByText("Invitation copied.");
    await user.click(await screen.findByRole("button", { name: "Revoke Maya invitation" }));
    await screen.findByText("Revoked");
    expect(screen.queryByLabelText("Private invitation link")).not.toBeInTheDocument();
  });

  it("accepts, declines and cancels handoffs without claiming control early", async () => {
    const fallback = handler;
    let pending = { requestedBy: "bob", targetActorId: "bob", createdAt: "2026-11-06T10:00:00Z" };
    handler = async (url, init) =>
      url.includes("/runs/")
        ? response({ ...activeRun, control: { ...activeRun.control, request: pending } })
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    await user.click(await screen.findByRole("button", { name: "Decline handoff" }));
    expect(submissions("/commands")[0]).toMatchObject({
      type: "respond_control",
      accept: false,
      expectedRevision: 4,
    });
    await user.click(screen.getByRole("button", { name: "Accept handoff" }));
    expect(submissions("/commands")[1]).toMatchObject({ type: "respond_control", accept: true });
    pending = { requestedBy: "alice", targetActorId: "bob", createdAt: "2026-11-06T10:00:00Z" };
    await act(async () => {
      await client.invalidateQueries();
    });
    await user.click(await screen.findByRole("button", { name: "Cancel request" }));
    expect(submissions("/commands")[2]).toMatchObject({ type: "cancel_control_request" });
    await user.click(screen.getByRole("button", { name: "Release control" }));
    expect(submissions("/commands")[3]).toMatchObject({
      type: "handoff_control",
      targetActorId: null,
    });
  });

  it("shows viewing-only guidance for native agents and keeps drafts attached to their original attempt", async () => {
    const fallback = handler;
    let current = activeRun;
    handler = async (url, init) =>
      url.includes("/runs/") ? response(current) : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    await user.type(await screen.findByLabelText("Guide the active agent"), "Only for attempt two");
    current = {
      ...activeRun,
      attempt: 3,
      attemptId: "attempt-three",
      control: { ...activeRun.control, runId: "attempt-three" },
    };
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(screen.getByLabelText("Guide the active agent")).toHaveValue(""));
    await user.click(screen.getByText("Drafts from earlier attempts"));
    expect(screen.getByText("Only for attempt two")).toBeInTheDocument();
    current = {
      ...current,
      supported: false,
      reason: "This native CLI backend supports viewing only.",
    };
    await act(async () => {
      await client.invalidateQueries();
    });
    await screen.findByText("This native CLI backend supports viewing only.");
    expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
    expect(submissions("/guidance")).toHaveLength(0);
  });

  it("removes cached content from view after credentials are revoked", async () => {
    const fallback = handler;
    let revoked = false;
    handler = async (url, init) =>
      revoked && url.endsWith("/snapshot")
        ? new Response(
            JSON.stringify({
              error: { code: "COLLABORATION_UNAUTHENTICATED", message: "Invitation revoked" },
            }),
            { status: 401 }
          )
        : revoked && url.includes("/events?")
          ? new Response(
              JSON.stringify({
                error: { code: "COLLABORATION_UNAUTHENTICATED", message: "Invitation revoked" },
              }),
              { status: 401 }
            )
          : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    revoked = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    await screen.findByRole("heading", { name: "Access to this project ended" });
    expect(screen.queryByLabelText("Discuss with participants")).not.toBeInTheDocument();
  });
  it("does not recreate a named session cache when a heartbeat finishes after leaving", async () => {
    const fallback = handler;
    let resolveBeat!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveBeat = resolve;
    });
    handler = async (url, init) =>
      url.endsWith("/presence") && init?.method === "POST" ? pending : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await waitFor(() => expect(submissions("/presence")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Leave session" }));
    await screen.findByRole("heading", { name: "Join collaboration" });
    await act(async () => resolveBeat(response(people)));
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => url.includes("/presence/") && init?.method === "DELETE"
        )
      ).toHaveLength(2)
    );
  });

  it("serializes overlapping heartbeats and publishes only the latest selected task", async () => {
    const fallback = handler;
    let resolveBeat!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveBeat = resolve;
    });
    let beats = 0;
    handler = async (url, init) =>
      url.endsWith("/presence") && init?.method === "POST" && ++beats === 1
        ? pending
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.selectOptions(screen.getByLabelText("Selected task"), "os-task");
    await user.selectOptions(screen.getByLabelText("Selected task"), "os-other");
    expect(submissions("/presence")).toHaveLength(1);
    await act(async () => resolveBeat(response(people)));
    await waitFor(() => expect(submissions("/presence")).toHaveLength(2));
    expect(submissions("/presence")[1].taskId).toBe("os-other");
  });
});
