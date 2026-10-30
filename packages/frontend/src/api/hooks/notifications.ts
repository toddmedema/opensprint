import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../queryKeys";
import type { Notification } from "@opensprint/shared";

export function useProjectNotifications(
  projectId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.notifications.project(projectId ?? ""),
    queryFn: () => api.notifications.listByProject(projectId!),
    enabled: Boolean(projectId) && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
  });
}

export function useGlobalNotifications(options?: { enabled?: boolean; refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.notifications.global(),
    queryFn: () => api.notifications.listGlobal(),
    enabled: options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
  });
}

export function useClearProjectNotifications(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.notifications.clearAllByProject(projectId),
    onSuccess: () => {
      queryClient.setQueryData<Notification[]>(
        queryKeys.notifications.project(projectId),
        (items) => items?.filter((item) => item.kind === "governance") ?? []
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.global() });
    },
  });
}

export function useClearGlobalNotifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.notifications.clearAllGlobal(),
    onSuccess: () => {
      queryClient.setQueryData<Notification[]>(
        queryKeys.notifications.global(),
        (items) => items?.filter((item) => item.kind === "governance") ?? []
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.global() });
      void queryClient.invalidateQueries({ queryKey: ["notifications", "project"] });
    },
  });
}
