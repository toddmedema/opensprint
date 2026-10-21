import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { collaborationApi } from "../api/collaboration";
/** The cursor is established before refetching resources; subsequent pages cover changes during fetch. */
export function useProjectReplay(projectId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!projectId || !enabled) return;
    const client = collaborationApi(projectId);
    let cancelled = false;
    let cursor: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () =>
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes(projectId) });
    const poll = async () => {
      try {
        if (cursor === undefined) {
          cursor = (await client.snapshot()).cursor;
          await refresh();
        }
        for (let page = 0; page < 50 && !cancelled; page++) {
          const replay = await client.replay(cursor);
          cursor = replay.nextCursor;
          if (replay.events.length) await refresh();
          if (!replay.hasMore) break;
        }
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          "details" in err &&
          err.details &&
          typeof err.details === "object" &&
          "resetRequired" in err.details
        )
          cursor = undefined;
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, enabled, queryClient]);
}
