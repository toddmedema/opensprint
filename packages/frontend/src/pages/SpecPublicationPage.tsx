import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../api/client";
import { getAccessSession, type AccessSession } from "../api/session";
import type { ProjectPermission } from "@opensprint/shared";

interface Draft {
  revision: number;
  content: string;
  content_hash: string;
  base_sha: string;
  base_ref: string;
  approved?: boolean;
}
interface Operation {
  operation_id: string;
  revision: number;
  status: string;
  error: string | null;
  commit_sha: string | null;
}

export function SpecPublicationPage() {
  const { projectId = "" } = useParams();
  return <SpecPublicationEditor key={projectId} projectId={projectId} />;
}
function SpecPublicationEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const base = `/projects/${encodeURIComponent(projectId)}/publication`;
  const key = ["spec-publication", projectId];
  const sharedHost = Boolean(document.querySelector('meta[name="opensprint-shared-host"]'));
  const access = useQuery({
    queryKey: ["access", projectId],
    queryFn: () =>
      request<AccessSession>(`/auth/session?projectId=${encodeURIComponent(projectId)}`),
    enabled: sharedHost || Boolean(getAccessSession()),
    retry: false,
  });
  const principal = access.isError
    ? undefined
    : (access.data?.principal ?? getAccessSession()?.principal);
  const can = (permission: ProjectPermission) =>
    principal
      ? principal.local || principal.permissions.includes(permission)
      : !sharedHost && !getAccessSession();
  const draft = useQuery({ queryKey: key, queryFn: () => request<Draft | null>(`${base}/draft`) });
  const published = useQuery({
    queryKey: [...key, "published"],
    queryFn: async () => (await request<{ content: string }>(`${base}/published`)).content,
  });
  const [edit, setEdit] = useState<{ content: string; baseRevision: number } | null>(null);
  const [approved, setApproved] = useState<{ revision: number; contentHash: string } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const operations = useQuery({
    queryKey: [...key, "operations"],
    queryFn: () => request<Operation[]>(`${base}/operations`),
    refetchInterval: 2000,
  });
  const identity = useRef<{ revision: number; id: string } | null>(null);
  const content = edit?.content ?? draft.data?.content ?? published.data ?? "";
  const revision = draft.data?.revision ?? 0;
  const changed = content !== draft.data?.content;
  const save = useMutation({
    mutationFn: () =>
      request<Draft>(`${base}/draft`, {
        method: "PUT",
        body: JSON.stringify({ content, expectedRevision: edit?.baseRevision ?? revision }),
      }),
    onSuccess: (result) => {
      qc.setQueryData(key, result);
      setEdit(null);
      setApproved(null);
      setOperation(null);
      identity.current = null;
    },
  });
  const approve = useMutation({
    mutationFn: (input: { revision: number; contentHash: string }) =>
      request(`${base}/approve`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (_result, input) => setApproved(input),
  });
  const importEdits = useMutation({
    mutationFn: () =>
      request<Draft>(`${base}/import`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: revision }),
      }),
    onSuccess: (result) => {
      qc.setQueryData(key, result);
      setEdit(null);
      setApproved(null);
    },
  });
  const publish = useMutation({
    mutationFn: () => {
      const accepted = operations.data?.find(
        (op) => op.revision === revision && op.status !== "failed"
      );
      const previous =
        operations.data?.find((op) => op.operation_id === identity.current?.id) ??
        (operation?.operation_id === identity.current?.id ? operation : null);
      if (identity.current?.revision !== revision || previous?.status === "failed")
        identity.current = { revision, id: accepted?.operation_id ?? crypto.randomUUID() };
      return request<Operation>(`${base}/publish`, {
        method: "POST",
        timeoutMs: null,
        body: JSON.stringify({ revision, operationId: identity.current.id }),
      });
    },
    onSuccess: (result) => {
      setOperation(result);
      void qc.invalidateQueries({ queryKey: [...key, "published"] });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [...key, "operations"] }),
  });
  const latest = operation ?? operations.data?.[0] ?? null;
  const reconcileId = identity.current?.id ?? latest?.operation_id;
  const reconcile = useMutation({
    mutationFn: () => request<Operation | null>(`${base}/operations/${reconcileId!}`),
    onSuccess: setOperation,
  });
  const busy =
    save.isPending ||
    approve.isPending ||
    publish.isPending ||
    reconcile.isPending ||
    importEdits.isPending;
  const error =
    draft.error ??
    published.error ??
    operations.error ??
    save.error ??
    approve.error ??
    publish.error ??
    reconcile.error ??
    importEdits.error;
  return (
    <main className="mx-auto w-full max-w-4xl space-y-4 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold">Reviewed SPEC publication</h1>
      <p className="text-sm text-theme-muted">
        Save an immutable draft, approve its exact content and Git base, then validate and publish
        it. Sketch autosaves use the installation’s existing local editing policy.
      </p>
      {error && (
        <p role="alert" className="text-theme-error-text">
          {error.message}
        </p>
      )}
      {draft.isPending || published.isPending ? (
        <p role="status">Loading SPEC…</p>
      ) : (
        <>
          <label htmlFor="spec-draft">Draft content</label>
          <textarea
            id="spec-draft"
            className="min-h-96 w-full rounded border border-theme-border bg-theme-bg p-3 font-mono text-sm"
            value={content}
            disabled={busy || !can("edit")}
            onChange={(event) => {
              setEdit((previous) => ({
                content: event.target.value,
                baseRevision: previous?.baseRevision ?? revision,
              }));
              setApproved(null);
            }}
          />
          {draft.data && (
            <p className="break-all text-sm text-theme-muted">
              Revision {revision} · Base {draft.data.base_sha} · {draft.data.base_ref}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary"
              disabled={busy || !!edit || !can("edit")}
              onClick={() => importEdits.mutate()}
            >
              Import editor changes
            </button>
            <button
              className="btn-secondary"
              disabled={busy || !changed || !can("edit")}
              onClick={() => save.mutate()}
            >
              Save draft
            </button>
            <button
              className="btn-secondary"
              disabled={busy || changed || !draft.data || !can("approve")}
              onClick={() => approve.mutate({ revision, contentHash: draft.data!.content_hash })}
            >
              Approve this revision
            </button>
            <button
              className="btn-primary"
              disabled={
                busy ||
                !can("publish") ||
                !operations.isSuccess ||
                changed ||
                !draft.data ||
                !(
                  draft.data.approved ||
                  (approved?.contentHash === draft.data.content_hash &&
                    approved.revision === revision)
                )
              }
              onClick={() => publish.mutate()}
            >
              Validate and publish
            </button>
            {reconcileId && (
              <button className="btn-secondary" disabled={busy} onClick={() => reconcile.mutate()}>
                Check publication
              </button>
            )}
          </div>
          {publish.isPending && (
            <p role="status">
              Validating the candidate and publishing. The server continues if this page
              disconnects.
            </p>
          )}
          {latest && (
            <p role="status">
              Publication {latest.status} · {latest.operation_id}
              {latest.commit_sha ? ` · ${latest.commit_sha}` : ""}
              {latest.error ? ` · ${latest.error}` : ""}
            </p>
          )}
        </>
      )}
    </main>
  );
}
