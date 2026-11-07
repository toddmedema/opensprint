import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import type { CollaborationSnapshot } from "@opensprint/shared";
import { CollaborationPage } from "./CollaborationPage";
import { CollaborationSession } from "../components/collaboration/CollaborationSession";

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
  await screen.findByRole("button", { name: "People in this workspace" });
  await user.click(screen.getByRole("tab", { name: "Discussion" }));
}
async function chooseTask(user: ReturnType<typeof userEvent.setup>, taskId = "os-task") {
  await user.click(screen.getByRole("button", { name: /^Choose task:/ }));
  await user.click(
    await screen.findByRole("button", {
      name: tasks.find((task) => task.id === taskId)!.title,
      exact: true,
    })
  );
  await screen.findByRole("heading", {
    name: new RegExp(tasks.find((task) => task.id === taskId)!.title),
  });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Choose task:/ })).toHaveFocus());
}
async function inspect(user: ReturnType<typeof userEvent.setup>) {
  await chooseTask(user);
  await user.click(screen.getByRole("button", { name: "Guide agent…" }));
  await screen.findByRole("dialog", { name: "Guide agent" });
}
async function leave(user: ReturnType<typeof userEvent.setup>) {
  const options = screen.queryByRole("button", { name: "Workspace options" });
  if (options) await user.click(options);
  const action = screen.getByRole("button", { name: "Leave session" });
  await user.click(action);
}
async function chooseMaya(user: ReturnType<typeof userEvent.setup>, taskTitle: string) {
  await user.type(screen.getByLabelText("Message team"), "@Ma");
  await user.click(screen.getByRole("button", { name: new RegExp("@Maya.*" + taskTitle) }));
}
function mayaParticipants() {
  return [
    people[0],
    {
      ...people[1],
      actorId: "maya-a",
      clientId: "maya-a-browser",
      displayName: "Maya",
      taskId: "os-task",
    },
    {
      ...people[1],
      actorId: "maya-b",
      clientId: "maya-b-browser",
      displayName: "Maya",
      taskId: "os-other",
    },
  ];
}

const submissions = (ending: string) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith(ending) && init?.body)
    .map(([, init]) => JSON.parse(init.body));

const readingObservers = new Set<{
  callback: IntersectionObserverCallback;
  targets: Set<Element>;
}>();
function enableObservedReading() {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback;
      targets = new Set<Element>();
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        readingObservers.add(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        readingObservers.delete(this);
      }
    }
  );
}
async function observeRows(...cursors: number[]) {
  await act(async () => {
    for (const observer of [...readingObservers]) {
      const entries = [...observer.targets]
        .filter((target) => cursors.includes(Number((target as HTMLElement).dataset.eventCursor)))
        .map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
      if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  });
}
function discussionEvent(cursor: number, taskId?: string) {
  return {
    projectId: "project-a",
    cursor,
    actorId: "bob",
    createdAt: "2026-11-06T10:00:00Z",
    type: "message_appended",
    payload: {
      id: "message-" + cursor,
      actorId: "bob",
      displayName: "Bob",
      content: "Discussion " + cursor,
      cursor,
      taskId,
      createdAt: "2026-11-06T10:00:00Z",
    },
  };
}

/** Deterministic layout for chat interaction tests; positions follow rendered row order. */
function mockConversationGeometry() {
  const nativeHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")?.get;
  const nativeClientHeight = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "clientHeight"
  )?.get;
  const nativeRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === "team-discussion-scroll"
      ? this.querySelectorAll("[data-conversation-entry]").length * 100
      : (nativeHeight?.call(this) ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === "team-discussion-scroll"
      ? this.closest("[hidden]")
        ? 0
        : 200
      : (nativeClientHeight?.call(this) ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const container = this.closest<HTMLElement>('[data-testid="team-discussion-scroll"]');
    if (!container || (!this.dataset.conversationEntry && this !== container))
      return nativeRect.call(this);
    const index = [...container.querySelectorAll("[data-conversation-entry]")].indexOf(this);
    const top = this === container ? 0 : index * 100 - container.scrollTop;
    const height = this === container ? 200 : 100;
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 400,
      width: 400,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

beforeEach(() => {
  // jsdom lacks AbortSignal.any. Fetch is mocked here; preserve the query cancellation signal.
  vi.stubGlobal("AbortSignal", {
    timeout: AbortSignal.timeout.bind(AbortSignal),
    any: (signals: AbortSignal[]) => signals.at(-1)!,
  });
  delete window.__OPENSPRINT_LOCAL_SESSION__;
  window.history.replaceState(null, "", "/");
  const storedPreferences = {
    seenCursor: 0,
    subscribedTaskIds: [] as string[],
    seenAt: null as string | null,
  };
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
    if (url.endsWith("/preferences")) {
      if (init?.method === "PUT") {
        const update = JSON.parse(String(init.body));
        storedPreferences.seenCursor = Math.max(
          storedPreferences.seenCursor,
          update.seenCursor ?? 0
        );
        if (Array.isArray(update.subscribedTaskIds))
          storedPreferences.subscribedTaskIds = update.subscribedTaskIds;
        if (update.markSeen)
          storedPreferences.seenAt = update.markSeenAt ?? new Date().toISOString();
      }
      return response(storedPreferences);
    }
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
  vi.restoreAllMocks();
  readingObservers.clear();
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
    await screen.findByRole("button", { name: "People in this workspace" });
    expect(screen.queryByLabelText("Project access token")).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "Share" });
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
    await screen.findByRole("button", { name: "People in this workspace" });
    expect(window.location.hash).toBe("");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer private-invite-token"
    );
    await leave(user);
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
    const field = screen.getByLabelText("Message team");
    await user.type(field, "Keep my draft");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Network response lost");
    expect(field).toHaveValue("Keep my draft");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(submissions("/commands")).toHaveLength(2);
    expect(submissions("/commands")[1]).toEqual(submissions("/commands")[0]);
  });

  it("offers control by name using the current attempt and authoritative revision", async () => {
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseTask(user);
    await user.click(screen.getByLabelText("Agent control options"));
    await user.click(screen.getByRole("button", { name: "Offer control to Bob" }));
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

  it("keeps ended-attempt instruction receipts in the shared conversation and reveals older instructions on demand", async () => {
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
            timestamp: "2026-11-06T09:00:00Z",
            role: "user",
          },
          {
            id: "ended",
            actorId: "bob",
            attempt: 2,
            content: "Pending guidance",
            status: "run-ended",
            timestamp: "2026-11-06T10:00:00Z",
            role: "user",
          },
        ]);
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseTask(user);
    await screen.findByText("Run ended before inclusion");
    expect(screen.queryByRole("button", { name: "Guide agent…" })).not.toBeInTheDocument();
    expect(screen.getByText("Pending guidance")).toBeInTheDocument();
    expect(screen.queryByText("Earlier guidance")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Earlier messages" }));
    await screen.findByText("Earlier guidance");
    expect(screen.getByText("Included in agent turn")).toBeInTheDocument();
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
    await chooseTask(user);
    await screen.findByText(/Alice \(you\) is guiding/);
    expect(screen.queryByLabelText("Message team")).not.toBeInTheDocument();
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

  it("preserves task-specific discussion drafts without participant-following mode or a persistent task selector", async () => {
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseTask(user);
    await user.type(screen.getByLabelText("Message team"), "Task A draft");
    await chooseTask(user, "os-other");
    expect(screen.getByLabelText("Message team")).toHaveValue("");
    await chooseTask(user);
    expect(screen.getByLabelText("Message team")).toHaveValue("Task A draft");
    expect(screen.queryByLabelText("Selected task")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "People in this workspace" }));
    expect(screen.queryByRole("button", { name: /Follow/ })).not.toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("prepares attributed instructions from a message action without automatically sending to the agent", async () => {
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
                cursor: 1,
              },
            ],
          })
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseTask(user);
    await user.click(screen.getByRole("button", { name: "Message actions for Bob" }));
    await user.click(await screen.findByRole("button", { name: "Send to agent…" }));
    const field = await screen.findByLabelText("Guide the active agent");
    expect((field as HTMLTextAreaElement).value).toContain("From Bob");
    expect((field as HTMLTextAreaElement).value).toContain("attempt 1");
    expect((field as HTMLTextAreaElement).value).toContain("old-revision");
    expect(submissions("/guidance")).toHaveLength(0);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Message actions for Bob" }));
    await user.click(screen.getByRole("button", { name: "Record decision…" }));
    expect(submissions("/commands")).toHaveLength(0);
    await user.type(screen.getByLabelText("Message team"), " @B");
    await user.click(screen.getByRole("button", { name: "@Bob" }));
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0]).toMatchObject({
      taskId: "os-task",
      decision: true,
      mentionActorIds: ["bob"],
      context: { kind: "event", eventCursor: 1, label: "Discussion by Bob" },
    });
  });

  it("keeps notifications contextual and task subscriptions inside workspace options", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/notifications")
        ? response([
            {
              id: "n",
              cursor: 3,
              taskId: "os-other",
              actorId: "bob",
              kind: "mention",
              content: "Please review search",
              createdAt: "2026-11-06T09:30:00Z",
            },
          ])
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    expect(screen.queryByRole("tab", { name: /Activity/ })).not.toBeInTheDocument();
    await user.click(screen.getByText("Updates (1)"));
    await user.click(screen.getByRole("button", { name: "Please review search" }));
    await screen.findByRole("heading", { name: /Improve search results/ });
    await user.click(screen.getByRole("button", { name: "Workspace options" }));
    await user.click(screen.getByRole("button", { name: "Notify me" }));
    expect(submissions("/preferences").at(-1)).toMatchObject({ subscribedTaskIds: ["os-other"] });
    expect(submissions("/preferences").at(-1)).not.toHaveProperty("markSeen");
    expect(submissions("/preferences").at(-1)).not.toHaveProperty("markSeenAt");
    expect(screen.queryByRole("button", { name: "Follow task" })).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "Share" }));
    await user.type(screen.getByLabelText("Person’s name"), "Maya");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
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
    await user.click(screen.getByText("Manage access"));
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
    await chooseTask(user);
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
    await user.click(screen.getByLabelText("Agent control options"));
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
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Guide agent" })).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Guide agent…" }));
    expect(screen.getByLabelText("Guide the active agent")).toHaveValue("");
    await user.click(screen.getByText("Earlier drafts"));
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
    expect(screen.queryByLabelText("Message team")).not.toBeInTheDocument();
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
    await leave(user);
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
    await chooseTask(user);
    await chooseTask(user, "os-other");
    expect(submissions("/presence")).toHaveLength(1);
    await act(async () => resolveBeat(response(people)));
    await waitFor(() => expect(submissions("/presence")).toHaveLength(2));
    expect(submissions("/presence")[1].taskId).toBe("os-other");
  });
  it("retrieves complete paged discussion inline after the read boundary has advanced", async () => {
    const fallback = handler;
    const event = (cursor: number, content: string) => ({
      projectId: "project-a",
      cursor,
      actorId: "bob",
      createdAt: "2026-11-06T09:30:00Z",
      type: "message_appended",
      payload: {
        id: "message-" + cursor,
        actorId: "bob",
        displayName: "Bob",
        content,
        cursor,
        createdAt: "2026-11-06T09:30:00Z",
      },
    });
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({ ...snapshot(), cursor: 400, messagesHasMore: true });
      if (url.endsWith("/preferences") && !init?.method)
        return response({ seenCursor: 400, subscribedTaskIds: [], seenAt: "2026-11-06T09:00:00Z" });
      if (url.includes("/events?after=0"))
        return response({
          events: [event(1, "Older architectural decision")],
          nextCursor: 200,
          hasMore: true,
        });
      if (url.includes("/events?after=200"))
        return response({
          events: [event(201, "Later architectural follow-up")],
          nextCursor: 400,
          hasMore: false,
        });
      if (url.includes("/events?after=400"))
        return response({ events: [], nextCursor: 400, hasMore: false });
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.click(screen.getByRole("button", { name: "Earlier messages" }));
    await screen.findByText("Older architectural decision");
    await user.click(screen.getByRole("button", { name: "Load more messages" }));
    await screen.findByText("Later architectural follow-up");
    expect(submissions("/preferences")).toHaveLength(0);
    expect(screen.queryByRole("tab", { name: /Activity/ })).not.toBeInTheDocument();
  });

  it("never marks fetched discussion pages read without observing their contents", async () => {
    const fallback = handler;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({ ...snapshot(), cursor: 400, messagesHasMore: true });
      if (url.includes("/events?after=0"))
        return response({
          events: [
            {
              projectId: "project-a",
              cursor: 1,
              actorId: "bob",
              createdAt: "2026-11-06T09:30:00Z",
              type: "message_appended",
              payload: {
                id: "old",
                actorId: "bob",
                displayName: "Bob",
                content: "Unread earlier discussion",
                cursor: 1,
                createdAt: "2026-11-06T09:30:00Z",
              },
            },
          ],
          nextCursor: 200,
          hasMore: true,
        });
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.click(screen.getByRole("button", { name: "Earlier messages" }));
    await screen.findByText("Unread earlier discussion");
    expect(submissions("/preferences")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Mark caught up" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more messages" })).toBeInTheDocument();
  });

  it("keeps the connection live after a rejected action and dismisses the action error", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/commands")
        ? new Response(
            JSON.stringify({
              error: {
                code: "COLLABORATION_CONFLICT",
                message: "Control changed; refresh before retrying.",
              },
            }),
            { status: 409 }
          )
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.type(screen.getByLabelText("Message team"), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Control changed; refresh before retrying.");
    expect(screen.getByRole("button", { name: "People in this workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Connection interrupted · retrying")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss error" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Message team")).toHaveValue("Keep this draft");
  });

  it("acknowledges only actually observed contiguous discussion records without acknowledging fetched work completions", async () => {
    enableObservedReading();
    const fallback = handler;
    const events = [discussionEvent(1), discussionEvent(2), discussionEvent(3)];
    let seenCursor = 0;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({
          ...snapshot(),
          cursor: 30,
          messages: events.map((event) => event.payload),
        });
      if (url.includes("/events?")) return response({ events, nextCursor: 3, hasMore: false });
      if (url.endsWith("/preferences")) {
        if (init?.method === "PUT") seenCursor = JSON.parse(String(init.body)).seenCursor;
        return response({ seenCursor, subscribedTaskIds: [], seenAt: "2026-11-06T08:00:00Z" });
      }
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await screen.findByText("Discussion 3");
    expect(submissions("/preferences")).toHaveLength(0);
    await observeRows(2, 3);
    expect(submissions("/preferences")).toHaveLength(0);
    await observeRows(1);
    await waitFor(() => expect(submissions("/preferences")).toHaveLength(1));
    expect(submissions("/preferences")[0]).toEqual({ seenCursor: 3 });
    expect(submissions("/preferences")[0]).not.toHaveProperty("markSeen");
    expect(submissions("/preferences")[0]).not.toHaveProperty("markSeenAt");
  });

  it("acknowledges observed unread events beyond the first history page without marking later events read", async () => {
    enableObservedReading();
    const fallback = handler;
    const events = Array.from({ length: 601 }, (_, index) => discussionEvent(index + 1));
    let seenCursor = 400;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({
          ...snapshot(),
          cursor: 601,
          messages: [events[400].payload, events[600].payload],
          messagesHasMore: true,
        });
      if (url.includes("/events?")) {
        const after = Number(new URL(url, location.origin).searchParams.get("after"));
        const page = events.filter((event) => event.cursor > after).slice(0, 200);
        return response({
          events: page,
          nextCursor: page.at(-1)?.cursor ?? after,
          hasMore: after + page.length < events.length,
        });
      }
      if (url.endsWith("/preferences")) {
        if (init?.method === "PUT") seenCursor = JSON.parse(String(init.body)).seenCursor;
        return response({ seenCursor, subscribedTaskIds: [], seenAt: null });
      }
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await screen.findByText("Discussion 401");
    await observeRows(401);
    await waitFor(() => expect(submissions("/preferences")[0]).toEqual({ seenCursor: 401 }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/events?after=600"))).toBe(
        true
      )
    );
    expect(submissions("/preferences").some((value) => value.seenCursor > 401)).toBe(false);
    expect(screen.getByRole("button", { name: "Earlier messages" })).toBeInTheDocument();
  });

  it("keeps the visibility observer attached while editing an unrelated discussion draft", async () => {
    enableObservedReading();
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/snapshot")
        ? response({ ...snapshot(), messages: [discussionEvent(1).payload], cursor: 1 })
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await screen.findByText("Discussion 1");
    await waitFor(() => expect(readingObservers.size).toBe(1));
    const observer = [...readingObservers][0];
    await user.type(screen.getByLabelText("Message team"), "Keep this unsent draft");
    expect(readingObservers.has(observer)).toBe(true);
    expect(observer.targets.size).toBe(1);
  });

  it("retains viewed control events and follows new replay pages after advancing the read cursor", async () => {
    enableObservedReading();
    const fallback = handler;
    const control = {
      ...discussionEvent(401),
      type: "control_claimed",
      payload: { runId: "run-1", controllerId: "bob", revision: 1 },
    };
    const events: unknown[] = [control];
    let seenCursor = 400;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({ ...snapshot(), cursor: 401, messagesHasMore: true });
      if (url.includes("/events?after=0"))
        return response({ events: [], nextCursor: 200, hasMore: true });
      if (url.includes("/events?")) {
        const after = Number(new URL(url, location.origin).searchParams.get("after"));
        const page = events.filter((event) => (event as { cursor: number }).cursor > after);
        return response({ events: page, nextCursor: 400 + events.length, hasMore: false });
      }
      if (url.endsWith("/preferences")) {
        if (init?.method === "PUT") seenCursor = JSON.parse(String(init.body)).seenCursor;
        return response({ seenCursor, subscribedTaskIds: [], seenAt: null });
      }
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await screen.findByText("Bob claimed control");
    await observeRows(401);
    await waitFor(() => expect(submissions("/preferences")[0]).toEqual({ seenCursor: 401 }));
    expect(screen.getByText("Bob claimed control")).toBeInTheDocument();
    events.push(discussionEvent(402));
    await act(async () => {
      await client.invalidateQueries({ predicate: (query) => query.queryKey[3] === "snapshot" });
    });
    await screen.findByText("Discussion 402");
    await observeRows(402);
    await waitFor(() => expect(submissions("/preferences").at(-1)).toEqual({ seenCursor: 402 }));
    expect(screen.getByText("Bob claimed control")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/events?after=400"))
    ).toHaveLength(1);
  });

  it("retries a failed unread replay explicitly without acknowledging unseen events or hot-looping", async () => {
    enableObservedReading();
    const fallback = handler;
    const event = discussionEvent(401);
    let seenCursor = 400;
    let reads = 0;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({
          ...snapshot(),
          cursor: 401,
          messages: [event.payload],
          messagesHasMore: true,
        });
      if (url.includes("/events?after=0"))
        return response({ events: [], nextCursor: 200, hasMore: true });
      if (url.includes("/events?after=400")) {
        if (++reads === 1) throw new Error("Unread replay unavailable");
        return response({ events: [event], nextCursor: 401, hasMore: false });
      }
      if (url.includes("/events?"))
        return response({ events: [], nextCursor: 401, hasMore: false });
      if (url.endsWith("/preferences")) {
        if (init?.method === "PUT") seenCursor = JSON.parse(String(init.body)).seenCursor;
        return response({ seenCursor, subscribedTaskIds: [], seenAt: null });
      }
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await screen.findByText("Unread replay unavailable");
    await observeRows(401);
    expect(reads).toBe(1);
    expect(submissions("/preferences")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(submissions("/preferences")[0]).toEqual({ seenCursor: 401 }));
    expect(reads).toBe(2);
  });

  it("does not acknowledge messages behind sheets, in a hidden document, or while unfocused", async () => {
    enableObservedReading();
    const fallback = handler;
    const event = discussionEvent(1, "os-task");
    window.__OPENSPRINT_LOCAL_SESSION__ = "local-secret";
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({
          ...snapshot(),
          cursor: 1,
          principal: { actorId: "local-user", displayName: "Local user", role: "controller" },
          messages: [event.payload],
        });
      if (url.includes("/events?"))
        return response({ events: [event], nextCursor: 1, hasMore: false });
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await screen.findByRole("button", { name: "Share" });
    await chooseTask(user);
    expect(submissions("/preferences")).toHaveLength(0);
    await user.click(screen.getByRole("tab", { name: "Discussion" }));
    await screen.findByText("Discussion 1");
    await user.click(screen.getByRole("button", { name: "Share" }));
    await observeRows(1);
    expect(submissions("/preferences")).toHaveLength(0);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Guide agent…" }));
    await observeRows(1);
    expect(submissions("/preferences")).toHaveLength(0);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "People in this workspace" }));
    await observeRows(1);
    expect(submissions("/preferences")).toHaveLength(0);
    await user.keyboard("{Escape}");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await observeRows(1);
    expect(submissions("/preferences")).toHaveLength(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await observeRows(1);
    expect(submissions("/preferences")).toHaveLength(0);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await observeRows(1);
    await waitFor(() => expect(submissions("/preferences")).toHaveLength(1));
  });

  it("keeps other-task and later-page events unread while accepting previously viewed contiguous records", async () => {
    enableObservedReading();
    const fallback = handler;
    const events = [
      discussionEvent(1, "os-task"),
      discussionEvent(2, "os-other"),
      discussionEvent(3, "os-task"),
    ];
    let seenCursor = 0;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({
          ...snapshot(),
          cursor: 400,
          messages: events.map((event) => event.payload),
          messagesHasMore: true,
        });
      if (url.includes("/events?after=0"))
        return response({ events, nextCursor: 3, hasMore: true });
      if (url.includes("/events?after=3"))
        return response({ events: [], nextCursor: 3, hasMore: true });
      if (url.endsWith("/preferences")) {
        if (init?.method === "PUT") seenCursor = JSON.parse(String(init.body)).seenCursor;
        return response({ seenCursor, subscribedTaskIds: [], seenAt: null });
      }
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseTask(user);
    await observeRows(1, 3);
    await waitFor(() => expect(submissions("/preferences").at(-1)?.seenCursor).toBe(1));
    expect(screen.queryByText("Discussion 2")).not.toBeInTheDocument();
    await chooseTask(user, "os-other");
    await screen.findByText("Discussion 2");
    await observeRows(2);
    await waitFor(() => expect(submissions("/preferences").at(-1)?.seenCursor).toBe(3));
    expect(submissions("/preferences").some((value) => value.seenCursor > 3)).toBe(false);
  });

  it("retries a failed read acknowledgment after dismissal without requiring a new message or hot-looping", async () => {
    enableObservedReading();
    const fallback = handler;
    const event = discussionEvent(1);
    let requests = 0;
    let seenCursor = 0;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({ ...snapshot(), cursor: 1, messages: [event.payload] });
      if (url.includes("/events?"))
        return response({ events: [event], nextCursor: 1, hasMore: false });
      if (url.endsWith("/preferences")) {
        if (init?.method === "PUT") {
          if (++requests === 1) throw new Error("Read acknowledgment lost");
          seenCursor = JSON.parse(String(init.body)).seenCursor;
        }
        return response({ seenCursor, subscribedTaskIds: [], seenAt: null });
      }
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await observeRows(1);
    await screen.findByText("Read acknowledgment lost");
    expect(requests).toBe(1);
    await observeRows(1);
    expect(requests).toBe(1);
    await user.click(screen.getByRole("button", { name: "Dismiss error" }));
    await waitFor(() => expect(requests).toBe(2));
    expect(submissions("/preferences")[1]).toEqual(submissions("/preferences")[0]);
  });

  it("preserves an unsent team draft while preparing an explicit decision", async () => {
    const fallback = handler;
    const message = { ...discussionEvent(1).payload, content: "Use URL state" };
    handler = async (url, init) =>
      url.endsWith("/snapshot")
        ? response({ ...snapshot(), messages: [message] })
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.type(screen.getByLabelText("Message team"), "My unfinished reply");
    await user.click(screen.getByRole("button", { name: "Message actions for Bob" }));
    await user.click(screen.getByRole("button", { name: "Record decision…" }));
    expect((screen.getByLabelText("Message team") as HTMLTextAreaElement).value).toContain(
      "My unfinished reply"
    );
    expect((screen.getByLabelText("Message team") as HTMLTextAreaElement).value).toContain(
      "Decision from Bob:"
    );
    expect((screen.getByLabelText("Message team") as HTMLTextAreaElement).value).toContain(
      "Use URL state"
    );
    expect(submissions("/commands")).toHaveLength(0);
  });

  it("mentions only the selected actor when two participants have the same display name", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/presence")
        ? response([
            ...people,
            { ...people[1], actorId: "bob-two", clientId: "bob-two-browser", taskId: "os-task" },
          ])
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.type(screen.getByLabelText("Message team"), "Hello @B");
    await user.click(screen.getByRole("button", { name: /@Bob.*Keep filters when navigating/ }));
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0].mentionActorIds).toEqual(["bob-two"]);
  });

  it("dismisses workspace and message menus before leaving the workspace and restores focus", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/snapshot")
        ? response({ ...snapshot(), messages: [discussionEvent(1).payload] })
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    const options = screen.getByRole("button", { name: "Workspace options" });
    await user.click(options);
    expect(screen.getByRole("button", { name: "Leave session" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(options).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Leave session" })).not.toBeInTheDocument();
    const actions = screen.getByRole("button", { name: "Message actions for Bob" });
    await user.click(actions);
    expect(screen.getByRole("button", { name: "Record decision…" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(actions).toHaveFocus();
    await user.click(actions);
    await user.click(screen.getByLabelText("Message team"));
    expect(screen.queryByRole("button", { name: "Record decision…" })).not.toBeInTheDocument();
  });

  it.each([
    { top: 450, expected: "bottom" },
    { top: 110, expected: "top" },
  ])("keeps message actions within the discussion viewport at $top", async ({ top, expected }) => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/snapshot")
        ? response({ ...snapshot(), messages: [discussionEvent(1).payload] })
        : fallback(url, init);
    const rect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.testid === "team-discussion-scroll")
        return { top: 100, bottom: 500 } as DOMRect;
      if (this.getAttribute("aria-label") === "Message actions for Bob")
        return { top, bottom: top + 32 } as DOMRect;
      return rect.call(this);
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.click(screen.getByRole("button", { name: "Message actions for Bob" }));
    const menu = screen.getByRole("button", { name: "Record decision…" }).parentElement!;
    expect(menu.style[expected as "top" | "bottom"]).toBe("100%");
    expect(menu.style.maxHeight).toBe(expected === "bottom" ? "350px" : "358px");
    // Scrolling changes the available space while the menu remains open.
    top = 300;
    fireEvent.scroll(screen.getByTestId("team-discussion-scroll"));
    expect(menu.style.top).toBe("100%");
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("168px");
  });

  it("does not offer redundant earlier history when replay only repeats the visible discussion", async () => {
    const fallback = handler;
    const event = discussionEvent(1);
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({ ...snapshot(), messages: [event.payload], cursor: 1 });
      if (url.includes("/events?"))
        return response({ events: [event], nextCursor: 1, hasMore: false });
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await screen.findByText("Discussion 1");
    expect(screen.queryByRole("button", { name: "Earlier messages" })).not.toBeInTheDocument();
  });

  it("keeps existing host work usable and defers shared context and history until opened", async () => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <CollaborationSession
          projectId="project-a"
          token="alice-project-token"
          selectedTaskId="os-task"
          taskTitle={tasks[0].title}
          embedded
          workContent={<p>Existing task work</p>}
        />
      </QueryClientProvider>
    );
    await screen.findByRole("button", { name: "People in this workspace" });
    expect(screen.getByText("Existing task work")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Work" })).toHaveAttribute("aria-selected", "true");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/context"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/guidance/"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/events?"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Workspace options" }));
    await user.click(screen.getByRole("button", { name: "View changes…" }));
    await screen.findByRole("textbox", { name: "Task diff" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/context"))).toBe(true);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: "Discussion" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/guidance/"))).toBe(true)
    );
  });

  it("attaches displayed line and attempt provenance from a direct code selection", async () => {
    const fallback = handler;
    const diff = [
      "diff --git a/src/filters.ts b/src/filters.ts",
      "--- a/src/filters.ts",
      "+++ b/src/filters.ts",
      "@@ -10,1 +12,1 @@",
      "+keepFilters();",
    ].join("\n");
    handler = async (url, init) =>
      url.endsWith("/context")
        ? response({
            task: tasks[0],
            activeRun,
            diff,
            output: "Checking filters",
            source: "active",
            sourceAttemptId: "attempt-new",
            sourceAttempt: 2,
            diffRevision: "revision-safe",
          })
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseTask(user);
    await user.click(screen.getByRole("tab", { name: "Work" }));
    const patch = await screen.findByRole("textbox", { name: "Task diff" });
    const node = patch.querySelector("pre")!.firstChild!;
    const range = document.createRange();
    range.setStart(node, diff.indexOf("keepFilters"));
    range.setEnd(node, diff.indexOf("keepFilters") + "keepFilters".length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(patch);
    await user.click(screen.getByRole("button", { name: "Comment on src/filters.ts:12" }));
    await user.type(screen.getByLabelText("Message team"), "Preserve this behavior");
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0]).toMatchObject({
      taskId: "os-task",
      context: {
        kind: "file",
        path: "src/filters.ts",
        line: 12,
        attemptId: "attempt-new",
        attempt: 2,
        diffRevision: "revision-safe",
      },
    });
    expect(screen.queryByLabelText("Line")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Comment on a file")).not.toBeInTheDocument();
  });

  it("opens at the latest discussion, follows only a pinned reader, preserves paged history anchors, and reveals an accepted own message", async () => {
    mockConversationGeometry();
    enableObservedReading();
    const fallback = handler;
    const events = Array.from({ length: 10 }, (_, index) => discussionEvent(index + 1));
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({
          ...snapshot(),
          cursor: events.at(-1)!.cursor,
          messages: events.slice(5).map((event) => event.payload),
          messagesHasMore: true,
        });
      if (url.includes("/events?")) {
        const after = Number(new URL(url, "http://localhost").searchParams.get("after"));
        const selected =
          after === 0 ? events.slice(0, 3) : events.filter((event) => event.cursor > after);
        return response({
          events: selected,
          nextCursor: selected.at(-1)?.cursor ?? after,
          hasMore: after === 0,
        });
      }
      if (url.endsWith("/commands")) {
        const input = JSON.parse(String(init?.body));
        const own = discussionEvent(events.at(-1)!.cursor + 1);
        own.payload = {
          ...own.payload,
          actorId: "alice",
          displayName: "Alice",
          content: input.content,
        };
        events.push(own);
        return response({});
      }
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    const scroll = screen.getByTestId("team-discussion-scroll");
    await waitFor(() => expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight));
    expect(scroll.scrollTop).toBe(300);
    await observeRows(9, 10);
    expect(submissions("/preferences")).toHaveLength(0);
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    events.push(discussionEvent(11));
    await act(async () => {
      await client.invalidateQueries();
    });
    await screen.findByText("Discussion 11");
    expect(scroll.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
    const anchor = scroll.querySelector<HTMLElement>('[data-conversation-entry="message-7"]')!;
    expect(anchor.getBoundingClientRect().top).toBe(0);
    await user.click(screen.getByRole("button", { name: "Earlier messages" }));
    expect(anchor.getBoundingClientRect().top).toBe(0);
    expect(scroll.scrollTop).toBe(400);
    await user.click(screen.getByRole("button", { name: "Load more messages" }));
    await screen.findByText("Discussion 5");
    expect(anchor.getBoundingClientRect().top).toBe(0);
    expect(scroll.scrollTop).toBe(600);
    await user.click(screen.getByRole("button", { name: "Jump to latest" }));
    await waitFor(() => expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight));
    events.push(discussionEvent(12));
    await act(async () => {
      await client.invalidateQueries();
    });
    await screen.findByText("Discussion 12");
    expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight);
    scroll.scrollTop = 200;
    fireEvent.scroll(scroll);
    await user.type(screen.getByLabelText("Message team"), "My accepted message");
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await screen.findByText("My accepted message");
    await waitFor(() => expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight));
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("starts each selected task at its latest message and ignores a previous task's delayed send when reading another task", async () => {
    mockConversationGeometry();
    const fallback = handler;
    const events = Array.from({ length: 10 }, (_, index) =>
      discussionEvent(index + 1, index < 5 ? "os-task" : "os-other")
    );
    let release!: (response: Response) => void;
    handler = async (url, init) => {
      if (url.endsWith("/snapshot"))
        return response({
          ...snapshot(),
          cursor: events.at(-1)!.cursor,
          messages: events.map((event) => event.payload),
        });
      if (url.includes("/events?")) {
        const after = Number(new URL(url, "http://localhost").searchParams.get("after"));
        const selected = events.filter((event) => event.cursor > after);
        return response({ events: selected, nextCursor: events.at(-1)!.cursor, hasMore: false });
      }
      if (url.endsWith("/commands"))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseTask(user);
    const scroll = screen.getByTestId("team-discussion-scroll");
    await waitFor(() => expect(scroll.scrollTop).toBe(300));
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    await user.type(screen.getByLabelText("Message team"), "Task A pending message");
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await chooseTask(user, "os-other");
    await waitFor(() => expect(scroll.scrollTop).toBe(300));
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    await act(async () => {
      release(response({}));
    });
    await waitFor(() => expect(screen.getByLabelText("Message team")).not.toBeDisabled());
    expect(scroll.scrollTop).toBe(100);
    await user.click(screen.getByRole("tab", { name: "Work" }));
    await user.click(screen.getByRole("tab", { name: "Discussion" }));
    expect(scroll.scrollTop).toBe(100);
  });

  it("replaces a selected mention identity when the whole draft is replaced with another person of the same name", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/presence")
        ? response([
            people[0],
            {
              ...people[1],
              actorId: "maya-a",
              clientId: "maya-a-browser",
              displayName: "Maya",
              taskId: "os-task",
            },
            {
              ...people[1],
              actorId: "maya-b",
              clientId: "maya-b-browser",
              displayName: "Maya",
              taskId: "os-other",
            },
          ])
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    const field = screen.getByLabelText("Message team");
    await user.type(field, "@Ma");
    await user.click(screen.getByRole("button", { name: /@Maya.*Keep filters when navigating/ }));
    await user.clear(field);
    await user.type(field, "@Ma");
    await user.click(screen.getByRole("button", { name: /@Maya.*Improve search results/ }));
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0].mentionActorIds).toEqual(["maya-b"]);
  });

  it("retains the explicit mention while typing ordinary text after it", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/presence") ? response(mayaParticipants()) : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseMaya(user, tasks[0].title);
    await user.type(screen.getByLabelText("Message team"), "thanks for checking");
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0].mentionActorIds).toEqual(["maya-a"]);
  });

  it.each(["partial edit", "removal"])(
    "drops a mention identity after %s of its displayed token",
    async (edit) => {
      const fallback = handler;
      handler = async (url, init) =>
        url.endsWith("/presence") ? response(mayaParticipants()) : fallback(url, init);
      const user = userEvent.setup();
      setup();
      await join(user);
      await chooseMaya(user, tasks[0].title);
      const field = screen.getByLabelText("Message team") as HTMLTextAreaElement;
      await user.click(field);
      field.setSelectionRange(edit === "removal" ? 0 : 2, edit === "removal" ? 6 : 3);
      fireEvent.select(field);
      await user.keyboard(edit === "removal" ? "{Backspace}No mention remains" : "x");
      await user.click(screen.getByRole("button", { name: "Send", exact: true }));
      await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
      expect(submissions("/commands")[0]).not.toHaveProperty("mentionActorIds");
    }
  );

  it("replaces identity when another actor is chosen over identical selected mention text", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/presence") ? response(mayaParticipants()) : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseMaya(user, tasks[0].title);
    const field = screen.getByLabelText("Message team") as HTMLTextAreaElement;
    await user.click(field);
    field.setSelectionRange(0, 5);
    fireEvent.select(field);
    await user.click(screen.getByRole("button", { name: /@Maya.*Improve search results/ }));
    expect(field).toHaveValue("@Maya ");
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0].mentionActorIds).toEqual(["maya-b"]);
  });

  it.each(["first", "second"])(
    "preserves the other actor when the %s of two identical-name mentions is deleted",
    async (removed) => {
      const fallback = handler;
      handler = async (url, init) =>
        url.endsWith("/presence") ? response(mayaParticipants()) : fallback(url, init);
      const user = userEvent.setup();
      setup();
      await join(user);
      await chooseMaya(user, tasks[0].title);
      await chooseMaya(user, tasks[1].title);
      const field = screen.getByLabelText("Message team") as HTMLTextAreaElement;
      expect(field).toHaveValue("@Maya @Maya ");
      await user.click(field);
      field.setSelectionRange(removed === "first" ? 0 : 6, removed === "first" ? 6 : 12);
      fireEvent.select(field);
      await user.keyboard("{Backspace}");
      expect(field).toHaveValue("@Maya ");
      await user.click(screen.getByRole("button", { name: "Send", exact: true }));
      await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
      expect(submissions("/commands")[0].mentionActorIds).toEqual([
        removed === "first" ? "maya-b" : "maya-a",
      ]);
    }
  );

  it.each(["AnnSmith", "Ann Smith"])(
    "does not mention Ann when the selected person is %s",
    async (name) => {
      const fallback = handler;
      handler = async (url, init) =>
        url.endsWith("/presence")
          ? response([
              people[0],
              { ...people[1], actorId: "ann", displayName: "Ann" },
              {
                ...people[1],
                actorId: "ann-smith",
                clientId: "ann-smith-browser",
                displayName: name,
              },
            ])
          : fallback(url, init);
      const user = userEvent.setup();
      setup();
      await join(user);
      await user.type(screen.getByLabelText("Message team"), "@Ann");
      await user.click(screen.getByRole("button", { name: "@" + name, exact: true }));
      await user.click(screen.getByRole("button", { name: "Send", exact: true }));
      await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
      expect(submissions("/commands")[0].mentionActorIds).toEqual(["ann-smith"]);
    }
  );

  it("distinguishes identical suggestion contexts without inserting identifiers into the message", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/presence")
        ? response(mayaParticipants().map((person) => ({ ...person, taskId: "os-task" })))
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await user.type(screen.getByLabelText("Message team"), "@Ma");
    await user.click(screen.getByRole("button", { name: /@Maya.*maya-b/ }));
    expect(screen.getByLabelText("Message team")).toHaveValue("@Maya ");
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0]).toMatchObject({
      content: "@Maya",
      mentionActorIds: ["maya-b"],
    });
  });

  it("conservatively drops identities when a value replacement has no before-edit input range", async () => {
    const fallback = handler;
    handler = async (url, init) =>
      url.endsWith("/presence") ? response(mayaParticipants()) : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await join(user);
    await chooseMaya(user, tasks[0].title);
    await chooseMaya(user, tasks[1].title);
    const field = screen.getByLabelText("Message team") as HTMLTextAreaElement;
    await user.click(field);
    fireEvent.change(field, { target: { value: "@Maya " } });
    await user.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(submissions("/commands")).toHaveLength(1));
    expect(submissions("/commands")[0]).not.toHaveProperty("mentionActorIds");
  });
});
