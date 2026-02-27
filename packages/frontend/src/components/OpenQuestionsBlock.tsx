import { useState, useCallback } from "react";
import type { Notification } from "@opensprint/shared";
import { api } from "../api/client";

export interface OpenQuestionsBlockProps {
  /** Open question notification (agent clarification request) */
  notification: Notification;
  projectId: string;
  /** Source determines Answer behavior: plan uses chat, execute uses task chat */
  source: "plan" | "execute";
  /** For plan: planId. For execute: taskId. Used for chat context. */
  sourceId: string;
  /** Called when notification is resolved (after Dismiss or successful Answer) */
  onResolved: () => void;
  /** When provided, Answer sends via this callback (plan chat, task chat). */
  onAnswerSent?: (message: string) => Promise<void>;
}

/**
 * Renders open questions from an agent with Answer and Dismiss actions.
 * Plan: Answer sends via plan chat. Execute: Answer sends via task chat (or inline).
 */
export function OpenQuestionsBlock({
  notification,
  projectId,
  source,
  sourceId,
  onResolved,
  onAnswerSent,
}: OpenQuestionsBlockProps) {
  const [answerText, setAnswerText] = useState("");
  const [answerSubmitting, setAnswerSubmitting] = useState(false);
  const [dismissLoading, setDismissLoading] = useState(false);

  const handleDismiss = useCallback(async () => {
    setDismissLoading(true);
    try {
      await api.notifications.resolve(projectId, notification.id);
      onResolved();
    } catch {
      setDismissLoading(false);
    }
  }, [projectId, notification.id, onResolved]);

  const handleAnswer = useCallback(async () => {
    const trimmed = answerText.trim();
    if (!trimmed || !onAnswerSent) return;

    setAnswerSubmitting(true);
    try {
      await onAnswerSent(trimmed);
      setAnswerText("");
      await api.notifications.resolve(projectId, notification.id);
      onResolved();
    } finally {
      setAnswerSubmitting(false);
    }
  }, [answerText, onAnswerSent, projectId, notification.id, onResolved]);

  const questions = notification.questions ?? [];
  if (questions.length === 0) return null;

  return (
    <div
      className="p-4 border-b border-theme-border bg-theme-warning-bg/30 border-l-4 border-l-theme-warning-solid"
      data-question-id={notification.id}
      data-testid="open-questions-block"
    >
      <h4 className="text-xs font-medium text-theme-muted uppercase tracking-wide mb-2">
        Open questions
      </h4>
      <p className="text-xs text-theme-muted mb-2">
        The {source === "plan" ? "planner" : "coder"} needs clarification before proceeding.
      </p>
      <ul className="space-y-2 mb-3">
        {questions.map((q) => (
          <li
            key={q.id}
            className="text-sm text-theme-text bg-theme-surface rounded-lg px-3 py-2 border border-theme-border"
          >
            {q.text}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        {onAnswerSent && (
          <div className="flex gap-2">
            <input
              type="text"
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAnswer()}
              placeholder="Type your answer..."
              className="flex-1 text-sm px-3 py-2 rounded-lg border border-theme-border bg-theme-surface text-theme-text placeholder-theme-muted focus:ring-2 focus:ring-theme-info-border focus:border-theme-info-border outline-none"
              aria-label="Answer to open questions"
              data-testid="open-questions-answer-input"
              disabled={answerSubmitting}
            />
            <button
              type="button"
              onClick={handleAnswer}
              disabled={!answerText.trim() || answerSubmitting}
              className="btn-primary text-sm px-3 py-2 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="open-questions-answer-btn"
            >
              {answerSubmitting ? "Sending…" : "Answer"}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={handleDismiss}
          disabled={dismissLoading}
          className="text-xs text-theme-muted hover:text-theme-text hover:underline self-start disabled:opacity-50"
          data-testid="open-questions-dismiss-btn"
        >
          {dismissLoading ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
