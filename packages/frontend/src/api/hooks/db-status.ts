import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

export const DB_STATUS_QUERY_KEY = ["db-status"] as const;
const CONNECTED_FALLBACK = {
  ok: true as const,
  state: "connected" as const,
  lastCheckedAt: null,
};

export function useDbStatus() {
  return useQuery({
    queryKey: DB_STATUS_QUERY_KEY,
    queryFn: () => (api.dbStatus?.get ? api.dbStatus.get() : Promise.resolve(CONNECTED_FALLBACK)),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
