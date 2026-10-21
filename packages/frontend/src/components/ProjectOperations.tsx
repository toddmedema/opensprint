import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectIdentity } from "@opensprint/shared";
import { request } from "../api/client";
interface Operation {
  id: string;
  kind: string;
  target: string;
  actorId: string;
  status: string;
  generation: number;
  createdAt: string;
  result: unknown;
  error: string | null;
}
export function ProjectOperations({
  projectId,
  principal,
}: {
  projectId: string;
  principal?: ProjectIdentity;
}) {
  const prefix = `/projects/${projectId}/runtime/operations`,
    key = ["operations", projectId];
  const qc = useQueryClient();
  const operations = useQuery({
    queryKey: key,
    queryFn: () => request<Operation[]>(prefix),
    refetchInterval: 4000,
  });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const action = useMutation({
    mutationFn: ({
      operation,
      outcome,
    }: {
      operation: Operation;
      outcome: "completed" | "failed";
    }) =>
      request(`${prefix}/${operation.id}/reconcile`, {
        method: "POST",
        body: JSON.stringify({
          expectedGeneration: operation.generation,
          outcome,
          reason: reasons[operation.id],
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  return (
    <details>
      <summary>
        Recent actions
        {operations.data?.some((op) => op.status === "uncertain")
          ? " · outcome needs inspection"
          : ""}
      </summary>
      <p className="py-2">
        Actions continue after disconnect. Inspect uncertain effects before recording their outcome.
      </p>
      {operations.error && <p role="alert">{operations.error.message}</p>}
      <ol className="max-h-96 space-y-2 overflow-auto">
        {operations.data?.map((operation) => (
          <li key={operation.id} className="rounded border border-theme-border p-2">
            <details>
              <summary>
                {operation.kind} · {operation.status} ·{" "}
                {new Date(operation.createdAt).toLocaleString()}
              </summary>
              <p>
                Target: {operation.target} · Actor: {operation.actorId}
              </p>
              {operation.error && <p>{operation.error}</p>}
              {operation.result != null && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(operation.result, null, 2).slice(0, 6000)}
                </pre>
              )}
              {operation.status === "uncertain" &&
                (!principal ||
                  principal.local ||
                  principal.permissions.includes(
                    operation.kind.startsWith("deployment.") ? "deploy" : "control"
                  )) && (
                  <div className="space-y-2">
                    <label className="block">
                      Evidence from inspecting the external effect
                      <textarea
                        value={reasons[operation.id] ?? ""}
                        onChange={(event) =>
                          setReasons({ ...reasons, [operation.id]: event.target.value })
                        }
                        maxLength={2000}
                        className="block w-full rounded border p-1 text-black"
                      />
                    </label>
                    {(["completed", "failed"] as const).map((outcome) => (
                      <button
                        key={outcome}
                        className="mr-2 rounded border px-2 py-1"
                        disabled={!reasons[operation.id]?.trim() || action.isPending}
                        onClick={() => action.mutate({ operation, outcome })}
                      >
                        Record {outcome}
                      </button>
                    ))}
                  </div>
                )}
            </details>
          </li>
        ))}
      </ol>
      {action.error && <p role="alert">{action.error.message}</p>}
    </details>
  );
}
