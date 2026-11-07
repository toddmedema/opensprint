import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollaborationControl } from "./CollaborationControl";
import type { CollaborationSessionState } from "./useCollaborationSession";

type Request = NonNullable<NonNullable<CollaborationSessionState["run"]>["request"]>;
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});
function sessionFor(
  options: {
    role?: "viewer" | "participant" | "controller";
    actorId?: string;
    controllerId?: string | null;
    attemptId?: string;
    supported?: boolean;
    request?: Request;
  } = {}
) {
  const attemptId = options.attemptId ?? "attempt-one";
  return {
    principal: { actorId: options.actorId ?? "alice", role: options.role ?? "controller" },
    activeRun: { attemptId, attempt: 1, supported: options.supported ?? true, reason: null },
    run: {
      runId: attemptId,
      controllerId: "controllerId" in options ? options.controllerId : "alice",
      revision: 7,
      request: options.request,
    },
    presence: {
      data: [
        { actorId: "alice", displayName: "Alice", role: "controller" },
        { actorId: "bob", displayName: "Bob", role: "controller" },
      ],
    },
    command: { mutate: vi.fn(), isPending: false, error: null },
    history: { data: [] },
    client: { guidance: vi.fn(async () => ({ delivered: true })) },
    invalidate: vi.fn(async () => {}),
  } as unknown as CollaborationSessionState;
}
function mount(session: CollaborationSessionState, initialDrafts: Record<string, string> = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  clients.push(client);
  const submitted = vi.fn();
  const opened = vi.fn();
  function Harness({ value, request = 0 }: { value: CollaborationSessionState; request?: number }) {
    const [drafts, setDrafts] = useState(initialDrafts);
    const [identities, setIdentities] = useState<
      Record<string, { payload: string; id: string } | undefined>
    >({});
    return (
      <CollaborationControl
        session={value}
        taskId="os-task"
        drafts={drafts}
        identities={identities}
        onIdentity={(attemptId, identity) =>
          setIdentities((previous) => ({ ...previous, [attemptId]: identity }))
        }
        onSubmissionResult={(input, delivered) => {
          submitted(input, delivered);
          setIdentities((previous) => ({ ...previous, [input.attemptId]: undefined }));
          if (delivered)
            setDrafts((previous) => ({
              ...previous,
              [input.attemptId]:
                previous[input.attemptId] === input.content ? "" : previous[input.attemptId],
            }));
        }}
        onDraft={(attemptId, content) =>
          setDrafts((previous) => ({ ...previous, [attemptId]: content }))
        }
        actorName={(actorId) => ({ alice: "Alice", bob: "Bob" })[actorId] ?? actorId}
        guidanceRequest={request}
        onOpenChange={opened}
      />
    );
  }
  const tree = (value: CollaborationSessionState, request = 0) => (
    <QueryClientProvider client={client}>
      <Harness value={value} request={request} />
    </QueryClientProvider>
  );
  const result = render(tree(session));
  return {
    ...result,
    submitted,
    opened,
    update: (value: CollaborationSessionState, request = 0) =>
      result.rerender(tree(value, request)),
  };
}

describe("focused agent guidance", () => {
  it("omits the idle guidance row when there is no active run or recoverable draft", () => {
    const session = { ...sessionFor(), activeRun: null, run: undefined };
    mount(session);
    expect(screen.queryByRole("region", { name: "Agent guidance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guide agent…" })).not.toBeInTheDocument();
  });

  it("keeps an ended attempt's unsent draft recoverable without allowing a send", async () => {
    const session = { ...sessionFor(), activeRun: null, run: undefined };
    const user = userEvent.setup();
    mount(session, { "attempt-one": "Retain the old instruction draft" });
    await user.click(screen.getByRole("button", { name: "Guide agent…" }));
    await user.click(screen.getByText("Earlier drafts"));
    expect(screen.getByText("Retain the old instruction draft")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
    expect(session.client.guidance).not.toHaveBeenCalled();
  });

  it("keeps ownership and instructions compact until the user explicitly opens and sends", async () => {
    const session = sessionFor();
    const user = userEvent.setup();
    mount(session);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release control" })).not.toBeVisible();
    expect(screen.getByRole("button", { name: /Offer control/ })).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Guide agent…" }));
    const dialog = screen.getByRole("dialog", { name: "Guide agent" });
    expect(session.client.guidance).not.toHaveBeenCalled();
    await user.type(
      within(dialog).getByRole("textbox", { name: "Guide the active agent" }),
      "Cover back navigation"
    );
    await user.click(within(dialog).getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(session.client.guidance).toHaveBeenCalledTimes(1));
    expect(session.client.guidance).toHaveBeenCalledWith(
      {
        taskId: "os-task",
        attemptId: "attempt-one",
        content: "Cover back navigation",
        clientMessageId: expect.any(String),
      },
      expect.anything()
    );
    await screen.findByText("Queued for the next agent turn.");
  });

  it.each([
    { controllerId: null, button: "Take control", type: "claim_control" },
    { controllerId: "bob", button: "Request control", type: "request_control" },
  ])(
    "shows $button only after an instruction is requested",
    async ({ controllerId, button, type }) => {
      const session = sessionFor({ controllerId });
      const user = userEvent.setup();
      mount(session);
      expect(screen.queryByRole("button", { name: button })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Guide agent…" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: button }));
      expect(session.command.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          type,
          taskId: "os-task",
          runId: "attempt-one",
          expectedRevision: 7,
          ...(type === "request_control" ? { targetActorId: "alice" } : {}),
        })
      );
      expect(session.client.guidance).not.toHaveBeenCalled();
    }
  );

  it("offers control from the ownership menu without bypassing consent", async () => {
    const session = sessionFor();
    const user = userEvent.setup();
    mount(session);
    await user.click(screen.getByLabelText("Agent control options"));
    await user.click(screen.getByRole("button", { name: "Offer control to Bob" }));
    expect(session.command.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "request_control",
        targetActorId: "bob",
        taskId: "os-task",
        runId: "attempt-one",
        expectedRevision: 7,
      })
    );
    expect(session.client.guidance).not.toHaveBeenCalled();
  });

  it("dismisses ownership actions with Escape before the workspace handles it", async () => {
    const user = userEvent.setup();
    mount(sessionFor());
    const summary = screen.getByLabelText("Agent control options");
    const menu = summary.closest("details")!;
    await user.click(summary);
    expect(menu).toHaveAttribute("open");
    const outerEscape = vi.fn();
    document.addEventListener("keydown", outerEscape);
    try {
      await user.keyboard("{Escape}");
      expect(menu).not.toHaveAttribute("open");
      expect(summary).toHaveFocus();
      expect(outerEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outerEscape);
    }
  });

  it("dismisses ownership actions on selection and outside focus without sending guidance", async () => {
    const session = sessionFor();
    const user = userEvent.setup();
    const result = mount(session);
    const summary = screen.getByLabelText("Agent control options");
    const menu = summary.closest("details")!;
    await user.click(summary);
    await waitFor(() => expect(result.opened).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole("button", { name: "Offer control to Bob" }));
    expect(menu).not.toHaveAttribute("open");
    expect(session.command.mutate).toHaveBeenCalledTimes(1);
    await user.click(summary);
    const guide = screen.getByRole("button", { name: "Guide agent…" });
    guide.focus();
    expect(guide).toHaveFocus();
    expect(menu).not.toHaveAttribute("open");
    expect(session.client.guidance).not.toHaveBeenCalled();
  });

  it("only presents handoff decisions when a request needs this person's response", async () => {
    const session = sessionFor({
      request: { requestedBy: "bob", targetActorId: "bob", createdAt: "2026-11-07T00:00:00Z" },
    });
    const user = userEvent.setup();
    mount(session);
    await user.click(screen.getByRole("button", { name: "Accept handoff" }));
    expect(session.command.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "respond_control",
        accept: true,
        expectedRevision: 7,
        taskId: "os-task",
        runId: "attempt-one",
      })
    );
  });

  it("opens a prepared draft without sending and closes instead of retargeting a new attempt", async () => {
    const session = sessionFor();
    const user = userEvent.setup();
    const result = mount(session, { "attempt-one": "A teammate's prepared instruction" });
    result.update(session, 1);
    const dialog = await screen.findByRole("dialog", { name: "Guide agent" });
    expect(within(dialog).getByRole("textbox")).toHaveValue("A teammate's prepared instruction");
    expect(session.client.guidance).not.toHaveBeenCalled();
    expect(result.opened).toHaveBeenLastCalledWith(true);
    const next = sessionFor({ attemptId: "attempt-two" });
    result.update(next, 1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(result.opened).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Guide agent…" }));
    expect(within(screen.getByRole("dialog")).getByRole("textbox")).toHaveValue("");
    await user.click(screen.getByText("Earlier drafts"));
    expect(screen.getByText("A teammate's prepared instruction")).toBeVisible();
    expect(next.client.guidance).not.toHaveBeenCalled();
  });

  it("preserves retry identity after uncertain delivery and creates a new identity for edited text", async () => {
    const session = sessionFor();
    const send = vi.mocked(session.client.guidance);
    send.mockRejectedValueOnce(new Error("Delivery uncertain"));
    const user = userEvent.setup();
    mount(session);
    await user.click(screen.getByRole("button", { name: "Guide agent…" }));
    const input = screen.getByRole("textbox");
    await user.type(input, "Preserve these filters");
    await user.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0].clientMessageId).toBe(send.mock.calls[0][0].clientMessageId);
    await waitFor(() => expect(input).toHaveValue(""));
    await user.type(input, "Use the URL instead");
    await user.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2][0].clientMessageId).not.toBe(send.mock.calls[1][0].clientMessageId);
  });

  it("closes the instruction sheet when authority changes and never submits from read-only access", async () => {
    const session = sessionFor();
    const user = userEvent.setup();
    const result = mount(session);
    await user.click(screen.getByRole("button", { name: "Guide agent…" }));
    result.update(sessionFor({ role: "participant" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guide agent…" })).not.toBeInTheDocument();
    expect(session.client.guidance).not.toHaveBeenCalled();
  });

  it("dismisses with Escape and restores focus to the guide action", async () => {
    const user = userEvent.setup();
    mount(sessionFor());
    const trigger = screen.getByRole("button", { name: "Guide agent…" });
    await user.click(trigger);
    expect(screen.getByRole("heading", { name: "Guide agent" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("explains unsupported guidance only when opened", async () => {
    const user = userEvent.setup();
    const session = sessionFor({ supported: false });
    mount(session);
    await user.click(screen.getByRole("button", { name: "Guide agent…" }));
    expect(screen.getByRole("status")).toHaveTextContent("Live guidance is unavailable");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to agent" })).not.toBeInTheDocument();
    expect(session.client.guidance).not.toHaveBeenCalled();
  });
});
