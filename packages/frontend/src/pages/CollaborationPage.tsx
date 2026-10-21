import { useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollaborationSnapshot, CollaborationCommand } from "@opensprint/shared";
import { applyCollaborationReplay, collaborationApi } from "../api/collaboration";

function Session({ projectId, token }: { projectId: string; token?: string }) {
  const client = useMemo(() => collaborationApi(projectId, token), [projectId, token]);
  const cacheId = useMemo(() => crypto.randomUUID(), []);
  const queryKey = ["collaboration", projectId, cacheId];
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [taskInput, setTaskInput] = useState("");
  const [taskId, setTaskId] = useState("");
  const [handoff, setHandoff] = useState("");
  const [guidance, setGuidance] = useState("");
  const [receipt, setReceipt] = useState("");
  const requestIdentity = useRef<{ payload: string; id: string } | null>(null);
  const guidanceIdentity = useRef<{ payload: string; id: string } | null>(null);
  const session = useQuery({
    queryKey,
    queryFn: async () => {
      const previous = qc.getQueryData<CollaborationSnapshot>(queryKey);
      if (!previous) return client.snapshot();
      try {
        return applyCollaborationReplay(previous, await client.replay(previous.cursor));
      } catch {
        return client.snapshot();
      }
    },
    refetchInterval: 2000,
    retry: false,
    gcTime: 0,
  });
  const active = useQuery({
    queryKey: [...queryKey, "run", taskId],
    queryFn: () => client.activeRun(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 2000,
    retry: false,
    gcTime: 0,
  });
  const command = useMutation({
    mutationFn: (input: CollaborationCommand) => client.command(input),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  const history = useQuery({
    queryKey: [...queryKey, "guidance", taskId],
    queryFn: () => client.guidanceHistory(taskId),
    enabled: Boolean(taskId),
    refetchInterval: 2000,
    retry: false,
    gcTime: 0,
  });
  const steering = useMutation({
    mutationFn: client.guidance,
    onSuccess: (result) => {
      guidanceIdentity.current = null;
      setReceipt(
        result.delivered
          ? "Guidance queued. Inclusion in an agent turn is recorded in its chat history."
          : (result.error ?? "Guidance was not queued.")
      );
      if (result.delivered) setGuidance("");
    },
  });
  const data = session.data;
  const run = active.data?.control ?? data?.runs.find((r) => r.runId === active.data?.attemptId);
  const controller = run?.controllerId ?? null;
  const mayControl = data?.principal.permissions
    ? data.principal.permissions.includes("control")
    : data?.principal.role === "controller";
  const ownsControl = mayControl && controller === data?.principal.actorId;
  const error = session.error ?? active.error ?? history.error ?? command.error ?? steering.error;
  return (
    <section aria-label="Shared Execute session" className="mx-auto max-w-3xl space-y-5 p-6">
      <h1 className="text-xl font-semibold">Shared Execute session</h1>
      {error && (
        <p role="alert" className="text-theme-error-text">
          {error.message}
        </p>
      )}
      {session.isPending && <p role="status">Connecting…</p>}
      {data && (
        <>
          <p className="text-sm text-theme-muted">
            {data.principal.displayName} · {data.principal.role} ·{" "}
            {session.isFetching ? "Syncing…" : `Synced through event ${data.cursor}`}
          </p>
          <ol aria-label="Session discussion" className="max-h-80 space-y-3 overflow-y-auto">
            {data.messages.map((message) => (
              <li key={message.id} className="rounded border border-theme-border p-3">
                <p className="text-sm font-medium">
                  {message.displayName}{" "}
                  <time className="font-normal text-theme-muted" dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleTimeString()}
                  </time>
                </p>
                <p className="whitespace-pre-wrap break-words">{message.content}</p>
              </li>
            ))}
          </ol>
          {data.messagesHasMore && (
            <p className="text-sm text-theme-muted">
              Showing the latest 200 messages. Earlier messages remain in session history.
            </p>
          )}
          {(data.principal.permissions
            ? data.principal.permissions.includes("discuss")
            : data.principal.role !== "viewer") && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const content = text.trim();
                if (!content || command.isPending) return;
                if (requestIdentity.current?.payload !== content)
                  requestIdentity.current = { payload: content, id: crypto.randomUUID() };
                try {
                  await command.mutateAsync({
                    type: "append_message",
                    content,
                    commandId: requestIdentity.current.id,
                  });
                  setText("");
                  requestIdentity.current = null;
                } catch {
                  /* Preserve text and retry identity. */
                }
              }}
              className="space-y-2"
            >
              <label className="block" htmlFor="session-message">
                Discuss with participants
              </label>
              <textarea
                id="session-message"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={command.isPending}
                maxLength={10000}
                className="w-full rounded border border-theme-border bg-theme-bg p-2"
              />
              <button
                disabled={command.isPending || !text.trim()}
                type="submit"
                className="btn-primary"
              >
                Send message
              </button>
            </form>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTaskId(taskInput.trim());
              setReceipt("");
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <label>
              Task ID
              <input
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                className="ml-2 rounded border border-theme-border bg-theme-bg p-2"
              />
            </label>
            <button type="submit" disabled={!taskInput.trim()} className="btn-secondary">
              Inspect active run
            </button>
          </form>
          {taskId && active.isSuccess && !active.data && <p>No active run for this task.</p>}
          {Boolean(history.data?.length) && (
            <ol aria-label="Agent guidance history" className="max-h-64 space-y-2 overflow-y-auto">
              {history.data?.map((message) => (
                <li key={message.id} className="rounded border border-theme-border p-2">
                  <p className="text-sm text-theme-muted">
                    {message.actorId ?? "Local user"} · Attempt {message.attempt} ·{" "}
                    {message.status ?? "Recorded"}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  {message.error && (
                    <p className="text-sm text-theme-error-text">{message.error}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {active.data && (
            <div className="space-y-3 rounded border border-theme-border p-4">
              <p>
                Attempt {active.data.attempt} · Controller: {controller ?? "Unclaimed"}
              </p>
              {!active.data.supported && <p>{active.data.reason}</p>}
              {mayControl && !controller && (
                <button
                  className="btn-secondary"
                  disabled={command.isPending}
                  onClick={() =>
                    command.mutate({
                      type: "claim_control",
                      commandId: crypto.randomUUID(),
                      runId: active.data!.attemptId,
                      expectedRevision: run?.revision ?? 0,
                    })
                  }
                >
                  Take control
                </button>
              )}
              {ownsControl && (
                <>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      command.mutate({
                        type: "handoff_control",
                        commandId: crypto.randomUUID(),
                        runId: active.data!.attemptId,
                        expectedRevision: run!.revision,
                        targetActorId: handoff.trim() || null,
                      });
                    }}
                  >
                    <label>
                      Next controller’s actor ID
                      <input
                        value={handoff}
                        onChange={(e) => setHandoff(e.target.value)}
                        className="ml-2 rounded border border-theme-border bg-theme-bg p-2"
                      />
                    </label>
                    <button disabled={command.isPending} className="btn-secondary" type="submit">
                      {handoff.trim() ? "Hand over control" : "Release control"}
                    </button>
                  </form>
                  {active.data.supported && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const content = guidance.trim();
                        if (!content || steering.isPending) return;
                        const payload = JSON.stringify([active.data!.attemptId, content]);
                        if (guidanceIdentity.current?.payload !== payload)
                          guidanceIdentity.current = { payload, id: crypto.randomUUID() };
                        steering.mutate({
                          taskId,
                          attemptId: active.data!.attemptId,
                          clientMessageId: guidanceIdentity.current.id,
                          content,
                        });
                      }}
                      className="space-y-2"
                    >
                      <label htmlFor="session-guidance">Guide the active agent</label>
                      <textarea
                        id="session-guidance"
                        value={guidance}
                        onChange={(e) => setGuidance(e.target.value)}
                        disabled={steering.isPending}
                        maxLength={10000}
                        className="w-full rounded border border-theme-border bg-theme-bg p-2"
                      />
                      <button
                        type="submit"
                        className="btn-primary"
                        disabled={steering.isPending || !guidance.trim()}
                      >
                        Queue guidance
                      </button>
                    </form>
                  )}
                </>
              )}
              {receipt && <p role="status">{receipt}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** A separate entry point lets project-scoped credentials join without access to local APIs. */
function CollaborationConnection({ projectId }: { projectId: string }) {
  const [credential, setCredential] = useState("");
  const [connection, setConnection] = useState<{ token?: string; id: string } | null>(null);
  return (
    <main className="min-h-screen bg-theme-bg text-theme-text">
      {!connection ? (
        <form
          className="mx-auto max-w-lg space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            setConnection({ token: credential.trim() || undefined, id: crypto.randomUUID() });
            setCredential("");
          }}
        >
          <h1 className="text-xl font-semibold">Join shared session</h1>
          <label className="block" htmlFor="collaboration-token">
            Project access token
          </label>
          <input
            type="password"
            id="collaboration-token"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            className="w-full rounded border border-theme-border bg-theme-bg p-2"
          />
          <p className="text-sm text-theme-muted">
            Use the project token provided by your host, or leave blank to use this installation’s
            local session.
          </p>
          <button className="btn-primary" type="submit">
            Join session
          </button>
        </form>
      ) : (
        <>
          <button className="m-4 btn-secondary" onClick={() => setConnection(null)}>
            Leave session
          </button>
          <Session
            key={`${projectId}:${connection.id}`}
            projectId={projectId}
            token={connection.token}
          />
        </>
      )}
    </main>
  );
}

export function CollaborationPage() {
  const { projectId = "" } = useParams();
  return <CollaborationConnection key={projectId} projectId={projectId} />;
}
