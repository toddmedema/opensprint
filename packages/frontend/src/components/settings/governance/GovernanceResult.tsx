import { useEffect, useRef, useState } from "react";

export interface GovernanceOutcome {
  /** Increments for every outcome so a repeated error still takes focus. */
  id: number;
  scope: string;
  kind: "success" | "error";
  message: string;
  stale: boolean;
}

interface GovernanceResultProps {
  scope: string;
  outcome: GovernanceOutcome | null;
  pendingScope: string | null;
}

/** Live regions stay mounted so assistive technology announces later content changes. */
export function GovernanceResult({ scope, outcome, pendingScope }: GovernanceResultProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  const current = outcome?.scope === scope ? outcome : null;
  const error = current?.kind === "error" ? current : null;
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return (
    <div data-testid={`governance-result-${scope}`}>
      <div role="status" aria-live="polite">
        {pendingScope === scope ? (
          <p className="text-sm text-theme-muted">
            Processing governance request… Evaluations may take several minutes.
          </p>
        ) : (
          current?.kind === "success" && (
            <p className="rounded-lg border border-theme-border px-3 py-2 text-sm text-theme-text">
              {current.message}
            </p>
          )
        )}
      </div>
      <div ref={errorRef} role="alert" tabIndex={-1} className="focus:outline-none">
        {error && (
          <p className="rounded-lg border border-theme-error-border bg-theme-error-bg px-3 py-2 text-sm text-theme-text">
            {error.stale
              ? "This item changed before your action was saved. Review the refreshed details and try again. "
              : ""}
            {error.message}
          </p>
        )}
      </div>
    </div>
  );
}

interface GovernanceConfirmActionProps {
  /** Opens the confirmation. */
  label: string;
  reasonLabel: string;
  consequence: string;
  confirmLabel: string;
  disabled: boolean;
  /** Also blocks confirming, for example while nothing is selected. */
  confirmDisabled?: boolean;
  onConfirm: (reason: string) => void;
  triggerClassName?: string;
}

/** Destructive actions each collect their own reason and an explicit second step. */
export function GovernanceConfirmAction({
  label,
  reasonLabel,
  consequence,
  confirmLabel,
  disabled,
  confirmDisabled = false,
  onConfirm,
  triggerClassName = "btn-secondary disabled:opacity-50",
}: GovernanceConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) reasonRef.current?.focus();
  }, [open]);
  if (!open)
    return (
      <button
        type="button"
        className={triggerClassName}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    );
  return (
    <div className="space-y-3 rounded-lg border border-theme-error-border p-3">
      <p className="text-sm text-theme-text">{consequence}</p>
      <label className="block text-sm font-medium text-theme-text">
        {reasonLabel}
        <textarea
          ref={reasonRef}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          className="input mt-1.5"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-danger disabled:opacity-50"
          disabled={disabled || confirmDisabled || !reason.trim()}
          onClick={() => onConfirm(reason.trim())}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="text-sm text-theme-muted hover:underline"
          onClick={() => {
            setOpen(false);
            setReason("");
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
