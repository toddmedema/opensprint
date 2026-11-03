import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GovernanceDecisionAction, ReviewCaseSummary } from "@opensprint/shared";
import { api } from "../../../api/client";
import { queryKeys } from "../../../api/queryKeys";
import {
  governanceCaseLabel,
  isAgentHeldCase,
  OPEN_GOVERNANCE_CASE_STATES,
  formatGovernanceDate,
} from "../../../lib/governance";
import type { GovernancePanelProps } from "../GovernanceSettingsContent";
import { GovernanceResult } from "./GovernanceResult";

const ACTIONS: { value: GovernanceDecisionAction; label: string; consequence: string }[] = [
  {
    value: "require_fix",
    label: "Require a fix",
    consequence:
      "Return this change to the coder. The cited findings remain blockers until a new review passes.",
  },
  {
    value: "allow_once",
    label: "Allow this change once",
    consequence:
      "Allow the cited standards exception for this exact code and policy only. Future tasks gain no exception. Hard checks still have to pass.",
  },
  {
    value: "allow_reusable",
    label: "Allow with reusable conditions",
    consequence:
      "Allow this change and future matching cases only for the selected rule revisions, approved paths, and expiry. Hard checks still have to pass.",
  },
  {
    value: "request_evidence",
    label: "Request more evidence",
    consequence:
      "Keep the task paused and record what is needed before a binding ruling can be made.",
  },
  {
    value: "cancel",
    label: "Cancel this case",
    consequence:
      "Cancel adjudication and keep the task paused. A human must require a fix before it can continue through a fresh review.",
  },
  {
    value: "abandon",
    label: "Abandon this work",
    consequence:
      "End this case and close the task without merging. Nothing is approved. If another case still holds the task, it stays paused until that case is decided.",
  },
];

const VERIFIED_DISPOSITION_LABELS: Record<
  NonNullable<ReviewCaseSummary["verifiedDisposition"]>["kind"],
  string
> = {
  reviewer_withdrew: "Reviewer withdrew the finding",
  finding_not_applicable: "Finding does not apply",
  precedent_applied: "Approved precedent applied",
  fix_required: "Fix required",
};

export function GovernanceDocket(props: GovernancePanelProps & { selectedCaseId: string | null }) {
  const [chosenId, setChosenId] = useState<string | null>(props.selectedCaseId);
  const [showClosed, setShowClosed] = useState(false);
  useEffect(() => {
    setChosenId(props.selectedCaseId);
  }, [props.selectedCaseId]);
  const openCases = props.summary.cases.filter(
    (item) => showClosed || item.humanCancelled || OPEN_GOVERNANCE_CASE_STATES.has(item.state)
  );
  const chosen = props.summary.cases.find((item) => item.id === chosenId);
  // A chosen case stays selected after it closes, so a link or ruling never lands on another case.
  const cases = chosen && !openCases.includes(chosen) ? [chosen, ...openCases] : openCases;
  const selected = chosen ?? openCases[0];
  const missingCaseId = chosenId !== null && !chosen ? chosenId : null;
  const chosenIsClosed = chosen !== undefined && !openCases.some((item) => item.id === chosen.id);
  if (props.summary.cases.length === 0)
    return (
      <div className="rounded-xl border border-dashed border-theme-border px-5 py-8 text-center">
        <h3 className="text-sm font-semibold text-theme-text">Your docket is clear</h3>
        <p className="mx-auto mt-2 max-w-lg text-sm text-theme-muted">
          Disputed standards appear here with the governing rule, both arguments, and a
          recommendation. Routine approvals continue through normal checks.
        </p>
      </div>
    );
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-theme-muted">
        <input
          type="checkbox"
          checked={showClosed}
          onChange={(event) => setShowClosed(event.target.checked)}
        />
        Show resolved cases
      </label>
      {missingCaseId && (
        <p
          role="status"
          className="rounded-lg border border-theme-border p-3 text-sm text-theme-text"
        >
          Case {missingCaseId} was not found in this project.
        </p>
      )}
      {chosen && chosenIsClosed && (
        <p
          role="status"
          className="rounded-lg border border-theme-border p-3 text-sm text-theme-text"
        >
          This case is resolved · {governanceCaseLabel(chosen)}. It needs no decision.
        </p>
      )}
      {openCases.length === 0 && (
        <p className="py-4 text-sm text-theme-muted">No cases are waiting for a decision.</p>
      )}
      {cases.length > 0 && (
        <label className="block text-sm font-medium text-theme-text xl:hidden">
          Case to review
          <select
            value={selected?.id ?? ""}
            onChange={(event) => setChosenId(event.target.value)}
            className="input mt-1.5"
          >
            {cases.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {governanceCaseLabel(item)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-[260px_minmax(0,1fr)]">
        <nav
          aria-label="Review cases"
          className="hidden max-h-[70vh] space-y-2 overflow-y-auto xl:block"
        >
          {cases.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={selected?.id === item.id ? "true" : undefined}
              onClick={() => setChosenId(item.id)}
              className={`w-full rounded-xl border p-3 text-left transition-colors ${selected?.id === item.id ? "border-brand-500 bg-brand-500/5" : "border-theme-border hover:bg-theme-border-subtle"}`}
            >
              <span className="block text-xs text-theme-muted">
                {item.taskId} · {formatGovernanceDate(item.createdAt)}
              </span>
              <span className="mt-1 block text-sm font-semibold text-theme-text">{item.title}</span>
              <span className="mt-2 block text-xs font-medium text-violet-700 dark:text-violet-300">
                {governanceCaseLabel(item)}
              </span>
            </button>
          ))}
        </nav>
        {selected && (
          <CaseDetail
            key={selected.id}
            {...props}
            item={selected}
            onSubmitted={() => setChosenId(selected.id)}
          />
        )}
      </div>
    </div>
  );
}

function CaseDetail({
  item,
  onSubmitted,
  ...props
}: GovernancePanelProps & { item: ReviewCaseSummary; onSubmitted: () => void }) {
  const release = props.summary.releases.find((entry) => entry.id === item.releaseId);
  const decisions = props.summary.decisions.filter((decision) => decision.caseId === item.id);
  const [action, setAction] = useState<GovernanceDecisionAction>("require_fix");
  const [rationale, setRationale] = useState("");
  const [paths, setPaths] = useState(item.changedPaths.join("\n"));
  const [expiry, setExpiry] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  // A ruling binds to one case version, so a new version needs a new key and a fresh confirmation.
  const [binding, setBinding] = useState(() => ({
    version: item.version,
    resolutionKey: crypto.randomUUID(),
  }));
  const [changedFromVersion, setChangedFromVersion] = useState<number | null>(null);
  const changedBannerRef = useRef<HTMLParagraphElement>(null);
  if (binding.version !== item.version) {
    setBinding({ version: item.version, resolutionKey: crypto.randomUUID() });
    setChangedFromVersion((current) => current ?? binding.version);
    setConfirmed(false);
  }
  const resolutionKey = binding.resolutionKey;
  const caseChanged = changedFromVersion !== null;
  useEffect(() => {
    if (!caseChanged) return;
    // Keep keystrokes in the field someone is typing in; a poll must not steal them.
    if (document.activeElement?.matches("input, textarea, select")) return;
    changedBannerRef.current?.focus();
  }, [caseChanged, item.version]);
  const [additionalEvidence, setAdditionalEvidence] = useState("");
  const [replacementRationale, setReplacementRationale] = useState("");
  const ruleIds = Array.from(
    new Set(
      item.findings.flatMap((finding) => (finding.ruleRevisionId ? [finding.ruleRevisionId] : []))
    )
  );
  const [reusableRuleIds, setReusableRuleIds] = useState(ruleIds);
  const hasHardBlockers = item.findings.some(
    (finding) => finding.severity === "blocking" && finding.category !== "standard"
  );
  const unavailableRules = item.findings.some(
    (finding) =>
      finding.category === "standard" &&
      finding.severity === "blocking" &&
      !release?.rules.some((rule) => rule.id === finding.ruleRevisionId)
  );
  const nonWaivable = item.findings.some(
    (finding) =>
      finding.severity === "blocking" &&
      release?.rules.some(
        (rule) =>
          rule.id === finding.ruleRevisionId &&
          (rule.severity === "constraint" || !rule.exceptionEligible)
      )
  );
  const allowanceBlocked =
    hasHardBlockers ||
    unavailableRules ||
    nonWaivable ||
    item.state === "stale" ||
    item.humanCancelled;
  const precedent = props.summary.decisions.filter(
    (decision) =>
      decision.ruleRevisionIds.some((id) => ruleIds.includes(id)) ||
      item.recommendation?.decisionIds.includes(decision.id)
  );
  const reusablePaths = paths
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  const expiryDate = expiry ? new Date(expiry) : null;
  const reusableValid =
    action !== "allow_reusable" ||
    (reusablePaths.length > 0 &&
      reusableRuleIds.length > 0 &&
      expiryDate !== null &&
      expiryDate.getTime() > Date.now());
  const allowance = action === "allow_once" || action === "allow_reusable";
  const recoveryRequired = item.state === "stale" || item.humanCancelled;
  const actionBlocked =
    (allowance && allowanceBlocked) || (action === "request_evidence" && recoveryRequired);
  const canResolve =
    item.state === "awaiting_human" ||
    item.state === "evidence_requested" ||
    item.state === "stale" ||
    item.humanCancelled;
  const currentAction = ACTIONS.find((option) => option.value === action)!;
  return (
    <article
      className="min-w-0 space-y-5 rounded-xl border border-theme-border p-4 sm:p-5"
      data-testid="governance-case-detail"
    >
      <header>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-theme-text">{item.title}</h3>
          <span className="rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-700 dark:text-violet-300">
            {governanceCaseLabel(item)}
          </span>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm text-theme-muted">{item.summary}</p>
        {item.publishedRemediationOnly && (
          <p className="mt-3 rounded-lg border border-theme-border p-3 text-sm text-theme-text">
            The original change was already published before this expiry was recovered. Its approval
            remains withdrawn. Create an explicitly scoped remediation task if a code change is
            needed.
          </p>
        )}
        <Link
          to={`/projects/${props.projectId}/execute?task=${encodeURIComponent(item.taskId)}`}
          className="mt-2 inline-block text-sm text-brand-600 hover:underline dark:text-brand-400"
        >
          Open task {item.taskId}
        </Link>
        <p className="mt-2 text-xs text-theme-muted">
          Policy {item.releaseId} · Code {item.headSha.slice(0, 12)} · Case version {item.version}
        </p>
        {OPEN_GOVERNANCE_CASE_STATES.has(item.state) && (
          <p className="mt-2 text-xs text-theme-muted">
            Worktree retained while waiting. Independent tasks can continue.
          </p>
        )}
        {item.humanCancelled && (
          <p role="alert" className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-theme-text">
            A human cancelled this change. It remains paused. Require a fix to resume through a
            fresh review, or abandon the work to close the task.
          </p>
        )}
        {item.state === "stale" && (
          <p role="alert" className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-theme-text">
            Code or policy changed after this review. This case cannot authorize the new revision; a
            fresh review is required.
          </p>
        )}
        {item.state === "stale" &&
          props.summary.activeReleaseId &&
          props.summary.activeReleaseId !== item.releaseId && (
            <details className="mt-3 rounded-lg border border-theme-border p-3">
              <summary className="cursor-pointer text-sm font-medium text-theme-text">
                Request a fresh review under the replacement policy
              </summary>
              <p className="mt-2 text-xs text-theme-muted">
                Replace this task’s revoked or superseded policy with the active approved release.
                This preserves its scope, evidence, and spent budgets. The code must pass a fresh
                review and hard checks before merging.
              </p>
              <label className="mt-3 block text-sm text-theme-text">
                Reason for revalidation
                <textarea
                  value={replacementRationale}
                  onChange={(event) => setReplacementRationale(event.target.value)}
                  className="input mt-1.5"
                />
              </label>
              <button
                type="button"
                className="btn-secondary mt-3 disabled:opacity-50"
                disabled={!props.capability || props.busy || !replacementRationale.trim()}
                onClick={() =>
                  props.run(
                    () =>
                      api.governance.revalidateTaskPolicy(
                        props.projectId,
                        item.taskId,
                        props.summary.activeReleaseId!,
                        replacementRationale.trim(),
                        props.capability
                      ),
                    "Requested a fresh review under the replacement policy. This action does not approve the code.",
                    `case:${item.id}`
                  )
                }
              >
                Request fresh policy review
              </button>
            </details>
          )}
      </header>
      <section aria-label="Findings" className="space-y-3">
        {item.findings.map((finding) => {
          const rule = release?.rules.find((entry) => entry.id === finding.ruleRevisionId);
          const appeal = item.appeals.find((entry) => entry.findingId === finding.id);
          return (
            <div
              key={finding.id}
              className="rounded-lg border border-theme-border bg-theme-bg/40 p-3"
            >
              <p className="break-all text-xs font-medium uppercase tracking-wide text-theme-muted">
                {finding.category} · {finding.severity} · {finding.id}
              </p>
              <h4 className="mt-2 text-sm font-semibold text-theme-text">
                {rule?.ruleId ?? finding.ruleId ?? "Independent code finding"}
                {rule && ` · revision ${rule.revision}`}
              </h4>
              {rule && (
                <>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-theme-text">{rule.text}</p>
                  <p className="mt-2 text-xs text-theme-muted">Why: {rule.rationale}</p>
                </>
              )}
              <p className="mt-3 break-all font-mono text-xs text-theme-muted">
                {finding.file} @ {finding.codeRevision.slice(0, 12)}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-theme-text">{finding.evidence}</p>
              <p className="mt-2 text-xs text-theme-muted">
                Suggested fix: {finding.suggestedRemedy}
              </p>
              <p className="mt-2 text-xs text-theme-muted">
                Reviewed by{" "}
                {(finding.provenance.sources?.length
                  ? finding.provenance.sources
                  : [finding.provenance]
                )
                  .map((source) =>
                    [source.reviewer, source.angle, source.model].filter(Boolean).join(" · ")
                  )
                  .join("; ")}
              </p>
              {appeal && (
                <div className="mt-3 border-t border-theme-border pt-3">
                  <h5 className="text-sm font-medium text-theme-text">Coder’s appeal</h5>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-theme-text">
                    {appeal.requestedException}
                  </p>
                  <EvidenceList title="Alternatives analyzed" items={appeal.alternatives} />
                  <div className="mt-2">
                    <h6 className="text-xs font-medium text-theme-muted">
                      Why compliant options fail
                    </h6>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-theme-text">
                      {appeal.whyCompliantOptionsFail}
                    </p>
                  </div>
                  <EvidenceList title="Tests" items={appeal.tests} />
                  <EvidenceList title="Risks" items={appeal.risks} />
                  <EvidenceList title="Proposed limits" items={appeal.proposedLimits} />
                </div>
              )}
            </div>
          );
        })}
      </section>
      {item.reconsideration && (
        <section
          aria-label="Reviewer reconsideration"
          className="rounded-lg border border-theme-border p-3"
        >
          <h4 className="text-sm font-semibold text-theme-text">
            Reviewer reconsideration ·{" "}
            {item.reconsideration.status === "approved" ? "Approved" : "Still rejected"}
          </h4>
          <p className="mt-2 whitespace-pre-wrap text-sm text-theme-text">
            {item.reconsideration.summary}
          </p>
          {item.reconsideration.notes && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-theme-muted">
              {item.reconsideration.notes}
            </p>
          )}
          <EvidenceList
            title="Withdrawn findings"
            items={item.reconsideration.withdrawnFindingIds ?? []}
          />
        </section>
      )}
      {item.verifiedDisposition && (
        <section
          aria-label="Verified disposition"
          className="rounded-lg border border-theme-border p-3"
        >
          <h4 className="text-sm font-semibold text-theme-text">
            Verified disposition · {VERIFIED_DISPOSITION_LABELS[item.verifiedDisposition.kind]}
          </h4>
          {item.verifiedDisposition.decisionIds.length > 0 && (
            <p className="mt-2 break-all text-xs text-theme-muted">
              Decisions: {item.verifiedDisposition.decisionIds.join(", ")}
            </p>
          )}
        </section>
      )}
      {item.recommendation && (
        <section className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
          <h4 className="text-sm font-semibold text-theme-text">
            Judge recommendation · {item.recommendation.disposition.replace(/_/g, " ")}
          </h4>
          <p className="mt-2 whitespace-pre-wrap text-sm text-theme-text">
            {item.recommendation.rationale}
          </p>
          <EvidenceList title="Evidence" items={item.recommendation.evidence} />
          <p className="mt-2 break-words text-xs text-theme-muted">
            Rules: {item.recommendation.ruleIds.join(", ") || "None cited"} · Decisions:{" "}
            {item.recommendation.decisionIds.join(", ") || "No precedent cited"}
          </p>
        </section>
      )}
      {precedent.length > 0 && (
        <details className="rounded-lg border border-theme-border p-3">
          <summary className="cursor-pointer text-sm font-medium text-theme-text">
            Supporting &amp; conflicting precedent ({precedent.length})
          </summary>
          <p className="mt-2 text-xs text-theme-muted">
            These rulings are evidence. Only unrevoked reusable conditions on compatible revisions
            can authorize future exceptions.
          </p>
          <ul className="mt-3 space-y-2">
            {precedent.map((decision) => (
              <li key={decision.id} className="rounded-lg bg-theme-bg p-3">
                <p className="text-sm font-medium text-theme-text">
                  {decision.action.replace(/_/g, " ")} · {decision.actor}
                  {decision.revokedAt && " · Revoked"}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-theme-muted">
                  {decision.rationale}
                </p>
                <p className="mt-2 break-all text-xs text-theme-muted">
                  {decision.id} ·{" "}
                  {decision.conditions
                    ? `Reusable until ${formatGovernanceDate(decision.conditions.expiresAt)}`
                    : "This case only"}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
      <CaseEvidence projectId={props.projectId} item={item} />
      {item.state === "evidence_requested" && (
        <form
          className="space-y-3 rounded-lg border border-theme-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            props.run(
              () =>
                api.governance.addEvidence(
                  props.projectId,
                  item.id,
                  item.version,
                  { humanEvidence: additionalEvidence.trim() },
                  props.capability
                ),
              "Additional evidence retained. The case is ready for a fresh human decision.",
              `case:${item.id}`
            );
          }}
        >
          <label className="block text-sm font-medium text-theme-text">
            Additional evidence
            <textarea
              value={additionalEvidence}
              onChange={(event) => setAdditionalEvidence(event.target.value)}
              rows={3}
              className="input mt-1.5"
              required
            />
          </label>
          <button
            type="submit"
            className="btn-secondary disabled:opacity-50"
            disabled={!props.capability || props.busy || !additionalEvidence.trim()}
          >
            Submit requested evidence
          </button>
        </form>
      )}
      {decisions.length > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-theme-text">Rulings on this case</h4>
          <ul className="mt-2 space-y-2">
            {decisions.map((decision) => (
              <li
                key={decision.id}
                className="rounded-lg border border-theme-border p-3 text-sm text-theme-text"
              >
                <p className="font-medium">
                  {decision.action.replace(/_/g, " ")} · {decision.actor}
                  {decision.revokedAt && " · Revoked"}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{decision.rationale}</p>
                <p className="mt-2 text-xs text-theme-muted">
                  {formatGovernanceDate(decision.createdAt)} · {decision.id}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {isAgentHeldCase(item) && !item.humanCancelled && (
        <p
          className="rounded-lg bg-theme-bg p-3 text-sm text-theme-text"
          data-testid="governance-agent-held"
        >
          No action needed right now. An agent is working on this case, and it will return here if
          it needs your decision.
        </p>
      )}
      {canResolve && (
        <form
          className="space-y-4 border-t border-theme-border pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reusableValid || caseChanged || actionBlocked) return;
            onSubmitted();
            props.run(
              () =>
                api.governance.resolve(
                  props.projectId,
                  item.id,
                  {
                    expectedVersion: item.version,
                    idempotencyKey: resolutionKey,
                    action,
                    rationale: rationale.trim(),
                    headSha: item.headSha,
                    diffHash: item.diffHash,
                    ...(action === "allow_reusable" && expiryDate
                      ? {
                          conditions: {
                            version: 1,
                            paths: reusablePaths,
                            ruleRevisionIds: reusableRuleIds,
                            expiresAt: expiryDate.toISOString(),
                          },
                        }
                      : {}),
                  },
                  props.capability
                ),
              action === "request_evidence"
                ? "Evidence request recorded. The task remains paused."
                : action === "cancel"
                  ? "Adjudication cancelled. The task remains paused until a safe human disposition."
                  : action === "abandon"
                    ? "Work abandoned. The task is closed without merging."
                    : "Human ruling recorded. The task will resume through normal review and hard checks.",
              `case:${item.id}`
            );
          }}
        >
          <h4 className="text-sm font-semibold text-theme-text">Your ruling</h4>
          <label className="block text-sm font-medium text-theme-text">
            Decision
            <select
              value={action}
              onChange={(event) => {
                setAction(event.target.value as GovernanceDecisionAction);
                setConfirmed(false);
              }}
              className="input mt-1.5"
            >
              {ACTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={
                    recoveryRequired &&
                    (option.value.startsWith("allow") || option.value === "request_evidence")
                  }
                >
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p
            className="rounded-lg bg-theme-bg p-3 text-sm text-theme-muted"
            data-testid="governance-action-consequence"
          >
            {currentAction.consequence}
          </p>
          {allowance && hasHardBlockers && (
            <p role="alert" className="text-sm text-theme-text">
              This case includes a defect, security concern, or failed gate. A standards exception
              cannot waive those blockers.
            </p>
          )}
          {item.state === "stale" && (
            <p className="text-sm text-theme-muted">
              Return this task for a fix, cancel adjudication, or abandon the work. Adding evidence
              cannot replace the fresh review required for changed code or policy.
            </p>
          )}
          {allowance && nonWaivable && (
            <p role="alert" className="text-sm text-theme-text">
              The governing policy does not permit an exception to this rule. Require a fix or
              propose a separately evaluated amendment.
            </p>
          )}
          {allowance && unavailableRules && (
            <p role="alert" className="text-sm text-theme-text">
              The governing rule revision is unavailable. Approval is withheld until policy
              retrieval is complete.
            </p>
          )}
          {action === "allow_reusable" && (
            <fieldset className="space-y-3 rounded-lg border border-theme-border p-3">
              <legend className="px-1 text-sm font-medium text-theme-text">
                Explicit reusable scope
              </legend>
              <label className="block text-sm text-theme-text">
                Allowed paths, one per line
                <textarea
                  value={paths}
                  onChange={(event) => setPaths(event.target.value)}
                  rows={3}
                  className="input mt-1.5"
                  required
                />
              </label>
              <label className="block text-sm text-theme-text">
                Expires at
                <input
                  type="datetime-local"
                  value={expiry}
                  onChange={(event) => setExpiry(event.target.value)}
                  className="input mt-1.5"
                  required
                />
              </label>
              <p className="text-xs text-theme-muted">
                Only these exact rule revisions may be reused. A changed rule or revoked decision
                requires a new ruling.
              </p>
              {ruleIds.map((id) => (
                <label key={id} className="flex items-start gap-2 text-sm text-theme-text">
                  <input
                    type="checkbox"
                    checked={reusableRuleIds.includes(id)}
                    onChange={(event) =>
                      setReusableRuleIds((current) =>
                        event.target.checked
                          ? [...current, id]
                          : current.filter((entry) => entry !== id)
                      )
                    }
                  />
                  {id}
                </label>
              ))}
            </fieldset>
          )}
          <label className="block text-sm font-medium text-theme-text">
            Rationale
            <textarea
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              className="input mt-1.5"
              rows={3}
              required
              placeholder={
                action === "request_evidence"
                  ? "What evidence is needed, and why?"
                  : "Why is this decision justified for this code and policy?"
              }
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-theme-muted">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                if (event.target.checked) setChangedFromVersion(null);
              }}
              className="mt-0.5"
            />
            I reviewed the evidence and the consequence of this action.
          </label>
          {caseChanged && (
            <p
              ref={changedBannerRef}
              role="alert"
              tabIndex={-1}
              className="rounded-lg bg-amber-500/10 p-3 text-sm text-theme-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              data-testid="governance-case-changed"
            >
              Case changed from version {changedFromVersion} to {item.version} while you were
              deciding. Your draft is kept. Review the updated case, then confirm again to submit.
            </p>
          )}
          <button
            type="submit"
            className="btn-primary disabled:opacity-50"
            disabled={
              !props.capability ||
              props.busy ||
              !rationale.trim() ||
              !confirmed ||
              !reusableValid ||
              caseChanged ||
              actionBlocked
            }
          >
            Record human ruling
          </button>
          {!props.capability && (
            <div className="space-y-2">
              <p className="text-xs text-theme-muted">
                Enter the designated owner’s capability before recording a binding ruling.
              </p>
              {props.unlockApproval && (
                <button
                  type="button"
                  onClick={props.unlockApproval}
                  className="text-sm font-medium text-brand-600 underline-offset-4 hover:underline dark:text-brand-400"
                >
                  Unlock approval controls
                </button>
              )}
            </div>
          )}
        </form>
      )}
      <GovernanceResult
        scope={`case:${item.id}`}
        outcome={props.outcome}
        pendingScope={props.pendingScope}
      />
    </article>
  );
}

function CaseEvidence({ projectId, item }: { projectId: string; item: ReviewCaseSummary }) {
  const [expanded, setExpanded] = useState(false);
  const client = useQueryClient();
  const evidence = useQuery({
    queryKey: queryKeys.governance.caseEvidence(
      projectId,
      item.id,
      item.version,
      item.evidenceHash
    ),
    enabled: expanded,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const current = await api.governance.getCase(projectId, item.id);
      if (current.version !== item.version || current.evidenceHash !== item.evidenceHash) {
        void client.invalidateQueries({
          queryKey: queryKeys.governance.summary(projectId),
          exact: true,
        });
        throw new Error(
          "This case changed. Review the refreshed case and load its evidence again."
        );
      }
      return current.evidence;
    },
  });
  return (
    <details
      className="rounded-lg border border-theme-border p-3"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer text-sm font-medium text-theme-text">
        Inspect full diff &amp; retained evidence
      </summary>
      <p className="mt-3 break-all text-xs text-theme-muted">
        Evidence hash: {item.evidenceHash} · Diff hash: {item.diffHash}
      </p>
      {expanded && evidence.isPending && (
        <p role="status" className="mt-3 text-sm text-theme-muted">
          Loading case evidence…
        </p>
      )}
      {evidence.isError && (
        <div role="alert" className="mt-3 space-y-2 text-sm text-theme-text">
          <p>{evidence.error.message}</p>
          <button type="button" className="btn-secondary" onClick={() => void evidence.refetch()}>
            Retry loading evidence
          </button>
        </div>
      )}
      {evidence.data && (
        <>
          {typeof evidence.data.diff === "string" && evidence.data.diff ? (
            <EvidenceDiff diff={evidence.data.diff} />
          ) : (
            <p className="mt-3 text-sm text-theme-muted">No diff was retained for this case.</p>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-theme-muted">
              Raw retained evidence (JSON)
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-theme-bg p-3 text-xs text-theme-text">
              {JSON.stringify(evidence.data, null, 2)}
            </pre>
          </details>
        </>
      )}
    </details>
  );
}

function EvidenceDiff({ diff }: { diff: string }) {
  return (
    <pre
      className="mt-3 max-h-96 overflow-auto rounded-lg bg-theme-bg p-3 font-mono text-xs text-theme-text"
      data-testid="governance-evidence-diff"
    >
      {diff.split("\n").map((line, index) => (
        <span
          key={index}
          className={`block whitespace-pre-wrap break-words ${
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-green-500/10"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-red-500/10"
                : ""
          }`}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function EvidenceList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <h6 className="text-xs font-medium text-theme-muted">{title}</h6>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-theme-text">
        {items.map((entry, index) => (
          <li key={index}>{entry}</li>
        ))}
      </ul>
    </div>
  );
}
