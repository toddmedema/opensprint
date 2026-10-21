import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../api/client";
import { getAccessSession, type AccessSession } from "../api/session";
import type { ProjectPermission } from "@opensprint/shared";
import { ProjectOperations } from "./ProjectOperations";
interface Presence {
  people: { actorId: string; displayName: string; focus: string; typing: boolean }[];
  presenter: { actor_id: string; focus: string; revision: number } | null;
}
export function CollaborationBar({ projectId }: { projectId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const connectionId = useRef(crypto.randomUUID());
  const typedAt = useRef(0);
  const [follow, setFollow] = useState(false);
  const [invite, setInvite] = useState("");
  const [name, setName] = useState("");
  const [grant, setGrant] = useState<"viewer" | "editor" | "controller" | "approver">("viewer");
  const phase = location.pathname.split("/").at(-1) ?? "sketch";
  const prefix = `/projects/${projectId}/runtime`;
  const key = ["presence", projectId];
  const presence = useQuery({
    queryKey: key,
    queryFn: () => request<Presence>(`${prefix}/presence`),
    refetchInterval: 3000,
  });
  const session = useQuery({
    queryKey: ["access", projectId],
    queryFn: () =>
      request<AccessSession>(`/auth/session?projectId=${encodeURIComponent(projectId)}`),
    retry: false,
  });
  const principal = session.data?.principal ?? getAccessSession()?.principal;
  const canManage = !principal || principal.local || principal.permissions.includes("manage");
  const mutation = useMutation({
    mutationFn: async () => {
      const permissions: ProjectPermission[] =
        grant === "viewer"
          ? ["read"]
          : grant === "approver"
            ? ["read", "approve"]
            : grant === "controller"
              ? ["read", "discuss", "edit", "control"]
              : ["read", "discuss", "edit"];
      const result = await request<{ token: string }>(
        `/projects/${projectId}/members/invitations`,
        {
          method: "POST",
          body: JSON.stringify({
            displayName: name,
            role:
              grant === "controller" ? "controller" : grant === "viewer" ? "viewer" : "participant",
            permissions,
          }),
        }
      );
      setInvite(result.token);
      setName("");
    },
  });
  useEffect(() => {
    const onInput = () => {
      typedAt.current = Date.now();
    };
    document.addEventListener("input", onInput);
    const beat = () => {
      if (!["sketch", "plan", "execute", "eval", "evaluate", "deliver"].includes(phase)) return;
      void (async () =>
        request(`${prefix}/presence`, {
          method: "POST",
          body: JSON.stringify({
            connectionId: connectionId.current,
            typing: Date.now() - typedAt.current < 5000,
            focus: phase === "eval" ? "evaluate" : phase,
          }),
        }))().catch(() => {});
    };
    beat();
    const timer = setInterval(beat, 8000);
    return () => {
      document.removeEventListener("input", onInput);
      clearInterval(timer);
    };
  }, [prefix, phase]);
  const presenter = presence.data?.presenter;
  useEffect(() => {
    if (follow && presenter?.focus && presenter.actor_id !== principal?.actorId)
      navigate(
        `/projects/${projectId}/${presenter.focus === "evaluate" ? "eval" : presenter.focus}`
      );
  }, [follow, presenter?.focus, presenter?.actor_id, principal?.actorId, projectId, navigate]);
  const [error, setError] = useState("");
  return (
    <aside
      aria-label="Project collaboration"
      className="border-b border-theme-border px-4 py-2 text-sm"
    >
      <ProjectOperations projectId={projectId} principal={principal} />
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`/collaborate/${projectId}`}>Discussion and run control</Link>
        <Link to={`/projects/${projectId}/publication`}>Draft publication</Link>
        <span aria-label="People present">
          {[
            ...new Map(
              (presence.data?.people ?? []).map((person) => [person.actorId, person])
            ).values(),
          ]
            .map((person) => `${person.displayName}${person.typing ? " is typing…" : ""}`)
            .join(", ")}
        </span>
        {presenter && (
          <label>
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />{" "}
            Follow presenter
          </label>
        )}
        <button
          onClick={async () => {
            try {
              await request(`${prefix}/presenter`, {
                method: "PUT",
                body: JSON.stringify({
                  expectedRevision: presenter?.revision ?? 0,
                  focus:
                    presenter?.actor_id === (principal?.actorId ?? "local-user")
                      ? null
                      : phase === "eval"
                        ? "evaluate"
                        : phase,
                }),
              });
              await qc.invalidateQueries({ queryKey: key });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Presentation changed.");
            }
          }}
        >
          Present this view
        </button>
      </div>
      {canManage && (
        <details className="mt-2">
          <summary>Invite a person</summary>
          <form
            className="flex flex-wrap gap-2 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            <input
              aria-label="Person’s name"
              placeholder="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="rounded border p-1 text-black"
            />
            <select
              aria-label="Project permission"
              value={grant}
              onChange={(event) => setGrant(event.target.value as typeof grant)}
              className="text-black"
            >
              <option value="viewer">View</option>
              <option value="editor">Discuss and edit</option>
              <option value="controller">Edit and control runs</option>
              <option value="approver">Approve changes</option>
            </select>
            <button disabled={!name.trim() || mutation.isPending}>Create invitation</button>
          </form>
          {invite && (
            <p>
              Single-use invitation (expires in one hour):{" "}
              <code className="select-all break-all">{invite}</code>
            </p>
          )}
        </details>
      )}
      {(error || mutation.error) && <p role="alert">{error || mutation.error?.message}</p>}
    </aside>
  );
}
