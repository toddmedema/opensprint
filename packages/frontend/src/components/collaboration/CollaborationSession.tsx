import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  CollaborationContext,
  CollaborationMessage,
  CollaborationPresence,
} from "@opensprint/shared";
import { useCollaborationSession, isCollaborationAccessError } from "./useCollaborationSession";
import { CollaborationControl } from "./CollaborationControl";
import { CollaborationInvites, collaborationRoleLabels } from "./CollaborationInvites";
import { CollaborationActivity } from "./CollaborationActivity";

type Tab = "discussion" | "agent" | "changes" | "activity";
const tabs: { id: Tab; label: string }[] = [
  { id: "discussion", label: "Discussion" },
  { id: "agent", label: "Agent" },
  { id: "changes", label: "Changes" },
  { id: "activity", label: "Activity" },
];
const fieldClass =
  "w-full min-w-0 rounded-lg border border-theme-border bg-theme-bg p-2 text-sm text-theme-text";

export interface CollaborationSessionProps {
  projectId: string;
  token?: string;
  selectedTaskId?: string | null;
  onSelectTaskId?: (taskId: string | null) => void;
  onLeave?: () => void;
  embedded?: boolean;
  initialInvite?: boolean;
}

export function CollaborationSession({
  projectId,
  token,
  selectedTaskId,
  onSelectTaskId,
  onLeave,
  embedded = false,
  initialInvite = false,
}: CollaborationSessionProps) {
  const id = useId();
  const [localTaskId, setLocalTaskId] = useState<string | null>(
    () => selectedTaskId ?? new URLSearchParams(window.location.search).get("task")
  );
  const [follow, setFollow] = useState<CollaborationPresence | null>(null);
  const [followTaskId, setFollowTaskId] = useState<string | null>(null);
  const taskId = follow
    ? followTaskId
    : selectedTaskId !== undefined
      ? selectedTaskId
      : localTaskId;
  const session = useCollaborationSession(projectId, token, taskId);
  const [tab, setTab] = useState<Tab>("discussion");
  const [inviteView, setInviteView] = useState(initialInvite);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [contexts, setContexts] = useState<Record<string, CollaborationContext | undefined>>({});
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [mentions, setMentions] = useState<Record<string, string[]>>({});
  const [guidanceDrafts, setGuidanceDrafts] = useState<Record<string, Record<string, string>>>({});
  const [contextView, setContextView] = useState<"diff" | "output">("diff");
  const [commentFile, setCommentFile] = useState("");
  const [commentLine, setCommentLine] = useState(1);
  const requestIdentity = useRef<{ payload: string; id: string } | null>(null);
  const discussionRef = useRef<HTMLTextAreaElement>(null);
  const scope = taskId ?? "project";
  const text = drafts[scope] ?? "";
  const source = contexts[scope];
  const data = session.snapshot.data;
  const principal = session.principal;
  const mayDiscuss = principal && principal.role !== "viewer";
  const mayGuide = principal?.role === "controller";
  const people = useMemo(
    () =>
      Array.from(
        new Map(
          [...(session.presence.data ?? [])]
            .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))
            .map((person) => [person.actorId, person])
        ).values()
      ),
    [session.presence.data]
  );
  const actorName = (actorId: string) =>
    actorId === principal?.actorId
      ? `${principal.displayName} (you)`
      : (people.find((person) => person.actorId === actorId)?.displayName ??
        data?.messages.find((message) => message.actorId === actorId)?.displayName ??
        (actorId === "local-user" ? "Local user" : actorId));
  const task =
    session.overview.data?.tasks.find((item) => item.id === taskId) ?? session.context.data?.task;
  const messages =
    data?.messages.filter((message) => (taskId ? message.taskId === taskId : !message.taskId)) ??
    [];
  const subscribed = Boolean(
    taskId && session.preferences.data?.subscribedTaskIds.includes(taskId)
  );
  const unread = session.notifications.data?.length ?? 0;
  const contextData = session.context.data;
  const files = useMemo(
    () =>
      Array.from(
        new Set(
          [...(contextData?.diff ?? "").matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1])
        )
      ),
    [contextData?.diff]
  );
  const accessError = isCollaborationAccessError(session.snapshot.error)
    ? session.snapshot.error
    : null;
  const previousSelection = useRef(selectedTaskId);
  useEffect(() => {
    if (selectedTaskId !== previousSelection.current) {
      previousSelection.current = selectedTaskId;
      setFollow(null);
      setFollowTaskId(null);
    }
  }, [selectedTaskId]);
  useEffect(() => {
    setInviteView(initialInvite);
  }, [initialInvite]);
  useEffect(() => {
    if (!follow) return;
    const live = session.presence.data?.find((person) => person.clientId === follow.clientId);
    if (live) setFollowTaskId(live.taskId);
  }, [follow, session.presence.data]);
  const selectTask = (next: string | null) => {
    setFollow(null);
    setFollowTaskId(null);
    setLocalTaskId(next);
    onSelectTaskId?.(next);
  };
  const openDiscussion = (context: CollaborationContext, nextTask?: string) => {
    const targetTask = nextTask ?? taskId;
    if (nextTask && nextTask !== taskId) selectTask(nextTask);
    setContexts((previous) => ({ ...previous, [targetTask ?? "project"]: context }));
    setInviteView(false);
    setTab("discussion");
    window.requestAnimationFrame(() => discussionRef.current?.focus());
  };
  const sourceContext = (
    kind: CollaborationContext["kind"],
    label: string
  ): CollaborationContext => ({
    kind,
    label,
    ...(contextData?.sourceAttemptId ? { attemptId: contextData.sourceAttemptId } : {}),
    ...(contextData?.sourceAttempt ? { attempt: contextData.sourceAttempt } : {}),
    ...(contextData?.diffRevision ? { diffRevision: contextData.diffRevision } : {}),
  });
  const promote = (message: CollaborationMessage) => {
    if (!taskId || !session.activeRun) return;
    const context = message.context;
    const provenance = context
      ? [
          context.label,
          context.path ? `${context.path}${context.line ? `:${context.line}` : ""}` : null,
          context.attempt ? `attempt ${context.attempt}` : null,
          context.attemptId ? `run ${context.attemptId}` : null,
          context.diffRevision ? `revision ${context.diffRevision}` : null,
          context.eventCursor ? `event ${context.eventCursor}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    const attribution = `From ${message.displayName}${provenance ? `, ${provenance}` : ""}:\n${message.content}`;
    const attemptId = session.activeRun.attemptId;
    setGuidanceDrafts((previous) => ({
      ...previous,
      [taskId]: {
        ...previous[taskId],
        [attemptId]: [previous[taskId]?.[attemptId], attribution].filter(Boolean).join("\n\n"),
      },
    }));
    setTab("agent");
  };
  if (accessError)
    return (
      <section className="space-y-3 p-5" aria-label="Collaboration access ended">
        <h2 className="text-lg font-semibold">Access to this project ended</h2>
        <p role="alert" className="text-sm text-theme-error-text">
          {accessError.message}
        </p>
        {onLeave && (
          <button className="btn-secondary" type="button" onClick={onLeave}>
            Leave session
          </button>
        )}
      </section>
    );
  return (
    <section
      aria-label="Shared Execute session"
      className={`flex min-h-0 min-w-0 flex-col bg-theme-bg text-theme-text ${embedded ? "h-full" : "mx-auto max-w-5xl rounded-xl border border-theme-border"}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-theme-border p-4">
        <div className="min-w-0">
          <p className="text-xs text-theme-muted">
            {session.overview.data?.projectName ?? "Execute"}
          </p>
          <h1 className="mt-1 text-lg font-semibold">Collaborate</h1>
          <p className="mt-1 text-xs text-theme-muted" role="status">
            {session.snapshot.isPending
              ? "Connecting…"
              : session.error
                ? "Connection interrupted · retrying"
                : "Live"}
            {principal
              ? ` · ${principal.displayName} · ${collaborationRoleLabels[principal.role]}`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {principal?.actorId === "local-user" && (
            <button
              type="button"
              className={inviteView ? "btn-primary" : "btn-secondary"}
              onClick={() => setInviteView(!inviteView)}
              aria-expanded={inviteView}
            >
              Invite
            </button>
          )}
          {embedded && (
            <a
              className="btn-secondary"
              href={`/collaborate/${encodeURIComponent(projectId)}${taskId ? `?task=${encodeURIComponent(taskId)}` : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open collaboration in a new tab"
            >
              Open full view
            </a>
          )}
          {onLeave && (
            <button type="button" className="btn-secondary" onClick={onLeave}>
              {embedded ? "Close" : "Leave session"}
            </button>
          )}
        </div>
      </header>
      {session.error && (
        <div className="flex flex-wrap items-center gap-2 border-b border-theme-border px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 break-words text-sm text-theme-error-text">
            {session.error.message}
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void session.invalidate();
            }}
          >
            Retry connection
          </button>
        </div>
      )}
      {data && (
        <>
          <details className="border-b border-theme-border px-4 py-3">
            <summary className="cursor-pointer text-sm text-theme-muted">
              {people.length || 1} {people.length === 1 ? "person" : "people"} here
              {people.length > 0
                ? ` · ${people.map((person) => (person.actorId === principal?.actorId ? "You" : person.displayName)).join(", ")}`
                : " · You"}
            </summary>
            <ul aria-label="Participants" className="mt-3 space-y-2">
              {people.map((person) => (
                <li
                  key={person.actorId}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-theme-surface-muted text-xs"
                      aria-hidden="true"
                    >
                      {person.displayName.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 break-words text-sm">
                      {actorName(person.actorId)}
                      <span className="block text-xs text-theme-muted">
                        {collaborationRoleLabels[person.role]} ·{" "}
                        {session.overview.data?.tasks.find((item) => item.id === person.taskId)
                          ?.title ?? "Project discussion"}
                      </span>
                    </span>
                  </div>
                  {person.actorId !== principal?.actorId && (
                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={() => {
                        setFollow(person);
                        setFollowTaskId(person.taskId);
                      }}
                      aria-label={`Follow ${person.displayName}`}
                    >
                      Follow
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
          {follow && (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 border-b border-theme-border bg-theme-surface-muted px-4 py-2"
            >
              <p className="text-xs text-theme-muted">
                {session.presence.data?.some((person) => person.clientId === follow.clientId)
                  ? `Following ${follow.displayName}’s selected task`
                  : `${follow.displayName} is offline · keeping their last task`}
              </p>
              <button
                className="btn-secondary"
                type="button"
                onClick={() => {
                  setLocalTaskId(taskId);
                  onSelectTaskId?.(taskId);
                  setFollow(null);
                }}
              >
                Stop following
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2 border-b border-theme-border p-4">
            <label className="min-w-0 flex-1 text-xs text-theme-muted" htmlFor={`${id}-task`}>
              Selected task
              <select
                id={`${id}-task`}
                className={`${fieldClass} mt-1`}
                value={taskId ?? ""}
                onChange={(event) => selectTask(event.target.value || null)}
              >
                <option value="">Project discussion</option>
                {session.overview.data?.tasks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            {taskId && (
              <button
                type="button"
                className="btn-secondary"
                aria-pressed={subscribed}
                disabled={!session.preferences.data || session.savePreferences.isPending}
                onClick={() =>
                  session.savePreferences.mutate({
                    seenCursor: session.preferences.data!.seenCursor,
                    subscribedTaskIds: subscribed
                      ? session.preferences.data!.subscribedTaskIds.filter(
                          (value) => value !== taskId
                        )
                      : [...session.preferences.data!.subscribedTaskIds, taskId],
                  })
                }
              >
                {subscribed ? "Following task" : "Follow task"}
              </button>
            )}
            <p className="w-full text-xs text-theme-muted">
              {task
                ? `${task.status.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase())} · ${session.activeRun ? `Attempt ${session.activeRun.attempt}` : "No active agent"}`
                : "Discuss the project or select a task to inspect its work."}
            </p>
          </div>
          {!inviteView && (
            <div
              className="flex flex-wrap border-b border-theme-border px-2"
              role="tablist"
              aria-label="Collaboration views"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = tabs.findIndex((item) => item.id === tab);
                const next =
                  event.key === "Home"
                    ? tabs[0]
                    : event.key === "End"
                      ? tabs[tabs.length - 1]
                      : tabs[
                          (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length
                        ];
                setTab(next.id);
                document.getElementById(`${id}-${next.id}-tab`)?.focus();
              }}
            >
              {tabs.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  role="tab"
                  id={`${id}-${item.id}-tab`}
                  aria-controls={`${id}-${item.id}-panel`}
                  aria-selected={tab === item.id}
                  tabIndex={tab === item.id ? 0 : -1}
                  onClick={() => setTab(item.id)}
                  className={`min-h-11 border-b-2 px-3 py-2 text-sm ${tab === item.id ? "border-brand-500 font-medium text-brand-600" : "border-transparent text-theme-muted hover:text-theme-text"}`}
                >
                  {item.label}
                  {item.id === "activity" && unread > 0 && (
                    <span className="ml-1 rounded-full bg-theme-surface-muted px-1.5 text-xs">
                      {unread}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className={`min-h-0 min-w-0 flex-1 p-4 ${embedded ? "overflow-y-auto" : ""}`}>
            {inviteView && principal?.actorId === "local-user" ? (
              <CollaborationInvites key={projectId} session={session} projectId={projectId} />
            ) : (
              <>
                <div
                  role="tabpanel"
                  id={`${id}-discussion-panel`}
                  aria-labelledby={`${id}-discussion-tab`}
                  hidden={tab !== "discussion"}
                >
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-sm font-semibold">
                        {task ? `Team discussion · ${task.title}` : "Project discussion"}
                      </h2>
                      <p className="mt-1 text-xs text-theme-muted">
                        Messages are for teammates. Agent guidance is sent separately.
                      </p>
                    </div>
                    <ol aria-label="Session discussion" className="space-y-4">
                      {messages.map((message) => (
                        <li key={message.id} className="min-w-0 border-b border-theme-border pb-3">
                          <p className="text-sm font-medium">
                            {message.displayName}
                            <time
                              className="ml-2 text-xs font-normal text-theme-muted"
                              dateTime={message.createdAt}
                            >
                              {new Date(message.createdAt).toLocaleTimeString()}
                            </time>
                            {message.decision && (
                              <span className="ml-2 rounded bg-theme-surface-muted px-2 py-0.5 text-xs">
                                Decision
                              </span>
                            )}
                          </p>
                          {message.context && (
                            <p className="mt-1 break-words text-xs text-theme-muted">
                              On {message.context.label}
                              {message.context.attempt
                                ? ` · attempt ${message.context.attempt}`
                                : ""}
                            </p>
                          )}
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                            {message.content}
                          </p>
                          {Boolean(message.mentionActorIds?.length) && (
                            <p className="mt-1 text-xs text-theme-muted">
                              Mentioned: {message.mentionActorIds!.map(actorName).join(", ")}
                            </p>
                          )}
                          {mayGuide && taskId && session.activeRun && (
                            <button
                              type="button"
                              className="mt-2 text-xs text-theme-link underline"
                              onClick={() => promote(message)}
                            >
                              Use as agent guidance
                            </button>
                          )}
                        </li>
                      ))}
                    </ol>
                    {!messages.length && (
                      <p className="text-sm text-theme-muted">
                        Start the conversation with your teammates.
                      </p>
                    )}
                    {data.messagesHasMore && (
                      <p className="text-xs text-theme-muted">
                        Showing recent discussion. Earlier messages are available in Activity.
                      </p>
                    )}
                    {mayDiscuss ? (
                      <form
                        className="space-y-3"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          if (!text.trim() || session.command.isPending) return;
                          const input = {
                            type: "append_message" as const,
                            content: text.trim(),
                            ...(taskId ? { taskId } : {}),
                            ...(source ? { context: source } : {}),
                            ...(decisions[scope] ? { decision: true } : {}),
                            ...(mentions[scope]?.length
                              ? { mentionActorIds: mentions[scope] }
                              : {}),
                          };
                          const payload = JSON.stringify(input);
                          if (requestIdentity.current?.payload !== payload)
                            requestIdentity.current = { payload, id: crypto.randomUUID() };
                          try {
                            await session.command.mutateAsync({
                              ...input,
                              commandId: requestIdentity.current.id,
                            });
                            setDrafts((previous) => ({ ...previous, [scope]: "" }));
                            setContexts((previous) => ({ ...previous, [scope]: undefined }));
                            setMentions((previous) => ({ ...previous, [scope]: [] }));
                            setDecisions((previous) => ({ ...previous, [scope]: false }));
                            requestIdentity.current = null;
                          } catch {
                            /* Keep the draft and uncertain command identity for retry. */
                          }
                        }}
                      >
                        {source && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-theme-surface-muted p-2 text-xs">
                            <span className="min-w-0 break-words">
                              Commenting on {source.label}
                              {source.attempt ? ` · attempt ${source.attempt}` : ""}
                            </span>
                            <button
                              type="button"
                              className="text-theme-link underline"
                              onClick={() =>
                                setContexts((previous) => ({ ...previous, [scope]: undefined }))
                              }
                            >
                              Remove context
                            </button>
                          </div>
                        )}
                        <label className="block text-sm font-medium" htmlFor={`${id}-message`}>
                          Discuss with participants
                        </label>
                        <textarea
                          ref={discussionRef}
                          id={`${id}-message`}
                          className={`${fieldClass} min-h-24`}
                          value={text}
                          onChange={(event) =>
                            setDrafts((previous) => ({ ...previous, [scope]: event.target.value }))
                          }
                          maxLength={10000}
                          disabled={session.command.isPending}
                          placeholder="Discuss this work with your team…"
                        />
                        <div className="flex flex-wrap items-center gap-3">
                          <label className="inline-flex items-center gap-2 text-xs text-theme-muted">
                            <input
                              type="checkbox"
                              checked={decisions[scope] ?? false}
                              onChange={(event) =>
                                setDecisions((previous) => ({
                                  ...previous,
                                  [scope]: event.target.checked,
                                }))
                              }
                            />
                            Record as a decision
                          </label>
                          {people.filter((person) => person.actorId !== principal?.actorId).length >
                            0 && (
                            <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-theme-muted">
                              Mention
                              <select
                                className={`${fieldClass} max-w-52`}
                                value=""
                                onChange={(event) => {
                                  const actorId = event.target.value;
                                  if (actorId)
                                    setMentions((previous) => ({
                                      ...previous,
                                      [scope]: Array.from(
                                        new Set([...(previous[scope] ?? []), actorId])
                                      ),
                                    }));
                                }}
                              >
                                <option value="">Choose a teammate</option>
                                {people
                                  .filter((person) => person.actorId !== principal?.actorId)
                                  .map((person) => (
                                    <option key={person.actorId} value={person.actorId}>
                                      {person.displayName}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          )}
                        </div>
                        {Boolean(mentions[scope]?.length) && (
                          <div className="flex flex-wrap gap-2">
                            {mentions[scope].map((actorId) => (
                              <button
                                key={actorId}
                                type="button"
                                className="rounded-full bg-theme-surface-muted px-2 py-1 text-xs"
                                aria-label={`Remove mention of ${actorName(actorId)}`}
                                onClick={() =>
                                  setMentions((previous) => ({
                                    ...previous,
                                    [scope]: previous[scope].filter((value) => value !== actorId),
                                  }))
                                }
                              >
                                @{actorName(actorId)} ×
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="flex justify-end">
                          <button
                            type="submit"
                            className="btn-primary"
                            disabled={session.command.isPending || !text.trim()}
                          >
                            {session.command.isPending ? "Sending…" : "Send message"}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <p className="text-sm text-theme-muted">
                        You have view access. Ask your host for discussion or agent permissions.
                      </p>
                    )}
                  </div>
                </div>
                <div
                  role="tabpanel"
                  id={`${id}-agent-panel`}
                  aria-labelledby={`${id}-agent-tab`}
                  hidden={tab !== "agent"}
                >
                  <CollaborationControl
                    key={scope}
                    session={session}
                    taskId={taskId}
                    actorName={actorName}
                    drafts={guidanceDrafts[scope] ?? {}}
                    onDraft={(attemptId, content) =>
                      setGuidanceDrafts((previous) => ({
                        ...previous,
                        [scope]: { ...previous[scope], [attemptId]: content },
                      }))
                    }
                  />
                </div>
                <div
                  role="tabpanel"
                  id={`${id}-changes-panel`}
                  aria-labelledby={`${id}-changes-tab`}
                  hidden={tab !== "changes"}
                  className="space-y-4"
                >
                  {!taskId ? (
                    <p className="text-sm text-theme-muted">
                      Select a task to inspect its output and changes.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className={contextView === "diff" ? "btn-primary" : "btn-secondary"}
                            aria-pressed={contextView === "diff"}
                            onClick={() => setContextView("diff")}
                          >
                            Diff
                          </button>
                          <button
                            type="button"
                            className={contextView === "output" ? "btn-primary" : "btn-secondary"}
                            aria-pressed={contextView === "output"}
                            onClick={() => setContextView("output")}
                          >
                            Output
                          </button>
                        </div>
                        <span className="text-xs text-theme-muted">
                          {contextData?.source === "archived" ? "Archived" : "Live"}
                          {contextData?.sourceAttempt
                            ? ` · attempt ${contextData.sourceAttempt}`
                            : ""}
                        </span>
                      </div>
                      {session.context.isPending ? (
                        <p role="status" className="text-sm text-theme-muted">
                          Loading task context…
                        </p>
                      ) : (
                        <>
                          {contextData?.unavailableReason && (
                            <p className="text-sm text-theme-muted">
                              {contextData.unavailableReason}
                            </p>
                          )}
                          <pre
                            className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-theme-surface-muted p-3 text-xs"
                            aria-label={contextView === "diff" ? "Task diff" : "Agent output"}
                          >
                            {(contextView === "diff" ? contextData?.diff : contextData?.output) ||
                              (contextView === "diff"
                                ? "No changes available yet."
                                : "No output available yet.")}
                          </pre>
                          {(contextView === "diff"
                            ? contextData?.diffTruncated
                            : contextData?.outputTruncated) && (
                            <p className="text-xs text-theme-muted">Showing a bounded excerpt.</p>
                          )}
                          {mayDiscuss && (
                            <div className="space-y-3">
                              <button
                                type="button"
                                className="btn-secondary"
                                disabled={
                                  !contextData ||
                                  !(contextView === "diff" ? contextData.diff : contextData.output)
                                }
                                onClick={() =>
                                  openDiscussion(
                                    sourceContext(
                                      contextView === "diff" ? "diff" : "event",
                                      contextView === "diff" ? "Task diff" : "Agent output"
                                    )
                                  )
                                }
                              >
                                Discuss this {contextView}
                              </button>
                              {contextView === "diff" && files.length > 0 && (
                                <div className="space-y-2 border-t border-theme-border pt-3">
                                  <label
                                    className="block text-xs text-theme-muted"
                                    htmlFor={`${id}-file`}
                                  >
                                    Comment on a file
                                    <select
                                      id={`${id}-file`}
                                      className={`${fieldClass} mt-1`}
                                      value={files.includes(commentFile) ? commentFile : ""}
                                      onChange={(event) => setCommentFile(event.target.value)}
                                    >
                                      <option value="">Choose a changed file</option>
                                      {files.map((file) => (
                                        <option key={file} value={file}>
                                          {file}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <div className="flex flex-wrap items-end gap-2">
                                    <label
                                      className="max-w-24 text-xs text-theme-muted"
                                      htmlFor={`${id}-line`}
                                    >
                                      Line
                                      <input
                                        type="number"
                                        min={1}
                                        max={1000000}
                                        id={`${id}-line`}
                                        className={`${fieldClass} mt-1`}
                                        value={commentLine}
                                        onChange={(event) =>
                                          setCommentLine(Number(event.target.value))
                                        }
                                      />
                                    </label>
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      disabled={
                                        !files.includes(commentFile) ||
                                        !Number.isInteger(commentLine) ||
                                        commentLine < 1 ||
                                        commentLine > 1000000
                                      }
                                      onClick={() =>
                                        openDiscussion({
                                          ...sourceContext("file", `${commentFile}:${commentLine}`),
                                          path: commentFile,
                                          line: commentLine,
                                        })
                                      }
                                    >
                                      Discuss line
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
                <div
                  role="tabpanel"
                  id={`${id}-activity-panel`}
                  aria-labelledby={`${id}-activity-tab`}
                  hidden={tab !== "activity"}
                >
                  <CollaborationActivity
                    session={session}
                    actorName={actorName}
                    onTaskSelect={selectTask}
                    onDiscuss={openDiscussion}
                  />
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
