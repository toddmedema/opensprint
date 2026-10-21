import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../queryKeys";
import { useAppDispatch } from "../../store";
import { setDecomposeProgress } from "../../store/slices/planSlice";

/** Normalize API messages to { role, content, timestamp }. */
function normalizeMessages(
  raw: unknown
): { role: "user" | "assistant"; content: string; timestamp: string }[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ role?: string; content?: string; timestamp?: string }>)
    .filter(
      (m) =>
        m != null &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content!,
      timestamp: typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString(),
    }));
}

export function usePlanStatus(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.plans.status(projectId ?? ""),
    queryFn: () => api.projects.getPlanStatus(projectId!),
    enabled: Boolean(projectId) && options?.enabled !== false,
  });
}

export function usePlans(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.plans.list(projectId ?? ""),
    queryFn: () => api.plans.list(projectId!),
    enabled: Boolean(projectId) && options?.enabled !== false,
  });
}

export function useSinglePlan(
  projectId: string | undefined,
  planId: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.plans.detail(projectId ?? "", planId ?? ""),
    queryFn: () => api.plans.get(projectId!, planId!),
    enabled: Boolean(projectId) && Boolean(planId) && options?.enabled !== false,
  });
}

export function usePlanHierarchy(
  projectId: string | undefined,
  planId: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.plans.hierarchy(projectId ?? "", planId ?? ""),
    queryFn: () => api.plans.getHierarchy(projectId!, planId!),
    enabled: Boolean(projectId) && Boolean(planId) && options?.enabled !== false,
  });
}

export function usePlanVersions(
  projectId: string | undefined,
  planId: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.plans.versions(projectId ?? "", planId ?? ""),
    queryFn: () => api.plans.listVersions(projectId!, planId!),
    enabled: Boolean(projectId) && Boolean(planId) && options?.enabled !== false,
  });
}

export function usePlanVersion(
  projectId: string | undefined,
  planId: string | undefined,
  versionNumber: number | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.plans.version(projectId ?? "", planId ?? "", versionNumber ?? 0),
    queryFn: () => api.plans.getVersion(projectId!, planId!, versionNumber!),
    enabled:
      Boolean(projectId) &&
      Boolean(planId) &&
      versionNumber != null &&
      versionNumber > 0 &&
      options?.enabled !== false,
  });
}

export function usePlanChat(
  projectId: string | undefined,
  context: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.plans.chat(projectId ?? "", context ?? ""),
    queryFn: async () => {
      const conv = await api.chat.history(projectId!, context!);
      return { context: context!, messages: normalizeMessages(conv?.messages ?? []) };
    },
    enabled: Boolean(projectId) && Boolean(context?.trim()) && options?.enabled !== false,
  });
}

export function useDecomposePlans(projectId: string) {
  const dispatch = useAppDispatch();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.plans.decompose(projectId),
    mutationFn: () => api.plans.decompose(projectId),
    onMutate: () => {
      dispatch(setDecomposeProgress({ createdCount: 0, totalCount: null }));
    },
    onSuccess: (result) => {
      const createdCount = Math.max(0, result?.created ?? 0);
      dispatch(setDecomposeProgress({ createdCount, totalCount: createdCount }));
    },
    /** Always refresh list after decompose settles so Plan phase can leave "generating" even on error. */
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    },
  });
}

export function useGeneratePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import("@opensprint/shared").GeneratePlanRequest) =>
      api.plans.generate(projectId, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    },
  });
}

export function useExecutePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      planId,
      prerequisitePlanIds,
      version_number,
    }: {
      planId: string;
      prerequisitePlanIds?: string[];
      version_number?: number;
    }) => api.plans.execute(projectId, planId, { prerequisitePlanIds, version_number }),
    onSuccess: (_, { planId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.detail(projectId, planId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.versions(projectId, planId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.auditorRuns(projectId, planId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.execute.status(projectId) });
    },
  });
}

export function useReExecutePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.plans.reExecute(projectId, planId),
    onSuccess: (_, planId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.detail(projectId, planId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.auditorRuns(projectId, planId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.execute.status(projectId) });
    },
  });
}

export function useArchivePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.plans.archive(projectId, planId),
    onSuccess: (_, planId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.detail(projectId, planId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
    },
  });
}

export function useMarkPlanComplete(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.plans.markPlanComplete(projectId, planId),
    onSuccess: (_, planId) => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.detail(projectId, planId) });
    },
  });
}

export function useUpdatePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      planId,
      content,
      expectedRevision,
    }: {
      planId: string;
      content: string;
      expectedRevision?: number;
    }) =>
      expectedRevision === undefined
        ? api.plans.update(projectId, planId, { content })
        : api.plans.update(projectId, planId, { content }, { expectedRevision }),
    onSuccess: (_, { planId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.detail(projectId, planId) });
    },
  });
}

export function useSendPlanMessage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ message, context }: { message: string; context: string }) =>
      api.chat.send(projectId, message, context),
    onSuccess: (_, { context }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.chat(projectId, context) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    },
  });
}

export function usePlanTasks(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ planId }: { planId: string }) => api.plans.planTasks(projectId, planId),
    onSuccess: (_, { planId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.detail(projectId, planId) });
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
    },
  });
}

export function useDeletePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.plans.delete(projectId, planId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
    },
  });
}

export function useAuditorRuns(
  projectId: string | undefined,
  planId: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.plans.auditorRuns(projectId ?? "", planId ?? ""),
    queryFn: () => api.plans.auditorRuns(projectId!, planId!),
    enabled: Boolean(projectId) && Boolean(planId) && options?.enabled !== false,
  });
}
