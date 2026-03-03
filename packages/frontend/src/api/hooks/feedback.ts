import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../queryKeys";

export function useFeedback(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.feedback.list(projectId ?? ""),
    queryFn: () => api.feedback.list(projectId!),
    enabled: Boolean(projectId) && options?.enabled !== false,
  });
}

export function useFeedbackItem(
  projectId: string | undefined,
  feedbackId: string | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: [...queryKeys.feedback.list(projectId ?? ""), "item", feedbackId] as const,
    queryFn: () => api.feedback.get(projectId!, feedbackId!),
    enabled: Boolean(projectId) && Boolean(feedbackId) && options?.enabled !== false,
  });
}

export function useSubmitFeedback(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      text,
      images,
      parentId,
      priority,
    }: {
      text: string;
      images?: string[];
      parentId?: string | null;
      priority?: number | null;
    }) => api.feedback.submit(projectId, text, images, parentId, priority),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
    },
  });
}

export function useRecategorizeFeedback(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ feedbackId, answer }: { feedbackId: string; answer?: string }) =>
      api.feedback.recategorize(projectId, feedbackId, answer),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
    },
  });
}

export function useResolveFeedback(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (feedbackId: string) => api.feedback.resolve(projectId, feedbackId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
    },
  });
}

export function useCancelFeedback(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (feedbackId: string) => api.feedback.cancel(projectId, feedbackId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
    },
  });
}
