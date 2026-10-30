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
  if (token) await user.type(screen.getByLabelText("Project access token"), token);
  await user.click(screen.getByRole("button", { name: "Join session" }));
  await screen.findByRole("heading", { name: "Shared Execute session" });
  await screen.findByText(/Alice · controller/);
}
async function inspect(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Task ID"), "os-task");
  await user.click(screen.getByRole("button", { name: "Inspect active run" }));
}
beforeEach(() => {
  handler = async (url) => {
    if (url.endsWith("/snapshot"))
      return response(snapshot(url.includes("project-b") ? "project-b" : "project-a"));
    if (url.includes("/events?")) return response({ events: [], nextCursor: 0, hasMore: false });
    if (url.includes("/runs/")) return response(activeRun);
    if (url.includes("/guidance/")) return response([]);
    if (url.endsWith("/guidance")) return response({ delivered: true, status: "queued" });
    if (url.endsWith("/commands")) return response({});
    throw new Error(`Unexpected request: ${url}`);
  };
  fetchMock = vi.fn((url: string, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
  window.__OPENSPRINT_LOCAL_SESSION__ = "local-secret";
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  delete window.__OPENSPRINT_LOCAL_SESSION__;
});

describe("shared Execute session", () => {
  it("uses the named project credential without fetching local installation APIs or caching credentials", async () => {
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
  });

  it("preserves a failed discussion draft and retries uncertain acceptance with the same command identity", async () => {
    const fallback = handler;
    let submissions = 0;
    handler = async (url, init) => {
      if (url.endsWith("/commands") && ++submissions === 1)
        throw new Error("Network response lost");
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
    const commands = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/commands"));
    expect(commands).toHaveLength(2);
    expect(JSON.parse(commands[0][1].body)).toEqual(JSON.parse(commands[1][1].body));
  });

  it("hands off control of the current attempt using its authoritative revision", async () => {
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    await user.type(await screen.findByLabelText("Next controller’s actor ID"), "bob");
    await user.click(screen.getByRole("button", { name: "Hand over control" }));
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/commands"))!;
    expect(JSON.parse(init.body)).toMatchObject({
      type: "handoff_control",
      runId: "attempt-new",
      expectedRevision: 4,
      targetActorId: "bob",
    });
  });

  it("treats a new identical guidance submission after success as a new instruction", async () => {
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    const field = await screen.findByLabelText("Guide the active agent");
    await user.type(field, "Continue");
    await user.click(screen.getByRole("button", { name: "Queue guidance" }));
    await waitFor(() => expect(field).toHaveValue(""));
    await user.type(field, "Continue");
    await user.click(screen.getByRole("button", { name: "Queue guidance" }));
    await waitFor(() => expect(field).toHaveValue(""));
    const commands = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/guidance"));
    expect(commands).toHaveLength(2);
    const first = JSON.parse(commands[0][1].body);
    const second = JSON.parse(commands[1][1].body);
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.clientMessageId).not.toBe(first.clientMessageId);
  });

  it("shows persisted guidance dispositions even after the active run ends", async () => {
    const fallback = handler;
    handler = async (url, init) => {
      if (url.includes("/runs/")) return response(null);
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
    await screen.findByText("No active run for this task.");
    const history = await screen.findByRole("list", { name: "Agent guidance history" });
    expect(within(history).getByText(/alice · Attempt 1 · included/)).toBeInTheDocument();
    expect(within(history).getByText(/bob · Attempt 2 · run-ended/)).toBeInTheDocument();
    expect(within(history).getByText("Run ended before inclusion.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Queue guidance" })).not.toBeInTheDocument();
  });

  it("allows retry after a definitive queue rejection with a fresh instruction identity", async () => {
    const fallback = handler;
    let submissions = 0;
    handler = async (url, init) => {
      if (url.endsWith("/guidance") && ++submissions === 1)
        return response({ delivered: false, status: "failed", error: "Queue is full" });
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    const field = await screen.findByLabelText("Guide the active agent");
    await user.type(field, "Preserve this guidance");
    await user.click(screen.getByRole("button", { name: "Queue guidance" }));
    await screen.findByText("Queue is full");
    expect(field).toHaveValue("Preserve this guidance");
    await user.click(screen.getByRole("button", { name: "Queue guidance" }));
    await waitFor(() => expect(field).toHaveValue(""));
    const commands = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/guidance"));
    expect(JSON.parse(commands[1][1].body).clientMessageId).not.toBe(
      JSON.parse(commands[0][1].body).clientMessageId
    );
  });

  it("keeps the guidance identity stable when the acceptance response is lost", async () => {
    const fallback = handler;
    let submissions = 0;
    handler = async (url, init) => {
      if (url.endsWith("/guidance") && ++submissions === 1)
        throw new Error("Guidance response lost");
      return fallback(url, init);
    };
    const user = userEvent.setup();
    setup();
    await join(user);
    await inspect(user);
    const field = await screen.findByLabelText("Guide the active agent");
    await user.type(field, "Preserve this guidance");
    await user.click(screen.getByRole("button", { name: "Queue guidance" }));
    await screen.findByText("Guidance response lost");
    expect(field).toHaveValue("Preserve this guidance");
    await user.click(screen.getByRole("button", { name: "Queue guidance" }));
    await waitFor(() => expect(field).toHaveValue(""));
    const commands = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/guidance"));
    expect(JSON.parse(commands[1][1].body)).toEqual(JSON.parse(commands[0][1].body));
  });

  it("hides discussion and steering for a viewer whose persisted run ownership predates a role downgrade", async () => {
    const fallback = handler;
    handler = (url, init) =>
      url.endsWith("/snapshot")
        ? Promise.resolve(response(snapshot("project-a", "viewer")))
        : fallback(url, init);
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("Project access token"), "alice-project-token");
    await user.click(screen.getByRole("button", { name: "Join session" }));
    await screen.findByText(/Alice · viewer/);
    await inspect(user);
    await screen.findByText(/Attempt 2 · Controller: alice/);
    expect(screen.queryByLabelText("Discuss with participants")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Guide the active agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release control" })).not.toBeInTheDocument();
  });

  it("clears project-scoped credentials on navigation and ignores an old project's late response", async () => {
    let resolveOld!: (response: Response) => void;
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
    await screen.findByRole("heading", { name: "Join shared session" });
    await act(async () => {
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
      );
    });
    expect(screen.queryByText("Old project private message")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("project-b"))).toBe(false);
    expect(screen.getByLabelText("Project access token")).toHaveValue("");
  });
});
