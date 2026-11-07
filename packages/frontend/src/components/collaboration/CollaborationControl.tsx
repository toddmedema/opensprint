import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CollaborationCommand, CollaborationPresence } from "@opensprint/shared";
import { useModalA11y } from "../../hooks/useModalA11y";
import type { CollaborationSessionState } from "./useCollaborationSession";

/** Translate durable receipt dispositions without implying that a model obeyed the guidance. */
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

/**
 * Keep agent ownership quiet until an instruction or handoff needs a decision.
 * Opening the sheet never sends guidance; drafts and retries remain bound to their attempt.
 */
export function CollaborationControl({
  session,
  taskId,
  drafts,
  identities,
  onIdentity,
  onSubmissionResult,
  onDraft,
  actorName,
  guidanceRequest = 0,
  onOpenChange,
}: {
  session: CollaborationSessionState;
  taskId: string | null;
  drafts: Record<string, string>;
  identities: Record<string, { payload: string; id: string } | undefined>;
  onIdentity: (attemptId: string, identity: { payload: string; id: string } | undefined) => void;
  onSubmissionResult: (
    input: { attemptId: string; clientMessageId: string; content: string },
    delivered: boolean
  ) => void;
  onDraft: (attemptId: string, content: string) => void;
  actorName: (actorId: string) => string;
  /** Increment when a contextual message action prepares, rather than submits, an instruction. */
  guidanceRequest?: number;
  /** Pause discussion read acknowledgments while control actions or the instruction sheet cover it. */
  onOpenChange?: (open: boolean) => void;
}) {
  const id = useId();
  const { activeRun: active, run, principal } = session;
  const [sheetTarget, setSheetTarget] = useState<{
    taskId: string;
    attemptId: string | null;
  } | null>(null);
  const previousRequest = useRef(guidanceRequest);
  const ownershipMenuRef = useRef<HTMLDetailsElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const reportedOpen = useRef(false);
  const reportOpen = useCallback((open: boolean) => {
    if (reportedOpen.current === open) return;
    reportedOpen.current = open;
    onOpenChangeRef.current?.(open);
  }, []);
  const closeSheet = useCallback(() => {
    setSheetTarget(null);
    reportOpen(false);
  }, [reportOpen]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [receipt, setReceipt] = useState<{ attemptId: string; text: string } | null>(null);
  const mayControl = principal?.role === "controller";
  const ownsControl = mayControl && run?.controllerId === principal?.actorId;
  const sheetOpen = Boolean(
    mayControl &&
    sheetTarget &&
    sheetTarget.taskId === taskId &&
    sheetTarget.attemptId === (active?.attemptId ?? null)
  );
  const closeOwnershipMenu = useCallback(() => {
    if (ownershipMenuRef.current) ownershipMenuRef.current.open = false;
    reportOpen(sheetOpen);
  }, [reportOpen, sheetOpen]);
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      const menu = ownershipMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target))
        closeOwnershipMenu();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [closeOwnershipMenu]);
  useEffect(() => {
    closeOwnershipMenu();
  }, [taskId, active?.attemptId, principal?.role, run?.controllerId, closeOwnershipMenu]);
  const openSheet = () => {
    if (taskId && mayControl) {
      setSheetTarget({ taskId, attemptId: active?.attemptId ?? null });
      reportOpen(true);
    }
  };
  useEffect(() => {
    if (previousRequest.current === guidanceRequest) return;
    previousRequest.current = guidanceRequest;
    if (guidanceRequest > 0 && taskId && mayControl) {
      setSheetTarget({ taskId, attemptId: active?.attemptId ?? null });
      reportOpen(true);
    }
  }, [guidanceRequest, taskId, mayControl, active?.attemptId, reportOpen]);
  useEffect(() => {
    if (sheetTarget && !sheetOpen) closeSheet();
  }, [sheetTarget, sheetOpen, closeSheet]);
  useEffect(() => () => reportOpen(false), [reportOpen]);
  useModalA11y({
    containerRef: dialogRef,
    initialFocusRef: headingRef,
    triggerRef,
    isOpen: sheetOpen,
    onClose: closeSheet,
  });
  const steering = useMutation({
    gcTime: 0,
    mutationFn: session.client.guidance,
    onSuccess: (result, input) => {
      onSubmissionResult(input, result.delivered);
      setReceipt({
        attemptId: input.attemptId,
        text: result.delivered
          ? "Queued for the next agent turn."
          : (result.error ?? "Guidance was not queued."),
      });
      void session.invalidate();
    },
  });
  const request = run?.request;
  const canRespond =
    mayControl &&
    request &&
    ((request.requestedBy === run?.controllerId && request.targetActorId === principal?.actorId) ||
      (request.requestedBy === request.targetActorId && run?.controllerId === principal?.actorId));
  const canCancel = mayControl && request?.requestedBy === principal?.actorId;
  const canReclaim =
    mayControl && principal?.actorId === "local-user" && run?.controllerId && !ownsControl;
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
  /** Bind every control mutation to the currently displayed task, attempt and revision. */
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
    closeOwnershipMenu();
    if (!active || !taskId || !mayControl) return;
    session.command.mutate({
      ...command,
      taskId,
      runId: active.attemptId,
      expectedRevision: run?.revision ?? 0,
      commandId: crypto.randomUUID(),
    } as CollaborationCommand);
  };
  const content = active ? (drafts[active.attemptId] ?? "") : "";
  const earlierDrafts = Object.entries(drafts).filter(
    ([attemptId, value]) => attemptId !== active?.attemptId && value.trim()
  );
  const ownerLabel = active
    ? run?.controllerId
      ? `${actorName(run.controllerId)} is guiding`
      : "Agent working"
    : "No active agent";
  const requestNotice = request && (canRespond || canCancel) && (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <p className="min-w-0 flex-1">
        {actorName(request.requestedBy)} requested control for {actorName(request.targetActorId)}.
      </p>
      {canRespond && (
        <>
          <button
            type="button"
            className="btn-primary min-h-11 text-xs"
            disabled={session.command.isPending}
            onClick={() => sendControl({ type: "respond_control", accept: true })}
          >
            Accept handoff
          </button>
          <button
            type="button"
            className="btn-secondary min-h-11 text-xs"
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
          className="btn-secondary min-h-11 text-xs"
          disabled={session.command.isPending}
          onClick={() => sendControl({ type: "cancel_control_request" })}
        >
          Cancel request
        </button>
      )}
    </div>
  );
  if (!taskId || (!active && (!mayControl || earlierDrafts.length === 0))) return null;
  return (
    <section aria-label="Agent guidance" className="space-y-2">
      <div className="flex min-h-11 items-center justify-between gap-2">
        {active && mayControl && (ownsControl || canReclaim) ? (
          <details
            ref={ownershipMenuRef}
            className="relative min-w-0 text-xs text-theme-muted"
            onToggle={(event) => reportOpen(event.currentTarget.open || sheetOpen)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) closeOwnershipMenu();
            }}
            onKeyDownCapture={(event) => {
              if (event.key !== "Escape" || !event.currentTarget.open) return;
              event.preventDefault();
              event.stopPropagation();
              closeOwnershipMenu();
              event.currentTarget.querySelector("summary")?.focus();
            }}
          >
            <summary
              className="min-h-11 cursor-pointer truncate py-3"
              aria-label="Agent control options"
              onClick={(event) => event.currentTarget.focus()}
            >
              {ownerLabel}
            </summary>
            <div className="absolute left-0 top-full z-20 mt-2 min-w-52 space-y-1 rounded-lg border border-theme-border bg-theme-bg p-2 shadow-lg">
              {ownsControl && (
                <>
                  {!request &&
                    controllers.map((person) => (
                      <button
                        key={person.actorId}
                        type="button"
                        className="block min-h-11 w-full rounded px-3 py-2 text-left hover:bg-theme-surface-muted"
                        disabled={session.command.isPending}
                        onClick={() =>
                          sendControl({ type: "request_control", targetActorId: person.actorId })
                        }
                      >
                        Offer control to {person.displayName}
                      </button>
                    ))}
                  <button
                    type="button"
                    className="block min-h-11 w-full rounded px-3 py-2 text-left hover:bg-theme-surface-muted"
                    disabled={session.command.isPending}
                    onClick={() => sendControl({ type: "handoff_control", targetActorId: null })}
                  >
                    Release control
                  </button>
                </>
              )}
              {canReclaim && (
                <button
                  type="button"
                  className="block min-h-11 w-full rounded px-3 py-2 text-left hover:bg-theme-surface-muted"
                  disabled={session.command.isPending}
                  onClick={() => sendControl({ type: "reclaim_control" })}
                >
                  Reclaim control
                </button>
              )}
            </div>
          </details>
        ) : (
          <p className="min-w-0 truncate text-xs text-theme-muted">{ownerLabel}</p>
        )}
        {mayControl && (
          <button
            ref={triggerRef}
            type="button"
            className="min-h-11 shrink-0 rounded-md px-2 py-2 text-xs font-medium text-theme-link hover:bg-theme-surface-muted disabled:opacity-50"
            disabled={!active && earlierDrafts.length === 0}
            onClick={openSheet}
          >
            Guide agent…
          </button>
        )}
      </div>
      {!sheetOpen && requestNotice}
      {sheetOpen && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-title`}
            tabIndex={-1}
            className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-xl border border-theme-border bg-theme-bg p-5 text-theme-text shadow-xl"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <h2 ref={headingRef} id={`${id}-title`} tabIndex={-1} className="font-semibold">
                Guide agent
              </h2>
              <button
                type="button"
                className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-theme-muted hover:bg-theme-surface-muted"
                aria-label="Close agent guidance"
                onClick={closeSheet}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <div className="space-y-4">
              {!active ? (
                <p className="text-sm text-theme-muted">There is no active agent for this task.</p>
              ) : !active.supported ? (
                <p role="status" className="text-sm text-theme-muted">
                  {active.reason ||
                    "This agent supports viewing only. Live guidance is unavailable."}
                </p>
              ) : !ownsControl ? (
                <div className="space-y-3">
                  <p className="text-sm text-theme-muted">
                    {run?.controllerId
                      ? `${actorName(run.controllerId)} is guiding. Request control to send an instruction.`
                      : "Take control to send an instruction."}
                  </p>
                  {!run?.controllerId ? (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={session.command.isPending}
                      onClick={() => sendControl({ type: "claim_control" })}
                    >
                      Take control
                    </button>
                  ) : !request ? (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={session.command.isPending}
                      onClick={() =>
                        sendControl({
                          type: "request_control",
                          targetActorId: principal!.actorId,
                        })
                      }
                    >
                      Request control
                    </button>
                  ) : null}
                </div>
              ) : (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!content.trim() || steering.isPending || !taskId || !sheetOpen) return;
                    const payload = JSON.stringify([taskId, active.attemptId, content.trim()]);
                    const identity =
                      identities[active.attemptId]?.payload === payload
                        ? identities[active.attemptId]!
                        : { payload, id: crypto.randomUUID() };
                    onIdentity(active.attemptId, identity);
                    steering.mutate({
                      taskId,
                      attemptId: active.attemptId,
                      content: content.trim(),
                      clientMessageId: identity.id,
                    });
                  }}
                >
                  <label className="sr-only" htmlFor={`${id}-guidance`}>
                    Guide the active agent
                  </label>
                  <textarea
                    id={`${id}-guidance`}
                    className="min-h-32 w-full rounded-lg border border-theme-border bg-theme-bg p-3 text-sm"
                    value={content}
                    onChange={(event) => onDraft(active.attemptId, event.target.value)}
                    maxLength={10000}
                    disabled={steering.isPending}
                    placeholder="Add context or correct the approach…"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-theme-muted">Sent at the next agent turn.</p>
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
              {requestNotice}
              {(steering.error || session.command.error) && (
                <p role="alert" className="text-sm text-theme-error-text">
                  {(steering.error || session.command.error)?.message}
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
              {earlierDrafts.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-theme-muted">Earlier drafts</summary>
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
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
