import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CollaborationRole } from "@opensprint/shared";
import type { CollaborationSessionState } from "./useCollaborationSession";

export const collaborationRoleLabels: Record<CollaborationRole, string> = {
  viewer: "Can view",
  participant: "Can discuss",
  controller: "Can guide agents",
};
const field =
  "min-h-11 w-full rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text";

/**
 * Create one private invitation with safe defaults; advanced access and past invitations
 * appear only when requested. The parent owns the Share sheet and its dismissal.
 */
export function CollaborationInvites({
  session,
  projectId,
}: {
  session: CollaborationSessionState;
  projectId: string;
}) {
  const id = useId();
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<CollaborationRole>("participant");
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [inviteLink, setInviteLink] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const mayManage = session.principal?.actorId === "local-user";
  const invitationOrigin = session.overview.data?.shareOrigin ?? window.location.origin;
  const invites = useQuery({
    queryKey: [...session.queryKey, "invites"],
    queryFn: ({ signal }) => session.client.invites(signal),
    enabled: mayManage && manageOpen,
    retry: false,
    gcTime: 0,
  });
  const create = useMutation({
    gcTime: 0,
    mutationFn: session.client.createInvite,
    onSuccess: (result) => {
      const url = new URL(`/collaborate/${encodeURIComponent(projectId)}`, invitationOrigin);
      url.hash = new URLSearchParams({ invite: result.token }).toString();
      setInviteLink(url.toString());
      setDisplayName("");
      setCopyStatus("");
      if (manageOpen) void invites.refetch();
    },
  });
  const revoke = useMutation({
    gcTime: 0,
    mutationFn: session.client.revokeInvite,
    onSuccess: () => {
      setInviteLink("");
      void invites.refetch();
      void session.invalidate();
    },
  });
  const error = create.error ?? revoke.error ?? (manageOpen ? invites.error : null);
  const localOnly = ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(invitationOrigin).hostname
  );
  if (!mayManage)
    return <p className="text-sm text-theme-muted">Ask the host to manage project access.</p>;
  return (
    <section aria-label="Project invitations" className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-theme-error-text">
          {error.message}
        </p>
      )}
      {localOnly && (
        <p className="rounded-lg bg-theme-surface-muted p-3 text-sm text-theme-muted">
          This link only works on this computer. Set up a reachable sharing address for teammates.
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (displayName.trim())
            create.mutate({ displayName: displayName.trim(), role, expiresInHours });
        }}
      >
        <label className="block text-sm">
          Person’s name
          <input
            className={`${field} mt-1`}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={120}
            required
            autoComplete="off"
          />
        </label>
        <p className="text-xs text-theme-muted">
          {collaborationRoleLabels[role]} · Expires in{" "}
          {expiresInHours === 168
            ? "7 days"
            : `${expiresInHours} ${expiresInHours === 1 ? "hour" : "hours"}`}
        </p>
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-3 text-theme-muted">
            Access and expiry
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              Access
              <select
                className={`${field} mt-1`}
                value={role}
                onChange={(event) => setRole(event.target.value as CollaborationRole)}
              >
                {Object.entries(collaborationRoleLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Expires
              <select
                className={`${field} mt-1`}
                value={expiresInHours}
                onChange={(event) => setExpiresInHours(Number(event.target.value))}
              >
                <option value={1}>In 1 hour</option>
                <option value={24}>In 24 hours</option>
                <option value={168}>In 7 days</option>
              </select>
            </label>
          </div>
        </details>
        <button
          type="submit"
          className="btn-primary min-h-11"
          disabled={create.isPending || !displayName.trim()}
        >
          {create.isPending ? "Creating…" : "Create invitation"}
        </button>
      </form>
      {inviteLink && (
        <div className="space-y-2 rounded-lg border border-theme-border p-3">
          <label className="block text-sm" htmlFor={`${id}-link`}>
            Private invitation link
          </label>
          <input
            id={`${id}-link`}
            className={field}
            value={inviteLink}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary min-h-11"
              onClick={() => {
                if (!navigator.clipboard) {
                  setCopyStatus("Select the link above and copy it.");
                  return;
                }
                void navigator.clipboard
                  .writeText(inviteLink)
                  .then(() => setCopyStatus("Invitation copied."))
                  .catch(() => setCopyStatus("Select the link above and copy it."));
              }}
            >
              Copy link
            </button>
            <button
              type="button"
              className="btn-secondary min-h-11"
              onClick={() => setInviteLink("")}
            >
              Hide link
            </button>
          </div>
          <p role="status" className="text-xs text-theme-muted">
            {copyStatus || "Keep this link private. It is shown only when created."}
          </p>
        </div>
      )}
      <details
        className="border-t border-theme-border pt-3 text-sm"
        onToggle={(event) => setManageOpen(event.currentTarget.open)}
      >
        <summary className="min-h-11 cursor-pointer py-3 text-theme-muted">Manage access</summary>
        {invites.isPending && manageOpen && (
          <p role="status" className="mt-3 text-theme-muted">
            Loading invitations…
          </p>
        )}
        <ul aria-label="Invitations" className="mt-2 divide-y divide-theme-border">
          {invites.data?.map((invite) => {
            const ended =
              Boolean(invite.revokedAt) || new Date(invite.expiresAt).getTime() <= Date.now();
            return (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <div>
                  <p className="text-sm font-medium">
                    {invite.displayName} · {collaborationRoleLabels[invite.role]}
                  </p>
                  <p className="text-xs text-theme-muted">
                    {invite.revokedAt
                      ? "Revoked"
                      : ended
                        ? "Expired"
                        : `Expires ${new Date(invite.expiresAt).toLocaleString()}`}
                  </p>
                </div>
                {!ended && (
                  <button
                    className="btn-secondary min-h-11"
                    type="button"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(invite.id)}
                    aria-label={`Revoke ${invite.displayName} invitation`}
                  >
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {invites.isSuccess && invites.data.length === 0 && (
          <p className="mt-3 text-theme-muted">No invitations yet.</p>
        )}
      </details>
    </section>
  );
}
