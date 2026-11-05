import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  REVIEW_AGENT_OPTIONS,
  type AutomatedQaPerspective,
  type AutomatedQaResult,
} from "@opensprint/shared";
import { api } from "../../api/client";
import { CloseButton } from "../CloseButton";
import { useModalA11y } from "../../hooks/useModalA11y";

export function AutomatedQaButton({
  projectId,
  onComplete,
}: {
  projectId: string;
  onComplete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [perspectives, setPerspectives] = useState<AutomatedQaPerspective[]>(["general"]);
  const [instructions, setInstructions] = useState("");
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutomatedQaResult | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useModalA11y({ containerRef, triggerRef, isOpen: open, onClose: () => setOpen(false) });

  async function run() {
    if (!perspectives.length || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.feedback.runAutomatedQa(projectId, {
          perspectives,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        })
      );
      onComplete();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not run automated QA. Please try again."
      );
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  const issueCount =
    result?.results.reduce((total, item) => total + item.feedbackIds.length, 0) ?? 0;
  const failedCount = result?.results.filter((item) => item.status === "failed").length ?? 0;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="btn-primary text-sm py-0.5 px-2.5 min-h-[32px] rounded-sm hover:bg-brand-800 inline-flex items-center justify-center whitespace-nowrap"
        data-testid="run-automated-qa-button"
      >
        {running ? "QA running…" : "Run automated QA"}
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div
              ref={containerRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="automated-qa-title"
              aria-describedby="automated-qa-description"
              tabIndex={-1}
              className="bg-theme-surface border border-theme-border rounded-xl shadow-xl w-full max-w-lg max-h-[90dvh] overflow-y-auto p-5 sm:p-6"
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <h2 id="automated-qa-title" className="text-lg font-semibold text-theme-text">
                  Run automated QA
                </h2>
                <CloseButton onClick={() => setOpen(false)} ariaLabel="Close automated QA" />
              </div>
              <p id="automated-qa-description" className="text-sm text-theme-muted mb-5">
                Choose what to test. Each perspective gets its own QA agent, and reported issues
                appear in the Evaluate queue.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                <fieldset disabled={running} className="mb-5 space-y-3">
                  <legend className="text-sm font-medium text-theme-text mb-3">
                    QA perspectives
                  </legend>
                  {REVIEW_AGENT_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className="flex items-start gap-3 text-sm text-theme-text cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={perspectives.includes(option.value)}
                        className="mt-0.5 h-4 w-4 accent-brand-600 shrink-0"
                        onChange={(event) =>
                          setPerspectives((previous) =>
                            event.target.checked
                              ? [...previous, option.value]
                              : previous.filter((value) => value !== option.value)
                          )
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </fieldset>
                <label
                  htmlFor="automated-qa-instructions"
                  className="block text-sm font-medium text-theme-text mb-2"
                >
                  Additional instructions (optional)
                </label>
                <textarea
                  id="automated-qa-instructions"
                  className="input min-h-[100px] resize-y"
                  maxLength={10000}
                  placeholder="For example, focus on mobile navigation and slow page loads…"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  disabled={running}
                />
                {running && (
                  <p role="status" className="text-sm text-theme-muted mt-4">
                    QA agents are testing your app. Findings appear in Evaluate as they are
                    reported. You can close this dialog while QA runs.
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-sm text-theme-error mt-4">
                    {error}
                  </p>
                )}
                {result && (
                  <div role="status" className="text-sm text-theme-text mt-4">
                    <p>
                      {issueCount} {issueCount === 1 ? "issue" : "issues"} added to Evaluate.{" "}
                      {failedCount
                        ? `${failedCount} ${failedCount === 1 ? "perspective" : "perspectives"} could not complete.`
                        : "All selected perspectives completed."}
                    </p>
                    <ul className="mt-2 space-y-2">
                      {result.results.map((item) => (
                        <li key={item.perspective}>
                          <span className="font-medium">
                            {
                              REVIEW_AGENT_OPTIONS.find(
                                (option) => option.value === item.perspective
                              )?.label
                            }
                            :{" "}
                          </span>
                          {item.status === "failed" ? "Incomplete — " : ""}
                          {item.summary}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex justify-end gap-2 mt-5">
                  <button
                    type="button"
                    className="btn-secondary text-sm"
                    onClick={() => setOpen(false)}
                  >
                    {running || result ? "Close" : "Cancel"}
                  </button>
                  <button
                    type="submit"
                    className="btn-primary text-sm"
                    disabled={running || !perspectives.length}
                  >
                    {running ? "Running QA…" : "Run QA"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
