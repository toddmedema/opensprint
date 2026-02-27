import { useState, useEffect, useCallback } from "react";
import type { Notification } from "@opensprint/shared";
import { api } from "../api/client";

const POLL_INTERVAL_MS = 5000;

/**
 * Fetches open-question notifications for a project.
 * Used by phases to add data-question-id to question blocks for scroll-to-target.
 */
export function useOpenQuestionNotifications(projectId: string | null): {
  notifications: Notification[];
  refetch: () => void;
} {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const fetchNotifications = useCallback(() => {
    if (!projectId) return;
    api.notifications.listByProject(projectId).then(setNotifications).catch(() => setNotifications([]));
  }, [projectId]);

  useEffect(() => {
    fetchNotifications();
    if (!projectId) return;
    const interval = setInterval(fetchNotifications, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchNotifications, projectId]);

  return { notifications, refetch: fetchNotifications };
}
