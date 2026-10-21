import React, { useEffect, useState, useMemo, useCallback } from "react";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { useDurableAgentOutput } from "../../hooks/useDurableAgentOutput";
import { useSidebarSectionRestore } from "../../hooks/useSidebarSectionRestore";
import type {
  AgentSession,
  Notification,
  Plan,
  Task,
  TaskExecutionDiagnostics,
} from "@opensprint/shared";
import { AGENT_ROLE_LABELS } from "@opensprint/shared";
import type { ActiveTaskInfo } from "../../store/slices/executeSlice";
import { useAppDispatch } from "../../store";
import { addTaskDependency, removeTaskDependency } from "../../store/slices/executeSlice";
import { filterAgentOutput } from "../../utils/agentOutputFilter";
import { CollapsibleSection } from "./CollapsibleSection";
import { TaskDetailHeader } from "./TaskDetailHeader";
import { TaskDetailOpenQuestions } from "./TaskDetailOpenQuestions";
import { TaskDetailMetadata } from "./TaskDetailMetadata";
import { TaskDetailLinks } from "./TaskDetailLinks";
import { TaskDetailDescription } from "./TaskDetailDescription";
import { TaskDetailFeedbackSections } from "./TaskDetailFeedbackSections";
import { TaskDetailDiagnostics } from "./TaskDetailDiagnostics";
import { TaskDetailAgentOutput } from "./TaskDetailAgentOutput";
import { ExecuteAgentChatPanel } from "./ExecuteAgentChatPanel";
import type { ExecuteChatMessage } from "./ExecuteAgentChatPanel";
import { ExecuteOutputTabs } from "./ExecuteOutputTabs";
import { SidebarSectionNav } from "../layout/SidebarSectionNav";

/** Prefer the latest valid ISO timestamp (browser receive time vs orchestrator status). */
function pickLatestIso(...candidates: Array<string | undefined>): string | undefined {
  let best = -1;
  let bestIso: string | undefined;
  for (const iso of candidates) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    if (t > best) {
      best = t;
      bestIso = iso;
    }
  }
  return bestIso;
}

/** Compare task data excluding priority. When only priority changed, skip sidebar re-render (TaskPriorityDropdown handles it via Redux). */
function taskDataEqualExceptPriority(a: Task | null, b: Task | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.id !== b.id) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Task>;
  for (const k of keys) {
    if (k === "priority") continue;
    const va = a[k];
    const vb = b[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
  }
  return true;
}

export interface TaskDetailData {
  selectedTaskData: Task | null;
  taskDetailLoading: boolean;
  taskDetailError: string | null;
}

export interface TaskDetailSections {
  descriptionSectionExpanded: boolean;
  setDescriptionSectionExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  artifactsSectionExpanded: boolean;
  setArtifactsSectionExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  diagnosticsSectionExpanded: boolean;
  setDiagnosticsSectionExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  sourceFeedbackExpanded: Record<string, boolean>;
  setSourceFeedbackExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

export interface TaskDetailCallbacks {
  onClose: () => void;
  onMarkDone: () => void;
  onUnblock: () => void;
  onDeleteTask: () => void | Promise<void>;
  onForceRetry: () => void | Promise<void>;
  onSelectTask: (taskId: string) => void;
  onNavigateToPlan?: (planId: string) => void;
  onOpenQuestionResolved?: (resolved?: Notification, notificationIdToRemove?: string) => void;
}

export interface TaskDetailSidebarProps {
  projectId: string;
  selectedTask: string;
  taskDetail: TaskDetailData;
  agentOutput: string[];
  completionState: {
    status: string;
    testResults: { passed: number; failed: number; skipped: number; total: number } | null;
    reason?: string | null;
  } | null;
  diagnostics: TaskExecutionDiagnostics | null;
  diagnosticsLoading: boolean;
  archivedSessions: AgentSession[];
  archivedLoading: boolean;
  markDoneLoading: boolean;
  unblockLoading: boolean;
  deleteLoading: boolean;
  forceRetryLoading: boolean;
  taskIdToStartedAt: Record<string, string>;
  planByEpicId: Record<string, Plan>;
  taskById: Record<string, Task>;
  activeTasks: ActiveTaskInfo[];
  wsConnected: boolean;
  isDoneTask: boolean;
  isBlockedTask: boolean;
  /** When true, assignee cannot be changed (task in progress or in review). */
  isInProgressTask?: boolean;
  sections: TaskDetailSections;
  /** Open question notification for this task (renders block with Answer/Dismiss) */
  openQuestionNotification?: Notification | null;
  /** Team members from project settings for assignee dropdown. */
  teamMembers?: Array<{ id: string; name: string }>;
  /** When false, assignee is not editable (show as text only). */
  enableHumanTeammates?: boolean;
  /** True when the project uses branches mode (shared checkout warning for Open in Editor). */
  isBranchesMode?: boolean;
  callbacks: TaskDetailCallbacks;
  /** Chat messages for the execute agent chat panel. */
  chatMessages?: ExecuteChatMessage[];
  /** Whether a chat response is pending. */
  chatSending?: boolean;
  /** Handler to send a chat message to the agent. */
  onChatSend?: (message: string) => void | boolean | Promise<void | boolean>;
  /** Draft storage key for chat input persistence. */
  chatDraftStorageKey?: string;
  /** Whether the agent's backend supports live chat. Defaults to true. */
  chatSupported?: boolean;
  /** Reason chat is unsupported (shown as notice). */
  chatUnsupportedReason?: string;
  /** ISO time from Redux when the browser last stored output for the selected task. */
  agentOutputLastReceivedAt?: string;
}

/** Build active agent label(s) for the selected task. Handles multi-angle review: shows each reviewer with angle (e.g. "Reviewer (Security), Reviewer (Performance)"). */
const activeRoleLabel = (selectedTask: string, activeTasks: ActiveTaskInfo[]): string | null => {
  const matching = activeTasks.filter((a) => a.taskId === selectedTask);
  if (matching.length === 0) return null;
  const labels = matching.map((a) => {
    const phase = a.phase as "coding" | "review";
    const roleLabel = AGENT_ROLE_LABELS[phase === "coding" ? "coder" : "reviewer"] ?? "";
    return a.name?.trim() || roleLabel;
  });
  return labels.filter(Boolean).join(", ") || null;
};

function areTaskDetailSidebarPropsEqual(
  prev: TaskDetailSidebarProps,
  next: TaskDetailSidebarProps
): boolean {
  const td = (a: TaskDetailSidebarProps) => a.taskDetail;
  const sec = (a: TaskDetailSidebarProps) => a.sections;
  const cb = (a: TaskDetailSidebarProps) => a.callbacks;
  if (
    prev.projectId !== next.projectId ||
    prev.selectedTask !== next.selectedTask ||
    !taskDataEqualExceptPriority(td(prev).selectedTaskData, td(next).selectedTaskData) ||
    td(prev).taskDetailLoading !== td(next).taskDetailLoading ||
    td(prev).taskDetailError !== td(next).taskDetailError ||
    prev.archivedLoading !== next.archivedLoading ||
    prev.markDoneLoading !== next.markDoneLoading ||
    prev.unblockLoading !== next.unblockLoading ||
    prev.deleteLoading !== next.deleteLoading ||
    prev.forceRetryLoading !== next.forceRetryLoading ||
    prev.taskIdToStartedAt !== next.taskIdToStartedAt ||
    prev.planByEpicId !== next.planByEpicId ||
    prev.taskById !== next.taskById ||
    prev.activeTasks !== next.activeTasks ||
    prev.wsConnected !== next.wsConnected ||
    prev.isDoneTask !== next.isDoneTask ||
    prev.isBlockedTask !== next.isBlockedTask ||
    prev.isInProgressTask !== next.isInProgressTask ||
    prev.diagnostics !== next.diagnostics ||
    prev.diagnosticsLoading !== next.diagnosticsLoading ||
    sec(prev).sourceFeedbackExpanded !== sec(next).sourceFeedbackExpanded ||
    sec(prev).setSourceFeedbackExpanded !== sec(next).setSourceFeedbackExpanded ||
    sec(prev).descriptionSectionExpanded !== sec(next).descriptionSectionExpanded ||
    sec(prev).setDescriptionSectionExpanded !== sec(next).setDescriptionSectionExpanded ||
    sec(prev).artifactsSectionExpanded !== sec(next).artifactsSectionExpanded ||
    sec(prev).setArtifactsSectionExpanded !== sec(next).setArtifactsSectionExpanded ||
    sec(prev).diagnosticsSectionExpanded !== sec(next).diagnosticsSectionExpanded ||
    sec(prev).setDiagnosticsSectionExpanded !== sec(next).setDiagnosticsSectionExpanded ||
    cb(prev).onNavigateToPlan !== cb(next).onNavigateToPlan ||
    cb(prev).onClose !== cb(next).onClose ||
    prev.openQuestionNotification !== next.openQuestionNotification ||
    prev.teamMembers !== next.teamMembers ||
    prev.enableHumanTeammates !== next.enableHumanTeammates ||
    prev.isBranchesMode !== next.isBranchesMode ||
    cb(prev).onOpenQuestionResolved !== cb(next).onOpenQuestionResolved ||
    cb(prev).onMarkDone !== cb(next).onMarkDone ||
    cb(prev).onUnblock !== cb(next).onUnblock ||
    cb(prev).onDeleteTask !== cb(next).onDeleteTask ||
    cb(prev).onForceRetry !== cb(next).onForceRetry ||
    cb(prev).onSelectTask !== cb(next).onSelectTask
  ) {
    return false;
  }
  if (prev.agentOutput !== next.agentOutput) return false;
  if (prev.archivedSessions !== next.archivedSessions) return false;
  if (prev.completionState !== next.completionState) return false;
  if (prev.chatMessages !== next.chatMessages) return false;
  if (prev.chatSending !== next.chatSending) return false;
  if (prev.onChatSend !== next.onChatSend) return false;
  if (prev.chatDraftStorageKey !== next.chatDraftStorageKey) return false;
  if (prev.chatSupported !== next.chatSupported) return false;
  if (prev.chatUnsupportedReason !== next.chatUnsupportedReason) return false;
  if (prev.agentOutputLastReceivedAt !== next.agentOutputLastReceivedAt) return false;
  return true;
}

function TaskDetailSidebarInner({
  projectId,
  selectedTask,
  taskDetail,
  agentOutput,
  completionState,
  diagnostics,
  diagnosticsLoading,
  archivedSessions,
  archivedLoading,
  markDoneLoading,
  unblockLoading,
  deleteLoading,
  forceRetryLoading,
  taskIdToStartedAt,
  planByEpicId,
  taskById,
  activeTasks,
  wsConnected,
  isDoneTask,
  isBlockedTask,
  isInProgressTask = false,
  sections,
  openQuestionNotification,
  teamMembers = [],
  enableHumanTeammates = false,
  isBranchesMode = false,
  callbacks,
  chatMessages = [],
  chatSending = false,
  onChatSend,
  chatDraftStorageKey,
  chatSupported = true,
  chatUnsupportedReason,
  agentOutputLastReceivedAt,
}: TaskDetailSidebarProps) {
  const { selectedTaskData, taskDetailLoading, taskDetailError } = taskDetail;
  const {
    sourceFeedbackExpanded,
    setSourceFeedbackExpanded,
    descriptionSectionExpanded,
    setDescriptionSectionExpanded,
    artifactsSectionExpanded,
    setArtifactsSectionExpanded,
    diagnosticsSectionExpanded,
    setDiagnosticsSectionExpanded,
  } = sections;
  const {
    onNavigateToPlan,
    onClose,
    onOpenQuestionResolved,
    onMarkDone,
    onUnblock,
    onDeleteTask,
    onForceRetry,
    onSelectTask,
  } = callbacks;
  const dispatch = useAppDispatch();
  const roleLabel = activeRoleLabel(selectedTask, activeTasks);
  const [showLoadingPlaceholder, setShowLoadingPlaceholder] = useState(false);
  const [chatTabScrollTrigger, setChatTabScrollTrigger] = useState(0);

  const agentOutputText = useMemo(() => agentOutput.join(""), [agentOutput]);
  const durableOutput = useDurableAgentOutput(
    projectId,
    selectedTask,
    !isDoneTask && artifactsSectionExpanded
  );
  const activeTaskState = useMemo(
    () => activeTasks.find((task) => task.taskId === selectedTask) ?? null,
    [activeTasks, selectedTask]
  );

  const lastOutputReceivedAtIso = useMemo(
    () => pickLatestIso(agentOutputLastReceivedAt, activeTaskState?.lastOutputAt) ?? null,
    [agentOutputLastReceivedAt, activeTaskState?.lastOutputAt]
  );

  const liveOutputContent = useMemo(() => {
    if (durableOutput.content !== null)
      return durableOutput.content || "Waiting for agent output...";
    if (agentOutputText.length > 0) return agentOutputText;
    if (archivedSessions.length > 0) {
      return (
        filterAgentOutput(archivedSessions[archivedSessions.length - 1]?.outputLog ?? "") ||
        (activeTaskState?.state === "suspended"
          ? "Agent suspended (no recent output); waiting for reconnect, new output, or active tool-call activity..."
          : "Waiting for agent output...")
      );
    }
    if (activeTaskState?.state === "suspended") {
      return "Agent suspended (no recent output); waiting for reconnect, new output, or active tool-call activity...";
    }
    return showLoadingPlaceholder ? "Loading output…" : "Waiting for agent output...";
  }, [
    activeTaskState?.state,
    agentOutputText,
    archivedSessions,
    showLoadingPlaceholder,
    durableOutput.content,
  ]);

  const {
    containerRef: liveOutputRef,
    showJumpToBottom,
    jumpToBottom,
    handleScroll: handleLiveOutputScroll,
  } = useAutoScroll({
    contentLength: liveOutputContent.length,
    resetKey: selectedTask,
  });
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLinkConfirm, setDeleteLinkConfirm] = useState<{
    targetId: string;
    type: string;
    taskName: string;
    expectedRevision?: number;
  } | null>(null);
  const [removeLinkRemovingId, setRemoveLinkRemovingId] = useState<string | null>(null);
  const task = selectedTaskData;
  const allTasks = useMemo(() => Object.values(taskById), [taskById]);

  const displayDesc = useMemo(() => {
    if (!task) return "";
    const desc = task.description ?? "";
    const isOnlyFeedbackId = /^Feedback ID:\s*.+$/.test(desc.trim());
    const hasSourceFeedback =
      (task.sourceFeedbackIds?.length ?? (task.sourceFeedbackId ? 1 : 0)) > 0;
    return hasSourceFeedback && isOnlyFeedbackId ? "" : desc;
  }, [task]);

  const feedbackIds = useMemo(
    () => task?.sourceFeedbackIds ?? (task?.sourceFeedbackId ? [task.sourceFeedbackId] : []),
    [task?.sourceFeedbackIds, task?.sourceFeedbackId]
  );
  const sidebarScrollRef = React.useRef<HTMLDivElement>(null);

  const { handleActiveSectionChange } = useSidebarSectionRestore({
    scrollContainerRef: sidebarScrollRef,
    selectedTask,
  });

  const hasActions = isBlockedTask || (!isDoneTask && !isBlockedTask);

  const collapseAllSections = useCallback(() => {
    setDescriptionSectionExpanded(false);
    setDiagnosticsSectionExpanded(false);
    setArtifactsSectionExpanded(false);
    if (feedbackIds.length > 0) {
      const next: Record<string, boolean> = {};
      for (const id of feedbackIds) next[id] = false;
      setSourceFeedbackExpanded(next);
    }
  }, [
    feedbackIds,
    setArtifactsSectionExpanded,
    setDescriptionSectionExpanded,
    setDiagnosticsSectionExpanded,
    setSourceFeedbackExpanded,
  ]);

  const expandAllSections = useCallback(() => {
    setDescriptionSectionExpanded(true);
    setDiagnosticsSectionExpanded(true);
    setArtifactsSectionExpanded(true);
    if (feedbackIds.length > 0) {
      const next: Record<string, boolean> = {};
      for (const id of feedbackIds) next[id] = true;
      setSourceFeedbackExpanded(next);
    }
  }, [
    feedbackIds,
    setArtifactsSectionExpanded,
    setDescriptionSectionExpanded,
    setDiagnosticsSectionExpanded,
    setSourceFeedbackExpanded,
  ]);

  const handleRemoveLink = useMemo(
    () => async (targetId: string) => {
      setRemoveLinkRemovingId(targetId);
      try {
        await dispatch(
          removeTaskDependency({
            projectId,
            taskId: selectedTask,
            parentTaskId: targetId,
            expectedRevision: deleteLinkConfirm?.expectedRevision,
          })
        ).unwrap();
        setDeleteLinkConfirm(null);
      } finally {
        setRemoveLinkRemovingId(null);
      }
    },
    [dispatch, projectId, selectedTask, deleteLinkConfirm?.expectedRevision]
  );

  useEffect(() => {
    setShowLoadingPlaceholder(true);
    const t = setTimeout(() => setShowLoadingPlaceholder(false), 2000);
    return () => clearTimeout(t);
  }, [selectedTask]);

  return (
    <>
      <TaskDetailHeader
        title={task?.title ?? selectedTask ?? ""}
        hasActions={hasActions}
        isBlockedTask={isBlockedTask}
        isDoneTask={isDoneTask}
        markDoneLoading={markDoneLoading}
        unblockLoading={unblockLoading}
        deleteLoading={deleteLoading}
        forceRetryLoading={forceRetryLoading}
        onClose={onClose}
        onMarkDone={onMarkDone}
        onUnblock={onUnblock}
        onDeleteTask={onDeleteTask}
        onForceRetry={onForceRetry}
        deleteConfirmOpen={deleteConfirmOpen}
        setDeleteConfirmOpen={setDeleteConfirmOpen}
        deleteLinkConfirm={deleteLinkConfirm}
        setDeleteLinkConfirm={setDeleteLinkConfirm}
        removeLinkRemovingId={removeLinkRemovingId}
        onRemoveLink={handleRemoveLink}
        projectId={projectId}
        taskId={selectedTask}
        isInProgressTask={isInProgressTask}
        worktreePath={activeTaskState?.worktreePath ?? null}
        isBranchesMode={isBranchesMode}
      />

      <div ref={sidebarScrollRef} className="flex-1 overflow-y-auto min-h-0">
        <SidebarSectionNav
          scrollContainerRef={sidebarScrollRef}
          onCollapseAll={collapseAllSections}
          onExpandAll={expandAllSections}
          onActiveSectionChange={handleActiveSectionChange}
        />
        <div className="pt-2 flex flex-col gap-3">
          <TaskDetailOpenQuestions
            projectId={projectId}
            selectedTask={selectedTask}
            task={task}
            openQuestionNotification={openQuestionNotification}
            onOpenQuestionResolved={onOpenQuestionResolved}
          />

          <TaskDetailMetadata
            projectId={projectId}
            selectedTask={selectedTask}
            task={task}
            taskDetailLoading={taskDetailLoading}
            taskDetailError={taskDetailError}
            taskIdToStartedAt={taskIdToStartedAt}
            roleLabel={roleLabel}
            isDoneTask={isDoneTask}
            isBlockedTask={isBlockedTask}
            isInProgressTask={isInProgressTask}
            enableHumanTeammates={enableHumanTeammates}
            teamMembers={teamMembers}
          />

          {task && (
            <TaskDetailLinks
              projectId={projectId}
              selectedTask={selectedTask}
              task={task}
              planByEpicId={planByEpicId}
              taskById={taskById}
              allTasks={allTasks}
              onNavigateToPlan={onNavigateToPlan}
              onSelectTask={onSelectTask}
              setDeleteLinkConfirm={setDeleteLinkConfirm}
              removeLinkRemovingId={removeLinkRemovingId}
              onAddLink={async (parentTaskId, type, expectedRevision) => {
                await dispatch(
                  addTaskDependency({
                    projectId,
                    taskId: selectedTask,
                    parentTaskId,
                    type: type as "blocks" | "related" | "parent-child",
                    expectedRevision,
                  })
                ).unwrap();
              }}
            />
          )}

          {task && displayDesc ? (
            <TaskDetailDescription
              content={displayDesc}
              expanded={descriptionSectionExpanded}
              onToggle={() => setDescriptionSectionExpanded((prev) => !prev)}
              sectionNavId="execute-description-section"
              sectionNavTitle="Description"
            />
          ) : null}
        </div>

        <TaskDetailFeedbackSections
          projectId={projectId}
          feedbackIds={feedbackIds}
          sourceFeedbackExpanded={sourceFeedbackExpanded}
          setSourceFeedbackExpanded={setSourceFeedbackExpanded}
        />

        <CollapsibleSection
          title="Execution diagnostics"
          expanded={diagnosticsSectionExpanded}
          onToggle={() => setDiagnosticsSectionExpanded((prev) => !prev)}
          expandAriaLabel="Expand Execution diagnostics"
          collapseAriaLabel="Collapse Execution diagnostics"
          contentId="execution-diagnostics-content"
          headerId="execution-diagnostics-header"
          sectionNavId="execute-diagnostics-section"
          sectionNavTitle="Execution diagnostics"
        >
          <TaskDetailDiagnostics
            task={task}
            diagnostics={diagnostics}
            diagnosticsLoading={diagnosticsLoading}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title={isDoneTask ? "Done Work Artifacts" : "Live agent output"}
          expanded={artifactsSectionExpanded}
          onToggle={() => setArtifactsSectionExpanded(!artifactsSectionExpanded)}
          expandAriaLabel={`Expand ${isDoneTask ? "Done Work Artifacts" : "Live agent output"}`}
          collapseAriaLabel={`Collapse ${isDoneTask ? "Done Work Artifacts" : "Live agent output"}`}
          contentId="artifacts-content"
          headerId="artifacts-header"
          sectionNavId="execute-artifacts-section"
          sectionNavTitle={isDoneTask ? "Done Work Artifacts" : "Live agent output"}
          contentClassName="p-0"
        >
          <ExecuteOutputTabs
            key={selectedTask}
            outputContent={
              <div
                className="h-full min-h-0 overflow-y-auto"
                data-testid="live-output-scroll-container"
              >
                <TaskDetailAgentOutput
                  projectId={projectId}
                  taskDetailLoading={taskDetailLoading}
                  isDoneTask={isDoneTask}
                  archivedLoading={archivedLoading}
                  archivedSessions={archivedSessions}
                  liveOutputContent={liveOutputContent}
                  completionState={completionState}
                  wsConnected={wsConnected || durableOutput.content !== null}
                  retentionGap={durableOutput.retentionGap}
                  executionState={durableOutput.state}
                  containerRef={liveOutputRef}
                  onScroll={handleLiveOutputScroll}
                  showJumpToBottom={showJumpToBottom}
                  jumpToBottom={jumpToBottom}
                  scrollResetKey={selectedTask}
                  lastOutputReceivedAtIso={
                    !isDoneTask && wsConnected ? lastOutputReceivedAtIso : null
                  }
                />
              </div>
            }
            chatContent={
              <div
                className="h-full min-h-0 overflow-hidden flex flex-col"
                data-testid="chat-section-scroll-container"
              >
                <ExecuteAgentChatPanel
                  messages={chatMessages}
                  sending={chatSending}
                  onSend={onChatSend ?? (() => {})}
                  draftStorageKey={chatDraftStorageKey}
                  agentRunning={activeTaskState?.state === "running"}
                  chatSupported={chatSupported}
                  chatUnsupportedReason={chatUnsupportedReason}
                  scrollResetKey={selectedTask}
                  scrollTriggerKey={chatTabScrollTrigger}
                />
              </div>
            }
            onTabChange={(tab) => {
              if (tab === "chat") {
                setChatTabScrollTrigger((n) => n + 1);
              }
            }}
          />
        </CollapsibleSection>
      </div>
    </>
  );
}

export const TaskDetailSidebar = React.memo(TaskDetailSidebarInner, areTaskDetailSidebarPropsEqual);
