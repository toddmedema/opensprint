import type { CollaborationContext, CollaborationEvent } from "@opensprint/shared";
import type { CollaborationSessionState } from "./useCollaborationSession";

export function collaborationEventLabel(
  event: CollaborationEvent,
  name: (id: string) => string
): string {
  const who = name(event.actorId);
  if ("content" in event.payload)
    return `${who}${event.payload.decision ? " recorded a decision" : " said"}: ${event.payload.content}`;
  const run = event.payload;
  if (event.type === "control_requested")
    return `${who} requested control for ${name(run.request?.targetActorId ?? event.actorId)}`;
  if (event.type === "control_request_resolved") return `${who} resolved a control request`;
  if (!run.controllerId) return `${who} released control`;
  return `${who} ${event.type === "control_claimed" ? "claimed" : "handed over"} control${event.type === "control_claimed" ? "" : ` to ${name(run.controllerId)}`}`;
}

export function CollaborationActivity({
  session,
  mode,
  onModeChange,
  actorName,
  onTaskSelect,
  onDiscuss,
}: {
  session: CollaborationSessionState;
  mode: "unread" | "history";
  onModeChange: (mode: "unread" | "history") => void;
  actorName: (id: string) => string;
  onTaskSelect: (taskId: string) => void;
  onDiscuss: (context: CollaborationContext, taskId?: string) => void;
}) {
  const events = session.activity.data?.pages.flatMap((page) => page.events) ?? [];
  const seenAt = session.preferences.data?.seenAt;
  const tasks = session.overview.data?.tasks ?? [];
  const completed = tasks.filter(
    (task) => task.completedAt && (!seenAt || new Date(task.completedAt) > new Date(seenAt))
  );
  const questions = tasks.filter((task) => task.questions?.length);
  const notifications = session.notifications.data ?? [];
  return (
    <section aria-label="Project activity" className="space-y-5">
      <div className="flex flex-wrap gap-2" aria-label="Activity range">
        <button
          type="button"
          className={mode === "unread" ? "btn-primary" : "btn-secondary"}
          aria-pressed={mode === "unread"}
          onClick={() => onModeChange("unread")}
        >
          Since last read
        </button>
        <button
          type="button"
          className={mode === "history" ? "btn-primary" : "btn-secondary"}
          aria-pressed={mode === "history"}
          onClick={() => onModeChange("history")}
        >
          Full history
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            {mode === "history"
              ? "Full project history"
              : seenAt
                ? "Since you last caught up"
                : "Project activity"}
          </h3>
          <p className="mt-1 text-xs text-theme-muted">
            {mode === "history"
              ? "Discussion and control remain available after being marked read."
              : seenAt
                ? `Last read ${new Date(seenAt).toLocaleString()}`
                : "Read updates here and mark them caught up when ready."}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={
            !session.preferences.data ||
            session.savePreferences.isPending ||
            session.activity.hasNextPage ||
            session.activity.isPending ||
            session.activity.isFetching ||
            Boolean(session.activity.error) ||
            !session.overview.data
          }
          onClick={() =>
            session.savePreferences.mutate({
              seenCursor:
                session.activity.data?.pages.at(-1)?.nextCursor ??
                session.preferences.data?.seenCursor ??
                0,
              subscribedTaskIds: session.preferences.data?.subscribedTaskIds ?? [],
              markSeen: true,
              markSeenAt: session.overview.data?.observedAt,
            })
          }
        >
          Mark caught up
        </button>
      </div>
      {notifications.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">Needs your attention</h4>
          <ul aria-label="Collaboration notifications" className="space-y-2">
            {notifications.map((notification) => (
              <li key={notification.id} className="rounded-lg border border-theme-border p-3">
                <p className="text-xs text-theme-muted">
                  {notification.kind === "mention"
                    ? "Mention"
                    : notification.kind === "control_request"
                      ? "Control request"
                      : "Following this task"}{" "}
                  · {actorName(notification.actorId)}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {notification.content}
                </p>
                {notification.taskId && (
                  <button
                    type="button"
                    className="mt-2 text-sm text-theme-link underline"
                    onClick={() => onTaskSelect(notification.taskId!)}
                  >
                    Open task
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {completed.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">Completed work</h4>
          <ul className="space-y-2">
            {completed.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="text-left text-sm text-theme-link underline"
                  onClick={() => onTaskSelect(task.id)}
                >
                  {task.title}
                </button>
                {task.summary && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-theme-muted">
                    {task.summary}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {questions.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">Unresolved questions</h4>
          <ul className="space-y-3">
            {questions.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="text-left text-sm text-theme-link underline"
                  onClick={() => onTaskSelect(task.id)}
                >
                  {task.title}
                </button>
                {task.questions?.map((question) => (
                  <p
                    key={question}
                    className="mt-1 whitespace-pre-wrap break-words text-sm text-theme-muted"
                  >
                    {question}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h4 className="mb-2 text-sm font-medium">Discussion and control</h4>
        <ol aria-label="Session activity" className="space-y-3">
          {events.map((event) => (
            <li key={event.cursor} className="border-l-2 border-theme-border pl-3">
              <time className="text-xs text-theme-muted" dateTime={event.createdAt}>
                {new Date(event.createdAt).toLocaleString()}
              </time>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {collaborationEventLabel(event, actorName)}
              </p>
              {session.principal?.role !== "viewer" && (
                <button
                  type="button"
                  className="mt-1 text-xs text-theme-link underline"
                  onClick={() =>
                    onDiscuss(
                      {
                        kind: "event",
                        label: collaborationEventLabel(event, actorName).slice(0, 160),
                        eventCursor: event.cursor,
                      },
                      event.payload.taskId
                    )
                  }
                >
                  Discuss event
                </button>
              )}
            </li>
          ))}
        </ol>
        {session.activity.hasNextPage && (
          <button
            className="btn-secondary mt-3"
            type="button"
            disabled={session.activity.isFetchingNextPage}
            onClick={() => {
              void session.activity.fetchNextPage();
            }}
          >
            Load more activity
          </button>
        )}
        {session.activity.isSuccess && !events.length && (
          <p className="text-sm text-theme-muted">
            {mode === "history"
              ? "No discussion or control events yet."
              : "You’re caught up on discussion and control."}
          </p>
        )}
      </div>
    </section>
  );
}
