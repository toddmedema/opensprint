import { useCallback } from "react";
import type { Notification } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../store";
import {
  fetchProjectNotifications,
  selectProjectNotifications,
} from "../store/slices/openQuestionsSlice";

/**
 * Fetches open-question notifications for a project.
 * Used by phases to add data-question-id to question blocks for scroll-to-target.
 */
export function useOpenQuestionNotifications(projectId: string | null): {
  notifications: Notification[];
  refetch: () => void;
} {
  const dispatch = useAppDispatch();
  const notifications = useAppSelector((state) => selectProjectNotifications(state, projectId));

  const fetchNotifications = useCallback(() => {
    if (!projectId) return;
    void dispatch(fetchProjectNotifications(projectId));
  }, [dispatch, projectId]);

  return { notifications, refetch: fetchNotifications };
}
