import type { DeploymentConfig } from "@opensprint/shared";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../queryKeys";

export function useDeliverStatus(
  projectId: string | undefined,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.deliver.status(projectId ?? ""),
    queryFn: () => api.deliver.status(projectId!),
    enabled: Boolean(projectId) && (options?.enabled !== false),
    refetchInterval: options?.refetchInterval,
  });
}

export function useDeliverHistory(
  projectId: string | undefined,
  limit?: number,
  options?: { enabled?: boolean; refetchInterval?: number }
) {
  return useQuery({
    queryKey: queryKeys.deliver.history(projectId ?? ""),
    queryFn: () => api.deliver.history(projectId!, limit),
    enabled: Boolean(projectId) && (options?.enabled !== false),
    refetchInterval: options?.refetchInterval,
  });
}

export function useTriggerDeliver(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target?: string) => api.deliver.deploy(projectId, target),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.deliver.status(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.deliver.history(projectId) });
    },
  });
}

export function useExpoDeploy(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (variant: "beta" | "prod") => api.deliver.expoDeploy(projectId, variant),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.deliver.status(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.deliver.history(projectId) });
    },
  });
}

export function useRollbackDeliver(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deployId: string) => api.deliver.rollback(projectId, deployId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.deliver.status(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.deliver.history(projectId) });
    },
  });
}

export function useUpdateDeliverSettings(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deployment: Partial<DeploymentConfig>) =>
      api.deliver.updateSettings(projectId, deployment),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.deliver.status(projectId) });
    },
  });
}
