import { useRef, useState } from "react";
import { api } from "../../../api/client";
import { revokedGovernanceReleaseIds } from "../../../lib/governance";
import type { GovernancePanelProps } from "../GovernanceSettingsContent";
import { GovernanceResult } from "./GovernanceResult";
type SourceChange = Awaited<ReturnType<typeof api.governance.sourceChanges>>;

export function PolicySourceChanges({
  projectId,
  capability,
  busy,
  run,
  outcome,
  pendingScope,
}: GovernancePanelProps) {
  const [taskId, setTaskId] = useState("");
  const [preview, setPreview] = useState<SourceChange | null>(null);
  const [rationale, setRationale] = useState("");
  // Only the newest lookup may show its diff; an older response must never be approvable.
  const lookup = useRef(0);
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
              lookup.current += 1;
              setTaskId(event.target.value);
              setPreview(null);
            }}
            placeholder="os-1234"
            className="input mt-1.5"
          />
        </label>
        <button
          type="button"
          disabled={!taskId.trim() || busy}
          className="btn-secondary disabled:opacity-50"
          onClick={() =>
            run(
              async () => {
                const current = ++lookup.current;
                const change = await api.governance.sourceChanges(projectId, taskId.trim());
                if (current === lookup.current) setPreview(change);
              },
              "Loaded the current policy-source change.",
              "source-changes"
            )
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
            run(
              async () => {
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
              },
              "Approved these exact source changes. Gates and policy release requirements remain in force.",
              "source-changes"
            );
          }}
        >
          <p className="break-all text-xs text-theme-muted">
            Task {preview.taskId} · Code {preview.headSha} · Policy {preview.releaseId}
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
              className="input mt-1.5"
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
      <div className="mt-3">
        <GovernanceResult scope="source-changes" outcome={outcome} pendingScope={pendingScope} />
      </div>
    </details>
  );
}

export function PolicyReleaseRevocation({
  projectId,
  summary,
  capability,
  busy,
  run,
  outcome,
  pendingScope,
}: GovernancePanelProps) {
  const [rationale, setRationale] = useState("");
  const releaseId = summary.activeReleaseId;
  const [confirmedReleaseId, setConfirmedReleaseId] = useState<string | null>(null);
  const confirmed = releaseId !== null && confirmedReleaseId === releaseId;
  const revoked = releaseId !== null && revokedGovernanceReleaseIds(summary).has(releaseId);
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
            if (!confirmed) return;
            run(
              () =>
                api.governance.revokeRelease(projectId, releaseId, rationale.trim(), capability),
              "Critically revoked this release. Affected pending tasks are held for a new policy and review; published work has a remediation record.",
              "release-revocation"
            );
          }}
        >
          <p className="text-sm text-theme-muted">
            Use this when the current release is unsafe or invalid. Revocation stops new assignments
            and invalidates pending approvals under this release. It preserves the audit trail and
            does not undo published commits.
          </p>
          <p className="break-all text-xs text-theme-muted">Release to revoke: {releaseId}</p>
          <label className="block text-sm text-theme-text">
            Reason for critical revocation
            <textarea
              required
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              className="input mt-1.5"
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-theme-text">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmedReleaseId(event.target.checked ? releaseId : null)}
              required
              className="mt-1"
            />
            I understand affected tasks will pause until a replacement policy and fresh review are
            approved.
          </label>
          <button
            type="submit"
            disabled={!capability || busy || !rationale.trim() || !confirmed}
            className="btn-danger disabled:opacity-50"
          >
            Revoke current policy release
          </button>
        </form>
      )}
      <div className="mt-3">
        <GovernanceResult
          scope="release-revocation"
          outcome={outcome}
          pendingScope={pendingScope}
        />
      </div>
    </details>
  );
}
