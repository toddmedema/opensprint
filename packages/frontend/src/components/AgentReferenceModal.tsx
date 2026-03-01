import { useState } from "react";
import type { AgentRole } from "@opensprint/shared";
import {
  AGENT_ROLE_CANONICAL_ORDER,
  AGENT_ROLE_LABELS,
  AGENT_ROLE_PHASES,
  AGENT_ROLE_DESCRIPTIONS,
} from "@opensprint/shared";
import { CloseButton } from "./CloseButton";
import { ASSET_BASE } from "../lib/constants";

export interface AgentReferenceModalProps {
  onClose: () => void;
}

/**
 * Modal showing all 9 agents with icon, name, phase(s), and description.
 * Accessible: keyboard-navigable, screen-reader friendly.
 */
export function AgentReferenceModal({ onClose }: AgentReferenceModalProps) {
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-theme-overlay p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-reference-title"
      aria-label="Meet the Agent Team"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      data-testid="agent-reference-backdrop"
    >
      <div
        className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col rounded-lg bg-theme-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-theme-border shrink-0">
          <h2 id="agent-reference-title" className="text-lg font-semibold text-theme-text">
            Meet the Agent Team
          </h2>
          <CloseButton onClick={onClose} ariaLabel="Close agent reference" />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            role="list"
            aria-label="Agent team members"
          >
            {AGENT_ROLE_CANONICAL_ORDER.map((role) => (
              <AgentCard key={role} role={role} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentCard({ role }: { role: AgentRole }) {
  const [iconError, setIconError] = useState(false);
  const label = AGENT_ROLE_LABELS[role];
  const phases = AGENT_ROLE_PHASES[role];
  const description = AGENT_ROLE_DESCRIPTIONS[role];
  const iconSrc = `${ASSET_BASE}agent-icons/${role}.svg`;

  return (
    <article
      className="flex flex-col gap-2 rounded-lg border border-theme-border bg-theme-surface-muted p-4"
      role="listitem"
    >
      <div className="flex items-start gap-3">
        {iconError ? (
          <div
            className="w-12 h-12 shrink-0 rounded-lg bg-theme-border-subtle flex items-center justify-center text-theme-muted text-xs"
            aria-hidden="true"
          >
            ?
          </div>
        ) : (
          <img
            src={iconSrc}
            alt=""
            className="w-12 h-12 shrink-0 rounded-lg object-contain"
            loading="lazy"
            onError={() => setIconError(true)}
          />
        )}
        <div className="min-w-0 flex-1 flex flex-col items-start">
          <h3 className="font-medium text-theme-text m-0">{label}</h3>
          <div className="flex flex-wrap gap-1 mt-1">
            {phases.map((phase) => (
              <span
                key={phase}
                className="inline-flex items-center pl-0 pr-2 py-0.5 rounded text-xs font-medium bg-theme-border-subtle text-theme-muted"
              >
                {phase}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="text-sm text-theme-muted leading-relaxed">{description}</p>
    </article>
  );
}
