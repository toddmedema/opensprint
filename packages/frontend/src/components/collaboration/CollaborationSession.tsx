import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import type {
  CollaborationContext,
  CollaborationEvent,
  CollaborationMessage,
} from "@opensprint/shared";
import type { CollaborationGuidanceMessage } from "../../api/collaboration";
import { useCollaborationSession, isCollaborationAccessError } from "./useCollaborationSession";
import { CollaborationControl, guidanceStatusLabel } from "./CollaborationControl";
import { CollaborationInvites, collaborationRoleLabels } from "./CollaborationInvites";
import { useConversationScroll } from "./useConversationScroll";
import {
  composerEdit,
  editMentionTokens,
  mentionCompletion,
  validMentionTokens,
  type ComposerSelection,
} from "./collaborationMentions";
import { CollaborationDialog } from "./CollaborationDialog";
import { CollaborationWork } from "./CollaborationWork";
import { collaborationEventLabel } from "./collaborationEventLabel";
import {
  emptyCollaborationDrafts,
  type CollaborationDraftOwner,
  type CollaborationDraftState,
} from "./collaborationDrafts";

type View = "work" | "discussion";
type Sheet = "share" | "people" | "tasks" | "changes" | null;

export interface CollaborationSessionProps {
  projectId: string;
  token?: string;
  selectedTaskId?: string | null;
  taskTitle?: string;
  onSelectTaskId?: (taskId: string | null) => void;
  onLeave?: () => void;
  onShareClose?: () => void;
  embedded?: boolean;
  inviteRequest?: number;
  draftOwner?: CollaborationDraftOwner;
  workContent?: ReactNode;
}

/** A shared task has one workspace, with work inspection and an explicit team discussion. */
export function CollaborationSession({
  projectId,
  token,
  selectedTaskId,
  taskTitle,
  onSelectTaskId,
  onLeave,
  onShareClose,
  embedded = false,
  inviteRequest = 0,
  draftOwner,
  workContent,
}: CollaborationSessionProps) {
  const id = useId();
  const [localTaskId, setLocalTaskId] = useState<string | null>(
    () => selectedTaskId ?? new URLSearchParams(window.location.search).get("task")
  );
  const taskId = selectedTaskId !== undefined ? selectedTaskId : localTaskId;
  const scope = taskId ?? "project";
  const displayedScope = useRef(scope);
  displayedScope.current = scope;
  const [view, setView] = useState<View>("work");
  const [sheet, setSheet] = useState<Sheet>(inviteRequest > 0 ? "share" : null);
  const session = useCollaborationSession(projectId, token, taskId, "history", {
    context: !workContent || sheet === "changes",
    history: view === "discussion",
  });
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [messageMenu, setMessageMenu] = useState<string | null>(null);
  const messageMenuRef = useRef<HTMLDivElement>(null);
  const [messageMenuLayout, setMessageMenuLayout] = useState({ above: false, height: 0 });
  const [guidanceRequest, setGuidanceRequest] = useState(0);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const readAcknowledgment = useRef<{
    confirmed: number;
    pending: number | null;
    failed: number | null;
  }>({ confirmed: 0, pending: null, failed: null });
  const [showEarlier, setShowEarlier] = useState(false);
  const [internalDrafts, setInternalDrafts] = useState(emptyCollaborationDrafts);
  const draftState = draftOwner?.state ?? internalDrafts;
  const updateDraftState = draftOwner?.update ?? setInternalDrafts;
  const discussionRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLOListElement>(null);
  const observed = useRef(new Set<number>());
  const [observation, setObservation] = useState(0);
  const previousInviteRequest = useRef(inviteRequest);
  const previousScope = useRef(scope);
  const { drafts, contexts, decisions, guidanceDrafts } = draftState;
  const text = drafts[scope] ?? "";
  const [composerSelection, setComposerSelection] = useState({
    scope,
    start: text.length,
    end: text.length,
  });
  const beforeEdit = useRef<(ComposerSelection & { scope: string; editing: boolean }) | undefined>(
    undefined
  );
  const pendingComposerCaret = useRef<{ scope: string; value: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingComposerCaret.current;
    if (!pending) return;
    pendingComposerCaret.current = null;
    const element = discussionRef.current;
    if (pending.scope === scope && pending.value === text && element?.value === text) {
      element.focus();
      element.setSelectionRange(pending.caret, pending.caret);
    }
  });

  const context = contexts[scope];
  const data = session.snapshot.data;
  const principal = session.principal;
  const mayDiscuss = Boolean(principal && principal.role !== "viewer");
  const mayGuide = principal?.role === "controller";
  const task =
    session.overview.data?.tasks.find((item) => item.id === taskId) ?? session.context.data?.task;
  const title =
    taskTitle ??
    task?.title ??
    (taskId ? taskId : (session.overview.data?.projectName ?? "Project"));
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
      ? principal.displayName + " (you)"
      : (people.find((person) => person.actorId === actorId)?.displayName ??
        data?.messages.find((message) => message.actorId === actorId)?.displayName ??
        (actorId === "local-user" ? "Local user" : actorId));
  const events = useMemo(
    () => session.activity.data?.pages.flatMap((page) => page.events) ?? [],
    [session.activity.data]
  );
  const recentMessages = useMemo(
    () =>
      data?.messages.filter((message) => (taskId ? message.taskId === taskId : !message.taskId)) ??
      [],
    [data?.messages, taskId]
  );
  const messages = useMemo(() => {
    const all = new Map<string, CollaborationMessage>();
    if (showEarlier)
      for (const event of events) {
        if (
          "content" in event.payload &&
          (taskId ? event.payload.taskId === taskId : !event.payload.taskId)
        )
          all.set(event.payload.id, event.payload);
      }
    for (const message of recentMessages) all.set(message.id, message);
    return [...all.values()].sort((a, b) => a.cursor - b.cursor);
  }, [events, recentMessages, showEarlier, taskId]);
  const controlEvents = events.filter(
    (event) =>
      !("content" in event.payload) &&
      (taskId ? event.payload.taskId === taskId : !event.payload.taskId) &&
      (showEarlier || !session.activity.hasNextPage)
  );
  const instructionHistory = session.history.data ?? [];
  const visibleInstructions = showEarlier ? instructionHistory : instructionHistory.slice(-1);
  const thread: (
    | { kind: "message"; message: CollaborationMessage; cursor: number }
    | { kind: "event"; event: CollaborationEvent; cursor: number }
    | { kind: "instruction"; instruction: CollaborationGuidanceMessage; cursor: number }
  )[] = [
    ...messages.map((message) => ({ kind: "message" as const, message, cursor: message.cursor })),
    ...controlEvents.map((event) => ({ kind: "event" as const, event, cursor: event.cursor })),
    ...visibleInstructions.map((instruction) => ({
      kind: "instruction" as const,
      instruction,
      cursor: 0,
    })),
  ].sort((a, b) => {
    const date = (item: typeof a) =>
      item.kind === "message"
        ? item.message.createdAt
        : item.kind === "event"
          ? item.event.createdAt
          : (item.instruction.timestamp ?? "");
    return date(a).localeCompare(date(b)) || a.cursor - b.cursor;
  });
  const conversationContentKey =
    thread
      .map((item) =>
        item.kind === "instruction"
          ? "instruction:" +
            item.instruction.id +
            ":" +
            item.instruction.content.length +
            ":" +
            item.instruction.status
          : item.kind +
            ":" +
            item.cursor +
            ":" +
            (item.kind === "message" ? item.message.content.length : item.event.type)
      )
      .join("|") +
    ":" +
    showEarlier +
    ":" +
    (session.activity.data?.pages.at(-1)?.nextCursor ?? 0) +
    ":" +
    session.activity.hasNextPage;
  const conversationScroll = useConversationScroll({
    scope,
    visible: view === "discussion",
    ready: Boolean(data),
    contentKey: conversationContentKey,
  });
  useLayoutEffect(() => {
    const menu = messageMenuRef.current;
    const pane = conversationScroll.containerRef.current;
    const trigger = menu?.previousElementSibling;
    if (!messageMenu || !menu || !pane || !trigger) return;
    const position = () => {
      const bounds = pane.getBoundingClientRect();
      const button = trigger.getBoundingClientRect();
      const below = Math.max(0, bounds.bottom - button.bottom);
      const above = Math.max(0, button.top - bounds.top);
      const openAbove = menu.scrollHeight > below && above > below;
      const height = openAbove ? above : below;
      setMessageMenuLayout((previous) =>
        previous.above === openAbove && previous.height === height
          ? previous
          : { above: openAbove, height }
      );
    };
    position();
    pane.addEventListener("scroll", position);
    window.addEventListener("resize", position);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(pane);
    return () => {
      pane.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
      observer?.disconnect();
    };
  }, [messageMenu, conversationScroll.containerRef]);
  const recentIds = new Set(recentMessages.map((message) => message.id));
  const hasEarlierMessages = Boolean(
    data?.messagesHasMore ||
    session.activity.hasNextPage ||
    instructionHistory.length > 1 ||
    events.some(
      (event) =>
        "content" in event.payload &&
        (taskId ? event.payload.taskId === taskId : !event.payload.taskId) &&
        !recentIds.has(event.payload.id)
    )
  );
  const historyCursor = session.activity.data?.pages.at(-1)?.nextCursor ?? 0;
  const unseen = session.preferences.data?.seenCursor ?? 0;
  const firstUnread = thread.find((item) => item.cursor > unseen)?.cursor;
  const subscribed = Boolean(
    taskId && session.preferences.data?.subscribedTaskIds.includes(taskId)
  );
  const notifications = (session.notifications.data ?? []).filter((notification) =>
    taskId ? notification.taskId === taskId : !notification.taskId
  );
  const tokenDraft = draftState.mentionTokens[scope] ?? [];
  const completion = mentionCompletion(
    text,
    composerSelection.scope === scope ? composerSelection.start : text.length,
    composerSelection.scope === scope ? composerSelection.end : text.length,
    tokenDraft
  );
  const mentionPeople = !completion
    ? []
    : people.filter(
        (person) =>
          person.actorId !== principal?.actorId &&
          person.displayName.toLowerCase().startsWith(completion.query.toLowerCase())
      );

  const setDraftField = <K extends keyof CollaborationDraftState>(
    key: K,
    value: SetStateAction<CollaborationDraftState[K]>
  ) =>
    updateDraftState((previous) => ({
      ...previous,
      [key]:
        typeof value === "function"
          ? (value as (old: CollaborationDraftState[K]) => CollaborationDraftState[K])(
              previous[key]
            )
          : value,
    }));
  const setGuidanceDrafts = (value: SetStateAction<CollaborationDraftState["guidanceDrafts"]>) =>
    setDraftField("guidanceDrafts", value);
  /** Capture the actual textarea selection before an edit changes identical mention text. */
  const captureComposerSelection = (
    element: HTMLTextAreaElement,
    inputType?: string,
    editing = true
  ) => {
    const selection = {
      scope,
      value: element.value,
      start: element.selectionStart,
      end: element.selectionEnd,
      inputType,
      editing,
    };
    const previous = beforeEdit.current;
    if (
      !inputType &&
      previous?.scope === scope &&
      previous.value === selection.value &&
      previous.start === selection.start &&
      previous.end === selection.end
    )
      selection.inputType = previous.inputType;
    beforeEdit.current = selection;
    setComposerSelection({ scope, start: selection.start, end: selection.end });
  };
  /** Rebase identity tokens from the user's real edit; unknown edits conservatively clear identity. */
  const changeComposer = (element: HTMLTextAreaElement, inputType?: string) => {
    const value = element.value;
    const selection =
      beforeEdit.current?.scope === scope && beforeEdit.current.editing
        ? beforeEdit.current
        : undefined;
    beforeEdit.current = undefined;
    setComposerSelection({ scope, start: element.selectionStart, end: element.selectionEnd });
    updateDraftState((previous) => {
      const old = previous.drafts[scope] ?? "";
      const edit = selection?.value === old ? composerEdit(selection, value, inputType) : undefined;
      const tokens = editMentionTokens(previous.mentionTokens[scope] ?? [], old, value, edit);
      return {
        ...previous,
        drafts: { ...previous.drafts, [scope]: value },
        mentionTokens: { ...previous.mentionTokens, [scope]: tokens },
        mentions: {
          ...previous.mentions,
          [scope]: [...new Set(tokens.map((token) => token.actorId))],
        },
      };
    });
  };
  const chooseMention = (actorId: string, displayName: string) => {
    if (!completion) return;
    const tokenText = "@" + displayName;
    const suffix = text.slice(completion.end);
    const inserted = tokenText + (!suffix || !/^[\s.,!?;:)\]}]/.test(suffix) ? " " : "");
    const value = text.slice(0, completion.start) + inserted + suffix;
    updateDraftState((previous) => {
      const old = previous.drafts[scope] ?? "";
      // A stale suggestion cannot attach an identity to a different draft.
      if (old !== text) return previous;
      const tokens = [
        ...editMentionTokens(previous.mentionTokens[scope] ?? [], old, value, completion),
        {
          actorId,
          start: completion.start,
          end: completion.start + tokenText.length,
          text: tokenText,
        },
      ];
      return {
        ...previous,
        drafts: { ...previous.drafts, [scope]: value },
        mentionTokens: { ...previous.mentionTokens, [scope]: tokens },
        mentions: {
          ...previous.mentions,
          [scope]: [...new Set(tokens.map((token) => token.actorId))],
        },
      };
    });
    const caret = completion.start + inserted.length + (/^[\s.,!?;:)\]}]/.test(suffix) ? 1 : 0);
    setComposerSelection({ scope, start: caret, end: caret });
    beforeEdit.current = undefined;
    pendingComposerCaret.current = { scope, value, caret };
  };
  const selectTask = (next: string | null) => {
    setLocalTaskId(next);
    onSelectTaskId?.(next);
    setSheet(null);
    setShowEarlier(false);
  };
  const closeSheet = () => {
    const wasShare = sheet === "share";
    setSheet(null);
    if (wasShare) onShareClose?.();
  };
  useEffect(() => {
    if (inviteRequest !== previousInviteRequest.current) {
      previousInviteRequest.current = inviteRequest;
      if (inviteRequest > 0) setSheet("share");
    }
  }, [inviteRequest]);
  useEffect(() => {
    if (scope !== previousScope.current) {
      previousScope.current = scope;
      setSheet(null);
      setMessageMenu(null);
      setShowEarlier(false);
    }
  }, [scope]);

  useEffect(() => {
    if (!optionsOpen && !messageMenu) return;
    const outside = (event: MouseEvent) => {
      const element =
        event.target instanceof Element ? event.target.closest("[data-collaboration-menu]") : null;
      const current = optionsOpen ? "workspace" : messageMenu;
      if (element?.getAttribute("data-collaboration-menu") !== current) {
        setOptionsOpen(false);
        setMessageMenu(null);
      }
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [optionsOpen, messageMenu]);
  const dismissMenu = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOptionsOpen(false);
    setMessageMenu(null);
    event.currentTarget.querySelector("button")?.focus();
  };
  const leaveMenu = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setOptionsOpen(false);
      setMessageMenu(null);
    }
  };

  useEffect(() => {
    const refresh = () => setVisibilityEpoch((value) => value + 1);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("blur", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("blur", refresh);
    };
  }, []);
  const threadReadable = useCallback(() => {
    const thread = threadRef.current;
    if (
      !thread ||
      view !== "discussion" ||
      sheet ||
      guidanceOpen ||
      optionsOpen ||
      messageMenu ||
      document.visibilityState === "hidden" ||
      !document.hasFocus()
    )
      return false;
    const dialogs = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
    ].filter((dialog) => !dialog.hidden && getComputedStyle(dialog).display !== "none");
    const modal = dialogs.at(-1);
    return !modal || modal.contains(thread);
  }, [view, sheet, guidanceOpen, optionsOpen, messageMenu]);

  // Fetching history does not acknowledge it. Only observed rows can advance a contiguous prefix.
  useEffect(() => {
    if (view !== "discussion" || typeof IntersectionObserver === "undefined" || !threadRef.current)
      return;
    const observer = new IntersectionObserver((entries) => {
      if (!threadReadable()) return;
      let changed = false;
      for (const entry of entries)
        if (
          entry.isIntersecting &&
          entry.target.isConnected &&
          threadRef.current?.contains(entry.target)
        ) {
          const cursor = Number((entry.target as HTMLElement).dataset.eventCursor);
          if (cursor > 0 && !observed.current.has(cursor)) {
            observed.current.add(cursor);
            changed = true;
          }
        }
      if (changed) setObservation((value) => value + 1);
    });
    threadRef.current
      .querySelectorAll("[data-event-cursor]")
      .forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [
    view,
    thread,
    sheet,
    guidanceOpen,
    optionsOpen,
    messageMenu,
    visibilityEpoch,
    threadReadable,
  ]);
  useEffect(() => {
    if (
      !threadReadable() ||
      !session.preferences.data ||
      session.savePreferences.isPending ||
      session.activity.isFetching ||
      session.activity.error
    )
      return;
    let cursor = session.preferences.data.seenCursor;
    for (const event of events) {
      if (event.cursor <= cursor) continue;
      if (event.cursor !== cursor + 1 || !observed.current.has(event.cursor)) break;
      cursor = event.cursor;
    }
    const acknowledgment = readAcknowledgment.current;
    if (
      cursor > Math.max(session.preferences.data.seenCursor, acknowledgment.confirmed) &&
      acknowledgment.pending === null &&
      acknowledgment.failed === null
    ) {
      acknowledgment.pending = cursor;
      session.savePreferences.mutate(
        {
          seenCursor: cursor,
        },
        {
          onSuccess: () => {
            acknowledgment.confirmed = Math.max(acknowledgment.confirmed, cursor);
            acknowledgment.pending = null;
            acknowledgment.failed = null;
          },
          onError: () => {
            acknowledgment.pending = null;
            acknowledgment.failed = cursor;
          },
        }
      );
    }
  }, [
    observation,
    view,
    sheet,
    guidanceOpen,
    optionsOpen,
    messageMenu,
    visibilityEpoch,
    events,
    session.preferences.data,
    session.activity.isFetching,
    session.activity.error,
    session.savePreferences,
    threadReadable,
  ]);

  const openDiscussion = (source: CollaborationContext) => {
    setDraftField("contexts", (previous) => ({ ...previous, [scope]: source }));
    setSheet(null);
    setView("discussion");
    requestAnimationFrame(() => discussionRef.current?.focus());
  };
  const promote = (message: CollaborationMessage) => {
    if (!taskId || !session.activeRun) return;
    const source = message.context;
    const provenance = source
      ? [
          source.label,
          source.path ? source.path + (source.line ? ":" + source.line : "") : null,
          source.attempt ? "attempt " + source.attempt : null,
          source.attemptId ? "run " + source.attemptId : null,
          source.diffRevision ? "revision " + source.diffRevision : null,
          source.eventCursor ? "event " + source.eventCursor : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    const attributed =
      "From " +
      message.displayName +
      (provenance ? ", " + provenance : "") +
      ":\n" +
      message.content;
    const attemptId = session.activeRun.attemptId;
    setGuidanceDrafts((previous) => ({
      ...previous,
      [scope]: {
        ...previous[scope],
        [attemptId]: [previous[scope]?.[attemptId], attributed].filter(Boolean).join("\n\n"),
      },
    }));
    setMessageMenu(null);
    setGuidanceRequest((value) => value + 1);
  };
  const prepareDecision = (message: CollaborationMessage) => {
    const existing = draftState.drafts[scope] ?? "";
    setDraftField("drafts", (previous) => ({
      ...previous,
      [scope]: existing.trim()
        ? existing + "\n\nDecision from " + message.displayName + ":\n" + message.content
        : message.content,
    }));
    if (!existing.trim()) {
      setDraftField("mentionTokens", (previous) => ({ ...previous, [scope]: [] }));
      setDraftField("mentions", (previous) => ({ ...previous, [scope]: [] }));
    }
    setDraftField("decisions", (previous) => ({ ...previous, [scope]: true }));
    openDiscussion(
      draftState.contexts[scope] ?? {
        kind: "event",
        label: "Discussion by " + message.displayName,
        eventCursor: message.cursor,
      }
    );
    setMessageMenu(null);
  };
  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || session.command.isPending || !mayDiscuss) return;
    const mentioned = [
      ...new Set(
        validMentionTokens(draftState.mentionTokens[scope] ?? [], text).map(
          (token) => token.actorId
        )
      ),
    ];
    const input = {
      type: "append_message" as const,
      content: text.trim(),
      ...(taskId ? { taskId } : {}),
      ...(context ? { context } : {}),
      ...(decisions[scope] ? { decision: true } : {}),
      ...(mentioned.length ? { mentionActorIds: mentioned } : {}),
    };
    const payload = JSON.stringify(input);
    const identity =
      draftState.messageIdentities[scope]?.payload === payload
        ? draftState.messageIdentities[scope]
        : { payload, id: crypto.randomUUID() };
    setDraftField("messageIdentities", (previous) => ({ ...previous, [scope]: identity }));
    try {
      await session.command.mutateAsync({ ...input, commandId: identity!.id });
      if (displayedScope.current === scope) conversationScroll.jumpToLatest();
      updateDraftState((previous) =>
        previous.messageIdentities[scope]?.id !== identity!.id
          ? previous
          : {
              ...previous,
              drafts:
                previous.drafts[scope] === text
                  ? { ...previous.drafts, [scope]: "" }
                  : previous.drafts,
              contexts:
                previous.drafts[scope] === text
                  ? { ...previous.contexts, [scope]: undefined }
                  : previous.contexts,
              decisions:
                previous.drafts[scope] === text
                  ? { ...previous.decisions, [scope]: false }
                  : previous.decisions,
              mentions:
                previous.drafts[scope] === text
                  ? { ...previous.mentions, [scope]: [] }
                  : previous.mentions,
              mentionTokens:
                previous.drafts[scope] === text
                  ? { ...previous.mentionTokens, [scope]: [] }
                  : previous.mentionTokens,
              messageIdentities: { ...previous.messageIdentities, [scope]: undefined },
            }
      );
    } catch {
      /* Preserve the draft and uncertain command identity for a safe retry. */
    }
  };
  const accessError = isCollaborationAccessError(session.snapshot.error)
    ? session.snapshot.error
    : null;
  if (accessError && !workContent)
    return (
      <section className="space-y-3 p-5" aria-label="Collaboration access ended">
        <h2 className="text-lg font-semibold">Access to this project ended</h2>
        <p role="alert" className="text-sm text-theme-error-text">
          {accessError.message}
        </p>
        {onLeave && (
          <button type="button" className="btn-secondary" onClick={onLeave}>
            Leave session
          </button>
        )}
      </section>
    );
  const work = (
    <CollaborationWork
      key={scope}
      context={session.context.data}
      loading={session.context.isPending}
      mayDiscuss={mayDiscuss}
      onDiscuss={openDiscussion}
    />
  );
  return (
    <section
      aria-label="Shared task workspace"
      className={
        "flex min-h-0 min-w-0 flex-col bg-theme-bg text-theme-text " +
        (embedded
          ? "h-full"
          : "mx-auto h-[calc(100dvh-1.5rem)] max-w-5xl rounded-xl border border-theme-border sm:h-[calc(100dvh-3rem)]")
      }
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-theme-border px-4 py-1">
        <div className="min-w-0 flex-1">
          {embedded ? (
            <h1
              className="line-clamp-2 text-sm font-semibold leading-5"
              data-testid="task-detail-title"
            >
              {title}
            </h1>
          ) : (
            <h1 className="min-w-0 text-sm font-semibold">
              <button
                type="button"
                className="line-clamp-2 max-w-full text-left text-sm font-semibold leading-5"
                onClick={() => setSheet("tasks")}
                aria-label={"Choose task: " + title}
              >
                {title} <span aria-hidden="true">⌄</span>
              </button>
            </h1>
          )}
          {(session.snapshot.isPending || session.connectionError) && (
            <p className="truncate text-xs text-theme-muted" role="status">
              {session.snapshot.isPending ? "Connecting…" : "Connection interrupted · retrying"}
            </p>
          )}
        </div>
        {data && (
          <button
            type="button"
            className="flex h-11 min-w-11 items-center justify-center -space-x-2 rounded-lg px-1"
            aria-label="People in this workspace"
            onClick={() => setSheet("people")}
          >
            {(people.length ? people : principal ? [principal] : []).slice(0, 3).map((person) => (
              <span
                key={person.actorId}
                title={person.displayName}
                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-theme-bg bg-theme-surface-muted text-[10px]"
                aria-hidden="true"
              >
                {person.displayName.slice(0, 2).toUpperCase()}
              </span>
            ))}
          </button>
        )}
        {principal?.actorId === "local-user" && (
          <button type="button" className="btn-secondary text-sm" onClick={() => setSheet("share")}>
            Share
          </button>
        )}
        <div
          className="relative"
          data-collaboration-menu="workspace"
          onKeyDownCapture={dismissMenu}
          onBlurCapture={leaveMenu}
        >
          <button
            type="button"
            aria-label="Workspace options"
            aria-expanded={optionsOpen}
            className="flex h-11 w-9 items-center justify-center rounded-lg text-theme-muted"
            onClick={() => setOptionsOpen(!optionsOpen)}
          >
            ⋯
          </button>
          {optionsOpen && (
            <div className="absolute right-0 top-full z-20 min-w-48 rounded-lg border border-theme-border bg-theme-bg p-1 shadow-lg">
              {embedded && (
                <a
                  className="block rounded px-3 py-2 text-sm hover:bg-theme-surface-muted"
                  href={
                    "/collaborate/" +
                    encodeURIComponent(projectId) +
                    (taskId ? "?task=" + encodeURIComponent(taskId) : "")
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOptionsOpen(false)}
                >
                  Open in new window
                </a>
              )}
              {workContent && taskId && (
                <button
                  type="button"
                  className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-theme-surface-muted"
                  onClick={() => {
                    setOptionsOpen(false);
                    setSheet("changes");
                  }}
                >
                  View changes…
                </button>
              )}
              {taskId && principal && (
                <button
                  type="button"
                  disabled={!session.preferences.data || session.savePreferences.isPending}
                  className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-theme-surface-muted"
                  onClick={() => {
                    if (!session.preferences.data) return;
                    session.savePreferences.mutate({
                      seenCursor: session.preferences.data.seenCursor,
                      subscribedTaskIds: subscribed
                        ? session.preferences.data.subscribedTaskIds.filter(
                            (value) => value !== taskId
                          )
                        : [...session.preferences.data.subscribedTaskIds, taskId],
                    });
                    setOptionsOpen(false);
                  }}
                >
                  {subscribed ? "Stop notifications" : "Notify me"}
                </button>
              )}
              {!embedded && onLeave && (
                <button
                  type="button"
                  className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-theme-surface-muted"
                  onClick={onLeave}
                >
                  Leave session
                </button>
              )}
            </div>
          )}
        </div>
        {embedded && onLeave && (
          <button
            type="button"
            className="flex h-11 w-8 items-center justify-center rounded-lg text-theme-muted"
            aria-label="Close task workspace"
            onClick={onLeave}
          >
            ×
          </button>
        )}
      </header>
      {session.error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-theme-border px-4 py-2">
          <p role="alert" className="min-w-0 flex-1 break-words text-sm text-theme-error-text">
            {session.error.message}
          </p>
          <button
            type="button"
            className="text-sm text-theme-link underline"
            onClick={() => {
              readAcknowledgment.current.failed = null;
              session.command.reset();
              session.savePreferences.reset();
              void session.invalidate();
            }}
          >
            {session.connectionError ? "Retry connection" : "Dismiss error"}
          </button>
        </div>
      )}
      <div
        role="tablist"
        tabIndex={-1}
        aria-label="Task workspace views"
        className="flex shrink-0 border-b border-theme-border px-2"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "work"
              : event.key === "End"
                ? "discussion"
                : view === "work"
                  ? "discussion"
                  : "work";
          setView(next);
          document.getElementById(id + "-" + next + "-tab")?.focus();
        }}
      >
        {(["work", "discussion"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={id + "-" + item + "-tab"}
            aria-controls={id + "-" + item + "-panel"}
            aria-selected={view === item}
            tabIndex={view === item ? 0 : -1}
            className={
              "min-h-11 border-b-2 px-3 py-2 text-sm " +
              (view === item
                ? "border-brand-500 font-medium text-brand-600"
                : "border-transparent text-theme-muted")
            }
            onClick={() => setView(item)}
          >
            {item === "work" ? "Work" : "Discussion"}
            {item === "discussion" && notifications.length > 0 && (
              <span className="ml-1 text-xs text-theme-muted">{notifications.length}</span>
            )}
          </button>
        ))}
      </div>
      {data && (
        <div className="shrink-0 px-4">
          <CollaborationControl
            key={scope}
            session={session}
            taskId={taskId}
            actorName={actorName}
            guidanceRequest={guidanceRequest}
            onOpenChange={setGuidanceOpen}
            drafts={guidanceDrafts[scope] ?? {}}
            identities={draftState.guidanceIdentities}
            onIdentity={(attemptId, identity) =>
              setDraftField("guidanceIdentities", (previous) => ({
                ...previous,
                [attemptId]: identity,
              }))
            }
            onSubmissionResult={(input, delivered) =>
              updateDraftState((previous) =>
                previous.guidanceIdentities[input.attemptId]?.id !== input.clientMessageId
                  ? previous
                  : {
                      ...previous,
                      guidanceIdentities: {
                        ...previous.guidanceIdentities,
                        [input.attemptId]: undefined,
                      },
                      guidanceDrafts:
                        delivered &&
                        previous.guidanceDrafts[scope]?.[input.attemptId]?.trim() === input.content
                          ? {
                              ...previous.guidanceDrafts,
                              [scope]: { ...previous.guidanceDrafts[scope], [input.attemptId]: "" },
                            }
                          : previous.guidanceDrafts,
                    }
              )
            }
            onDraft={(attemptId, content) =>
              setGuidanceDrafts((previous) => ({
                ...previous,
                [scope]: { ...previous[scope], [attemptId]: content },
              }))
            }
          />
        </div>
      )}
      <div
        role="tabpanel"
        id={id + "-work-panel"}
        aria-labelledby={id + "-work-tab"}
        hidden={view !== "work"}
        className="min-h-0 flex-1 overflow-hidden"
      >
        <div className={"h-full min-h-0 " + (workContent ? "flex flex-col" : "overflow-y-auto")}>
          {workContent ??
            (taskId ? (
              work
            ) : (
              <p className="p-4 text-sm text-theme-muted">Choose a task to inspect its work.</p>
            ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id={id + "-discussion-panel"}
        aria-labelledby={id + "-discussion-tab"}
        hidden={view !== "discussion"}
        className="min-h-0 flex-1 flex-col"
      >
        {data && (
          <div className="flex h-full min-h-0 flex-col">
            <div
              ref={conversationScroll.containerRef}
              data-testid="team-discussion-scroll"
              onScroll={conversationScroll.handleScroll}
              style={{ overflowAnchor: "none" }}
              className="min-h-0 flex-1 overflow-y-auto px-4 py-2"
            >
              {!showEarlier && hasEarlierMessages && (
                <button
                  type="button"
                  className="mb-3 text-sm text-theme-link underline"
                  onClick={() => {
                    conversationScroll.beforeHistoryChange();
                    setShowEarlier(true);
                  }}
                >
                  Earlier messages
                </button>
              )}
              {(session.notifications.data?.length ?? 0) > 0 && (
                <details className="mb-3 text-sm">
                  <summary className="cursor-pointer text-theme-muted">
                    Updates ({session.notifications.data!.length})
                  </summary>
                  <ul aria-label="Collaboration updates" className="mt-2 space-y-2">
                    {session.notifications.data!.map((notification) => (
                      <li key={notification.id}>
                        <button
                          type="button"
                          className="text-left text-theme-link underline"
                          onClick={() => {
                            if (notification.taskId) selectTask(notification.taskId);
                            setView("discussion");
                          }}
                        >
                          {notification.content}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <ol ref={threadRef} aria-label="Team discussion" className="space-y-4">
                {thread.map((item) => (
                  <li
                    key={
                      item.kind === "instruction"
                        ? "instruction-" + item.instruction.id
                        : item.kind + "-" + item.cursor
                    }
                    data-conversation-entry={
                      item.kind === "instruction"
                        ? "instruction-" + item.instruction.id
                        : item.kind + "-" + item.cursor
                    }
                    data-event-cursor={item.kind === "instruction" ? undefined : item.cursor}
                  >
                    {item.cursor === firstUnread && (
                      <p className="mb-3 border-t border-brand-500 pt-2 text-xs font-medium text-brand-600">
                        New updates
                      </p>
                    )}
                    {showEarlier &&
                      session.activity.hasNextPage &&
                      item.cursor > historyCursor &&
                      thread.find((row) => row.cursor > historyCursor)?.cursor === item.cursor && (
                        <button
                          type="button"
                          className="mb-4 text-sm text-theme-link underline"
                          disabled={session.activity.isFetchingNextPage}
                          onClick={() => {
                            conversationScroll.beforeHistoryChange();
                            void session.activity.fetchNextPage();
                          }}
                        >
                          {session.activity.isFetchingNextPage
                            ? "Loading messages…"
                            : "Load more messages"}
                        </button>
                      )}
                    {item.kind === "instruction" ? (
                      <article
                        aria-label={
                          item.instruction.role === "assistant"
                            ? "Agent reply"
                            : "Instruction to agent"
                        }
                        className="rounded-lg bg-theme-surface-muted p-3"
                      >
                        <p className="text-xs font-medium">
                          {item.instruction.role === "assistant"
                            ? "Agent"
                            : actorName(item.instruction.actorId ?? "local-user") + " → Agent"}
                          {item.instruction.role !== "assistant" && (
                            <span className="ml-1 font-normal text-theme-muted">
                              {guidanceStatusLabel(item.instruction.status)}
                            </span>
                          )}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                          {item.instruction.content}
                        </p>
                      </article>
                    ) : item.kind === "event" ? (
                      <p className="text-xs text-theme-muted">
                        {collaborationEventLabel(item.event, actorName)}
                      </p>
                    ) : (
                      <article className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="min-w-0 flex-1 text-sm font-medium">
                            {item.message.displayName}{" "}
                            <time
                              dateTime={item.message.createdAt}
                              className="ml-1 text-xs font-normal text-theme-muted"
                            >
                              {new Date(item.message.createdAt).toLocaleTimeString([], {
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </time>
                            {item.message.decision && (
                              <span className="ml-2 rounded bg-theme-surface-muted px-1.5 py-0.5 text-xs">
                                Decision
                              </span>
                            )}
                          </p>
                          {mayDiscuss && (
                            <div
                              className="relative"
                              data-collaboration-menu={item.message.id}
                              onKeyDownCapture={dismissMenu}
                              onBlurCapture={leaveMenu}
                            >
                              <button
                                type="button"
                                aria-label={"Message actions for " + item.message.displayName}
                                aria-expanded={messageMenu === item.message.id}
                                className="flex h-8 w-8 items-center justify-center rounded text-theme-muted"
                                onClick={() =>
                                  setMessageMenu(
                                    messageMenu === item.message.id ? null : item.message.id
                                  )
                                }
                              >
                                ⋯
                              </button>
                              {messageMenu === item.message.id && (
                                <div
                                  ref={messageMenuRef}
                                  style={{
                                    maxHeight: messageMenuLayout.height || undefined,
                                    ...(messageMenuLayout.above
                                      ? { bottom: "100%" }
                                      : { top: "100%" }),
                                  }}
                                  className="absolute right-0 z-10 min-w-44 overflow-y-auto rounded-lg border border-theme-border bg-theme-bg p-1 shadow-lg"
                                >
                                  <button
                                    type="button"
                                    className="block w-full px-3 py-2 text-left text-sm"
                                    onClick={() => prepareDecision(item.message)}
                                  >
                                    Record decision…
                                  </button>
                                  {mayGuide && taskId && session.activeRun && (
                                    <button
                                      type="button"
                                      className="block w-full px-3 py-2 text-left text-sm"
                                      onClick={() => promote(item.message)}
                                    >
                                      Send to agent…
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {item.message.context && (
                          <p className="mt-1 text-xs text-theme-muted">
                            {"↳ " + item.message.context.label}
                          </p>
                        )}
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                          {item.message.content}
                        </p>
                      </article>
                    )}
                  </li>
                ))}
              </ol>
              {showEarlier &&
                session.activity.hasNextPage &&
                !thread.some((item) => item.cursor > historyCursor) && (
                  <button
                    type="button"
                    className="mt-3 text-sm text-theme-link underline"
                    disabled={session.activity.isFetchingNextPage}
                    onClick={() => {
                      conversationScroll.beforeHistoryChange();
                      void session.activity.fetchNextPage();
                    }}
                  >
                    {session.activity.isFetchingNextPage
                      ? "Loading messages…"
                      : "Load more messages"}
                  </button>
                )}
              {session.activity.error && (
                <button
                  type="button"
                  className="mt-3 text-sm text-theme-link underline"
                  onClick={() => {
                    conversationScroll.beforeHistoryChange();
                    void session.activity.refetch();
                  }}
                >
                  Retry earlier messages
                </button>
              )}
              {!thread.length && (
                <p className="text-sm text-theme-muted">Start the conversation.</p>
              )}
            </div>
            {conversationScroll.showJumpToLatest && (
              <div className="flex shrink-0 justify-center py-1">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={conversationScroll.jumpToLatest}
                >
                  Jump to latest
                </button>
              </div>
            )}
            {mayDiscuss ? (
              <form
                className="shrink-0 space-y-2 border-t border-theme-border bg-theme-bg p-3"
                onSubmit={sendMessage}
              >
                {(context || decisions[scope]) && (
                  <div className="flex items-center gap-2 text-xs text-theme-muted">
                    <span className="min-w-0 flex-1 truncate">
                      {decisions[scope] ? "Decision" : "Commenting on " + context?.label}
                    </span>
                    <button
                      type="button"
                      className="text-theme-link underline"
                      onClick={() => {
                        setDraftField("contexts", (previous) => ({
                          ...previous,
                          [scope]: undefined,
                        }));
                        setDraftField("decisions", (previous) => ({ ...previous, [scope]: false }));
                      }}
                    >
                      Remove context
                    </button>
                  </div>
                )}
                {mentionPeople.length > 0 && (
                  <div aria-label="Mention suggestions" className="flex flex-wrap gap-1">
                    {mentionPeople.map((person) => (
                      <button
                        key={person.actorId}
                        type="button"
                        className="rounded bg-theme-surface-muted px-2 py-1 text-sm"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseMention(person.actorId, person.displayName)}
                      >
                        {"@" + person.displayName}
                        {people.filter((candidate) => candidate.displayName === person.displayName)
                          .length > 1 && (
                          <span className="ml-1 text-xs text-theme-muted">
                            {"· " +
                              (session.overview.data?.tasks.find(
                                (candidate) => candidate.id === person.taskId
                              )?.title ?? "Project") +
                              " · " +
                              collaborationRoleLabels[person.role] +
                              (people.some(
                                (candidate) =>
                                  candidate.actorId !== person.actorId &&
                                  candidate.displayName === person.displayName &&
                                  candidate.taskId === person.taskId &&
                                  candidate.role === person.role
                              )
                                ? " · " + person.actorId.slice(-6)
                                : "")}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <label htmlFor={id + "-message"} className="sr-only">
                    Message team
                  </label>
                  <textarea
                    ref={discussionRef}
                    id={id + "-message"}
                    rows={2}
                    className="min-w-0 flex-1 resize-none rounded-lg border border-theme-border bg-theme-bg p-2 text-sm"
                    value={text}
                    placeholder="Message team…"
                    maxLength={10000}
                    disabled={session.command.isPending}
                    onSelect={(event) =>
                      captureComposerSelection(event.currentTarget, undefined, false)
                    }
                    onBeforeInput={(event) =>
                      captureComposerSelection(
                        event.currentTarget,
                        (event.nativeEvent as InputEvent).inputType
                      )
                    }
                    onKeyDown={(event) =>
                      captureComposerSelection(
                        event.currentTarget,
                        event.key === "Backspace"
                          ? "deleteContentBackward"
                          : event.key === "Delete"
                            ? "deleteContentForward"
                            : undefined
                      )
                    }
                    onPaste={(event) =>
                      captureComposerSelection(event.currentTarget, "insertFromPaste")
                    }
                    onCut={(event) => captureComposerSelection(event.currentTarget, "deleteByCut")}
                    onDrop={(event) =>
                      captureComposerSelection(event.currentTarget, "insertFromDrop")
                    }
                    onChange={(event) =>
                      changeComposer(
                        event.currentTarget,
                        (event.nativeEvent as InputEvent).inputType
                      )
                    }
                  />
                  <button
                    type="submit"
                    className="btn-primary min-h-11 shrink-0"
                    disabled={session.command.isPending || !text.trim()}
                  >
                    {session.command.isPending ? "Sending…" : "Send"}
                  </button>
                </div>
              </form>
            ) : (
              <p className="shrink-0 border-t border-theme-border p-3 text-sm text-theme-muted">
                View only. Ask the host for discussion access.
              </p>
            )}
          </div>
        )}
      </div>
      {sheet === "share" && principal?.actorId === "local-user" && (
        <CollaborationDialog title="Share project" onClose={closeSheet}>
          <CollaborationInvites key={projectId} session={session} projectId={projectId} />
        </CollaborationDialog>
      )}
      {sheet === "people" && (
        <CollaborationDialog title="People" onClose={closeSheet}>
          <ul className="space-y-4">
            {people.map((person) => (
              <li key={person.actorId}>
                <p className="text-sm font-medium">{actorName(person.actorId)}</p>
                <p className="text-xs text-theme-muted">{collaborationRoleLabels[person.role]}</p>
              </li>
            ))}
          </ul>
        </CollaborationDialog>
      )}
      {sheet === "tasks" && !embedded && (
        <CollaborationDialog title="Choose task" onClose={closeSheet}>
          <div className="space-y-1">
            <button
              type="button"
              className="block w-full rounded p-3 text-left text-sm hover:bg-theme-surface-muted"
              onClick={() => selectTask(null)}
            >
              Project discussion
            </button>
            {session.overview.data?.tasks.map((item) => (
              <button
                key={item.id}
                type="button"
                className="block w-full rounded p-3 text-left text-sm hover:bg-theme-surface-muted"
                onClick={() => selectTask(item.id)}
              >
                {item.title}
              </button>
            ))}
          </div>
        </CollaborationDialog>
      )}
      {sheet === "changes" && (
        <CollaborationDialog title="Shared changes" onClose={closeSheet}>
          {work}
        </CollaborationDialog>
      )}
    </section>
  );
}
