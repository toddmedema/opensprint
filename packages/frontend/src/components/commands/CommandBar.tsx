import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { getCurrentProjectRoute } from "../../lib/currentProjectRoute";
import type {
  CommandInterpretation,
  CommandPreview,
  CommandExecutionResult,
  CommandMutation,
} from "@opensprint/shared";
import { useInterpretCommand, usePreviewCommand, useApplyCommand } from "../../api/hooks/commands";

type CommandStage =
  | "idle"
  | "interpreting"
  | "previewing"
  | "confirming"
  | "executing"
  | "done"
  | "error";

const RISK_LABELS: Record<string, { label: string; className: string }> = {
  safe: { label: "Safe", className: "text-green-400 bg-green-500/10" },
  "mutating-low-risk": { label: "Low Risk", className: "text-yellow-400 bg-yellow-500/10" },
  "mutating-high-risk": { label: "High Risk", className: "text-red-400 bg-red-500/10" },
};

function MutationPreviewList({ mutations }: { mutations: CommandMutation[] }) {
  if (mutations.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="mutation-preview">
      {mutations.map((m, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              m.operation === "create"
                ? "bg-green-400"
                : m.operation === "delete"
                  ? "bg-red-400"
                  : "bg-yellow-400"
            }`}
          />
          <span className="text-theme-text">{m.summary}</span>
        </div>
      ))}
    </div>
  );
}

export function CommandBar() {
  const { pathname } = useLocation();
  const { projectId } = getCurrentProjectRoute(pathname);
  const sessionGeneration = useRef(0);
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [stage, setStage] = useState<CommandStage>("idle");
  const [interpretation, setInterpretation] = useState<CommandInterpretation | null>(null);
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [commandRunId, setCommandRunId] = useState<string | null>(null);
  const [result, setResult] = useState<CommandExecutionResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const interpretMutation = useInterpretCommand(projectId ?? "");
  const previewMutation = usePreviewCommand(projectId ?? "");
  const applyMutation = useApplyCommand(projectId ?? "");

  const invalidateSession = useCallback(() => {
    sessionGeneration.current++;
  }, []);

  const reset = useCallback(() => {
    invalidateSession();
    setIsOpen(false);
    setInput("");
    setStage("idle");
    setInterpretation(null);
    setPreview(null);
    setCommandRunId(null);
    setResult(null);
    setErrorMsg(null);
  }, [invalidateSession]);

  useLayoutEffect(() => {
    reset();
    return invalidateSession;
  }, [projectId, reset, invalidateSession]);

  // Global keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (!projectId) return;
        if (isOpen) reset();
        else setIsOpen(true);
      }
      if (e.key === "Escape" && isOpen) {
        reset();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, projectId, reset]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || !projectId) return;

    const generation = ++sessionGeneration.current;
    setStage("interpreting");
    setErrorMsg(null);

    try {
      const interpResult = await interpretMutation.mutateAsync(input.trim());
      if (generation !== sessionGeneration.current) return;
      setInterpretation(interpResult.interpretation);
      setCommandRunId(interpResult.commandRunId);

      if (interpResult.interpretation.intent.commandType === "unrecognized") {
        setStage("error");
        setErrorMsg(interpResult.interpretation.clarificationNeeded ?? "Command not recognized");
        return;
      }

      setStage("previewing");
      const prevResult = await previewMutation.mutateAsync(interpResult.interpretation.intent);
      if (generation !== sessionGeneration.current) return;
      setPreview(prevResult.preview);
      setCommandRunId(prevResult.commandRunId);

      if (interpResult.interpretation.riskLevel === "safe") {
        // Auto-apply safe commands
        setStage("executing");
        const execResult = await applyMutation.mutateAsync({
          commandRunId: prevResult.commandRunId,
        });
        if (generation !== sessionGeneration.current) return;
        setResult(execResult.result);
        setStage("done");
      } else {
        setStage("confirming");
      }
    } catch (err) {
      if (generation !== sessionGeneration.current) return;
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : "Command failed");
    }
  }, [input, projectId, interpretMutation, previewMutation, applyMutation]);

  const handleConfirm = useCallback(async () => {
    if (!commandRunId || !projectId) return;
    const generation = ++sessionGeneration.current;
    setStage("executing");
    try {
      const execResult = await applyMutation.mutateAsync({ commandRunId });
      if (generation !== sessionGeneration.current) return;
      setResult(execResult.result);
      setStage("done");
    } catch (err) {
      if (generation !== sessionGeneration.current) return;
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : "Execution failed");
    }
  }, [commandRunId, projectId, applyMutation]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      data-testid="command-bar-overlay"
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop dismiss handled by Escape key in useEffect */}
      <div className="absolute inset-0 bg-black/50" onClick={reset} />
      <div className="relative w-full max-w-xl bg-theme-surface border border-theme-border rounded-xl shadow-2xl overflow-hidden">
        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-theme-border">
          <span className="text-xs text-theme-text-secondary font-mono">⌘K</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            placeholder="Type a command... (e.g., list intake items, show tasks, sync todoist)"
            className="flex-1 bg-transparent text-sm text-theme-text placeholder:text-theme-text-secondary outline-none"
            disabled={stage !== "idle" && stage !== "error"}
            data-testid="command-input"
          />
        </div>

        {/* Interpretation */}
        {interpretation && stage !== "idle" && (
          <div className="px-4 py-3 border-b border-theme-border space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-theme-text-secondary">Interpreted as:</p>
              {interpretation.riskLevel && (
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-medium ${RISK_LABELS[interpretation.riskLevel]?.className ?? ""}`}
                >
                  {RISK_LABELS[interpretation.riskLevel]?.label ?? interpretation.riskLevel}
                </span>
              )}
            </div>
            <p className="text-sm text-theme-text font-medium">
              {interpretation.intent.commandType.replace(/_/g, " ")}
            </p>
          </div>
        )}

        {/* Preview */}
        {preview && (stage === "confirming" || stage === "executing" || stage === "done") && (
          <div className="px-4 py-3 border-b border-theme-border space-y-2">
            <p className="text-xs text-theme-text-secondary">What will happen:</p>
            <p className="text-sm text-theme-text">{preview.description}</p>
            <MutationPreviewList mutations={preview.mutations} />
            {preview.warnings.length > 0 && (
              <div className="space-y-1">
                {preview.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-orange-400">
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Confirmation */}
        {stage === "confirming" && (
          <div className="px-4 py-3 border-b border-theme-border flex items-center gap-2">
            <button
              onClick={handleConfirm}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors"
              data-testid="command-confirm"
            >
              {interpretation?.riskLevel === "mutating-high-risk" ? "Confirm & Apply" : "Apply"}
            </button>
            <button
              onClick={reset}
              className="px-3 py-1.5 bg-theme-border hover:bg-theme-surface-hover text-theme-text-secondary text-xs rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Executing */}
        {stage === "executing" && (
          <div className="px-4 py-3 text-sm text-theme-text-secondary animate-pulse">
            Executing command...
          </div>
        )}

        {/* Result */}
        {stage === "done" && result && (
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${result.success ? "bg-green-400" : "bg-red-400"}`}
              />
              <p className="text-sm text-theme-text font-medium">{result.summary}</p>
            </div>
            {result.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span
                  className={`mt-0.5 w-1.5 h-1.5 rounded-full ${step.success ? "bg-green-400" : "bg-red-400"}`}
                />
                <span className="text-theme-text-secondary">{step.description}</span>
              </div>
            ))}
            <button
              onClick={reset}
              className="mt-2 px-3 py-1 bg-theme-border hover:bg-theme-surface-hover text-theme-text-secondary text-xs rounded transition-colors"
            >
              Done
            </button>
          </div>
        )}

        {/* Error */}
        {stage === "error" && (
          <div className="px-4 py-3 space-y-2">
            <p className="text-sm text-red-400">{errorMsg}</p>
            <button
              onClick={() => {
                setStage("idle");
                setInput("");
              }}
              className="px-3 py-1 bg-theme-border hover:bg-theme-surface-hover text-theme-text-secondary text-xs rounded transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Interpreting */}
        {stage === "interpreting" && (
          <div className="px-4 py-3 text-sm text-theme-text-secondary animate-pulse">
            Interpreting command...
          </div>
        )}

        {stage === "previewing" && (
          <div className="px-4 py-3 text-sm text-theme-text-secondary animate-pulse">
            Generating preview...
          </div>
        )}
      </div>
    </div>
  );
}
