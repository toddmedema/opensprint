import { useState } from "react";
import type { FeedbackItem } from "@opensprint/shared";
import { useAppDispatch, useAppSelector } from "../../store";
import { submitFeedback, setVerifyError } from "../../store/slices/verifySlice";

interface VerifyPhaseProps {
  projectId: string;
  onNavigateToBuildTask?: (taskId: string) => void;
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

export function VerifyPhase({ projectId, onNavigateToBuildTask }: VerifyPhaseProps) {
  const dispatch = useAppDispatch();

  /* ── Redux state ── */
  const feedback = useAppSelector((s) => s.verify.feedback);
  const loading = useAppSelector((s) => s.verify.loading);
  const submitting = useAppSelector((s) => s.verify.submitting);
  const error = useAppSelector((s) => s.verify.error);

  /* ── Local UI state (preserved by mount-all) ── */
  const [input, setInput] = useState("");

  const handleSubmit = async () => {
    if (!input.trim() || submitting) return;
    const text = input.trim();
    const result = await dispatch(submitFeedback({ projectId, text }));
    if (submitFeedback.fulfilled.match(result)) {
      setInput("");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center">
            <span>{error}</span>
            <button type="button" onClick={() => dispatch(setVerifyError(null))} className="text-red-500 hover:text-red-700 underline">
              Dismiss
            </button>
          </div>
        )}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Verify</h2>
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
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
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
            {feedback.map((item: FeedbackItem) => (
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
                  <div className="mt-1 flex gap-1 flex-wrap">
                    {item.createdTaskIds.map((taskId) =>
                      onNavigateToBuildTask ? (
                        <button
                          key={taskId}
                          type="button"
                          onClick={() => onNavigateToBuildTask(taskId)}
                          className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-brand-600 hover:bg-brand-50 hover:text-brand-700 underline transition-colors"
                          title={`Go to ${taskId} on Build tab`}
                        >
                          {taskId}
                        </button>
                      ) : (
                        <span
                          key={taskId}
                          className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-600"
                        >
                          {taskId}
                        </span>
                      ),
                    )}
                  </div>
                )}

                <p className="text-xs text-gray-400 mt-2">{new Date(item.createdAt).toLocaleString()}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
