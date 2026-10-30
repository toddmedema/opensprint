import { useState } from "react";
import type { PolicyRuleRevision } from "@opensprint/shared";
import { AGENT_ROLE_CANONICAL_ORDER, AGENT_ROLE_LABELS } from "@opensprint/shared";
import { api } from "../../../api/client";
import { GOVERNANCE_INPUT_CLASS, type GovernancePanelProps } from "../GovernanceSettingsContent";

const lines = (value: string) =>
  value
    .split(/\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
const emptyRule = (): PolicyRuleRevision => ({
  id: "",
  ruleId: "",
  revision: 1,
  text: "",
  rationale: "",
  owner: "",
  paths: [],
  components: [],
  roles: ["coder", "reviewer", "judge"],
  severity: "standard",
  mandatory: true,
  exceptionEligible: true,
  examples: { compliant: [], noncompliant: [] },
  parentIds: [],
  overrideIds: [],
  conflictIds: [],
  layer: 1,
  sourceHash: "",
});

export function PolicyRegistry(props: GovernancePanelProps) {
  const active = props.summary.releases.find((item) => item.id === props.summary.activeReleaseId);
  const [draftRules, setDraftRules] = useState<PolicyRuleRevision[]>([]);
  const [editing, setEditing] = useState<PolicyRuleRevision | null>(null);
  const [before, setBefore] = useState<PolicyRuleRevision | null>(null);
  const [enforcement, setEnforcement] = useState(active?.enforcementRevision ?? "");
  const [releaseRationale, setReleaseRationale] = useState("");
  const initialRelease = props.summary.releases.find(
    (release) => release.id !== props.summary.activeReleaseId
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-theme-text">Approved standards</h3>
          <p className="mt-1 max-w-2xl text-sm text-theme-muted">
            Each task pins an immutable release. An exception decides one case; a reviewed amendment
            changes future standards.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setBefore(null);
            setEditing(emptyRule());
          }}
        >
          Add a standard
        </button>
      </div>
      {active ? (
        <div className="rounded-lg border border-theme-border bg-theme-bg/40 p-3">
          <p className="text-sm font-medium text-theme-text">Active release · {active.id}</p>
          <p className="mt-1 break-all text-xs text-theme-muted">
            Content {active.contentHash} · Enforcement {active.enforcementRevision}
          </p>
        </div>
      ) : (
        <p className="rounded-lg bg-theme-bg p-4 text-sm text-theme-muted">
          Start with a small, manually reviewed policy. Existing project instructions continue to
          apply. Publish and activate the first release before enabling adjudication.
        </p>
      )}
      {(active?.rules ?? []).map((rule) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          onEdit={() => {
            setBefore(rule);
            setEditing({
              ...rule,
              id: `${rule.ruleId}@${rule.revision + 1}`,
              revision: rule.revision + 1,
              sourceHash: "",
            });
          }}
        />
      ))}
      {draftRules.length > 0 && (
        <section className="space-y-3">
          <h4 className="text-sm font-semibold text-theme-text">Unpublished initial standards</h4>
          {draftRules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              onEdit={() => {
                setBefore(null);
                setEditing(rule);
              }}
            />
          ))}
        </section>
      )}
      {editing && (
        <RuleEditor
          key={editing.id || "new"}
          {...props}
          initial={editing}
          before={before}
          onCancel={() => setEditing(null)}
          onDraft={(rule) => {
            setDraftRules((current) => [
              ...current.filter((entry) => entry.ruleId !== rule.ruleId),
              rule,
            ]);
            setEditing(null);
          }}
        />
      )}
      {!active && draftRules.length > 0 && (
        <form
          className="space-y-3 rounded-xl border border-theme-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            props.run(
              () =>
                api.governance.createRelease(
                  props.projectId,
                  {
                    expectedActiveReleaseId: null,
                    rules: draftRules,
                    instructions: {},
                    sourceHashes: {},
                    enforcementRevision: enforcement.trim(),
                    rationale: releaseRationale.trim(),
                  },
                  props.capability
                ),
              "Initial release saved. Review its complete content before activation."
            );
          }}
        >
          <h4 className="text-sm font-semibold text-theme-text">Publish initial release</h4>
          <label className="block text-sm font-medium text-theme-text">
            Compatible enforcement commit
            <input
              value={enforcement}
              onChange={(event) => setEnforcement(event.target.value)}
              placeholder="Full Git commit SHA"
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              required
            />
          </label>
          <label className="block text-sm font-medium text-theme-text">
            Approval rationale
            <textarea
              value={releaseRationale}
              onChange={(event) => setReleaseRationale(event.target.value)}
              rows={2}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              required
            />
          </label>
          <button
            type="submit"
            className="btn-primary disabled:opacity-50"
            disabled={
              !props.capability || props.busy || !releaseRationale.trim() || !enforcement.trim()
            }
          >
            Publish initial release
          </button>
        </form>
      )}
      {!active && initialRelease && (
        <section className="space-y-3 rounded-xl border border-theme-border p-4">
          <h4 className="text-sm font-semibold text-theme-text">
            Initial release ready to activate
          </h4>
          <p className="text-sm text-theme-muted">
            {initialRelease.id} · {initialRelease.rules.length} standards. Activation makes this
            immutable content govern new assignments.
          </p>
          <details>
            <summary className="cursor-pointer text-sm text-theme-text">
              Inspect complete release
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-theme-bg p-3 text-xs text-theme-text">
              {JSON.stringify(initialRelease, null, 2)}
            </pre>
          </details>
          <label className="block text-sm font-medium text-theme-text">
            Activation rationale
            <textarea
              value={releaseRationale}
              onChange={(event) => setReleaseRationale(event.target.value)}
              rows={2}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            />
          </label>
          <button
            type="button"
            className="btn-primary disabled:opacity-50"
            disabled={!props.capability || props.busy || !releaseRationale.trim()}
            onClick={() =>
              props.run(
                () =>
                  api.governance.activateRelease(
                    props.projectId,
                    initialRelease.id,
                    { expectedActiveReleaseId: null, rationale: releaseRationale.trim() },
                    props.capability
                  ),
                "Initial policy activated. New assignments will use this release."
              )
            }
          >
            Activate first policy
          </button>
        </section>
      )}
    </div>
  );
}

function RuleCard({ rule, onEdit }: { rule: PolicyRuleRevision; onEdit: () => void }) {
  return (
    <article className="rounded-xl border border-theme-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-theme-text">
            {rule.ruleId}{" "}
            <span className="font-normal text-theme-muted">· revision {rule.revision}</span>
          </h4>
          <p className="mt-1 text-xs text-theme-muted">
            {rule.severity === "constraint"
              ? "Non-waivable constraint"
              : rule.exceptionEligible
                ? "Standard · exceptions eligible"
                : "Standard · no exceptions"}
            {rule.mandatory && " · Mandatory"} · {rule.owner}
          </p>
        </div>
        <button
          type="button"
          className="text-sm font-medium text-brand-600 hover:underline"
          onClick={onEdit}
        >
          Propose a change
        </button>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm text-theme-text">{rule.text}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-theme-muted">{rule.rationale}</p>
      <p className="mt-3 break-words text-xs text-theme-muted">
        Paths: {rule.paths.join(", ") || "All"} · Roles: {rule.roles.join(", ") || "All"}
      </p>
      {rule.parentIds.length > 0 && (
        <p className="mt-1 text-xs text-theme-muted">Parents: {rule.parentIds.join(", ")}</p>
      )}
      {rule.overrideIds.length > 0 && (
        <p className="mt-1 text-xs text-theme-muted">
          Explicit overrides: {rule.overrideIds.join(", ")}
        </p>
      )}
    </article>
  );
}

function RuleEditor({
  initial,
  before,
  onCancel,
  onDraft,
  ...props
}: GovernancePanelProps & {
  initial: PolicyRuleRevision;
  before: PolicyRuleRevision | null;
  onCancel: () => void;
  onDraft: (rule: PolicyRuleRevision) => void;
}) {
  const [rule, setRule] = useState(initial);
  const [scope, setScope] = useState("");
  const [compatibility, setCompatibility] = useState("");
  const [enforcement, setEnforcement] = useState(
    props.summary.releases.find((item) => item.id === props.summary.activeReleaseId)
      ?.enforcementRevision ?? ""
  );
  const [supporting, setSupporting] = useState("");
  const [contrary, setContrary] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const patch = <K extends keyof PolicyRuleRevision>(key: K, value: PolicyRuleRevision[K]) =>
    setRule((current) => ({ ...current, [key]: value }));
  const initialOnboarding = props.summary.activeReleaseId === null;
  return (
    <form
      className="space-y-4 rounded-xl border border-brand-500/40 p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        setFormError(null);
        if (
          !rule.ruleId.trim() ||
          !rule.text.trim() ||
          !rule.rationale.trim() ||
          !rule.owner.trim()
        ) {
          setFormError("Provide a stable ID, rule text, rationale, and owner.");
          return;
        }
        const after = {
          ...rule,
          ruleId: rule.ruleId.trim(),
          id: `${rule.ruleId.trim()}@${rule.revision}`,
          exceptionEligible: rule.severity === "constraint" ? false : rule.exceptionEligible,
          sourceHash: "",
        };
        if (initialOnboarding) {
          onDraft(after);
          return;
        }
        props.run(
          () =>
            api.governance.propose(
              props.projectId,
              {
                projectId: props.projectId,
                baseReleaseId: props.summary.activeReleaseId!,
                title: `${before ? "Amend" : "Add"} ${after.ruleId}`,
                rationale: after.rationale,
                patches: [{ ruleId: after.ruleId, before, after }],
                supportingDecisionIds: lines(supporting),
                contraryDecisionIds: lines(contrary),
                scope,
                compatibility,
                enforcementRevision: enforcement,
                positiveExamples: after.examples.compliant,
                negativeExamples: after.examples.noncompliant,
              },
              props.capability
            ),
          "Amendment proposed. Evaluation and explicit human activation are required before policy changes."
        );
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-base font-semibold text-theme-text">
          {initialOnboarding ? "Author a standard" : "Draft a rule amendment"}
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-theme-muted hover:underline"
        >
          Close editor
        </button>
      </div>
      {formError && (
        <p role="alert" className="text-sm text-theme-error-solid">
          {formError}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-theme-text">
          Stable rule ID
          <input
            value={rule.ruleId}
            onChange={(event) => patch("ruleId", event.target.value)}
            disabled={before !== null}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            placeholder="architecture.repository-access"
            required
          />
        </label>
        <label className="text-sm font-medium text-theme-text">
          Owner
          <input
            value={rule.owner}
            onChange={(event) => patch("owner", event.target.value)}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            required
          />
        </label>
      </div>
      <label className="block text-sm font-medium text-theme-text">
        Full rule text
        <textarea
          value={rule.text}
          onChange={(event) => patch("text", event.target.value)}
          rows={4}
          className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
          required
        />
      </label>
      <label className="block text-sm font-medium text-theme-text">
        Rationale
        <textarea
          value={rule.rationale}
          onChange={(event) => patch("rationale", event.target.value)}
          rows={3}
          className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
          required
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-theme-text">
          Classification
          <select
            value={rule.severity}
            onChange={(event) => {
              patch("severity", event.target.value as PolicyRuleRevision["severity"]);
              if (event.target.value === "constraint") patch("exceptionEligible", false);
            }}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
          >
            <option value="standard">Standard</option>
            <option value="constraint">Non-waivable constraint</option>
          </select>
        </label>
        <label className="text-sm font-medium text-theme-text">
          Policy layer
          <input
            type="number"
            min={0}
            value={rule.layer}
            onChange={(event) => patch("layer", Number(event.target.value))}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-theme-text">
          <input
            type="checkbox"
            checked={rule.mandatory}
            onChange={(event) => patch("mandatory", event.target.checked)}
          />
          Always include this rule
        </label>
        <label className="flex items-center gap-2 text-sm text-theme-text">
          <input
            type="checkbox"
            checked={rule.exceptionEligible}
            disabled={rule.severity === "constraint"}
            onChange={(event) => patch("exceptionEligible", event.target.checked)}
          />
          Exceptions may be considered
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-theme-text">
          Applicable paths
          <textarea
            defaultValue={rule.paths.join("\n")}
            onChange={(event) => patch("paths", lines(event.target.value))}
            rows={2}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            placeholder="packages/backend/src/**"
          />
        </label>
        <label className="text-sm font-medium text-theme-text">
          Components
          <textarea
            defaultValue={rule.components.join("\n")}
            onChange={(event) => patch("components", lines(event.target.value))}
            rows={2}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            placeholder="One per line; empty means all"
          />
        </label>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-theme-text">Applicable roles</legend>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {AGENT_ROLE_CANONICAL_ORDER.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm text-theme-text">
              <input
                type="checkbox"
                checked={rule.roles.includes(role)}
                onChange={(event) =>
                  patch(
                    "roles",
                    event.target.checked
                      ? [...rule.roles, role]
                      : rule.roles.filter((item) => item !== role)
                  )
                }
              />
              {AGENT_ROLE_LABELS[role]}
            </label>
          ))}
        </div>
      </fieldset>
      <details>
        <summary className="cursor-pointer text-sm font-medium text-theme-text">
          Parents, overrides, conflicts &amp; examples
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(
            [
              ["parentIds", "Parent revision IDs"],
              ["overrideIds", "Authorized override revision IDs"],
              ["conflictIds", "Conflicting revision IDs"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-sm text-theme-text">
              {label}
              <textarea
                defaultValue={rule[key].join("\n")}
                onChange={(event) => patch(key, lines(event.target.value))}
                rows={2}
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              />
            </label>
          ))}
          {(
            [
              ["compliant", "Compliant examples"],
              ["noncompliant", "Noncompliant examples"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-sm text-theme-text">
              {label}
              <textarea
                defaultValue={rule.examples[key].join("\n")}
                onChange={(event) =>
                  patch("examples", {
                    ...rule.examples,
                    [key]: event.target.value.split("\n").filter(Boolean),
                  })
                }
                rows={3}
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              />
            </label>
          ))}
        </div>
      </details>
      {!initialOnboarding && (
        <fieldset className="space-y-3 border-t border-theme-border pt-4">
          <legend className="text-sm font-semibold text-theme-text">Amendment evidence</legend>
          <label className="block text-sm text-theme-text">
            Intended scope
            <textarea
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              rows={2}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              required
            />
          </label>
          <label className="block text-sm text-theme-text">
            Migration &amp; compatibility effects
            <textarea
              value={compatibility}
              onChange={(event) => setCompatibility(event.target.value)}
              rows={2}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              required
            />
          </label>
          <label className="block text-sm text-theme-text">
            Compatible enforcement commit
            <input
              value={enforcement}
              onChange={(event) => setEnforcement(event.target.value)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              required
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-theme-text">
              Supporting decision IDs
              <textarea
                value={supporting}
                onChange={(event) => setSupporting(event.target.value)}
                rows={2}
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              />
            </label>
            <label className="text-sm text-theme-text">
              Contrary decision IDs
              <textarea
                value={contrary}
                onChange={(event) => setContrary(event.target.value)}
                rows={2}
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              />
            </label>
          </div>
          <p className="text-xs text-theme-muted">
            Include positive and negative examples above. Contrary decisions remain part of the
            review even when an exception has recurred.
          </p>
        </fieldset>
      )}
      <button
        type="submit"
        className="btn-primary disabled:opacity-50"
        disabled={props.busy || (!initialOnboarding && !props.capability)}
      >
        {initialOnboarding ? "Add to initial release" : "Submit amendment for evaluation"}
      </button>
    </form>
  );
}
