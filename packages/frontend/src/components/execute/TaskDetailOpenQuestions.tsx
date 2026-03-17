import React from "react";
import type { Notification, Task } from "@opensprint/shared";
import { OpenQuestionsBlock } from "../OpenQuestionsBlock";
import { api } from "../../api/client";

export interface TaskDetailOpenQuestionsProps {
  projectId: string;
  selectedTask: string;
  task: Task | null;
  openQuestionNotification: Notification | null | undefined;
  onOpenQuestionResolved?: (resolved?: Notification, notificationIdToRemove?: string) => void;
}

export function TaskDetailOpenQuestions({
  projectId,
  selectedTask,
  task,
  openQuestionNotification,
  onOpenQuestionResolved,
}: TaskDetailOpenQuestionsProps) {
  if (!openQuestionNotification || !task) return null;

  return (
    <OpenQuestionsBlock
      notification={openQuestionNotification}
      projectId={projectId}
      source="execute"
      sourceId={selectedTask}
      onResolved={(resolved, notificationIdToRemove) =>
        onOpenQuestionResolved?.(resolved, notificationIdToRemove)
      }
      onAnswerSent={async (message) => {
        const taskContext = {
          id: task.id,
          title: task.title,
          description: task.description ?? "",
          status: task.status,
          kanbanColumn: task.kanbanColumn,
        };
        await api.chat.send(
          projectId,
          message,
          `execute:${selectedTask}`,
          undefined,
          undefined,
          taskContext
        );
      }}
    />
  );
}
