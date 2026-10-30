import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type GovernanceReplayLabel } from "../../../api/client";
import { GOVERNANCE_INPUT_CLASS, type GovernancePanelProps } from "../GovernanceSettingsContent";

const LABELS: Array<{ value: GovernanceReplayLabel; label: string }> = [
  { value: "compliant", label: "Compliant change" },
  { value: "exception", label: "Legitimate exception" },
  { value: "defect", label: "Defect" },
  { value: "conflict", label: "Conflicting rulings" },
  { value: "retrieval_miss", label: "Retrieval miss" },
];

export function ReplayFixtures(props: GovernancePanelProps) {
  const queryClient = useQueryClient();
  const fixtures = useQuery({
    queryKey: ["governance", props.projectId, "replay-fixtures"],
    queryFn: () => api.governance.fixtures(props.projectId),
  });
  const sources = useQuery({
    queryKey: ["governance", props.projectId, "replay-sources"],
    queryFn: () => api.governance.replaySources(props.projectId),
  });
  const [sessionId, setSessionId] = useState("");
  const [label, setLabel] = useState<GovernanceReplayLabel>("compliant");
  const [holdout, setHoldout] = useState(true);
  const [toolchain, setToolchain] = useState("");
  const [rubricId, setRubricId] = useState("");
  const [rubric, setRubric] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const selectedSource = sources.data?.find((source) => source.sessionId === Number(sessionId));
  const availableSources =
    sources.data?.filter(
      (source) => !fixtures.data?.some((fixture) => fixture.sessionId === source.sessionId)
    ) ?? [];
  return (
    <details className="rounded-xl border border-theme-border p-4">
      <summary className="cursor-pointer text-sm font-semibold text-theme-text">
        Human-labeled evaluation set ({fixtures.data?.length ?? 0} fixtures)
      </summary>
      <p className="mt-3 text-sm text-theme-muted">
        Label retained task inputs and write a fixed, independent rubric. The original base commit,
        task prompt, and policy are captured by the server; candidate agents cannot change their
        benchmark.
      </p>
      <p className="mt-2 text-xs text-theme-muted">
        Activation requires at least ten fixtures covering all five categories, held-out positive
        and negative cases, and complete measured baseline and candidate runs. Unsupported isolation
        or missing inputs produces an incomplete evaluation.
      </p>
      {fixtures.error && (
        <p role="alert" className="mt-3 text-sm text-theme-text">
          Could not load replay fixtures: {fixtures.error.message}
        </p>
      )}
      {(fixtures.data?.length ?? 0) > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-theme-border text-theme-muted">
                <th className="py-2 pr-3 font-medium">Session</th>
                <th className="py-2 pr-3 font-medium">Human label</th>
                <th className="py-2 pr-3 font-medium">Split</th>
                <th className="py-2 font-medium">Rubric</th>
              </tr>
            </thead>
            <tbody>
              {fixtures.data?.map((fixture) => (
                <tr
                  key={fixture.sessionId}
                  className="border-b border-theme-border-subtle text-theme-text"
                >
                  <td className="py-2 pr-3">{fixture.sessionId}</td>
                  <td className="py-2 pr-3">
                    {LABELS.find((entry) => entry.value === fixture.label)?.label}
                  </td>
                  <td className="py-2 pr-3">{fixture.holdout ? "Held out" : "Development"}</td>
                  <td className="break-all py-2">{fixture.rubricId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sources.error ? (
        <p role="alert" className="mt-3 text-sm text-theme-text">
          Retained task sources could not be loaded: {sources.error.message}
        </p>
      ) : sources.isPending ? (
        <p className="mt-3 text-sm text-theme-muted" role="status">
          Loading retained task sources…
        </p>
      ) : availableSources.length === 0 ? (
        <p className="mt-4 rounded-lg bg-theme-bg p-3 text-sm text-theme-muted">
          No unlabeled retained sessions are available. Complete a governed task with retained
          review evidence before adding a fixture.
        </p>
      ) : (
        <form
          className="mt-5 space-y-3 border-t border-theme-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedSource) return;
            props.run(async () => {
              const result = await api.governance.captureFixture(
                props.projectId,
                {
                  sessionId: selectedSource.sessionId,
                  taskId: selectedSource.taskId,
                  toolchain: toolchain.trim(),
                  label,
                  holdout,
                  rubric: {
                    id: rubricId.trim(),
                    text: rubric.trim(),
                    checks: [
                      {
                        name: "Independent verification",
                        command: command.trim(),
                        args: args.split("\n").filter(Boolean),
                      },
                    ],
                  },
                },
                props.capability
              );
              await queryClient.invalidateQueries({
                queryKey: ["governance", props.projectId, "replay-fixtures"],
              });
              setSessionId("");
              return result;
            }, "Human-labeled fixture retained with original task inputs. Its rubric is immutable.");
          }}
        >
          <h4 className="text-sm font-semibold text-theme-text">Add a labeled fixture</h4>
          <label className="block text-sm font-medium text-theme-text">
            Retained task session
            <select
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              required
            >
              <option value="">Select a completed task session</option>
              {availableSources.map((source) => (
                <option key={source.sessionId} value={source.sessionId}>
                  {source.taskId} · attempt {source.attempt} · {source.status} · session{" "}
                  {source.sessionId}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-theme-text">
              Human label
              <select
                value={label}
                onChange={(event) => setLabel(event.target.value as GovernanceReplayLabel)}
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              >
                {LABELS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-theme-text">
              Pinned toolchain
              <input
                value={toolchain}
                onChange={(event) => setToolchain(event.target.value)}
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
                placeholder="Node 24 / npm lockfile revision"
                required
              />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm text-theme-text">
            <input
              type="checkbox"
              checked={holdout}
              onChange={(event) => setHoldout(event.target.checked)}
              className="mt-0.5"
            />
            Hold this example out of candidate generation
          </label>
          <label className="block text-sm font-medium text-theme-text">
            Independent rubric ID
            <input
              value={rubricId}
              onChange={(event) => setRubricId(event.target.value)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              required
            />
          </label>
          <label className="block text-sm font-medium text-theme-text">
            Expected behavior &amp; fixed evaluation rubric
            <textarea
              value={rubric}
              onChange={(event) => setRubric(event.target.value)}
              rows={3}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
              required
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-theme-text">
              Independent check executable
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
                placeholder="npm"
                required
              />
            </label>
            <label className="text-sm font-medium text-theme-text">
              Arguments, one per line
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                rows={3}
                className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
                placeholder={"run\ntest:governance"}
              />
            </label>
          </div>
          <p className="text-xs text-theme-muted">
            The check runs in the isolated evaluator. Each line is a literal argument; shell
            expressions are not expanded.
          </p>
          <button
            type="submit"
            className="btn-secondary disabled:opacity-50"
            disabled={!props.capability || props.busy || !selectedSource}
          >
            Retain labeled fixture
          </button>
        </form>
      )}
    </details>
  );
}
