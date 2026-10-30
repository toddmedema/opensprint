import { useState } from "react";
import { api } from "../../../api/client";
import { GOVERNANCE_INPUT_CLASS, type GovernancePanelProps } from "../GovernanceSettingsContent";
type SourceChange = Awaited<ReturnType<typeof api.governance.sourceChanges>>;

export function PolicySourceChanges({ projectId, capability, busy, run }: GovernancePanelProps) {
  const [taskId, setTaskId] = useState("");
  const [preview, setPreview] = useState<SourceChange | null>(null);
  const [rationale, setRationale] = useState("");
  return (
    <details className="rounded-xl border border-theme-border p-4">
      <summary className="cursor-pointer text-sm font-medium text-theme-text">
        Review changes to policy or enforcement files
      </summary>
      <p className="mt-3 text-sm text-theme-muted">
        A task that changes instructions, skills, or hard-check configuration needs a separate human
        review of its exact code. This approval keeps all quality gates in force. Updated standards
        still require an evaluated policy release.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-sm text-theme-text">
          Task ID
          <input
            value={taskId}
            onChange={(event) => {
              setTaskId(event.target.value);
              setPreview(null);
            }}
            placeholder="os-1234"
            className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
          />
        </label>
        <button
          type="button"
          disabled={!taskId.trim() || busy}
          className="btn-secondary disabled:opacity-50"
          onClick={() =>
            run(async () => {
              setPreview(await api.governance.sourceChanges(projectId, taskId.trim()));
            }, "Loaded the current policy-source change.")
          }
        >
          Inspect change
        </button>
      </div>
      {preview && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await api.governance.approveSourceChanges(
                projectId,
                {
                  taskId: preview.taskId,
                  headSha: preview.headSha,
                  diffHash: preview.diffHash,
                  rationale: rationale.trim(),
                },
                capability
              );
              setPreview(null);
              setRationale("");
            }, "Approved these exact source changes. Gates and policy release requirements remain in force.");
          }}
        >
          <p className="break-all text-xs text-theme-muted">
            Code {preview.headSha} · Policy {preview.releaseId}
          </p>
          {preview.changedPaths.length ? (
            <ul className="list-inside list-disc break-words text-sm text-theme-text">
              {preview.changedPaths.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-theme-muted">
              This task has no policy-sensitive file changes to approve.
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-sm text-theme-text">
              Inspect full code diff
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-theme-bg p-3 text-xs text-theme-text">
              {preview.diff}
            </pre>
          </details>
          <label className="block text-sm text-theme-text">
            Approval rationale
            <textarea
              required
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            />
          </label>
          <p className="text-xs text-theme-muted">
            Approve only a deliberately scoped implementation of compatible enforcement or
            policy-source changes. The server rejects this approval if the code changes.
          </p>
          <button
            disabled={!capability || busy || !rationale.trim() || preview.changedPaths.length === 0}
            className="btn-secondary disabled:opacity-50"
            type="submit"
          >
            Approve exact source change
          </button>
        </form>
      )}
    </details>
  );
}

export function PolicyReleaseRevocation({
  projectId,
  summary,
  capability,
  busy,
  run,
}: GovernancePanelProps) {
  const [rationale, setRationale] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const releaseId = summary.activeReleaseId;
  const revoked = summary.events.some(
    (event) => event.kind === "release_revoked" && event.payload.releaseId === releaseId
  );
  if (!releaseId) return null;
  return (
    <details className="rounded-xl border border-theme-border p-4">
      <summary className="cursor-pointer text-sm font-medium text-theme-text">
        Critical policy revocation
      </summary>
      {revoked ? (
        <p className="mt-3 text-sm text-theme-text">
          This release is revoked. Pending work needs a fresh approved policy and review before it
          can resume.
        </p>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () =>
                api.governance.revokeRelease(projectId, releaseId, rationale.trim(), capability),
              "Critically revoked this release. Affected pending tasks are held for a new policy and review; published work has a remediation record."
            );
          }}
        >
          <p className="text-sm text-theme-muted">
            Use this when the current release is unsafe or invalid. Revocation stops new assignments
            and invalidates pending approvals under this release. It preserves the audit trail and
            does not undo published commits.
          </p>
          <label className="block text-sm text-theme-text">
            Reason for critical revocation
            <textarea
              required
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              className={`${GOVERNANCE_INPUT_CLASS} mt-1.5`}
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-theme-text">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              required
              className="mt-1"
            />
            I understand affected tasks will pause until a replacement policy and fresh review are
            approved.
          </label>
          <button
            type="submit"
            disabled={!capability || busy || !rationale.trim() || !confirmed}
            className="btn-secondary disabled:opacity-50"
          >
            Revoke current policy release
          </button>
        </form>
      )}
    </details>
  );
}
