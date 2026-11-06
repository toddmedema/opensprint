import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CollaborationCommand, CollaborationPresence } from "@opensprint/shared";
import type { CollaborationSessionState } from "./useCollaborationSession";

export function guidanceStatusLabel(status?: string): string {
  return (
    (
      {
        accepted: "Accepted",
        queued: "Queued · waiting for the next turn",
        included: "Included in agent turn",
        failed: "Failed",
        "run-ended": "Run ended before inclusion",
      } as Record<string, string>
    )[status ?? ""] ?? "Recorded"
  );
}

export function CollaborationControl({
  session,
  taskId,
  drafts,
  onDraft,
  actorName,
}: {
  session: CollaborationSessionState;
  taskId: string | null;
  drafts: Record<string, string>;
  onDraft: (attemptId: string, content: string) => void;
  actorName: (actorId: string) => string;
}) {
  const { activeRun: active, run, principal } = session;
  const [receipt, setReceipt] = useState<{ attemptId: string; text: string } | null>(null);
  const [handoff, setHandoff] = useState("");
  const guidanceIdentity = useRef<{ payload: string; id: string } | null>(null);
  const steering = useMutation({
    gcTime: 0,
    mutationFn: session.client.guidance,
    onSuccess: (result, input) => {
      guidanceIdentity.current = null;
      setReceipt({
        attemptId: input.attemptId,
        text: result.delivered
          ? "Queued · waiting for the next agent turn. Inclusion is recorded below."
          : (result.error ?? "Guidance was not queued."),
      });
      if (result.delivered) onDraft(input.attemptId, "");
      void session.invalidate();
    },
  });
  const mayControl = principal?.role === "controller";
  const ownsControl = mayControl && run?.controllerId === principal?.actorId;
  const request = run?.request;
  const canRespond =
    mayControl &&
    request &&
    ((request.requestedBy === run?.controllerId && request.targetActorId === principal?.actorId) ||
      (request.requestedBy === request.targetActorId && run?.controllerId === principal?.actorId));
  const canCancel = mayControl && request?.requestedBy === principal?.actorId;
  const controllers = Array.from(
    new Map(
      (session.presence.data ?? [])
        .filter(
          (person: CollaborationPresence) =>
            person.role === "controller" && person.actorId !== principal?.actorId
        )
        .map((person) => [person.actorId, person])
    ).values()
  );
  const sendControl = (
    command:
      | Omit<
          Extract<CollaborationCommand, { type: "claim_control" }>,
          "commandId" | "runId" | "expectedRevision"
        >
      | { type: "handoff_control"; targetActorId: null }
      | { type: "request_control"; targetActorId: string }
      | { type: "respond_control"; accept: boolean }
      | { type: "cancel_control_request" }
      | { type: "reclaim_control" }
  ) => {
    if (!active) return;
    session.command.mutate({
      ...command,
      taskId: taskId ?? undefined,
      runId: active.attemptId,
      expectedRevision: run?.revision ?? 0,
      commandId: crypto.randomUUID(),
    } as CollaborationCommand);
  };
  const content = active ? (drafts[active.attemptId] ?? "") : "";
  const earlierDrafts = Object.entries(drafts).filter(
    ([attemptId, value]) => attemptId !== active?.attemptId && value.trim()
  );
  return (
    <section aria-label="Agent guidance" className="space-y-4">
      {!taskId ? (
        <p className="text-sm text-theme-muted">Select a task to follow or guide its agent.</p>
      ) : !active ? (
        <p className="text-sm text-theme-muted">
          No active run for this task. Earlier guidance remains in history.
        </p>
      ) : (
        <>
          <div className="space-y-2 rounded-lg bg-theme-surface-muted p-3">
            <p className="text-sm font-medium">
              Attempt {active.attempt} ·{" "}
              {run?.controllerId
                ? `${actorName(run.controllerId)} is guiding this agent`
                : "No one is guiding this agent"}
            </p>
            <p className="text-xs text-theme-muted">
              Control applies to this attempt. Leaving the page keeps the agent running.
            </p>
            {mayControl && !run?.controllerId && (
              <button
                type="button"
                className="btn-secondary"
                disabled={session.command.isPending}
                onClick={() => sendControl({ type: "claim_control" })}
              >
                Take control
              </button>
            )}
            {mayControl && run?.controllerId && !ownsControl && !request && (
              <button
                type="button"
                className="btn-secondary"
                disabled={session.command.isPending}
                onClick={() =>
                  sendControl({ type: "request_control", targetActorId: principal!.actorId })
                }
              >
                Request control
              </button>
            )}
            {mayControl &&
              principal?.actorId === "local-user" &&
              run?.controllerId &&
              !ownsControl && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={session.command.isPending}
                  onClick={() => sendControl({ type: "reclaim_control" })}
                >
                  Reclaim control
                </button>
              )}
            {request && (
              <div className="space-y-2 border-t border-theme-border pt-2">
                <p className="text-sm">
                  {actorName(request.requestedBy)} requested control for{" "}
                  {actorName(request.targetActorId)}. The current controller keeps control until
                  accepted.
                </p>
                <div className="flex flex-wrap gap-2">
                  {canRespond && (
                    <>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={session.command.isPending}
                        onClick={() => sendControl({ type: "respond_control", accept: true })}
                      >
                        Accept handoff
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={session.command.isPending}
                        onClick={() => sendControl({ type: "respond_control", accept: false })}
                      >
                        Decline handoff
                      </button>
                    </>
                  )}
                  {canCancel && (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={session.command.isPending}
                      onClick={() => sendControl({ type: "cancel_control_request" })}
                    >
                      Cancel request
                    </button>
                  )}
                </div>
              </div>
            )}
            {ownsControl && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {controllers.length > 0 && !request && (
                    <>
                      <label className="sr-only" htmlFor="collaboration-next-controller">
                        Next controller
                      </label>
                      <select
                        id="collaboration-next-controller"
                        className="min-w-0 flex-1 rounded-lg border border-theme-border bg-theme-bg p-2 text-sm"
                        value={handoff}
                        onChange={(event) => setHandoff(event.target.value)}
                      >
                        <option value="">Choose a teammate</option>
                        {controllers.map((person) => (
                          <option key={person.actorId} value={person.actorId}>
                            {person.displayName}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn-secondary"
                        type="button"
                        disabled={!handoff || session.command.isPending}
                        onClick={() =>
                          sendControl({ type: "request_control", targetActorId: handoff })
                        }
                      >
                        Offer control
                      </button>
                    </>
                  )}
                  <button
                    className="btn-secondary"
                    type="button"
                    disabled={session.command.isPending}
                    onClick={() => sendControl({ type: "handoff_control", targetActorId: null })}
                  >
                    Release control
                  </button>
                </div>
              </div>
            )}
          </div>
          {!active.supported && (
            <p
              role="status"
              className="rounded-lg border border-theme-border p-3 text-sm text-theme-muted"
            >
              {active.reason ||
                "This agent backend supports viewing only. Live guidance requires an API agent."}
            </p>
          )}
          {ownsControl && active.supported && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!content.trim() || steering.isPending || !taskId) return;
                const payload = JSON.stringify([taskId, active.attemptId, content.trim()]);
                if (guidanceIdentity.current?.payload !== payload)
                  guidanceIdentity.current = { payload, id: crypto.randomUUID() };
                steering.mutate({
                  taskId,
                  attemptId: active.attemptId,
                  content: content.trim(),
                  clientMessageId: guidanceIdentity.current.id,
                });
              }}
            >
              <label className="block text-sm font-medium" htmlFor="collaboration-guidance">
                Guide the active agent
              </label>
              <textarea
                id="collaboration-guidance"
                className="min-h-24 w-full rounded-lg border border-theme-border bg-theme-bg p-3 text-sm"
                value={content}
                onChange={(event) => onDraft(active.attemptId, event.target.value)}
                maxLength={10000}
                disabled={steering.isPending}
                placeholder="Add context or correct the approach…"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-theme-muted">
                  Sent at the next agent turn · attempt {active.attempt}
                </span>
                <button
                  className="btn-primary"
                  type="submit"
                  disabled={!content.trim() || steering.isPending}
                >
                  {steering.isPending ? "Queueing…" : "Send to agent"}
                </button>
              </div>
            </form>
          )}
          {mayControl && !ownsControl && (
            <p className="text-sm text-theme-muted">
              Claim or request control to send agent guidance.
            </p>
          )}
        </>
      )}
      {earlierDrafts.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-theme-muted">
            Drafts from earlier attempts
          </summary>
          {earlierDrafts.map(([attemptId, value]) => (
            <pre
              key={attemptId}
              className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-theme-surface-muted p-3 font-sans"
            >
              {value}
            </pre>
          ))}
        </details>
      )}
      {steering.error && (
        <p role="alert" className="text-sm text-theme-error-text">
          {steering.error.message}
        </p>
      )}
      {receipt && (
        <p role="status" className="text-sm text-theme-muted">
          {receipt.text}
          {receipt.attemptId !== active?.attemptId
            ? " This receipt belongs to an earlier attempt."
            : ""}
        </p>
      )}
      {Boolean(session.history.data?.length) && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Guidance history</h3>
          <ol aria-label="Agent guidance history" className="space-y-2">
            {session.history.data?.map((message) => (
              <li key={message.id} className="rounded-lg border border-theme-border p-3">
                <p className="text-xs text-theme-muted">
                  {actorName(message.actorId ?? "local-user")} · Attempt {message.attempt} ·{" "}
                  {guidanceStatusLabel(message.status)}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.content}</p>
                {message.error && (
                  <p className="mt-1 text-xs text-theme-error-text">{message.error}</p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
