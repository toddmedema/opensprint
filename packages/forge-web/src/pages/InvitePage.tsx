import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { acceptInvite, getSession, queryKeys } from "../api";
import { cap } from "../text";
import { ErrorNote, Loading, PageHeading } from "../ui";

export function InvitePage() {
  const { token = "" } = useParams();
  const tokenId = useId();
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: getSession });
  const mutation = useMutation({
    mutationFn: () => acceptInvite(token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
      await queryClient.invalidateQueries({ queryKey: ["team"] });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="stack">
      <PageHeading
        kicker="People"
        title="Accept invite"
        lead={
          session.data
            ? `Accept this invite for ${session.data.name}.`
            : "Accept this invite for the signed-in user."
        }
      />
      {session.isPending ? <Loading>Checking session…</Loading> : null}
      {!token ? (
        <p className="error" role="alert">
          Error: This invite link is missing a token.
        </p>
      ) : (
        <form className="card form-narrow stack" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor={tokenId}>Invite token</label>
            <input id={tokenId} readOnly spellCheck={false} value={token} />
          </div>
          <ErrorNote error={mutation.error} />
          {mutation.data ? (
            <p role="status">
              You joined team {mutation.data.teamId} as {cap(mutation.data.role || "member")}.
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" disabled={mutation.isPending || !token}>
              {mutation.isPending ? "Accepting…" : "Accept invite"}
            </button>
            {mutation.data ? (
              <Link to={`/people?team=${encodeURIComponent(mutation.data.teamId)}`}>
                Open people
              </Link>
            ) : null}
            <Link to="/">Back to home</Link>
          </div>
        </form>
      )}
    </div>
  );
}
