import { useState } from "react";
import { api } from "../../../api/client";
import { formatGovernanceDate, restorableGovernanceReleases } from "../../../lib/governance";
import type { GovernancePanelProps } from "../GovernanceSettingsContent";
import { GovernanceConfirmAction, GovernanceResult } from "./GovernanceResult";

export function GovernanceHistory(props: GovernancePanelProps) {
  const [rollbackRelease, setRollbackRelease] = useState("");
  const restorable = restorableGovernanceReleases(props.summary);
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-theme-text">Human rulings &amp; precedent</h3>
        <p className="text-sm text-theme-muted">
          One-time allowances remain evidence. Only explicitly reusable rulings can authorize future
          matching exceptions.
        </p>
        {props.summary.decisions.length === 0 && (
          <p className="rounded-xl border border-dashed border-theme-border p-5 text-sm text-theme-muted">
            No rulings have been recorded.
          </p>
        )}
        {props.summary.decisions.map((decision) => (
          <article
            key={decision.id}
            className="space-y-2 rounded-xl border border-theme-border p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h4 className="text-sm font-semibold text-theme-text">
                {decision.action.replace(/_/g, " ")} · {decision.actor}
              </h4>
              <span className="text-xs text-theme-muted">
                {decision.revokedAt
                  ? "Revoked"
                  : decision.conditions
                    ? "Reusable within conditions"
                    : "This case only"}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-theme-text">{decision.rationale}</p>
            <p className="break-all text-xs text-theme-muted">
              {decision.id} · {decision.taskId} · {formatGovernanceDate(decision.createdAt)}
              <br />
              Policy {decision.releaseId} · Code {decision.headSha.slice(0, 12)}
            </p>
            {decision.conditions && (
              <p className="break-words text-xs text-theme-muted">
                Paths: {decision.conditions.paths.join(", ")}
                <br />
                Rules: {decision.conditions.ruleRevisionIds.join(", ")}
                <br />
                Expires {formatGovernanceDate(decision.conditions.expiresAt)}
              </p>
            )}
            {!decision.revokedAt &&
              (decision.action === "allow_once" || decision.action === "allow_reusable") && (
                <GovernanceConfirmAction
                  label="Revoke ruling"
                  reasonLabel="Reason for revoking this ruling"
                  consequence="Future reuse stops and pending approvals that relied on this ruling must be revalidated."
                  confirmLabel="Confirm revocation"
                  triggerClassName="text-sm font-medium text-theme-error-solid underline disabled:opacity-50"
                  disabled={!props.capability || props.busy}
                  onConfirm={(reason) =>
                    props.run(
                      () =>
                        api.governance.revoke(
                          props.projectId,
                          decision.id,
                          reason,
                          props.capability
                        ),
                      "Ruling revoked. Future reuse and pending approvals must be revalidated.",
                      `decision:${decision.id}`
                    )
                  }
                />
              )}
            <GovernanceResult
              scope={`decision:${decision.id}`}
              outcome={props.outcome}
              pendingScope={props.pendingScope}
            />
          </article>
        ))}
      </section>
      <section className="space-y-3 rounded-xl border border-theme-border p-4">
        <h3 className="text-base font-semibold text-theme-text">Restore a compatible release</h3>
        <p className="text-sm text-theme-muted">
          Rollback restores actual policy content for new assignments. Compatible enforcement must
          already be present; unrelated code is never reverted.
        </p>
        <label className="block text-sm font-medium text-theme-text">
          Previous release
          <select
            value={rollbackRelease}
            onChange={(event) => setRollbackRelease(event.target.value)}
            className="input mt-1.5"
          >
            <option value="">Select a release</option>
            {restorable.map((release) => (
              <option key={release.id} value={release.id}>
                {release.id} · {formatGovernanceDate(release.createdAt)}
              </option>
            ))}
          </select>
        </label>
        {restorable.length === 0 && (
          <p className="text-sm text-theme-muted">
            No earlier release can be restored. Only previously active releases that were not
            revoked are listed.
          </p>
        )}
        <GovernanceConfirmAction
          key={`${props.summary.activeReleaseId}:${rollbackRelease}`}
          label="Roll back policy"
          reasonLabel="Reason for this rollback"
          consequence="New assignments will use the selected release. Current tasks keep their pinned policy."
          confirmLabel="Approve policy rollback"
          disabled={!props.capability || props.busy}
          confirmDisabled={!restorable.some((release) => release.id === rollbackRelease)}
          onConfirm={(reason) =>
            props.run(
              async () => {
                await api.governance.rollback(
                  props.projectId,
                  {
                    releaseId: rollbackRelease,
                    expectedActiveReleaseId: props.summary.activeReleaseId,
                    rationale: reason,
                  },
                  props.capability
                );
                setRollbackRelease("");
              },
              "Compatible release restored. New assignments will use its immutable content.",
              "rollback"
            )
          }
        />
        <GovernanceResult
          scope="rollback"
          outcome={props.outcome}
          pendingScope={props.pendingScope}
        />
      </section>
      <details className="rounded-xl border border-theme-border p-4">
        <summary className="cursor-pointer text-sm font-semibold text-theme-text">
          Immutable governance audit trail ({props.summary.events.length})
        </summary>
        <ol className="mt-4 space-y-3">
          {props.summary.events.map((event) => (
            <li key={event.id} className="border-l-2 border-theme-border pl-3">
              <p className="text-sm font-medium text-theme-text">{event.kind.replace(/_/g, " ")}</p>
              <p className="mt-1 text-xs text-theme-muted">
                {event.actor} · {formatGovernanceDate(event.createdAt)}
              </p>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-theme-muted">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
