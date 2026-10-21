import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  TaskExecutionDiagnostics,
  AgentChatHistoryResponse,
  AgentChatSupportResponse,
} from "@opensprint/shared";
import { api } from "../client";
import { queryKeys } from "../queryKeys";
import { normalizeTaskListResponse } from "../taskList";

/** Poll interval (ms) when WebSocket is disconnected so Execute page still gets task status updates from other clients/agents. */
export const TASKS_LIVE_POLL_MS = 4000;
/** Safety poll interval (ms) while WebSocket is connected to recover from silent Electron/macOS socket stalls without manual refresh. */
export const TASKS_WS_SAFETY_POLL_MS = 15000;

/** Task-list refetch cadence for Execute page: fast when disconnected, low-frequency safety when connected. */
export function getExecuteTasksRefetchInterval(wsConnected: boolean): number {
  return wsConnected ? TASKS_WS_SAFETY_POLL_MS : TASKS_LIVE_POLL_MS;
}

export function useTasks(
  projectId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number | false }
) {
  return useQuery({
    queryKey: queryKeys.tasks.list(projectId ?? ""),
    queryFn: async () => normalizeTaskListResponse(await api.tasks.list(projectId!)),
    enabled: Boolean(projectId) && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
  });
}

export function useTaskDetail(
  projectId: string | undefined,
  taskId: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(projectId ?? "", taskId ?? ""),
    queryFn: () => api.tasks.get(projectId!, taskId!),
    enabled: Boolean(projectId) && Boolean(taskId) && options?.enabled !== false,
  });
}

export function useArchivedSessions(
  projectId: string | undefined,
  taskId: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.tasks.sessions(projectId ?? "", taskId ?? ""),
    queryFn: async () => (await api.tasks.sessions(projectId!, taskId!)) ?? [],
    enabled: Boolean(projectId) && Boolean(taskId) && options?.enabled !== false,
  });
}

export function useExecuteStatus(
  projectId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.execute.status(projectId ?? ""),
    queryFn: () => api.execute.status(projectId!),
    enabled: Boolean(projectId) && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
  });
}

export function useLiveOutputBackfill(
  projectId: string | undefined,
  taskId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.execute.liveOutput(projectId ?? "", taskId ?? ""),
    queryFn: async () => (await api.execute.liveOutput(projectId!, taskId!)).output,
    enabled: Boolean(projectId) && Boolean(taskId) && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
  });
}

export function useTaskExecutionDiagnostics(
  projectId: string | undefined,
  taskId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number | false }
) {
  return useQuery<TaskExecutionDiagnostics>({
    queryKey: queryKeys.execute.diagnostics(projectId ?? "", taskId ?? ""),
    queryFn: () => api.execute.taskDiagnostics(projectId!, taskId!),
    enabled: Boolean(projectId) && Boolean(taskId) && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
  });
}

export function useMarkTaskDone(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.tasks.markDone(projectId, taskId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.execute.status(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    },
  });
}

export function useUpdateTaskPriority(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      priority,
      expectedRevision,
    }: {
      taskId: string;
      priority: number;
      expectedRevision?: number;
    }) =>
      expectedRevision === undefined
        ? api.tasks.updatePriority(projectId, taskId, priority)
        : api.tasks.updatePriority(projectId, taskId, priority, { expectedRevision }),
    onSuccess: (_, { taskId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(projectId, taskId) });
    },
  });
}

export function useUpdateTaskAssignee(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      assignee,
      expectedRevision,
    }: {
      taskId: string;
      assignee: string | null;
      expectedRevision?: number;
    }) =>
      expectedRevision === undefined
        ? api.tasks.updateTask(projectId, taskId, { assignee })
        : api.tasks.updateTask(projectId, taskId, { assignee }, { expectedRevision }),
    onSuccess: (task) => {
      qc.setQueryData(queryKeys.tasks.detail(projectId, task.id), task);
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.projects.settings(projectId) });
    },
  });
}

export function useUnblockTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, resetAttempts }: { taskId: string; resetAttempts?: boolean }) =>
      api.tasks.unblock(projectId, taskId, { resetAttempts }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.execute.status(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    },
  });
}

export function useDeleteTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.tasks.delete(projectId, taskId),
    onSuccess: (_, taskId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(projectId, taskId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.sessions(projectId, taskId) });
      void qc.invalidateQueries({ queryKey: queryKeys.execute.status(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
    },
  });
}

export function useForceRetryTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.tasks.forceRetry(projectId, taskId),
    onSuccess: (_, taskId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(projectId, taskId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.sessions(projectId, taskId) });
      void qc.invalidateQueries({ queryKey: queryKeys.execute.status(projectId) });
      void qc.invalidateQueries({
        queryKey: queryKeys.execute.diagnostics(projectId, taskId),
      });
    },
  });
}

export function useAddTaskDependency(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      parentTaskId,
      type,
    }: {
      taskId: string;
      parentTaskId: string;
      type?: "blocks" | "parent-child" | "related";
    }) => api.tasks.addDependency(projectId, taskId, parentTaskId, type),
    onSuccess: (_, { taskId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(projectId, taskId) });
    },
  });
}

export function useOpenEditor(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.tasks.openEditor(projectId, taskId),
    onSuccess: (_, taskId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(projectId, taskId) });
    },
  });
}

export function useAgentChatHistory(
  projectId: string | undefined,
  taskId: string | undefined,
  options?: { enabled?: boolean; attempt?: number; refetchInterval?: number | false }
) {
  return useQuery<AgentChatHistoryResponse>({
    queryKey: queryKeys.tasks.chatHistory(projectId ?? "", taskId ?? "", options?.attempt),
    queryFn: () => api.tasks.chatHistory(projectId!, taskId!, options?.attempt),
    enabled: Boolean(projectId) && Boolean(taskId) && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
  });
}

export function useAgentChatSupport(
  projectId: string | undefined,
  taskId: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery<AgentChatSupportResponse>({
    queryKey: queryKeys.tasks.chatSupport(projectId ?? "", taskId ?? ""),
    queryFn: () => api.tasks.chatSupport(projectId!, taskId!),
    enabled: Boolean(projectId) && Boolean(taskId) && options?.enabled !== false,
  });
}

/** Active agents (for Execute phase). Use refetchInterval for polling. */
export function useActiveAgents(
  projectId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.agents.active(projectId ?? ""),
    queryFn: async () => {
      const agents = await api.agents.active(projectId!);
      const taskIdToStartedAt: Record<string, string> = {};
      for (const a of agents) {
        if (a.phase === "coding" || a.phase === "review") {
          taskIdToStartedAt[a.taskId ?? a.id] = a.startedAt;
        }
      }
      return { agents, taskIdToStartedAt };
    },
    enabled: Boolean(projectId) && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
  });
}
