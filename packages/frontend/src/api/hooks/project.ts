import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../queryKeys";

export function useProject(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.projects.detail(projectId ?? ""),
    queryFn: () => api.projects.get(projectId!),
    enabled: Boolean(projectId) && options?.enabled !== false,
  });
}
