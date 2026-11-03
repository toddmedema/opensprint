import { useState } from "react";
import type { PolicyProposal, PolicyRuleRevision } from "@opensprint/shared";
import { api } from "../../../api/client";
import type { GovernancePanelProps } from "../GovernanceSettingsContent";
import { formatGovernanceDate } from "../../../lib/governance";
import { ReplayFixtures } from "./ReplayFixtures";
import { GovernanceConfirmAction, GovernanceResult } from "./GovernanceResult";

export function PolicyProposals(props: GovernancePanelProps) {
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-theme-text">Rule amendments</h3>
          <p className="mt-1 max-w-2xl text-sm text-theme-muted">
            Decisions can nominate a rule for review. Frequency alone cannot weaken a standard;
            every amendment needs evidence, a complete evaluation, and your approval.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary disabled:opacity-50"
          disabled={!props.capability || props.busy}
          onClick={() =>
            props.run(
              () => api.governance.mine(props.projectId, props.capability),
              "Decision events processed. New nominations appear below when supported by recurring rulings.",
              "mine"
            )
          }
        >
          Review recent decisions
        </button>
      </header>
      <GovernanceResult scope="mine" outcome={props.outcome} pendingScope={props.pendingScope} />
      <ReplayFixtures {...props} />
      {props.summary.proposals.length === 0 && (
        <p className="rounded-xl border border-dashed border-theme-border p-6 text-sm text-theme-muted">
          No amendments yet. Propose a rule change from Standards, or process recent rulings to find
          recurring conflicts.
        </p>
      )}
      {props.summary.proposals.map((proposal) => (
        <ProposalCard key={proposal.id} {...props} proposal={proposal} />
      ))}
    </div>
  );
}

function ProposalCard({ proposal, ...props }: GovernancePanelProps & { proposal: PolicyProposal }) {
  const [rationale, setRationale] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reviewedVersion, setReviewedVersion] = useState(proposal.version);
  // Keep the drafted rationale across versions, but require a new review of the changed proposal.
  if (reviewedVersion !== proposal.version) {
    setReviewedVersion(proposal.version);
    setConfirmed(false);
  }
  const resultScope = `proposal:${proposal.id}`;
  const evaluation = proposal.evaluation;
  const evaluated = proposal.state === "evaluated" && evaluation?.complete && evaluation.passed;
  const stale = proposal.baseReleaseId !== props.summary.activeReleaseId;
  const terminal = proposal.state === "activated" || proposal.state === "rejected";
  const supporting = props.summary.decisions.filter((entry) =>
    proposal.supportingDecisionIds.includes(entry.id)
  );
  const contrary = props.summary.decisions.filter((entry) =>
    proposal.contraryDecisionIds.includes(entry.id)
  );
  return (
    <article
      className="space-y-4 rounded-xl border border-theme-border p-4 sm:p-5"
      data-testid="governance-proposal"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-base font-semibold text-theme-text">{proposal.title}</h4>
          <p className="mt-1 text-xs text-theme-muted">
            {proposal.id} · {formatGovernanceDate(proposal.createdAt)} · version {proposal.version}
          </p>
        </div>
        <span className="rounded-full bg-theme-border-subtle px-2.5 py-1 text-xs font-medium capitalize text-theme-text">
          {proposal.state}
        </span>
      </header>
      <p className="whitespace-pre-wrap text-sm text-theme-text">{proposal.rationale}</p>
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="font-medium text-theme-text">Intended scope</dt>
          <dd className="mt-1 whitespace-pre-wrap text-theme-muted">{proposal.scope}</dd>
        </div>
        <div>
          <dt className="font-medium text-theme-text">Migration &amp; compatibility</dt>
          <dd className="mt-1 whitespace-pre-wrap text-theme-muted">{proposal.compatibility}</dd>
        </div>
        <div>
          <dt className="font-medium text-theme-text">Required enforcement commit</dt>
          <dd className="mt-1 break-all font-mono text-xs text-theme-muted">
            {proposal.enforcementRevision}
          </dd>
        </div>
      </dl>
      {stale && !terminal && (
        <div role="alert" className="rounded-lg bg-amber-500/10 p-3 text-sm text-theme-text">
          <p>
            The active policy changed after this proposal was drafted, so it can no longer be
            evaluated or activated. Reject this proposal below, then draft the same change again
            from the current standard.
          </p>
          {props.openStandards && (
            <button
              type="button"
              className="mt-2 font-medium text-brand-600 underline-offset-4 hover:underline dark:text-brand-400"
              onClick={props.openStandards}
            >
              Go to Standards
            </button>
          )}
        </div>
      )}
      <section className="space-y-3" aria-label="Exact rule changes">
        {proposal.patches.length === 0 && (
          <p className="text-sm text-theme-muted">
            This is a nomination. A substantive rule amendment and evaluation are still required.
          </p>
        )}
        {proposal.patches.map((patch) => (
          <div key={patch.ruleId} className="overflow-hidden rounded-lg border border-theme-border">
            <h5 className="border-b border-theme-border px-3 py-2 text-sm font-semibold text-theme-text">
              {patch.ruleId}
            </h5>
            <div className="grid md:grid-cols-2">
              <div className="min-w-0 bg-red-500/5 p-3">
                <p className="mb-2 text-xs font-semibold text-theme-muted">Before</p>
                <RuleChangeContent rule={patch.before} emptyLabel="New rule" />
              </div>
              <div className="min-w-0 border-t border-theme-border bg-green-500/5 p-3 md:border-l md:border-t-0">
                <p className="mb-2 text-xs font-semibold text-theme-muted">After</p>
                <RuleChangeContent rule={patch.after} emptyLabel="Rule retired" />
              </div>
            </div>
            <details
              className="border-t border-theme-border px-3 py-3"
              open={
                JSON.stringify(ruleAuthority(patch.before)) !==
                JSON.stringify(ruleAuthority(patch.after))
              }
            >
              <summary className="cursor-pointer text-xs font-medium text-theme-text">
                Full rule manifest · scope, authority, and exact content
              </summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {[patch.before, patch.after].map((rule, index) => (
                  <pre
                    key={index}
                    className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-theme-bg p-3 text-xs text-theme-text"
                  >
                    {JSON.stringify(rule, null, 2)}
                  </pre>
                ))}
              </div>
            </details>
          </div>
        ))}
      </section>
      {proposal.instructions && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-theme-text">
            Instruction content changes
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-theme-bg p-3 text-xs text-theme-text">
            {JSON.stringify(proposal.instructions, null, 2)}
          </pre>
        </details>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <DecisionEvidence
          title="Supporting rulings"
          ids={proposal.supportingDecisionIds}
          decisions={supporting}
        />
        <DecisionEvidence
          title="Contrary rulings"
          ids={proposal.contraryDecisionIds}
          decisions={contrary}
        />
      </div>
      {(proposal.supportingEventIds?.length ?? 0) + (proposal.contraryEventIds?.length ?? 0) >
        0 && (
        <details className="rounded-lg border border-theme-border p-3">
          <summary className="cursor-pointer text-sm font-medium text-theme-text">
            Advisory review and fix evidence
          </summary>
          <p className="mt-2 text-xs text-theme-muted">
            These events inform this proposal. They grant no reusable authority.
          </p>
          {(
            [
              ["Supporting events", proposal.supportingEventIds ?? []],
              ["Contrary events", proposal.contraryEventIds ?? []],
            ] as const
          ).map(([label, ids]) => (
            <section key={label} className="mt-3">
              <h5 className="text-sm font-medium text-theme-text">{label}</h5>
              <ul className="mt-1 space-y-2 text-xs text-theme-muted">
                {ids.map((id) => {
                  const event = props.summary.events.find((item) => item.id === id);
                  return (
                    <li key={id} className="break-all">
                      {id}
                      {event
                        ? ` · ${event.kind.replaceAll("_", " ")} · ${formatGovernanceDate(event.createdAt)}${event.caseId ? ` · case ${event.caseId}` : ""}`
                        : ""}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </details>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Examples title="Positive examples" items={proposal.positiveExamples} />
        <Examples title="Negative examples" items={proposal.negativeExamples} />
      </div>
      <section className="rounded-lg border border-theme-border bg-theme-bg/40 p-3">
        <h5 className="text-sm font-semibold text-theme-text">Independent evaluation</h5>
        {!terminal && (proposal.patches.length > 0 || proposal.instructions) && (
          <button
            type="button"
            className="btn-secondary mt-3 disabled:opacity-50"
            disabled={!props.capability || props.busy || stale}
            onClick={() =>
              props.run(
                () =>
                  api.governance.evaluate(
                    props.projectId,
                    proposal.id,
                    proposal.version,
                    props.capability
                  ),
                "Evaluation finished. Inspect completeness, independent checks, held-out results, and measured outcomes before activation.",
                resultScope
              )
            }
          >
            Run baseline &amp; candidate evaluation
          </button>
        )}
        {evaluation ? (
          <>
            <p className="mt-2 text-sm text-theme-text">
              {evaluation.complete
                ? evaluation.passed
                  ? "Complete · Passed"
                  : "Complete · Did not pass"
                : "Incomplete · Cannot activate"}
            </p>
            <p className="mt-1 text-xs text-theme-muted">
              {evaluation.fixtureIds.length} fixtures · {evaluation.heldOutCount} held out ·{" "}
              {evaluation.positiveCount} positive · {evaluation.negativeCount} negative
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-theme-border text-theme-muted">
                    <th className="py-2 pr-3 font-medium">Metric</th>
                    <th className="py-2 pr-3 font-medium">Baseline</th>
                    <th className="py-2 font-medium">Candidate</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from(
                    new Set([
                      ...Object.keys(evaluation.baseline),
                      ...Object.keys(evaluation.candidate),
                    ])
                  ).map((key) => (
                    <tr key={key} className="border-b border-theme-border-subtle text-theme-text">
                      <th className="py-2 pr-3 font-normal">{metricLabel(key)}</th>
                      <td className="py-2 pr-3 tabular-nums">
                        {formatMetric(key, evaluation.baseline[key])}
                      </td>
                      <td className="py-2 tabular-nums">
                        {formatMetric(key, evaluation.candidate[key])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 break-all text-xs text-theme-muted">
              Executor: {evaluation.executor} · {formatGovernanceDate(evaluation.measuredAt)}
              <br />
              Evidence: {evaluation.artifactHash}
              <br />
              Evaluated content: {evaluation.releaseContentHash}
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-theme-muted">
            No complete evaluation is available. Missing inputs or unsupported isolation keep this
            amendment from activation.
          </p>
        )}
      </section>
      {!terminal && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!evaluated || stale) return;
            props.run(
              () =>
                api.governance.activate(
                  props.projectId,
                  proposal.id,
                  {
                    expectedVersion: proposal.version,
                    expectedActiveReleaseId: props.summary.activeReleaseId,
                    rationale: rationale.trim(),
                  },
                  props.capability
                ),
              "Amendment activated. New assignments will use the approved release content.",
              resultScope
            );
          }}
          className="space-y-3 border-t border-theme-border pt-4"
        >
          <label className="block text-sm font-medium text-theme-text">
            Decision rationale
            <textarea
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              rows={3}
              className="input mt-1.5"
              required
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-theme-muted">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5"
            />
            I reviewed the exact rule changes, contrary evidence, evaluation, and enforcement
            compatibility.
          </label>
          <p className="text-xs text-theme-muted">
            Activation changes the standards and instructions used by new assignments. Current cases
            retain their pinned policy unless a critical revocation requires revalidation.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className="btn-primary disabled:opacity-50"
              disabled={
                !props.capability ||
                props.busy ||
                !evaluated ||
                stale ||
                !confirmed ||
                !rationale.trim()
              }
            >
              Approve &amp; activate amendment
            </button>
            <GovernanceConfirmAction
              label="Reject amendment"
              reasonLabel="Reason for rejecting this amendment"
              consequence="This amendment closes permanently. The active policy does not change."
              confirmLabel="Confirm rejection"
              disabled={!props.capability || props.busy}
              onConfirm={(reason) =>
                props.run(
                  () =>
                    api.governance.rejectProposal(
                      props.projectId,
                      proposal.id,
                      { expectedVersion: proposal.version, rationale: reason },
                      props.capability
                    ),
                  "Amendment rejected. The active policy is unchanged.",
                  resultScope
                )
              }
            />
          </div>
          {!evaluated && (
            <p className="text-xs text-theme-muted">
              Activation is locked until a substantive amendment passes a real baseline and
              candidate evaluation.
            </p>
          )}
        </form>
      )}
      <GovernanceResult
        scope={resultScope}
        outcome={props.outcome}
        pendingScope={props.pendingScope}
      />
    </article>
  );
}

function DecisionEvidence({
  title,
  ids,
  decisions,
}: {
  title: string;
  ids: string[];
  decisions: GovernancePanelProps["summary"]["decisions"];
}) {
  return (
    <section>
      <h5 className="text-sm font-medium text-theme-text">{title}</h5>
      {ids.length === 0 ? (
        <p className="mt-1 text-xs text-theme-muted">No rulings cited.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {ids.map((id) => {
            const decision = decisions.find((item) => item.id === id);
            return (
              <li
                key={id}
                className="rounded-lg border border-theme-border p-3 text-xs text-theme-muted"
              >
                <p className="break-all font-medium text-theme-text">{id}</p>
                {decision ? (
                  <>
                    <p className="mt-1">
                      {decision.action.replace(/_/g, " ")} · {decision.actor}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{decision.rationale}</p>
                  </>
                ) : (
                  <p className="mt-1">
                    Ruling details unavailable. Resolve missing evidence before activation.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
function metricLabel(key: string): string {
  return (
    (
      {
        taskSuccessRate: "Task success",
        reviewPassRate: "Review pass rate",
        retryRate: "Retries per task",
        avgLatencyMs: "Average duration",
        avgCostUsd: "Average cost",
      } as Record<string, string>
    )[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2")
  );
}
function formatMetric(key: string, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (key === "taskSuccessRate" || key === "reviewPassRate")
    return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (key === "avgLatencyMs")
    return value < 1000
      ? `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`
      : `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
  if (key === "avgCostUsd")
    return value.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function ruleAuthority(rule: PolicyRuleRevision | null) {
  if (!rule) return null;
  return {
    owner: rule.owner,
    paths: rule.paths,
    components: rule.components,
    roles: rule.roles,
    severity: rule.severity,
    mandatory: rule.mandatory,
    exceptionEligible: rule.exceptionEligible,
    parentIds: rule.parentIds,
    overrideIds: rule.overrideIds,
    conflictIds: rule.conflictIds,
    layer: rule.layer,
  };
}
function RuleChangeContent({
  rule,
  emptyLabel,
}: {
  rule: PolicyRuleRevision | null;
  emptyLabel: string;
}) {
  if (!rule) return <p className="text-sm text-theme-muted">{emptyLabel}</p>;
  return (
    <div className="space-y-3 text-sm text-theme-text">
      <p className="whitespace-pre-wrap break-words leading-relaxed">{rule.text}</p>
      <p className="whitespace-pre-wrap break-words text-xs text-theme-muted">
        <span className="font-medium text-theme-text">Rationale: </span>
        {rule.rationale}
      </p>
      {(rule.examples.compliant.length > 0 || rule.examples.noncompliant.length > 0) && (
        <div className="space-y-3">
          <Examples title="Compliant examples" items={rule.examples.compliant} />
          <Examples title="Noncompliant examples" items={rule.examples.noncompliant} />
        </div>
      )}
      <p className="text-xs text-theme-muted">
        Revision {rule.revision} · {rule.severity} ·{" "}
        {rule.exceptionEligible ? "Explicit exceptions permitted" : "Non-waivable"}
      </p>
    </div>
  );
}
function Examples({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h5 className="text-sm font-medium text-theme-text">{title}</h5>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-theme-muted">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
      {items.length === 0 && <p className="mt-1 text-xs text-theme-muted">None provided.</p>}
    </section>
  );
}
