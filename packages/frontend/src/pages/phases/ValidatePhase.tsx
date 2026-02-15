import { useState, useEffect } from "react";
import { api } from "../../api/client";
import { useProjectWebSocket } from "../../contexts/ProjectWebSocketContext";
import type { FeedbackItem, FeedbackMappedEvent } from "@opensprint/shared";

interface ValidatePhaseProps {
  projectId: string;
}

const categoryColors: Record<string, string> = {
  bug: "bg-red-50 text-red-700",
  feature: "bg-purple-50 text-purple-700",
  ux: "bg-blue-50 text-blue-700",
  scope: "bg-yellow-50 text-yellow-700",
};

const statusColors: Record<string, string> = {
  pending: "bg-gray-100 text-gray-600",
  mapped: "bg-blue-100 text-blue-700",
  resolved: "bg-green-100 text-green-700",
};

export function ValidatePhase({ projectId }: ValidatePhaseProps) {
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { registerEventHandler } = useProjectWebSocket();

  useEffect(() => {
    api.feedback
      .list(projectId)
      .then((data) => setFeedback(data as FeedbackItem[]))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    const handleFeedbackMapped = (event: FeedbackMappedEvent) => {
      setFeedback((prev) =>
        prev.map((item) =>
          item.id === event.feedbackId
            ? {
                ...item,
                mappedPlanId: event.planId || item.mappedPlanId,
                createdTaskIds: event.taskIds,
                status: "mapped" as const,
              }
            : item,
        ),
      );
    };
    const unregister = registerEventHandler((e) => {
      if (e.type === "feedback.mapped") handleFeedbackMapped(e);
    });
    return unregister;
  }, [registerEventHandler]);

  const handleSubmit = async () => {
    if (!input.trim() || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const item = await api.feedback.submit(projectId, input.trim());
      setFeedback((prev) => [item as FeedbackItem, ...prev]);
      setInput("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to submit feedback";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-500 hover:text-red-700 underline">
            Dismiss
          </button>
        </div>
      )}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Validate</h2>
        <p className="text-sm text-gray-500">
          Test your application and report feedback. The AI will map issues to the right features and create tickets
          automatically.
        </p>
      </div>

      {/* Feedback Input */}
      <div className="card p-5 mb-8">
        <label className="block text-sm font-medium text-gray-700 mb-2">What did you find?</label>
        <textarea
          className="input min-h-[100px] mb-3"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe a bug, suggest a feature, or report a UX issue..."
          disabled={submitting}
        />
        <div className="flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={submitting || !input.trim()}
            className="btn-primary disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit Feedback"}
          </button>
        </div>
      </div>

      {/* Feedback Feed */}
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Feedback History ({feedback.length})</h3>

      {loading ? (
        <div className="text-center py-10 text-gray-400">Loading feedback...</div>
      ) : feedback.length === 0 ? (
        <div className="text-center py-10 text-gray-400 text-sm">
          No feedback submitted yet. Test your app and report findings above.
        </div>
      ) : (
        <div className="space-y-3">
          {feedback.map((item) => (
            <div key={item.id} className="card p-4">
              <div className="flex items-start justify-between mb-2">
                <p className="text-sm text-gray-900 flex-1">{item.text}</p>
                <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      categoryColors[item.category] ?? "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {item.category}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                      statusColors[item.status] ?? "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
              </div>

              {item.mappedPlanId && (
                <p className="text-xs text-gray-500">
                  Mapped to plan: <span className="font-mono">{item.mappedPlanId}</span>
                </p>
              )}

              {item.createdTaskIds.length > 0 && (
                <div className="mt-1 flex gap-1">
                  {item.createdTaskIds.map((taskId) => (
                    <span
                      key={taskId}
                      className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-600"
                    >
                      {taskId}
                    </span>
                  ))}
                </div>
              )}

              <p className="text-xs text-gray-400 mt-2">{new Date(item.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
