import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@opensprint/shared";
import { api } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { normalizeTaskListResponse } from "../api/taskList";

const EMPTY_TASKS: Task[] = [];

/** Subscribe to one task in the canonical project cache without fetching N task details. */
export function useServerTask(projectId: string | undefined, taskId: string) {
  return useQuery({
    queryKey: queryKeys.tasks.list(projectId ?? ""),
    queryFn: async () => normalizeTaskListResponse(await api.tasks.list(projectId!)),
    enabled: false,
    select: (tasks) => tasks.find((task) => task.id === taskId),
  });
}

export function useServerEpicTasks(projectId: string | undefined, epicId: string) {
  const query = useQuery({
    queryKey: queryKeys.tasks.list(projectId ?? ""),
    queryFn: async () => normalizeTaskListResponse(await api.tasks.list(projectId!)),
    enabled: false,
  });
  return useMemo(
    () => (query.data ?? EMPTY_TASKS).filter((task) => task.epicId === epicId),
    [query.data, epicId]
  );
}
