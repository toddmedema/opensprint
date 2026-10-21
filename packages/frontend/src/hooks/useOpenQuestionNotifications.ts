import { useCallback } from "react";
import type { Notification } from "@opensprint/shared";
import { useProjectNotifications } from "../api/hooks";
const EMPTY_NOTIFICATIONS: Notification[] = [];

/**
 * Fetches open-question notifications for a project.
 * Used by phases to add data-question-id to question blocks for scroll-to-target.
 */
export function useOpenQuestionNotifications(projectId: string | null): {
  notifications: Notification[];
  refetch: () => void;
} {
  const query = useProjectNotifications(projectId ?? undefined);
  const refetch = query.refetch;

  const fetchNotifications = useCallback(() => {
    if (!projectId) return;
    void refetch();
  }, [refetch, projectId]);

  return { notifications: query.data ?? EMPTY_NOTIFICATIONS, refetch: fetchNotifications };
}
