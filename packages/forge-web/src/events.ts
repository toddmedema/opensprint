import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isProjectEvent, queryKeys } from "./api";

export type LiveState = "off" | "connecting" | "connected" | "reconnecting";

export function useProjectEvents(projectId: string | undefined): LiveState {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveState>(projectId ? "connecting" : "off");

  useEffect(() => {
    if (!projectId) {
      setLive("off");
      return;
    }

    setLive("connecting");
    const source = new EventSource(`/projects/${encodeURIComponent(projectId)}/events`, {
      withCredentials: true,
    });

    const refresh = (type: string) => {
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes(projectId),
      });
      if (type === "membership.updated" || type === "work_item.updated" || type === "run.updated") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.home });
      }
      if (type === "membership.updated") {
        void queryClient.invalidateQueries({ queryKey: ["team"] });
      }
    };

    const onNamed = (event: Event) => {
      refresh(event.type);
    };

    for (const type of [
      "run.updated",
      "work_item.updated",
      "thread.appended",
      "runbook.updated",
      "membership.updated",
    ]) {
      source.addEventListener(type, onNamed);
    }

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: unknown };
        if (typeof data.type === "string" && isProjectEvent(data.type)) refresh(data.type);
      } catch {
        // Ignore keepalives and non-JSON frames.
      }
    };

    source.onopen = () => setLive("connected");
    source.onerror = () => setLive("reconnecting");

    return () => {
      source.close();
    };
  }, [projectId, queryClient]);

  return live;
}
