import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CollaborationRole } from "@opensprint/shared";
import type { CollaborationSessionState } from "./useCollaborationSession";

export const collaborationRoleLabels: Record<CollaborationRole, string> = {
  viewer: "Can view",
  participant: "Can discuss",
  controller: "Can guide agents",
};
const field =
  "w-full rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text";

export function CollaborationInvites({
  session,
  projectId,
}: {
  session: CollaborationSessionState;
  projectId: string;
}) {
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<CollaborationRole>("participant");
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [inviteLink, setInviteLink] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const invitationOrigin = session.overview.data?.shareOrigin ?? window.location.origin;
  const invites = useQuery({
    queryKey: [...session.queryKey, "invites"],
    queryFn: ({ signal }) => session.client.invites(signal),
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
      void invites.refetch();
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
  const error = invites.error ?? create.error ?? revoke.error;
  const localOnly = ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(invitationOrigin).hostname
  );
  return (
    <section aria-label="Project invitations" className="space-y-4">
      <div>
        <h3 className="font-semibold text-theme-text">Invite to this project</h3>
        <p className="mt-1 text-sm text-theme-muted">
          Each person gets their own access and identity.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-theme-error-text">
          {error.message}
        </p>
      )}
      {session.overview.data?.shareOrigin && (
        <p className="text-sm text-theme-muted">Invitations use {invitationOrigin}</p>
      )}
      {localOnly && (
        <p className="rounded-lg bg-theme-surface-muted p-3 text-sm text-theme-muted">
          This address is local to your computer. Teammates need a reachable host address to join;
          invitations do not expose your installation to the network.
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
        <div className="grid gap-3 sm:grid-cols-2">
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
        <button
          type="submit"
          className="btn-primary"
          disabled={create.isPending || !displayName.trim()}
        >
          {create.isPending ? "Creating…" : "Create invite"}
        </button>
      </form>
      {inviteLink && (
        <div className="space-y-2 rounded-lg border border-theme-border p-3">
          <label className="block text-sm" htmlFor="collaboration-invite-link">
            Private invitation link
          </label>
          <input
            id="collaboration-invite-link"
            className={field}
            value={inviteLink}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
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
            <button type="button" className="btn-secondary" onClick={() => setInviteLink("")}>
              Hide link
            </button>
          </div>
          <p role="status" className="text-xs text-theme-muted">
            {copyStatus || "Keep this link private. It is shown only when created."}
          </p>
        </div>
      )}
      <ul aria-label="Invitations" className="divide-y divide-theme-border">
        {invites.data?.map((invite) => {
          const ended =
            Boolean(invite.revokedAt) || new Date(invite.expiresAt).getTime() <= Date.now();
          return (
            <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
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
                  className="btn-secondary"
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
        <p className="text-sm text-theme-muted">No invitations yet.</p>
      )}
    </section>
  );
}
