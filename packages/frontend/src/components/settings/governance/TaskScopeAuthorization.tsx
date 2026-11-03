import { useState } from "react";
import { api } from "../../../api/client";
import type { GovernancePanelProps } from "../GovernanceSettingsContent";
import { GovernanceResult } from "./GovernanceResult";

/** The values the server accepts as grants; wording in a task never matches them. */
const SCOPE_VALUES = [
  "integration",
  "oauth",
  "todoist",
  "token-encrypt",
  "api-key-stor",
  "third-party-auth",
  "external-service",
  "connection-service",
] as const;

/**
 * With enforcement on, only this grant lets a task change protected integration, OAuth, or token
 * files. It must be made before the task is first assigned, because an assigned task's scope is fixed.
 */
export function TaskScopeAuthorization({
  projectId,
  capability,
  busy,
  run,
  outcome,
  pendingScope,
}: GovernancePanelProps) {
  const [taskId, setTaskId] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [rationale, setRationale] = useState("");
  const ready = Boolean(capability && taskId.trim() && scopes.length && rationale.trim());
  return (
    <details className="rounded-xl border border-theme-border p-4">
      <summary className="cursor-pointer text-sm font-medium text-theme-text">
        Authorize protected scope for a task
      </summary>
      <p className="mt-3 text-sm text-theme-muted">
        Under bounded adjudication, a task&apos;s title and description are evidence only. Grant
        protected scope here before the task is assigned; an assigned task keeps the scope it
        started with.
      </p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          run(
            () =>
              api.governance.authorizeScope(
                projectId,
                taskId.trim(),
                scopes.join(", "),
                rationale.trim(),
                capability
              ),
            `Protected scope granted to ${taskId.trim()}: ${scopes.join(", ")}.`,
            "task-scope"
          );
        }}
      >
        <label className="block text-sm text-theme-text">
          Task to authorize
          <input
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            className="input mt-1.5"
          />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-sm text-theme-text">Scope to grant</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {SCOPE_VALUES.map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm text-theme-text">
                <input
                  type="checkbox"
                  checked={scopes.includes(value)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, value]
                        : current.filter((entry) => entry !== value)
                    )
                  }
                />
                {value}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-sm text-theme-text">
          Reason for the grant
          <textarea
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            className="input mt-1.5"
            rows={2}
          />
        </label>
        <button
          type="submit"
          className="btn-secondary disabled:opacity-50"
          disabled={!ready || busy}
        >
          Grant scope
        </button>
      </form>
      <GovernanceResult scope="task-scope" outcome={outcome} pendingScope={pendingScope} />
    </details>
  );
}
