import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { GovernanceSummary, GovernanceMode } from "@opensprint/shared";
import { api, isApiError } from "../../api/client";
import { queryKeys } from "../../api/queryKeys";
import { GovernanceDocket } from "./governance/GovernanceDocket";
import { PolicyRegistry } from "./governance/PolicyRegistry";
import { PolicyProposals } from "./governance/PolicyProposals";
import { GovernanceHistory } from "./governance/GovernanceHistory";
import { PolicySourceChanges, PolicyReleaseRevocation } from "./governance/PolicySourceChanges";
import { OPEN_GOVERNANCE_CASE_STATES } from "../../lib/governance";

export const GOVERNANCE_INPUT_CLASS =
  "w-full rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50";
export type GovernanceRun = (operation: () => Promise<unknown>, successMessage: string) => void;

export interface GovernancePanelProps {
  projectId: string;
  summary: GovernanceSummary;
  capability: string;
  busy: boolean;
  run: GovernanceRun;
  unlockApproval?: () => void;
}

const MODE_LABELS: Record<GovernanceMode, string> = {
  disabled: "Off",
  shadow: "Shadow pilot",
  enforced: "Bounded adjudication",
};

export function GovernanceSettingsContent({ projectId }: { projectId: string }) {
  // Approval credentials are intentionally kept in component memory only.
  const [capability, setCapability] = useState("");
  const authorityRef = useRef<HTMLDetailsElement>(null);
  const [tab, setTab] = useState<"docket" | "standards" | "proposals" | "history">("docket");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const summaryQuery = useQuery({
    queryKey: queryKeys.governance.summary(projectId),
    queryFn: () => api.governance.get(projectId),
    refetchInterval: 15_000,
  });
  const command = useMutation({
    mutationFn: async ({
      operation,
      message,
    }: {
      operation: () => Promise<unknown>;
      message: string;
    }) => {
      await operation();
      return message;
    },
    onSuccess: (message) => {
      setFeedback(message);
      void queryClient.invalidateQueries({ queryKey: queryKeys.governance.summary(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.global() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
    },
    onError: (error) => {
      setFeedback(null);
      if (isApiError(error) && /STALE|CONFLICT|VERSION/.test(error.code)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.governance.summary(projectId) });
      }
    },
  });
  const run: GovernanceRun = (operation, message) => {
    setFeedback(null);
    command.mutate({ operation, message });
  };

  if (summaryQuery.isPending)
    return (
      <p role="status" className="py-8 text-sm text-theme-muted">
        Loading review governance…
      </p>
    );
  if (!summaryQuery.data)
    return (
      <div role="alert" className="rounded-xl border border-theme-border p-5">
        <p className="text-sm text-theme-text">
          {summaryQuery.error instanceof Error
            ? summaryQuery.error.message
            : "Review governance could not be loaded."}
        </p>
        <button
          type="button"
          onClick={() => void summaryQuery.refetch()}
          className="btn-secondary mt-3"
        >
          Try again
        </button>
      </div>
    );

  const summary = summaryQuery.data;
  const pendingCount = summary.cases.filter(
    (item) => item.humanCancelled || OPEN_GOVERNANCE_CASE_STATES.has(item.state)
  ).length;
  const props: GovernancePanelProps = {
    projectId,
    summary,
    capability,
    busy: command.isPending,
    run,
    unlockApproval: () => {
      if (authorityRef.current) {
        authorityRef.current.open = true;
        authorityRef.current.scrollIntoView?.({ block: "start" });
        authorityRef.current.querySelector<HTMLInputElement>('input[type="password"]')?.focus();
      }
    },
  };

  return (
    <div className="space-y-6 pb-8" data-testid="governance-settings">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-theme-text">Review governance</h2>
          <p className="mt-1 max-w-2xl text-sm text-theme-muted">
            Apply approved standards, decide exceptions, and improve rules with an auditable human
            decision.
          </p>
        </div>
        <span className="rounded-full border border-theme-border bg-theme-bg px-3 py-1 text-xs font-medium text-theme-text">
          {MODE_LABELS[summary.config.mode]}
        </span>
      </header>

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <SummaryStat label="Waiting for a decision" value={String(pendingCount)} />
        <SummaryStat
          label="Approved standards"
          value={String(
            summary.releases.find((release) => release.id === summary.activeReleaseId)?.rules
              .length ?? 0
          )}
        />
        <SummaryStat
          label="Amendments to review"
          value={String(
            summary.proposals.filter(
              (proposal) => proposal.state !== "activated" && proposal.state !== "rejected"
            ).length
          )}
        />
      </div>

      <details
        ref={authorityRef}
        className="rounded-xl border border-theme-border bg-theme-bg/40"
        open={!summary.authority.configured}
      >
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-theme-text">
          Human authority &amp; rollout
        </summary>
        <div className="space-y-4 border-t border-theme-border px-4 py-4">
          {summary.authority.owner && (
            <p className="text-sm font-medium text-theme-text">
              Decisions are recorded as {summary.authority.owner}.
            </p>
          )}
          {!summary.authority.configured && (
            <p className="text-sm text-theme-muted">
              A project owner must configure governance approval authority on the server before
              rulings or policy changes can be saved.
            </p>
          )}
          <label className="block max-w-xl text-sm font-medium text-theme-text">
            Approval capability
            <input
              type="password"
              value={capability}
              onChange={(event) => setCapability(event.target.value)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              autoComplete="off"
              spellCheck={false}
              disabled={!summary.authority.configured}
              aria-describedby="governance-capability-help"
            />
          </label>
          <p id="governance-capability-help" className="text-xs text-theme-muted">
            Enter the owner’s approval capability to make a binding decision. It stays in this
            page’s memory and clears when you leave.
          </p>
          {capability && (
            <button
              type="button"
              className="text-sm text-theme-muted underline"
              onClick={() => setCapability("")}
            >
              Lock approval controls
            </button>
          )}
          <GovernanceConfiguration key={`${summary.config.version}:${projectId}`} {...props} />
        </div>
      </details>

      {command.error && (
        <div
          role="alert"
          className="rounded-lg border border-theme-error-border bg-theme-error-bg px-4 py-3 text-sm text-theme-text"
        >
          {isApiError(command.error) && /STALE|CONFLICT|VERSION/.test(command.error.code)
            ? "This review changed before your decision was saved. Review the refreshed evidence and submit a new decision. "
            : ""}
          {command.error.message}
        </div>
      )}
      {feedback && (
        <p
          role="status"
          className="rounded-lg border border-theme-border px-4 py-3 text-sm text-theme-text"
        >
          {feedback}
        </p>
      )}
      {command.isPending && (
        <p role="status" className="text-sm text-theme-muted">
          Processing governance request… Evaluations may take several minutes.
        </p>
      )}

      <div
        role="tablist"
        tabIndex={-1}
        aria-label="Governance sections"
        className="flex flex-wrap gap-1 border-b border-theme-border pb-3"
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const keys = ["docket", "standards", "proposals", "history"] as const;
          let index = keys.indexOf(tab);
          if (event.key === "ArrowRight") index = (index + 1) % keys.length;
          else if (event.key === "ArrowLeft") index = (index + keys.length - 1) % keys.length;
          else if (event.key === "Home") index = 0;
          else if (event.key === "End") index = keys.length - 1;
          else return;
          event.preventDefault();
          setTab(keys[index]);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`#governance-tab-${keys[index]}`)
            ?.focus();
        }}
      >
        {(
          [
            ["docket", `Docket${pendingCount > 0 ? ` (${pendingCount})` : ""}`],
            ["standards", "Standards"],
            ["proposals", "Rule amendments"],
            ["history", "Decision history"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`governance-tab-${id}`}
            aria-controls={`governance-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 ${tab === id ? "bg-brand-500/10 text-brand-700 dark:text-brand-300" : "text-theme-muted hover:bg-theme-border-subtle"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={`governance-panel-${tab}`}
        aria-labelledby={`governance-tab-${tab}`}
      >
        {tab === "docket" && (
          <GovernanceDocket {...props} selectedCaseId={searchParams.get("case")} />
        )}
        {tab === "standards" && (
          <div className="space-y-5">
            <PolicyRegistry {...props} />
            <PolicySourceChanges {...props} />
            <PolicyReleaseRevocation {...props} />
          </div>
        )}
        {tab === "proposals" && <PolicyProposals {...props} />}
        {tab === "history" && <GovernanceHistory {...props} />}
      </section>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-theme-border px-3 py-3 sm:px-4">
      <p className="text-xl font-semibold tabular-nums text-theme-text sm:text-2xl">{value}</p>
      <p className="mt-1 text-xs text-theme-muted">{label}</p>
    </div>
  );
}

function GovernanceConfiguration({
  projectId,
  summary,
  capability,
  busy,
  run,
}: GovernancePanelProps) {
  const [mode, setMode] = useState(summary.config.mode);
  const [model, setModel] = useState(summary.config.judgeAgent?.model ?? "");
  const [provider, setProvider] = useState(summary.config.judgeAgent?.type ?? "openai");
  const [inputPrice, setInputPrice] = useState(
    summary.config.judgeTokenPricing?.inputPerMillionUsd.toString() ?? ""
  );
  const [outputPrice, setOutputPrice] = useState(
    summary.config.judgeTokenPricing?.outputPerMillionUsd.toString() ?? ""
  );
  const [reconsiderationModel, setReconsiderationModel] = useState(
    summary.config.reconsiderationAgent?.model ?? ""
  );
  const [reconsiderationProvider, setReconsiderationProvider] = useState(
    summary.config.reconsiderationAgent?.type ?? "openai"
  );
  const [reconsiderationInputPrice, setReconsiderationInputPrice] = useState(
    summary.config.reconsiderationTokenPricing?.inputPerMillionUsd.toString() ?? ""
  );
  const [reconsiderationOutputPrice, setReconsiderationOutputPrice] = useState(
    summary.config.reconsiderationTokenPricing?.outputPerMillionUsd.toString() ?? ""
  );
  const [limits, setLimits] = useState({
    maxAppeals: summary.config.maxAppeals,
    maxTokens: summary.config.maxTokens,
    maxCostUsd: summary.config.maxCostUsd,
    maxElapsedMs: summary.config.maxElapsedMs,
    recurrenceThreshold: summary.config.recurrenceThreshold,
    contextMaxChars: summary.config.contextMaxChars,
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        run(
          () =>
            api.governance.configure(
              projectId,
              {
                expectedVersion: summary.config.version,
                mode,
                ...limits,
                judgeAgent: { type: provider, model: model.trim() || null, cliCommand: null },
                reconsiderationAgent: reconsiderationModel.trim()
                  ? {
                      type: reconsiderationProvider,
                      model: reconsiderationModel.trim(),
                      cliCommand: null,
                    }
                  : null,
                reconsiderationTokenPricing:
                  reconsiderationInputPrice && reconsiderationOutputPrice
                    ? {
                        inputPerMillionUsd: Number(reconsiderationInputPrice),
                        outputPerMillionUsd: Number(reconsiderationOutputPrice),
                      }
                    : null,
                ...(inputPrice && outputPrice
                  ? {
                      judgeTokenPricing: {
                        inputPerMillionUsd: Number(inputPrice),
                        outputPerMillionUsd: Number(outputPrice),
                      },
                    }
                  : { judgeTokenPricing: null }),
              },
              capability
            ),
          "Governance configuration saved."
        );
      }}
      className="space-y-3"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm font-medium text-theme-text">
          Rollout mode
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as GovernanceMode)}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
          >
            <option value="disabled">Off</option>
            <option value="shadow">Shadow pilot</option>
            <option value="enforced">Bounded adjudication</option>
          </select>
        </label>
        <label className="text-sm font-medium text-theme-text">
          Judge provider
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as typeof provider)}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
          >
            <option value="openai">OpenAI</option>
            <option value="claude">Anthropic</option>
            {provider !== "openai" && provider !== "claude" && (
              <option value={provider}>{provider} · human docket fallback</option>
            )}
          </select>
        </label>
        <label className="text-sm font-medium text-theme-text">
          Judge model
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            placeholder="A model for difficult reasoning"
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-theme-text">
          Input price ceiling ($ / million tokens)
          <input
            type="number"
            min={0}
            step="any"
            value={inputPrice}
            onChange={(event) => setInputPrice(event.target.value)}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            required={Boolean(outputPrice)}
          />
        </label>
        <label className="text-sm text-theme-text">
          Output price ceiling ($ / million tokens)
          <input
            type="number"
            min={0}
            step="any"
            value={outputPrice}
            onChange={(event) => setOutputPrice(event.target.value)}
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            required={Boolean(inputPrice)}
          />
        </label>
      </div>
      <p className="text-xs text-theme-muted">
        Set verified price ceilings for the configured model to bound judge spending. Without
        configured ceilings, disputes go directly to the human docket.
      </p>
      <fieldset className="rounded-lg border border-theme-border p-3">
        <legend className="px-1 text-sm font-medium text-theme-text">
          Read-only reviewer reconsideration
        </legend>
        <p className="mb-3 text-xs text-theme-muted">
          Choose the API reviewer that reconsiders an appeal before the independent judge. This
          model can differ from the judge and from the initial code reviewer, including an initial
          CLI reviewer. It receives evidence and has no repository tools.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-theme-text">
            Reconsideration provider
            <select
              value={reconsiderationProvider}
              onChange={(event) =>
                setReconsiderationProvider(event.target.value as typeof reconsiderationProvider)
              }
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            >
              <option value="openai">OpenAI</option>
              <option value="claude">Anthropic</option>
            </select>
          </label>
          <label className="text-sm text-theme-text">
            Reconsideration model
            <input
              value={reconsiderationModel}
              onChange={(event) => setReconsiderationModel(event.target.value)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              placeholder="An API model for reviewing appeals"
            />
          </label>
          <label className="text-sm text-theme-text">
            Reconsideration input price ceiling ($ / million tokens)
            <input
              type="number"
              min={0}
              step="any"
              value={reconsiderationInputPrice}
              onChange={(event) => setReconsiderationInputPrice(event.target.value)}
              required={Boolean(reconsiderationOutputPrice)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            />
          </label>
          <label className="text-sm text-theme-text">
            Reconsideration output price ceiling ($ / million tokens)
            <input
              type="number"
              min={0}
              step="any"
              value={reconsiderationOutputPrice}
              onChange={(event) => setReconsiderationOutputPrice(event.target.value)}
              required={Boolean(reconsiderationInputPrice)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            />
          </label>
        </div>
        <p className="mt-3 text-xs text-theme-muted">
          Set verified price ceilings for this model separately from the judge. With no
          reconsideration model, only an initial API reviewer matching the judge’s exact provider
          and model can use the judge’s ceilings. Otherwise the dispute requires a human. Clear this
          model and both ceilings to remove the separate configuration.
        </p>
      </fieldset>
      <details className="rounded-lg border border-theme-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-theme-text">
          Appeal budgets &amp; policy limits
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(
            [
              ["maxAppeals", "Total appeal cycles per task"],
              ["maxTokens", "Total agent tokens per task"],
              ["maxCostUsd", "Total agent cost per task ($)"],
              ["maxElapsedMs", "Total agent time per task (ms)"],
              ["contextMaxChars", "Policy context limit (characters)"],
              ["recurrenceThreshold", "Rulings before a rule nomination"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-sm text-theme-text">
              {label}
              <input
                type="number"
                min={key === "maxCostUsd" ? 0.01 : 1}
                step={key === "maxCostUsd" ? 0.01 : 1}
                value={limits[key]}
                onChange={(event) =>
                  setLimits((current) => ({ ...current, [key]: Number(event.target.value) }))
                }
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
                required
              />
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-theme-muted">
          Each finding gets one reconsideration and judge cycle per material diff. New commits do
          not reset the task’s overall budget. Missing mandatory policy blocks approval.
        </p>
      </details>
      <p className="text-xs text-theme-muted">
        Shadow recommendations preserve normal review outcomes. Bounded adjudication requires review
        on every task and an approved release. Open holds must be explicitly resolved before
        governance can be turned off.
      </p>
      <button
        type="submit"
        className="btn-secondary disabled:opacity-50"
        disabled={!capability || busy}
      >
        Save rollout settings
      </button>
    </form>
  );
}
